/**
 * Knowledge anchors (docs/features/knowledge-anchors.md): a Mission Log entry may say "this file holds this text" (`present`) or
 * "this file does not hold this text" (`absent`), about a repository that an agent of this room works in. The check is plain literal
 * matching, no pattern, no model. The answer is `ok`, `stale` ("not confirmed on <branch>@<sha>", never "false") or `unknown`
 * (could not check). It is a hint on the page and in log_read and log_search, never a gate, and nothing read from a repository goes
 * into a prompt, a message or a note: the notes of a state are written here from fixed words, a branch name and a short hash.
 *
 * What a repository can do to this code (an agent can write in it): its `.git/config` can name programs (git runs with the Recorder's
 * safe arguments and a clean environment), a file can be a link to something outside (a path is read through its realpath, which must
 * lie under the realpath of the repository, opened with O_NOFOLLOW, regular files only), a file can be huge (1 MiB is read).
 *
 * shortcut: a `present` check reads the first 1 MiB of the file, so a text past it is "not confirmed"; and the check looks at the
 * working tree of the checkout the repo path names (not at a branch), so it can differ between two worktrees of one repository.
 */
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import { LOG_ANCHOR_FILE_MAX_CHARS, LOG_ANCHOR_REPO_MAX_CHARS, LOG_ANCHOR_TEXT_MAX_CHARS, LOG_ANCHORS_MAX } from '../shared/protocol.js';
import type { LogAnchor, LogAnchorState, Logger } from '../shared/protocol.js';
import { GIT_BIN } from './constants.js';
import { HubError } from './hub.js';
import { BASE_ARGS, KEEP_ENV } from './recorder.js';

/** One git call, and the time a check of one entry may take at most. */
export const ANCHOR_GIT_MS = 5000;
/** A `present` check reads this much of the file. */
export const ANCHOR_READ_BYTES = 1024 * 1024;
/** The answer of a check is kept this long: a page that is opened again and again does not run git again. */
export const ANCHOR_CACHE_MS = 30_000;

export interface AnchorChecker {
  /** The list as the entry will hold it, or a HubError (bad_request, field `anchors`). Every repo must be the top of a repository an agent works in. */
  validate(input: unknown): Promise<LogAnchor[]>;
  /** The last answer for these anchors (any age), or undefined. Never runs anything. */
  peek(anchors: readonly LogAnchor[]): LogAnchorState | undefined;
  /** Checks them, or gives the answer kept for ANCHOR_CACHE_MS. One check per repository at a time. Never throws. */
  check(anchors: readonly LogAnchor[]): Promise<LogAnchorState>;
}

export interface AnchorOptions {
  /** The start directories of the agents hired in this room. */
  dirs(): readonly string[];
  now(): number;
  env?: Record<string, string | undefined>;
  gitBin?: string;
  gitMs?: number;
  log: Logger;
}

const bad = (message: string): HubError => new HubError('bad_request', message, 'anchors');
// control characters (a newline would make `git grep -F` search for two texts), and the bidi and zero-width marks
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/;
const WINDOWS_DRIVE = /^[a-zA-Z]:/;

/** The anchor list of a request or a file, checked for shape (not for the repository): the first problem throws. */
export function anchorShape(input: unknown): Array<Omit<LogAnchor, 'repo'> & { repo: string }> {
  if (!Array.isArray(input)) throw bad('anchors must be a list');
  if (input.length > LOG_ANCHORS_MAX) throw bad(`at most ${LOG_ANCHORS_MAX} anchors`);
  return input.map((raw: unknown, i) => {
    const at = `anchor ${i + 1}`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw bad(`${at} must be an object with repo, file, kind and text`);
    const a = raw as Record<string, unknown>;
    for (const key of Object.keys(a)) if (!['repo', 'file', 'kind', 'text'].includes(key)) throw bad(`${at}: unknown field "${key}"`);
    const { repo, file, kind, text } = a;
    if (typeof repo !== 'string' || repo === '' || repo.length > LOG_ANCHOR_REPO_MAX_CHARS || !isAbsolute(repo) || repo.includes('\0')) throw bad(`${at}: repo must be an absolute path`);
    if (typeof file !== 'string' || file === '' || file.length > LOG_ANCHOR_FILE_MAX_CHARS) throw bad(`${at}: file must be 1 to ${LOG_ANCHOR_FILE_MAX_CHARS} characters`);
    if (UNSAFE_TEXT.test(file) || file.startsWith('/') || file.startsWith('~') || file.includes('\\') || WINDOWS_DRIVE.test(file) || file.split('/').includes('..')) {
      throw bad(`${at}: file must be a path inside the repository: relative, with no "..", no "~" and no drive`);
    }
    if (kind !== 'present' && kind !== 'absent') throw bad(`${at}: kind must be "present" or "absent"`);
    if (typeof text !== 'string' || text === '' || text.length > LOG_ANCHOR_TEXT_MAX_CHARS || UNSAFE_TEXT.test(text)) {
      throw bad(`${at}: text must be 1 to ${LOG_ANCHOR_TEXT_MAX_CHARS} characters on one line`);
    }
    return { repo, file, kind, text };
  });
}

interface Ran {
  /** The exit code; null when git did not run or was stopped. */
  code: number | null;
  out: string;
  why?: 'timeout' | 'missing' | 'failed';
}

export function createAnchorChecker(options: AnchorOptions): AnchorChecker {
  const { log } = options;
  const gitBin = options.gitBin ?? GIT_BIN;
  const gitMs = options.gitMs ?? ANCHOR_GIT_MS;
  const gitEnv: Record<string, string> = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
  for (const key of KEEP_ENV) {
    const value = (options.env ?? process.env)[key];
    if (value !== undefined) gitEnv[key] = value;
  }
  const cache = new Map<string, { at: number; state: LogAnchorState }>();
  const running = new Map<string, Promise<LogAnchorState>>();
  // one check per repository at a time: the tail of each repository's queue
  const queues = new Map<string, Promise<unknown>>();
  const sig = (anchors: readonly LogAnchor[]): string => JSON.stringify(anchors);

  /** git with the Recorder's safe arguments and a clean environment; SIGTERM when over time, so git removes its own lock. */
  const git = (cwd: string, args: string[], cap = 64 * 1024): Promise<Ran> =>
    new Promise((resolve) => {
      execFile(gitBin, [...BASE_ARGS, ...args], { cwd, env: gitEnv, timeout: gitMs, killSignal: 'SIGTERM', maxBuffer: cap, encoding: 'utf8' }, (error, stdout) => {
        if (error === null) return resolve({ code: 0, out: stdout });
        const e = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
        if (e.killed === true || e.signal != null) return resolve({ code: null, out: '', why: 'timeout' });
        if (e.code === 'ENOENT') return resolve({ code: null, out: '', why: 'missing' });
        resolve(typeof e.code === 'number' ? { code: e.code, out: String(stdout) } : { code: null, out: '', why: 'failed' });
      });
    });

  /** The real top of the repository of `dir`, or null. */
  async function topOf(dir: string): Promise<string | null> {
    const ran = await git(dir, ['rev-parse', '--show-toplevel'], 4096);
    if (ran.code !== 0) return null;
    return realpath(ran.out.trim()).catch(() => null);
  }

  /** The real tops of the repositories of the agents' directories. */
  async function tops(): Promise<Set<string>> {
    const found = await Promise.all([...new Set(options.dirs())].map((dir) => topOf(dir)));
    return new Set(found.filter((top): top is string => top !== null));
  }

  async function validate(input: unknown): Promise<LogAnchor[]> {
    const shaped = anchorShape(input);
    if (shaped.length === 0) return [];
    const valid = await tops();
    const out: LogAnchor[] = [];
    for (const [i, a] of shaped.entries()) {
      const real = await realpath(a.repo).catch(() => null);
      if (real === null || !valid.has(real)) throw bad(`anchor ${i + 1}: repo must be the top of a git repository that an agent of this room works in`);
      out.push({ repo: real, file: a.file, kind: a.kind, text: a.text });
    }
    return out;
  }

  /** "main@abc1234": only characters of a branch name and a hash; whatever else the repository holds is not shown. */
  async function where(repo: string): Promise<string> {
    const [branch, sha] = await Promise.all([git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'], 1024), git(repo, ['rev-parse', '--short=7', 'HEAD'], 1024)]);
    const b = branch.out.trim();
    const s = sha.out.trim();
    return `${/^[\w./-]{1,80}$/.test(b) ? b : 'HEAD'}@${/^[0-9a-f]{7,40}$/.test(s) ? s : 'unknown'}`;
  }

  /** true: the text is in the file, false: it is not (or the file is not a regular tracked file of the repository), a string: why git could not say. A regular tracked file, read through its realpath (which must be under the repository's) with O_NOFOLLOW, at most 1 MiB. */
  async function holds(repo: string, a: LogAnchor): Promise<boolean | string> {
    const tracked = await git(repo, ['ls-files', '-z', '--cached', '--', a.file], 4096);
    if (tracked.code !== 0) return why(tracked);
    if (!tracked.out.split('\0').includes(a.file)) return false;
    const real = await realpath(join(repo, a.file)).catch(() => null);
    if (real === null || !real.startsWith(repo + sep)) return false;
    let handle;
    try {
      handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
      if (!(await handle.stat()).isFile()) return false;
      const buffer = Buffer.alloc(ANCHOR_READ_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, ANCHOR_READ_BYTES, 0);
      return buffer.subarray(0, bytesRead).includes(Buffer.from(a.text));
    } catch {
      return false;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  const why = (ran: Ran): string => (ran.why === 'timeout' ? 'git did not answer in time' : ran.why === 'missing' ? 'git was not found' : 'git could not check');

  /** true: the text is in the file, false: it is not, a string: why git could not say. -F: the text is literal; -q: nothing is printed. */
  async function found(repo: string, a: LogAnchor): Promise<boolean | string> {
    const ran = await git(repo, ['grep', '-F', '-q', '--no-textconv', '-e', a.text, '--', a.file], 4096);
    return ran.code === 0 ? true : ran.code === 1 ? false : why(ran);
  }

  
  async function run(anchors: readonly LogAnchor[]): Promise<LogAnchorState> {
    const at = options.now();
    const valid = await tops();
    let state: LogAnchorState['state'] = 'ok';
    let note = '';
    const byRepo = new Map<string, LogAnchor[]>();
    for (const a of anchors) byRepo.set(a.repo, [...(byRepo.get(a.repo) ?? []), a]);
    for (const [repo, list] of byRepo) {
      // the repository may have been moved, or its agent removed, since the anchor was written
      if (!valid.has(repo)) {
        if (state === 'ok') {
          state = 'unknown';
          note = 'a repository of the anchors is not one of an agent of this room now';
        }
        continue;
      }
      const result = await turn(repo, async () => {
        let verdict: 'ok' | 'stale' | 'unknown' = 'ok';
        let reason = '';
        for (const a of list) {
          const held = a.kind === 'present' ? await holds(repo, a) : await found(repo, a);
          if (typeof held === 'string') {
            if (verdict === 'ok') {
              verdict = 'unknown';
              reason = held;
            }
          } else if (held !== (a.kind === 'present')) {
            verdict = 'stale';
            reason = `not confirmed on ${await where(repo)}`;
            break;
          }
        }
        return { verdict, reason };
      });
      if (result.verdict === 'stale') {
        state = 'stale';
        note = result.reason;
        break;
      }
      if (result.verdict === 'unknown' && state === 'ok') {
        state = 'unknown';
        note = result.reason;
      }
    }
    return { state, note, checkedAt: at };
  }

  /** `fn` after the checks already queued for this repository. */
  function turn<T>(repo: string, fn: () => Promise<T>): Promise<T> {
    const next = (queues.get(repo) ?? Promise.resolve()).then(fn);
    const tail = next.catch(() => undefined);
    queues.set(repo, tail);
    void tail.then(() => {
      if (queues.get(repo) === tail) queues.delete(repo);
    });
    return next;
  }

  return {
    validate,
    peek: (anchors) => cache.get(sig(anchors))?.state,
    check(anchors) {
      const key = sig(anchors);
      const kept = cache.get(key);
      if (kept !== undefined && options.now() - kept.at < ANCHOR_CACHE_MS) return Promise.resolve(kept.state);
      const going = running.get(key);
      if (going !== undefined) return going;
      const next = run(anchors)
        .catch((error: unknown): LogAnchorState => {
          log.warn(`an anchor check failed: ${error instanceof Error ? error.message : String(error)}`);
          return { state: 'unknown', note: 'the check failed', checkedAt: options.now() };
        })
        .then((state) => {
          cache.set(key, { at: options.now(), state });
          // a bounded cache: the oldest answers go first
          if (cache.size > 500) cache.delete(cache.keys().next().value as string);
          return state;
        })
        .finally(() => running.delete(key));
      running.set(key, next);
      return next;
    },
  };
}
