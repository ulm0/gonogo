/**
 * Co-author (docs/coauthor-spec.md): a commit an agent makes carries `Co-Authored-By: <name> (gonogo) <<name>@gonogo.invalid>`.
 * Nothing of the repository or of the user's git config is written: the agent's environment sets `core.hooksPath` (GIT_CONFIG_COUNT,
 * git 2.31 or newer) to a folder of gonogo's own in the agent's folder. Every hook name there is a link to one dispatcher that first
 * runs the repository's own hook of that name (found as git itself finds it, so husky and a plain .git/hooks keep working) and, for
 * prepare-commit-msg, adds the trailer with `git interpret-trailers --if-exists addIfDifferent`. A failure of ours never blocks a commit.
 */
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, readdir, readlink, rename, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { AGENT_NAME_PATTERN } from '../shared/protocol.js';
import type { Logger, CoauthorSettings } from '../shared/protocol.js';
import { COAUTHOR_FILE, FILE_MODE, GIT_BIN, nullLogger } from './constants.js';
import { HubError } from './hub.js';
import { readFile, rm } from 'node:fs/promises';

const NAME_RE = new RegExp(AGENT_NAME_PATTERN);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The 28 hook names of githooks(5). A name a newer git adds is not here (the config-hook upgrade path of the spec is the end state). */
export const GIT_HOOK_NAMES = [
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit',
  'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'pre-receive', 'update', 'proc-receive', 'post-receive', 'post-update',
  'reference-transaction', 'push-to-checkout', 'pre-auto-gc', 'post-rewrite', 'sendemail-validate', 'fsmonitor-watchman', 'p4-changelist',
  'p4-prepare-changelist', 'p4-post-changelist', 'p4-pre-submit', 'post-index-change',
] as const;
const HOOK_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
/** Always linked: a hook the repository gets after the console started (`husky`, `pre-commit install`, `lefthook install`) must not be shadowed by our hooks path. The heavy ones (reference-transaction, post-index-change) are linked only when the repository has them. */
export const ALWAYS_LINKED = ['prepare-commit-msg', 'pre-commit', 'commit-msg', 'pre-merge-commit', 'pre-push', 'pre-rebase', 'post-commit', 'post-checkout', 'post-merge', 'post-rewrite'] as const;
export const COAUTHOR_MIN_GIT = '2.31';

/** The trailer of an agent: `.invalid` is reserved (RFC 2606), so the mailbox can never be a real account. */
export const trailerOf = (name: string): string => `Co-Authored-By: ${name} (gonogo) <${name}@gonogo.invalid>`;

/** The dispatcher, with the trailer in it. `name` is checked against the agent name pattern: nothing else goes into the text. */
export function dispatchText(name: string): string {
  if (!NAME_RE.test(name)) throw new Error('not an agent name');
  return `#!/bin/sh
# gonogo: runs the repository's own hook of this name first, then adds the co-author line of this agent to a commit message.
hook=$(basename "$0")
here=$(cd "$(dirname "$0")" 2>/dev/null && pwd)
# without our own setting (the Director's own GIT_CONFIG_* entries stay): what git itself would use (husky's core.hooksPath, .git/hooks, a worktree's shared hooks)
real=$(env GIT_CONFIG_COUNT="\${GONOGO_GIT_CONFIG_COUNT:-0}" git rev-parse --git-path hooks 2>/dev/null)
if [ -n "$real" ] && [ -x "$real/$hook" ] && [ "$(cd "$real" 2>/dev/null && pwd)" != "$here" ]; then
  "$real/$hook" "$@" || exit $?
fi
if [ "$hook" = prepare-commit-msg ]; then
  case "$2" in merge|squash) exit 0 ;; esac
  # a commit that is being replayed (cherry-pick, revert, rebase, am) is somebody else's work: no line
  for marker in CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply; do
    p=$(git rev-parse --git-path "$marker" 2>/dev/null)
    if [ -n "$p" ] && [ -e "$p" ]; then exit 0; fi
  done
  # an amend or a reuse of a message keeps the author of that commit: the line only goes on the agent's own commits.
  # (with -m the source is "message" for an amend too, so the command line of git commit says it)
  target=
  if [ "$2" = commit ] && [ -n "$3" ]; then
    target=$3
  else
    cmd=$(tr '\\0' ' ' < "/proc/$PPID/cmdline" 2>/dev/null || ps -o args= -p "$PPID" 2>/dev/null)
    case " $cmd " in *" --amend"*) target=HEAD ;; esac
  fi
  if [ -n "$target" ]; then
    was=$(git log -1 --format='%an <%ae>' "$target" 2>/dev/null)
    # git hands the amended commit's author to the hook as the author, so the committer is the one that says who is working
    me=$(git var GIT_COMMITTER_IDENT 2>/dev/null | sed 's/ [0-9][0-9]* [-+][0-9][0-9]*$//')
    if [ -n "$was" ] && [ "$was" != "$me" ]; then exit 0; fi
  fi
  git interpret-trailers --in-place --if-exists addIfDifferent --trailer "${trailerOf(name)}" "$1" >/dev/null 2>&1 || true
fi
exit 0
`;
}

/**
 * Makes `<agentDir>/githooks`: the dispatcher and a link for the commit and push hooks (ALWAYS_LINKED) and for each executable hook of the
 * real hooks folder (git runs a hook of our folder only when it has the name; the links of reference-transaction and post-index-change
 * would cost a process at every ref update, so those are made only when the repository has them). A hook that is neither, and that the
 * repository gets after the console started, is not chained until its next start.
 * Idempotent; only the dispatcher and links gonogo made are touched. Returns the folder.
 */
export async function ensureHooksDir(agentDir: string, name: string, extraNames: readonly string[]): Promise<string> {
  const dir = join(agentDir, 'githooks');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const text = dispatchText(name);
  const dispatch = join(dir, 'dispatch');
  const current = await readFile(dispatch, 'utf8').catch(() => null);
  if (current !== text) {
    const temp = `${dispatch}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temp, text, { mode: 0o700, flag: 'wx' });
    await chmod(temp, 0o700);
    await rename(temp, dispatch);
  }
  const wanted = new Set<string>([...ALWAYS_LINKED, ...extraNames.filter((n) => HOOK_NAME_RE.test(n))]);
  for (const hook of wanted) {
    const link = join(dir, hook);
    const info = await lstat(link).catch(() => null);
    if (info?.isSymbolicLink() && (await readlink(link).catch(() => '')) === 'dispatch') continue;
    if (info !== null) await unlink(link).catch(() => undefined);
    await symlink('dispatch', link);
  }
  // a link of a hook the repository no longer has: gone with it (only links to the dispatcher)
  for (const entry of await readdir(dir)) {
    if (entry === 'dispatch' || wanted.has(entry)) continue;
    const link = join(dir, entry);
    if ((await readlink(link).catch(() => '')) === 'dispatch') await unlink(link).catch(() => undefined);
  }
  return dir;
}

/** The names of the executable hooks in the folder git would use for `cwd` (without our setting), so that each can be chained. */
export function realHookNames(cwd: string, env: Record<string, string | undefined>): Promise<string[]> {
  const clean: Record<string, string | undefined> = { ...env };
  clean.GIT_CONFIG_COUNT = clean.GONOGO_GIT_CONFIG_COUNT ?? clean.GIT_CONFIG_COUNT;
  return new Promise((done) => {
    // absolute whatever the git (a linked worktree's hooks are in the main repository); --path-format needs git 2.31, the same as the setting
    execFile(GIT_BIN, ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-path', 'hooks'], { env: clean as NodeJS.ProcessEnv, timeout: 10_000, encoding: 'utf8' }, (error, stdout) => {
      if (error !== null) return done([]);
      const dir = stdout.trim();
      if (dir === '') return done([]);
      const hooksDir = resolve(cwd, dir);
      readdir(hooksDir).then(
        async (names) => {
          const found: string[] = [];
          for (const entry of names) if (HOOK_NAME_RE.test(entry) && ((await stat(join(hooksDir, entry)).then((i) => i.isFile() && (i.mode & 0o111) !== 0, () => false)) as boolean)) found.push(entry);
          done(found);
        },
        () => done([]),
      );
    });
  }).then((names) => names as string[]);
}

/** The environment of an agent with the co-author line on: an existing GIT_CONFIG_COUNT is extended, never replaced. */
export function coauthorEnv(base: Record<string, string | undefined>, hooksDir: string): Record<string, string> {
  const given = Number(base.GIT_CONFIG_COUNT);
  const n = Number.isInteger(given) && given >= 0 && given < 1000 ? given : 0;
  // the Director's own count is kept for the dispatcher, which looks at git as it would be without our entry
  return { GIT_CONFIG_COUNT: String(n + 1), [`GIT_CONFIG_KEY_${n}`]: 'core.hooksPath', [`GIT_CONFIG_VALUE_${n}`]: hooksDir, GONOGO_GIT_CONFIG_COUNT: String(n) };
}

/** `git version 2.39.5` to [2, 39], or null. */
export const parseGitVersion = (text: string): [number, number] | null => {
  const m = /(\d+)\.(\d+)/.exec(text);
  return m === null ? null : [Number(m[1]), Number(m[2])];
};
export const gitHasEnvConfig = (text: string): boolean => {
  const v = parseGitVersion(text);
  return v !== null && (v[0] > 2 || (v[0] === 2 && v[1] >= 31));
};

/** One line for `gonogo doctor`. */
export function doctorLine(versionText: string | null): string {
  if (versionText === null) return `--  git  not found: agents cannot add a co-author line to their commits (needs git ${COAUTHOR_MIN_GIT} or newer)`;
  return gitHasEnvConfig(versionText) ? `ok  co-author line  ${versionText.trim()}` : `--  co-author line  ${versionText.trim()}: needs git ${COAUTHOR_MIN_GIT} or newer, so commits get no co-author line`;
}

export function gitVersion(env: Record<string, string | undefined>): Promise<string | null> {
  return new Promise((done) => {
    execFile(GIT_BIN, ['--version'], { env: env as NodeJS.ProcessEnv, timeout: 10_000, encoding: 'utf8' }, (error, stdout) => done(error === null ? stdout.trim() : null));
  });
}

export interface CoauthorStore {
  load(): Promise<void>;
  view(): CoauthorSettings;
  set(input: unknown): Promise<CoauthorSettings>;
  close(): Promise<void>;
}

/** The room's setting: `<home>/coauthor.json` `{ version: 1, enabled }`, on by default; a damaged file is kept aside and the default applies. */
export function createCoauthorStore(options: { dir: string; log?: Logger }): CoauthorStore {
  const log = options.log ?? nullLogger;
  const path = join(options.dir, COAUTHOR_FILE);
  let enabled = true;
  let chain: Promise<unknown> = Promise.resolve();
  return {
    async load() {
      try {
        const saved: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!isRecord(saved) || saved.version !== 1 || typeof saved.enabled !== 'boolean') throw new Error('not a version 1 coauthor file');
        enabled = saved.enabled;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return;
        if (code !== undefined) {
          log.error(`${COAUTHOR_FILE} could not be read; the co-author line is on`, error);
          return;
        }
        log.error(`${COAUTHOR_FILE} could not be read; the co-author line is on and the file is kept as ${COAUTHOR_FILE}.bad`, error instanceof SyntaxError ? 'not valid JSON' : error);
        await rename(path, `${path}.bad`).catch(() => undefined);
      }
    },
    view: () => ({ enabled }),
    async set(input) {
      if (!isRecord(input)) throw new HubError('bad_request', 'request body must be a JSON object');
      for (const key of Object.keys(input)) if (key !== 'enabled') throw new HubError('bad_request', `unknown field "${key}"`, key);
      if (typeof input.enabled !== 'boolean') throw new HubError('bad_request', 'enabled must be true or false', 'enabled');
      const next = input.enabled;
      const run = chain.then(async () => {
        if (next === enabled) return;
        const before = enabled;
        enabled = next;
        const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
        try {
          await writeFile(temp, JSON.stringify({ version: 1, enabled }, null, 2), { flag: 'wx', mode: FILE_MODE });
          await rename(temp, path);
        } catch (error) {
          enabled = before;
          await rm(temp, { force: true }).catch(() => undefined);
          throw new Error(`could not save the co-author setting: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
      chain = run.catch(() => undefined);
      return run.then(() => ({ enabled }));
    },
    close: () => chain.then(() => undefined),
  };
}
