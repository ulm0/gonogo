/**
 * Knowledge anchors (docs/features/knowledge-anchors.md, docs/knowledge-spec.md section 0.3): a Mission Log entry may say "this file
 * holds this text" (`present`) or "this file, or no tracked file, holds this text" (`absent`), about the repository of an agent of this
 * room. The check is plain literal matching, no pattern, no model. The answer is `ok`, `stale` ("not confirmed on <branch>@<sha>",
 * never "false"), `vacuous` (the file is not there: check the path) or `unchecked` (could not check, and why). It is a hint on the page
 * and in log_read and log_search, never a gate, and nothing read from a repository goes into a prompt, a message or a note: the notes
 * are written here from fixed words, a branch name, a short hash and a count of files.
 *
 * Who may anchor what (RSO C2): an anchor written by an agent names that agent's own top level (for a Clean Room or worktree agent,
 * its own worktree); only the Director, on an entry of his own, may name the top level of any hired agent. It is checked at write and
 * at every check, with the author of the entry. A file is read only when git lists it as tracked, so an untracked `.env` gives
 * `unchecked: not tracked` and is never opened.
 *
 * What a repository can do to this code (an agent can write in it): its `.git/config` can name programs (git runs with the Recorder's
 * safe arguments and a clean environment), a file can be a link to something outside (read through its realpath, which must lie under
 * the realpath of the root, with O_NOFOLLOW, regular files only, and the opened file must be the one `lstat` saw), a file can be huge
 * (1 MiB is read), and a text that starts with a dash could be an option of `git grep` (refused at write; `-e <text> --` besides).
 *
 * shortcut: a `present` or `absent`-with-file check reads at most 1 MiB, so a larger file is `unchecked: too large`; the check looks at
 * the working tree of the root, not at a branch; the same anchors are checked at most once per 30 s, and checks of one root run one
 * after the other, rather than one run of a whole root per 30 s; at most 5 anchors of 1 MiB each, so the 64 MiB cap of a run is never reached.
 */
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import { LOG_ANCHOR_FILE_MAX_CHARS, LOG_ANCHOR_ROOT_MAX_CHARS, LOG_ANCHOR_TEXT_MAX_CHARS, LOG_ANCHORS_MAX } from '../shared/protocol.js';
import type { LogAnchor, LogAnchorState, Logger } from '../shared/protocol.js';
import { GIT_BIN } from './constants.js';
import { HubError } from './hub.js';
import { BASE_ARGS, KEEP_ENV } from './recorder.js';

/** One git call. */
export const ANCHOR_GIT_MS = 5000;
/** The whole check of one entry. */
export const ANCHOR_RUN_MS = 5000;
/** A check reads this much of a file. */
export const ANCHOR_READ_BYTES = 1024 * 1024;
/** The answer of a check is kept this long: a page that is opened again and again does not run git again. */
export const ANCHOR_CACHE_MS = 30_000;
/** What `git grep -l` may print before it is stopped: more than this is a hit all the same. */
const GREP_CAP = 64 * 1024;

export interface AnchorChecker {
  /** The list as the entry will hold it (roots as real paths, the branch stamped), or a HubError (bad_request, field `anchors`). `author` is "user" or the agent that wrote the entry. */
  validate(input: unknown, author: string): Promise<LogAnchor[]>;
  /** The last answer for these anchors (any age), or undefined. Never runs anything. */
  peek(anchors: readonly LogAnchor[], author: string): LogAnchorState | undefined;
  /** Checks them, or gives the answer kept for ANCHOR_CACHE_MS. One check per root at a time. Never throws. */
  check(anchors: readonly LogAnchor[], author: string): Promise<LogAnchorState>;
}

export interface AnchorOptions {
  /** The names of the agents hired in this room. */
  agents(): readonly string[];
  /** Where an agent's files are (its Clean Room or worktree, else its folder), or null when it has none now. */
  place(name: string): Promise<string | null>;
  now(): number;
  env?: Record<string, string | undefined>;
  gitBin?: string;
  gitMs?: number;
  runMs?: number;
  /** For tests: runs between the `lstat` of a file and its open. */
  afterLstat?(path: string): Promise<void>;
  log: Logger;
}

const bad = (message: string): HubError => new HubError('bad_request', message, 'anchors');
// control characters (a newline would make `git grep -F` search for two texts), and the bidi and zero-width marks
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/;
const WINDOWS_DRIVE = /^[a-zA-Z]:/;
const BRANCH = /^[\w./-]{1,80}$/;

/** The anchors of a request or of a file, checked for shape (not for the repository): the first problem throws. `stored`: the server's own `branch` is allowed. */
export function anchorShape(input: unknown, stored = false): LogAnchor[] {
  if (!Array.isArray(input)) throw bad('anchors must be a list');
  if (input.length > LOG_ANCHORS_MAX) throw bad(`at most ${LOG_ANCHORS_MAX} anchors`);
  return input.map((raw: unknown, i) => {
    const at = `anchor ${i + 1}`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw bad(`${at} must be an object with root, text and mode (and file)`);
    const a = raw as Record<string, unknown>;
    for (const key of Object.keys(a)) if (!['root', 'file', 'text', 'mode', ...(stored ? ['branch'] : [])].includes(key)) throw bad(`${at}: unknown field "${key}"`);
    const { root, file, text, mode, branch } = a;
    if (typeof root !== 'string' || root === '' || root.length > LOG_ANCHOR_ROOT_MAX_CHARS || !isAbsolute(root) || root.includes('\0')) throw bad(`${at}: root must be an absolute path`);
    if (mode !== 'present' && mode !== 'absent') throw bad(`${at}: mode must be "present" or "absent"`);
    if (file === undefined) {
      if (mode === 'present') throw bad(`${at}: a "present" anchor needs a file`);
    } else if (typeof file !== 'string' || file === '' || file.length > LOG_ANCHOR_FILE_MAX_CHARS) {
      throw bad(`${at}: file must be 1 to ${LOG_ANCHOR_FILE_MAX_CHARS} characters`);
    } else if (UNSAFE_TEXT.test(file) || file.startsWith('/') || file.startsWith('~') || file.includes('\\') || WINDOWS_DRIVE.test(file) || file.split('/').some((part) => part === '' || part === '..')) {
      throw bad(`${at}: file must be a path inside the repository: relative, no empty part, no "..", no "~", no backslash, no drive`);
    }
    if (typeof text !== 'string' || text === '' || text.length > LOG_ANCHOR_TEXT_MAX_CHARS || UNSAFE_TEXT.test(text)) throw bad(`${at}: text must be 1 to ${LOG_ANCHOR_TEXT_MAX_CHARS} characters on one line`);
    // a text that starts with a dash could be taken for an option of git
    if (text.startsWith('-')) throw bad(`${at}: text must not start with "-"`);
    if (branch !== undefined && (typeof branch !== 'string' || !BRANCH.test(branch))) throw bad(`${at}: no valid branch`);
    return { root, ...(file === undefined ? {} : { file }), text, mode, ...(branch === undefined ? {} : { branch }) };
  });
}

interface Ran {
  /** The exit code; null when git did not run or was stopped. */
  code: number | null;
  out: string;
  why?: 'timeout' | 'missing' | 'failed' | 'flood';
}

/** One anchor's answer; `files` is the count of files a search found. */
interface Verdict {
  state: LogAnchorState['state'];
  reason: string;
  files?: number;
}

const RANK: Record<LogAnchorState['state'], number> = { ok: 0, unchecked: 1, vacuous: 2, stale: 3 };

export function createAnchorChecker(options: AnchorOptions): AnchorChecker {
  const { log } = options;
  const gitBin = options.gitBin ?? GIT_BIN;
  const gitMs = options.gitMs ?? ANCHOR_GIT_MS;
  const runMs = options.runMs ?? ANCHOR_RUN_MS;
  const gitEnv: Record<string, string> = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
  for (const key of KEEP_ENV) {
    const value = (options.env ?? process.env)[key];
    if (value !== undefined) gitEnv[key] = value;
  }
  const cache = new Map<string, { at: number; state: LogAnchorState }>();
  const running = new Map<string, Promise<LogAnchorState>>();
  // one check per root at a time: the tail of each root's queue
  const queues = new Map<string, Promise<unknown>>();
  const sig = (anchors: readonly LogAnchor[], author: string): string => JSON.stringify([author, anchors]);

  /** git with the Recorder's safe arguments and a clean environment; SIGTERM when over time, so git removes its own lock. */
  const git = (cwd: string, args: string[], cap = 64 * 1024): Promise<Ran> =>
    new Promise((resolve) => {
      execFile(gitBin, [...BASE_ARGS, ...args], { cwd, env: gitEnv, timeout: gitMs, killSignal: 'SIGTERM', maxBuffer: cap, encoding: 'utf8' }, (error, stdout) => {
        if (error === null) return resolve({ code: 0, out: stdout });
        const e = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
        if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve({ code: null, out: String(stdout), why: 'flood' });
        if (e.killed === true || e.signal != null) return resolve({ code: null, out: '', why: 'timeout' });
        if (e.code === 'ENOENT') return resolve({ code: null, out: '', why: 'missing' });
        resolve(typeof e.code === 'number' ? { code: e.code, out: String(stdout) } : { code: null, out: '', why: 'failed' });
      });
    });

  const why = (ran: Ran): string => (ran.why === 'timeout' ? 'git did not answer in time' : ran.why === 'missing' ? 'git was not found' : 'git could not check');

  /** The real top of the repository of `dir`, or null. */
  async function topOf(dir: string): Promise<string | null> {
    const ran = await git(dir, ['rev-parse', '--show-toplevel'], 4096);
    if (ran.code !== 0) return null;
    return realpath(ran.out.trim()).catch(() => null);
  }

  /** The real top levels an anchor of this author may name: the agent's own, or, for the Director, those of every hired agent. */
  async function allowed(author: string): Promise<Set<string>> {
    const names = author === 'user' ? [...new Set(options.agents())] : options.agents().includes(author) ? [author] : [];
    const tops = await Promise.all(names.map(async (name) => {
      const place = await options.place(name).catch(() => null);
      return place === null ? null : topOf(place);
    }));
    return new Set(tops.filter((top): top is string => top !== null));
  }

  /** The branch a root is on, for the stamp and the note. */
  async function branchOf(root: string): Promise<string> {
    const b = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], 1024)).out.trim();
    return BRANCH.test(b) ? b : 'HEAD';
  }

  async function validate(input: unknown, author: string): Promise<LogAnchor[]> {
    const shaped = anchorShape(input);
    if (shaped.length === 0) return [];
    const ok = await allowed(author);
    const out: LogAnchor[] = [];
    for (const [i, a] of shaped.entries()) {
      const real = await realpath(a.root).catch(() => null);
      if (real === null || !ok.has(real)) {
        throw bad(author === 'user' ? `anchor ${i + 1}: root must be the top of a git repository that an agent of this room works in` : `anchor ${i + 1}: root must be the top of your own repository; only the Director may name another`);
      }
      out.push({ ...a, root: real, branch: await branchOf(real) });
    }
    return out;
  }

  /** A tracked regular file, read through its realpath (which must be under the root's) with O_NOFOLLOW, at most 1 MiB: its text, 'missing', or a reason it was not read. */
  async function read(root: string, file: string): Promise<{ text: string } | { missing: true } | { unchecked: string }> {
    const real = await realpath(join(root, file)).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' || e.code === 'ENOTDIR' ? null : undefined));
    if (real === null) return { missing: true };
    if (real === undefined || !real.startsWith(root + sep)) return { unchecked: 'not inside the repository' };
    let handle;
    try {
      const seen = await lstat(real);
      if (!seen.isFile()) return { missing: true };
      await options.afterLstat?.(real);
      handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
      const now = await handle.stat();
      // the file that was opened must be the one that was looked at
      if (!now.isFile() || now.ino !== seen.ino || now.dev !== seen.dev) return { unchecked: 'the file changed during the check' };
      if (now.size > ANCHOR_READ_BYTES) return { unchecked: 'too large' };
      const buffer = Buffer.alloc(now.size);
      const { bytesRead } = await handle.read(buffer, 0, now.size, 0);
      return { text: buffer.subarray(0, bytesRead).toString('utf8') };
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { missing: true } : { unchecked: 'could not read the file' };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async function verdict(root: string, a: LogAnchor): Promise<Verdict> {
    if (a.file === undefined) {
      // -e <text> then --: the text can only be a pattern; -F: literal; -l -z: file names only, and only counted; tracked files only; no submodules, no textconv
      const ran = await git(root, ['grep', '-F', '-l', '-z', '--no-textconv', '--no-recurse-submodules', '-e', a.text, '--'], GREP_CAP);
      if (ran.code === 1) return { state: 'ok', reason: '' };
      if (ran.code === 0 || ran.why === 'flood') return { state: 'stale', reason: '', files: ran.code === 0 ? ran.out.split('\0').filter((f) => f !== '').length : undefined };
      return { state: 'unchecked', reason: why(ran) };
    }
    // a file that git does not list is never opened, and not looked for either: the answer must not tell what is on the disk
    const tracked = await git(root, ['ls-files', '--error-unmatch', '--', a.file], 4096);
    if (tracked.code === 1) return { state: 'unchecked', reason: 'not tracked' };
    if (tracked.code !== 0) return { state: 'unchecked', reason: why(tracked) };
    const got = await read(root, a.file);
    if ('unchecked' in got) return { state: 'unchecked', reason: got.unchecked };
    if ('missing' in got) return a.mode === 'present' ? { state: 'stale', reason: 'file not found here' } : { state: 'vacuous', reason: 'file not found here' };
    return got.text.includes(a.text) === (a.mode === 'present') ? { state: 'ok', reason: '' } : { state: 'stale', reason: '' };
  }

  /** `fn` after the checks already queued for this root. */
  function turn<T>(root: string, fn: () => Promise<T>): Promise<T> {
    const next = (queues.get(root) ?? Promise.resolve()).then(fn);
    const tail = next.catch(() => undefined);
    queues.set(root, tail);
    void tail.then(() => {
      if (queues.get(root) === tail) queues.delete(root);
    });
    return next;
  }

  async function run(anchors: readonly LogAnchor[], author: string): Promise<LogAnchorState> {
    const at = options.now();
    const ok = await allowed(author);
    const byRoot = new Map<string, LogAnchor[]>();
    for (const a of anchors) byRoot.set(a.root, [...(byRoot.get(a.root) ?? []), a]);
    let worst: Verdict = { state: 'ok', reason: '' };
    let place = '';
    let moved = false;
    for (const [root, list] of byRoot) {
      // the root may no longer be one of an agent of this room (the agent was removed, the folder moved), or never was the author's own
      if (!ok.has(root)) {
        if (RANK.unchecked > RANK[worst.state]) worst = { state: 'unchecked', reason: author === 'user' ? 'no hired agent works there' : 'not the repository of the agent that wrote the entry' };
        continue;
      }
      await turn(root, async () => {
        const now = await branchOf(root);
        const sha = (await git(root, ['rev-parse', '--short=7', 'HEAD'], 1024)).out.trim();
        const here = `${now}@${/^[0-9a-f]{7,40}$/.test(sha) ? sha : 'unknown'}`;
        for (const a of list) {
          const v = await verdict(root, a);
          if (RANK[v.state] > RANK[worst.state]) {
            worst = v;
            place = here;
            moved = a.branch !== undefined && a.branch !== now;
          } else if (worst.state === 'ok' && place === '') {
            place = here;
            moved = a.branch !== undefined && a.branch !== now;
          }
        }
      });
    }
    const where = place === '' ? '' : ` on ${place}`;
    const files = worst.files === undefined ? '' : ` (${worst.files} ${worst.files === 1 ? 'file' : 'files'})`;
    const note =
      worst.state === 'ok'
        ? `confirmed${where}`
        : worst.state === 'stale'
          ? `${worst.reason === '' ? 'not confirmed' : worst.reason}${where}${files}`
          : worst.state === 'vacuous'
            ? `check the path: ${worst.reason}${where}`
            : `unchecked: ${worst.reason}`;
    return { state: worst.state, note: moved && place !== '' ? `${note}, not the branch it was written on` : note, checkedAt: at };
  }

  return {
    validate,
    peek: (anchors, author) => cache.get(sig(anchors, author))?.state,
    check(anchors, author) {
      const key = sig(anchors, author);
      const kept = cache.get(key);
      if (kept !== undefined && options.now() - kept.at < ANCHOR_CACHE_MS) return Promise.resolve(kept.state);
      const going = running.get(key);
      if (going !== undefined) return going;
      let timer: NodeJS.Timeout | undefined;
      // the whole check ends at runMs; what git was still doing ends at its own limit
      const slow = new Promise<LogAnchorState>((resolve) => {
        timer = setTimeout(() => resolve({ state: 'unchecked', note: 'unchecked: too slow', checkedAt: options.now() }), runMs);
      });
      const next = Promise.race([run(anchors, author), slow])
        .catch((error: unknown): LogAnchorState => {
          log.warn(`an anchor check failed: ${error instanceof Error ? error.message : String(error)}`);
          return { state: 'unchecked', note: 'unchecked: the check failed', checkedAt: options.now() };
        })
        .then((state) => {
          cache.set(key, { at: options.now(), state });
          // a bounded cache: the oldest answers go first
          if (cache.size > 500) cache.delete(cache.keys().next().value as string);
          return state;
        })
        .finally(() => {
          clearTimeout(timer);
          running.delete(key);
        });
      running.set(key, next);
      return next;
    },
  };
}
