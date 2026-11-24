/**
 * Auto-review S1 (docs/auto-review-spec.md): an opt-in room setting that watches linked GitHub repos and records one review JOB per open pull request head.
 * This slice is the setting, the poller, the eligibility gate and the dedupe; the reviewer agents and the post come in the next slices.
 *
 * Trust: a pull request is text an attacker may write, so a job is made only for a same-repo branch (never a fork), by an allow-listed author, not a draft,
 * under a size cap, in a linked repo. The only gh calls here are `gh pr list` and (S2) `gh pr diff`, with a fixed argv: no other verb, owner/repo checked
 * against REPO_RE, nothing from a request but the repo name and the author login. The poller reads with the room's own gh login (GH_CONFIG_DIR).
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AutoReviewJob, AutoReviewSettings, AutoReviewView, Logger } from '../shared/protocol.js';
import { AUTO_REVIEW_FILE, AUTO_REVIEW_JOBS_FILE, FILE_MODE, nullLogger } from './constants.js';
import { HubError } from './hub.js';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `owner/repo`, as GitHub spells them: the one pattern a repo name must match before it reaches gh. */
export const REPO_RE = /^(?!\.{1,2}\/)(?!-)[A-Za-z0-9_.-]{1,100}\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const POSITION_RE = /^[a-z][a-z0-9-]{0,31}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,119}$/;
export const POLL_MS = 3 * 60_000;
export const JOBS_KEPT = 200;
/** At most this many jobs per repo in an hour: a busy repo cannot make a storm (spec A4). */
export const JOBS_PER_HOUR = 4;
const LIST_LIMIT = 50;
const LISTS_MAX = 20;

export const DEFAULT_SETTINGS: AutoReviewSettings = {
  enabled: false,
  autoPost: false,
  repos: [],
  authors: [],
  positions: ['rso', 'retro'],
  model: null,
  maxUsdPerPr: 2,
  maxUsdPerDay: 10,
  maxLines: 1500,
  maxFiles: 40,
  focus: '',
  ignorePaths: [],
};

/** A settings patch from untrusted JSON: only known fields, each checked. Returns the fields to change, or a message and the field. */
export function parseSettingsPatch(body: unknown): { ok: true; patch: Partial<AutoReviewSettings> } | { ok: false; error: string; field: string } {
  if (!isRecord(body)) return { ok: false, error: 'request body must be a JSON object', field: '' };
  const patch: Partial<AutoReviewSettings> = {};
  const fail = (error: string, field: string): { ok: false; error: string; field: string } => ({ ok: false, error, field });
  for (const [key, value] of Object.entries(body)) {
    switch (key) {
      case 'enabled':
      case 'autoPost':
        if (typeof value !== 'boolean') return fail(`${key} must be true or false`, key);
        patch[key] = value;
        break;
      case 'repos':
      case 'authors':
      case 'positions':
      case 'ignorePaths': {
        if (!Array.isArray(value) || value.length > LISTS_MAX) return fail(`${key} must be a list of at most ${LISTS_MAX} items`, key);
        const ok = key === 'repos' ? REPO_RE : key === 'authors' ? LOGIN_RE : key === 'positions' ? POSITION_RE : /^[^\0\n]{1,200}$/;
        if (!value.every((v) => typeof v === 'string' && ok.test(v))) return fail(`${key} has an item that is not valid`, key);
        const list = [...new Set(value as string[])];
        if (key === 'positions' && list.length === 0) return fail('positions must name at least one reviewer position', key);
        patch[key] = list;
        break;
      }
      case 'model':
        if (value !== null && (typeof value !== 'string' || !MODEL_RE.test(value))) return fail('model must be a model name or null', key);
        patch.model = value;
        break;
      case 'maxUsdPerPr':
      case 'maxUsdPerDay':
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.01 || value > 1000) return fail(`${key} must be dollars from 0.01 to 1000`, key);
        patch[key] = Math.round(value * 100) / 100;
        break;
      case 'maxLines':
      case 'maxFiles':
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100_000) return fail(`${key} must be a whole number from 1 to 100000`, key);
        patch[key] = value;
        break;
      case 'focus':
        if (typeof value !== 'string' || value.length > 2000 || /[\0]/.test(value)) return fail('focus must be text of at most 2000 characters', key);
        patch.focus = value;
        break;
      default:
        return fail(`unknown field "${key}"`, key);
    }
  }
  return { ok: true, patch };
}

/** What `gh pr list --json` says of one pull request: only the fields the gate reads. */
export interface ListedPr {
  number: number;
  headRefOid: string;
  isDraft: boolean;
  isCrossRepository: boolean;
  author: { login: string };
  headRepositoryOwner: { login: string } | null;
  changedFiles: number;
  additions: number;
  deletions: number;
  title: string;
}

const JSON_FIELDS = 'number,headRefOid,isDraft,isCrossRepository,author,headRepositoryOwner,changedFiles,additions,deletions,title';

/** The one place gh is called for reading: the argv is fixed, the repo and the author are checked first. */
export type PrLister = (repo: string, author: string) => Promise<ListedPr[]>;

export const ghEnv = (options: { dir: string; env: NodeJS.ProcessEnv }): NodeJS.ProcessEnv => ({ PATH: options.env.PATH, HOME: options.env.HOME, GH_CONFIG_DIR: options.env.GH_CONFIG_DIR?.trim() ? options.env.GH_CONFIG_DIR : join(options.dir, 'gh'), GH_PROMPT_DISABLED: '1', NO_COLOR: '1' });

/** The real lister: `gh pr list`, with the room's own gh login. `author` is a login or `@me`. */
export function ghLister(options: { dir: string; env: NodeJS.ProcessEnv; bin?: string }): PrLister {
  return (repo, author) =>
    new Promise((resolve, reject) => {
      if (!REPO_RE.test(repo)) return reject(new Error('not a repo name'));
      if (author !== '@me' && !LOGIN_RE.test(author)) return reject(new Error('not a login'));
      const env = ghEnv(options);
      execFile(options.bin ?? 'gh', ['pr', 'list', '--repo', repo, '--state', 'open', '--author', author, '--limit', String(LIST_LIMIT), '--json', JSON_FIELDS], { env, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
        if (error) return reject(new Error(`gh pr list failed (${(error as NodeJS.ErrnoException).code ?? 'error'})`));
        try {
          const parsed: unknown = JSON.parse(stdout);
          resolve(Array.isArray(parsed) ? (parsed as ListedPr[]) : []);
        } catch {
          reject(new Error('gh pr list did not answer JSON'));
        }
      });
    });
}

/** Why a pull request is not reviewed, or null when it is eligible. The gate of spec §2 step 2. */
export function skipReason(pr: ListedPr, repo: string, settings: AutoReviewSettings, byDefaultAuthor: boolean): string | null {
  if (typeof pr.number !== 'number' || !Number.isInteger(pr.number) || pr.number < 1) return 'not a pull request number';
  if (typeof pr.headRefOid !== 'string' || !/^[0-9a-f]{40}$/.test(pr.headRefOid)) return 'no head commit';
  if (pr.isDraft) return 'a draft';
  const owner = repo.split('/')[0] ?? '';
  if (pr.isCrossRepository !== false) return 'from a fork (only branches of this repo are reviewed)';
  if (typeof pr.headRepositoryOwner?.login !== 'string' || pr.headRepositoryOwner.login.toLowerCase() !== owner.toLowerCase()) return 'the head belongs to another owner';
  if (!byDefaultAuthor && !settings.authors.some((a) => a.toLowerCase() === String(pr.author?.login).toLowerCase())) return `author ${String(pr.author?.login)} is not on the list`;
  if (pr.changedFiles > settings.maxFiles || pr.additions + pr.deletions > settings.maxLines) return `too large (${pr.changedFiles} files, ${pr.additions + pr.deletions} lines)`;
  return null;
}

export interface AutoReviewOptions {
  /** The room's home: `auto-review.json` and `auto-review-jobs.json` live here. */
  dir: string;
  now: () => number;
  log?: Logger;
  list: PrLister;
  /** A job was made for a head (S2 starts the reviewers on it). */
  onJob?: (job: AutoReviewJob) => void;
  /** After every poll: jobs that waited (the day's cap, a restart) get another try. */
  onPolled?: () => void;
  /** A job that had not finished was superseded by a new head: its reviewers must go. */
  onSuperseded?: (job: AutoReviewJob) => void;
  /** Milliseconds between polls; tests give 0 to poll by hand only. */
  pollMs?: number;
}

export interface AutoReview {
  load(): Promise<void>;
  view(): AutoReviewView;
  /** A settings patch (parseSettingsPatch has checked the shape): saves, and starts or stops the poller. */
  set(input: unknown): Promise<AutoReviewView>;
  /** One poll now (the page's button and the tests). Resolves with the jobs made. */
  pollNow(): Promise<AutoReviewJob[]>;
  /** A job changes state (S2: running, done, posted). */
  mark(id: string, change: Partial<Pick<AutoReviewJob, 'status' | 'reason' | 'task' | 'mission' | 'reviewers' | 'submitted' | 'url'>>): Promise<void>;
  /** The jobs, oldest first (a live array: do not change it). */
  jobs(): AutoReviewJob[];
  start(): void;
  close(): Promise<void>;
}

const jobKey = (repo: string, pr: number, sha: string): string => `${repo}#${pr}@${sha}`;

export function createAutoReview(options: AutoReviewOptions): AutoReview {
  const { dir, now } = options;
  const log = options.log ?? nullLogger;
  const settingsPath = join(dir, AUTO_REVIEW_FILE);
  const jobsPath = join(dir, AUTO_REVIEW_JOBS_FILE);
  let settings: AutoReviewSettings = { ...DEFAULT_SETTINGS };
  let jobs: AutoReviewJob[] = [];
  let seq = 0;
  let timer: NodeJS.Timeout | null = null;
  let polling: Promise<AutoReviewJob[]> | null = null;
  let lastPoll: { at: number; error: string | null } | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const pollMs = options.pollMs ?? POLL_MS;

  const write = async (path: string, value: unknown): Promise<void> => {
    const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(value, null, 2), { flag: 'wx', mode: FILE_MODE });
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw new Error(`could not save the auto-review state: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const later = (fn: () => Promise<void>): Promise<void> => {
    const run = chain.then(fn);
    chain = run.catch(() => undefined);
    return run;
  };
  const saveJobs = (): Promise<void> => later(() => write(jobsPath, { version: 1, seq, jobs }));

  const view = (): AutoReviewView => ({ settings: { ...settings, repos: [...settings.repos], authors: [...settings.authors], positions: [...settings.positions], ignorePaths: [...settings.ignorePaths] }, jobs: [...jobs].reverse(), lastPoll });

  const poll = async (): Promise<AutoReviewJob[]> => {
    if (!settings.enabled || settings.repos.length === 0) return [];
    const made: AutoReviewJob[] = [];
    const superseded: AutoReviewJob[] = [];
    let failure: string | null = null;
    for (const repo of settings.repos) {
      const byDefault = settings.authors.length === 0;
      const seen = new Map<number, ListedPr>();
      try {
        // with no list the room's own login is the only author (`@me`): the server filters, nothing is guessed from a name
        for (const author of byDefault ? ['@me'] : settings.authors) for (const pr of await options.list(repo, author)) seen.set(pr.number, pr);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        log.warn(`auto-review could not list ${repo}: ${failure}`);
        continue;
      }
      for (const pr of seen.values()) {
        const sha = typeof pr.headRefOid === 'string' ? pr.headRefOid : '';
        const key = jobKey(repo, pr.number, sha);
        const known = jobs.find((j) => j.key === key);
        // a head already made into a job is not made again; one the GATE skipped is judged again (the PR may have been marked ready, or the list changed), and only that
        if (known !== undefined && known.gate !== true) continue;
        const reason = skipReason(pr, repo, settings, byDefault);
        if (known !== undefined) {
          if (reason !== null) {
            known.reason = reason;
            continue;
          }
          jobs = jobs.filter((j) => j !== known);
        }
        const title = typeof pr.title === 'string' ? pr.title.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 120) : '';
        if (reason === null) {
          // a storm guard: at most JOBS_PER_HOUR jobs per repo in an hour; the rest wait for the next poll
          const recent = jobs.filter((j) => j.repo === repo && j.status !== 'skipped' && now() - j.at < 3_600_000).length;
          if (recent >= JOBS_PER_HOUR) {
            log.debug(`auto-review: ${repo} is at ${JOBS_PER_HOUR} jobs this hour; #${pr.number} waits`);
            continue;
          }
          // a new head supersedes the job of the older one that did not finish
          for (const old of jobs) {
            if (old.repo === repo && old.pr === pr.number && (old.status === 'queued' || old.status === 'running')) {
              old.status = 'superseded';
              superseded.push(old);
            }
          }
        }
        const job: AutoReviewJob = { id: `rv${(seq += 1)}`, key, repo, pr: pr.number, sha, title, status: reason === null ? 'queued' : 'skipped', ...(reason === null ? {} : { reason, gate: true }), at: now() };
        jobs.push(job);
        if (reason === null) made.push(job);
      }
    }
    if (jobs.length > JOBS_KEPT) jobs = jobs.slice(jobs.length - JOBS_KEPT);
    lastPoll = { at: now(), error: failure };
    await saveJobs().catch((error: unknown) => log.error('auto-review could not save its jobs', error));
    for (const old of superseded) options.onSuperseded?.(old);
    for (const job of made) options.onJob?.(job);
    options.onPolled?.();
    return made;
  };

  const stop = (): void => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const start = (): void => {
    stop();
    if (!settings.enabled || pollMs <= 0) return;
    timer = setInterval(() => void api.pollNow().catch(() => undefined), pollMs);
    timer.unref();
  };

  const api: AutoReview = {
    async load() {
      try {
        const saved: unknown = JSON.parse(await readFile(settingsPath, 'utf8'));
        const parsed = isRecord(saved) && saved.version === 1 ? parseSettingsPatch(Object.fromEntries(Object.entries(saved).filter(([k]) => k !== 'version'))) : null;
        if (parsed?.ok) settings = { ...DEFAULT_SETTINGS, ...parsed.patch };
        else throw new Error('not a version 1 auto-review file');
      } catch (error) {
        // an unreadable file leaves it OFF: the safe side of a feature that posts under the Director's login
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.error(`${AUTO_REVIEW_FILE} could not be read; auto-review is off`, error instanceof SyntaxError ? 'not valid JSON' : error);
      }
      try {
        const saved: unknown = JSON.parse(await readFile(jobsPath, 'utf8'));
        if (isRecord(saved) && Array.isArray(saved.jobs)) {
          jobs = (saved.jobs as unknown[]).filter((j): j is AutoReviewJob => isRecord(j) && typeof j.key === 'string' && typeof j.repo === 'string' && REPO_RE.test(j.repo) && typeof j.pr === 'number').slice(-JOBS_KEPT);
          seq = typeof saved.seq === 'number' ? saved.seq : jobs.length;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`${AUTO_REVIEW_JOBS_FILE} could not be read; the jobs start empty`);
      }
    },
    view,
    async set(input) {
      const parsed = parseSettingsPatch(input);
      if (!parsed.ok) throw new HubError('bad_request', parsed.error, parsed.field || undefined);
      const next = { ...settings, ...parsed.patch };
      if (JSON.stringify(next) !== JSON.stringify(settings)) {
        await later(() => write(settingsPath, { version: 1, ...next }));
        settings = next;
      }
      start();
      return view();
    },
    pollNow() {
      polling ??= poll().finally(() => {
        polling = null;
      });
      return polling;
    },
    async mark(id, change) {
      const job = jobs.find((j) => j.id === id);
      if (job === undefined) return;
      Object.assign(job, change);
      await saveJobs();
    },
    jobs: () => jobs,
    start,
    async close() {
      stop();
      await polling?.catch(() => undefined);
      await chain;
    },
  };
  return api;
}
