/**
 * Black Box: an append-only record of what happened in the room, in a git repository of its own, with the server as the only
 * committer (docs/black-box-spec.md).
 *
 * `<home>/black-box/` holds one file for each UTC day, `YYYY-MM-DD.jsonl`, a line for each event: { at, kind, text }. A text is made of
 * names, ids and words of the server, never of a message, a title or anything somebody typed (the callers see to that, audited.ts
 * lists them), and it is cut to one clean line. A line is appended at once; the commit is batched, at most once in BLACKBOX_COMMIT_MS,
 * and at shutdown. Git runs through execFile with an argument array, a timeout and a scrubbed environment: the identity is passed
 * with -c, so that no git config of the user is read or written, and the repository's own hooks, signing and fsmonitor are switched
 * off. Without git, or when git fails, the room goes on: events are still written to the files and shown, and the view says why they
 * are not committed; the next batch commits whatever is waiting.
 *
 * shortcut: a rate cap (BLACKBOX_RATE_MAX a minute) drops the rest of a burst and says so in the log; raise it or batch the burst
 * if a real room ever hits it. shortcut: the files are plain files, so anything that can write the home (an agent in bypassPermissions)
 * can change them; git history makes that visible, it does not prevent it.
 */
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { appendFile, lstat, mkdir, open, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AUDIT_KINDS, AUDIT_TEXT_MAX_CHARS } from '../shared/protocol.js';
import type { AuditEvent, AuditGitState, AuditKind, AuditView, Logger, TimerHandle } from '../shared/protocol.js';
import { BLACKBOX_COMMIT_MS, BLACKBOX_DIR, BLACKBOX_GIT_TIMEOUT_MS, BLACKBOX_RATE_MAX, BLACKBOX_RATE_WINDOW_MS, BLACKBOX_RECENT_MAX, BLACKBOX_TAIL_BYTES, DIR_MODE, FILE_MODE } from './constants.js';

/** One git call: the exit code of git (not zero is an answer, not a throw) and what it printed. Throws when git cannot run (not found, timeout). */
export type GitRun = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface BlackBoxOptions {
  /** gonogo's home: the folder black-box/ lives here. */
  dir: string;
  now(): number;
  setTimer(fn: () => void, ms: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
  /** The PATH to look for git on: the environment gonogo was started with. */
  path?: string;
  /** Tests pass a fake; the default runs the git program in the repository. */
  git?: GitRun;
  log: Logger;
}

export interface BlackBox {
  /** Makes the folder and the repository when they are missing, and reads the newest events. Never throws: a problem is in the view. */
  load(): Promise<void>;
  /** Never throws, never waits. */
  record(kind: AuditKind, text: string): void;
  view(): AuditView;
  /** Commits what is waiting, once, and stops. */
  close(): Promise<void>;
}

// C0, DEL, C1 and bidi controls: an event is one clean line.
const UNSAFE_IN_TEXT = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
/** The identity and the switches of every git call: nothing of the user's git setup applies, and nothing in the repository runs. */
const GIT_FIXED = ['-c', 'user.name=gonogo', '-c', 'user.email=gonogo@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

/** The real runner: execFile (no shell), the repository as GIT_DIR and GIT_WORK_TREE so that no other repository is found above it, no config file read. */
export function execGit(repo: string, path: string | undefined = process.env.PATH, timeoutMs: number = BLACKBOX_GIT_TIMEOUT_MS): GitRun {
  const env: Record<string, string> = {
    ...(path === undefined ? {} : { PATH: path }),
    GIT_DIR: join(repo, '.git'),
    GIT_WORK_TREE: repo,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  };
  return (args) =>
    new Promise((done, fail) => {
      execFile('git', [...GIT_FIXED, ...args], { cwd: repo, env, timeout: timeoutMs, maxBuffer: 1_048_576, windowsHide: true, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code;
        if (error === null) done({ code: 0, stdout, stderr });
        else if (typeof code === 'number') done({ code, stdout, stderr });
        // a git that was killed leaves its index.lock, and only the server runs git here: without this every later commit fails until somebody deletes it
        else if ((error as { killed?: boolean }).killed === true) void rm(join(repo, '.git', 'index.lock'), { force: true }).catch(() => undefined).then(() => fail(error));
        else fail(error);
      });
    });
}

/** At most `max` characters, never half of a surrogate pair. */
const cutText = (text: string, max: number): string => (text.length <= max ? text : text.slice(0, /[\ud800-\udbff]/.test(text.charAt(max - 1)) ? max - 1 : max));

/** A path as one word of a POSIX shell, to paste in a terminal. */
export const shellWord = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

const firstLine = (text: string): string => cutText((text.trim().split('\n')[0] ?? '').replace(UNSAFE_IN_TEXT, ' ').trim(), 200);
const dayFile = (at: number): string => `${new Date(at).toISOString().slice(0, 10)}.jsonl`;

/** The events of a text file, oldest first: a line that is not an event is skipped. */
function parseLines(text: string): AuditEvent[] {
  const found: AuditEvent[] = [];
  for (const line of text.split('\n')) {
    try {
      const value = JSON.parse(line) as { at?: unknown; kind?: unknown; text?: unknown };
      const at = typeof value.at === 'string' ? Date.parse(value.at) : Number.NaN;
      if (!Number.isNaN(at) && (AUDIT_KINDS as readonly unknown[]).includes(value.kind) && typeof value.text === 'string') {
        found.push({ at, kind: value.kind as AuditKind, text: cutText(value.text, AUDIT_TEXT_MAX_CHARS) });
      }
    } catch {
      // an empty line, the cut start of the tail, or a hand edit: not an event
    }
  }
  return found;
}

/** The newest events of the day files, newest first: only the end of each file is read, so a big day costs no more than a small one. */
async function readRecent(repo: string): Promise<AuditEvent[]> {
  const names = (await readdir(repo)).filter((name) => DAY_FILE.test(name)).sort().reverse();
  const found: AuditEvent[] = [];
  for (const name of names.slice(0, 7)) {
    const path = join(repo, name);
    if (!(await lstat(path)).isFile()) continue;
    const handle = await open(path, 'r');
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - BLACKBOX_TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      const text = buffer.toString('utf8');
      // a tail starts in the middle of a line: drop that line
      found.push(...parseLines(start > 0 ? text.slice(text.indexOf('\n') + 1) : text).reverse());
    } finally {
      await handle.close();
    }
    if (found.length >= BLACKBOX_RECENT_MAX) break;
  }
  return found.slice(0, BLACKBOX_RECENT_MAX);
}

export function createBlackBox(options: BlackBoxOptions): BlackBox {
  const { now, log } = options;
  const repo = resolve(options.dir, BLACKBOX_DIR);
  const git = options.git ?? execGit(repo, options.path);
  /** Newest first. */
  let recent: AuditEvent[] = [];
  // load() says otherwise at once when git is not usable
  let state: AuditGitState = 'ok';
  let note = '';
  /** The folder can take files: false when it is not a plain folder. */
  let writable = false;
  /** Git was found and the repository is there: false until load says so, and for good when it could not. */
  let canCommit = false;
  let waiting = 0;
  let dropped = 0;
  let windowStart = 0;
  let inWindow = 0;
  let timer: TimerHandle | null = null;
  let closed = false;
  let chain: Promise<unknown> = Promise.resolve();

  const setGit = (next: AuditGitState, why: string): void => {
    if (next !== state || why !== note) {
      if (next === 'ok') log.info('the Black Box commits again');
      else log.warn(`the Black Box does not commit: ${why}`);
    }
    state = next;
    note = why;
  };

  /** Adds what the log needs of the batch: files first, so a commit sees every line that was recorded before it. */
  const later = (fn: () => Promise<void>): void => {
    chain = chain.then(fn).catch((error: unknown) => log.warn('the Black Box could not write', error instanceof Error ? error.message : String(error)));
  };

  const commit = async (): Promise<void> => {
    if (!canCommit) return;
    const count = waiting;
    waiting = 0;
    try {
      const steps: Array<[string[], number[]]> = [
        [['add', '-A', '--', '.'], [0]],
        [['diff', '--cached', '--quiet'], [0, 1]],
      ];
      let changed = false;
      for (const [args, accepted] of steps) {
        const done = await git(args);
        if (!accepted.includes(done.code)) throw new Error(firstLine(done.stderr) || `git ${args[0]} exited with ${done.code}`);
        changed = done.code === 1;
      }
      if (changed) {
        const done = await git(['commit', '-q', '-m', count > 0 ? `audit: ${count} event${count === 1 ? '' : 's'}` : 'audit: earlier events']);
        if (done.code !== 0) throw new Error(firstLine(done.stderr) || `git commit exited with ${done.code}`);
      }
      setGit('ok', '');
    } catch (error) {
      waiting += count;
      setGit('error', error instanceof Error && (error as { killed?: boolean }).killed ? `git took more than ${BLACKBOX_GIT_TIMEOUT_MS / 1000} seconds` : firstLine(error instanceof Error ? error.message : String(error)));
      arm();
    }
  };

  /** One timer for a batch: the first event of a batch starts it, and events that come later join it. */
  const arm = (): void => {
    if (timer !== null || closed || !canCommit) return;
    timer = options.setTimer(() => {
      timer = null;
      later(commit);
    }, BLACKBOX_COMMIT_MS);
  };

  const droppedText = (): string => `${dropped} events were not recorded: more than ${BLACKBOX_RATE_MAX} in a minute`;

  const add = (kind: AuditKind, text: string, at: number): void => {
    const event: AuditEvent = { at, kind, text };
    recent = [event, ...recent].slice(0, BLACKBOX_RECENT_MAX);
    if (!writable) return;
    waiting += 1;
    // O_NOFOLLOW: a link where the day's file goes must not send the line somewhere else (the folder itself is checked in load)
    const flag = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;
    later(() => appendFile(join(repo, dayFile(at)), `${JSON.stringify({ ...event, at: new Date(at).toISOString() })}\n`, { mode: FILE_MODE, flag }));
    arm();
  };

  return {
    async load() {
      try {
        await mkdir(repo, { recursive: true, mode: DIR_MODE });
        // a link in its place would send the files and the repository somewhere else
        if (!(await lstat(repo)).isDirectory()) throw new Error(`${BLACKBOX_DIR} is not a plain folder`);
        writable = true;
        recent = await readRecent(repo);
      } catch (error) {
        setGit('error', firstLine(error instanceof Error ? error.message : String(error)));
        return;
      }
      try {
        await git(['--version']);
      } catch (error) {
        // not found is the usual reason; a git that cannot start for another reason is the same to the room
        setGit('missing', (error as { code?: unknown }).code === 'ENOENT' ? 'git was not found on the PATH' : firstLine(error instanceof Error ? error.message : String(error)));
        return;
      }
      try {
        const missing = await lstat(join(repo, '.git')).then(
          () => false,
          () => true,
        );
        if (missing) {
          const done = await git(['init', '-q']);
          if (done.code !== 0) throw new Error(firstLine(done.stderr) || `git init exited with ${done.code}`);
        }
        canCommit = true;
        setGit('ok', '');
        // whatever a crash left uncommitted goes in the first batch
        arm();
      } catch (error) {
        setGit('error', firstLine(error instanceof Error ? error.message : String(error)));
      }
    },

    record(kind, text) {
      if (closed) return;
      const line = cutText(text.replace(UNSAFE_IN_TEXT, ' ').replace(/\s+/g, ' ').trim(), AUDIT_TEXT_MAX_CHARS);
      if (line === '' || !(AUDIT_KINDS as readonly string[]).includes(kind)) return;
      const at = now();
      if (at - windowStart >= BLACKBOX_RATE_WINDOW_MS || at < windowStart) {
        windowStart = at;
        inWindow = 0;
        if (dropped > 0) {
          add('audit', droppedText(), at);
          dropped = 0;
        }
      }
      if (inWindow >= BLACKBOX_RATE_MAX) {
        dropped += 1;
        return;
      }
      inWindow += 1;
      add(kind, line, at);
    },

    view: () => ({ git: state, note, dir: repo, command: `git -C ${shellWord(repo)} log -p`, events: [...recent] }),

    close() {
      if (dropped > 0) add('audit', droppedText(), now());
      dropped = 0;
      closed = true;
      if (timer !== null) options.clearTimer(timer);
      timer = null;
      later(commit);
      return chain.then(() => undefined);
    },
  };
}
