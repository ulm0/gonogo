/**
 * Clearance (docs/engine-bay-spec.md): environment variables the Director sets for one agent, usually API keys.
 *
 * keys.json (mode 0600, written whole through a temporary file and a rename) holds the values: agent name to name to value.
 * The roster keeps the names and the time each was set, so the page can say "set"; a value is never sent to a browser and
 * never logged. The launcher puts an agent's keys in that agent's environment only (launcher.ts).
 *
 * shortcut: the values are stored as text (an API key has to be sent as it is), so the file is 0600 and nothing else; encrypt
 * it if the home folder is ever shared.
 */
import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { KEY_NAME_PATTERN, KEY_VALUE_PATTERN, KEYS_MAX } from '../shared/protocol.js';
import type { KeyStore, Logger } from '../shared/protocol.js';
import { FILE_MODE, KEYS_FILE, nullLogger } from './constants.js';

const NAME_RE = new RegExp(KEY_NAME_PATTERN);
const VALUE_RE = new RegExp(KEY_VALUE_PATTERN);
/** Variables that change what runs or where, or that gonogo sets itself: a key is data, so these are refused. */
const RESERVED_EXACT = new Set([
  'PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'PWD', 'TMPDIR', 'TERM', 'COLORTERM', 'IS_DEMO', 'NODE_OPTIONS', 'NODE_PATH', 'CLAUDE_CONFIG_DIR',
  // shell and interpreter start-up hooks: each runs a file or a command before the program the agent started
  'BASH_ENV', 'SHELLOPTS', 'BASHOPTS', 'PROMPT_COMMAND', 'IFS', 'PYTHONSTARTUP', 'PYTHONPATH', 'PYTHONHOME', 'RUBYOPT', 'RUBYLIB', 'PERL5OPT', 'PERL5LIB',
  'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_EXEC_PATH',
  // more programs a variable makes run: a shell's start-up file (ENV for sh, ZDOTDIR for zsh), git's ssh, proxy, editor and pager, and what many tools open as an editor or pager
  'ENV', 'ZDOTDIR', 'GIT_SSH', 'GIT_PROXY_COMMAND', 'GIT_EDITOR', 'GIT_PAGER', 'EDITOR', 'VISUAL', 'PAGER',
]);
// DOCKER_: a Clean Room's docker client runs with the agent's keys in its environment, and DOCKER_HOST would move the container to another daemon.
// shortcut: the usual start-up hooks, not every variable some program reads as a command; the Director owns the agent anyway, so extend the list when one turns up.
const RESERVED_PREFIXES = ['GONOGO_', 'LD_', 'DYLD_', 'BASH_FUNC_', 'DOCKER_', 'GIT_CONFIG_'];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A name of the right shape that gonogo reserves (it was a key before a later version reserved it, or it never could be one). */
export const keyNameReserved = (name: string): boolean => NAME_RE.test(name) && (RESERVED_EXACT.has(name) || RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix)));

/** Why this name cannot be a key, or null. */
export function keyNameProblem(name: string): string | null {
  // the name is not echoed: a value pasted in the wrong field must not come back in an error
  if (!NAME_RE.test(name)) return 'a key name uses capital letters, digits and _, starting with a letter (at most 64 characters)';
  if (RESERVED_EXACT.has(name) || RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))) return `${name} is set by gonogo or changes what runs, so it cannot be a key`;
  return null;
}

export type KeysCheck = { ok: true; patch: Record<string, string | null>; names: Record<string, number> } | { ok: false; error: string };

/**
 * The shape of a hire's or an edit's keys: name to value, and for an edit also name to null (remove). `current` is the names
 * the agent has (name to time), `names` the names it will have, new and changed ones stamped `now`. Values stay in `patch`.
 * An error names the key and says what is wrong, never what the value was.
 */
export function checkKeys(value: unknown, current: Readonly<Record<string, number>> | undefined, now: number, hire: boolean): KeysCheck {
  if (!isRecord(value)) return { ok: false, error: 'keys must be an object of names and values' };
  const entries = Object.entries(value);
  if (entries.length > KEYS_MAX) return { ok: false, error: `at most ${KEYS_MAX} keys` };
  const names: Record<string, number> = { ...current };
  const patch: Record<string, string | null> = {};
  for (const [name, item] of entries) {
    const problem = keyNameProblem(name);
    if (problem !== null) return { ok: false, error: problem };
    if (item === null && !hire) {
      delete names[name];
      patch[name] = null;
    } else if (typeof item === 'string' && VALUE_RE.test(item)) {
      names[name] = now;
      patch[name] = item;
    } else return { ok: false, error: `${name} must be text of 1 to 4096 printable characters without a space${hire ? '' : ', or null to remove it'}` };
  }
  if (Object.keys(names).length > KEYS_MAX) return { ok: false, error: `at most ${KEYS_MAX} keys` };
  return { ok: true, patch, names };
}

export interface Clearance extends KeyStore {
  load(): Promise<void>;
  /** The stored keys that load refused because their name is reserved: `agent: NAME`. Names only. */
  refused(): string[];
  close(): Promise<void>;
}

export function createClearance(options: { dir: string; log?: Logger }): Clearance {
  const log = options.log ?? nullLogger;
  const path = join(options.dir, KEYS_FILE);
  let agents = new Map<string, Record<string, string>>();
  /** `agent: NAME` for each stored key refused at load because its name is reserved now. */
  let refused: string[] = [];
  let chain: Promise<unknown> = Promise.resolve();

  /** One write after the other; a failed one rejects to its caller and does not stop the next. A change that returns the same map writes nothing. */
  const write = (change: () => Map<string, Record<string, string>>): Promise<void> => {
    const run = chain.then(async () => {
      const before = agents;
      agents = change();
      if (agents === before) return;
      const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      try {
        await writeFile(temp, JSON.stringify({ version: 1, agents: Object.fromEntries(agents) }, null, 2), { flag: 'wx', mode: FILE_MODE });
        await rename(temp, path);
      } catch (error) {
        agents = before;
        await rm(temp, { force: true }).catch(() => undefined);
        // the message of a file error holds a path, not a value
        throw new Error(`could not save the keys: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    chain = run.catch(() => undefined);
    return run;
  };

  return {
    async load() {
      let saved: unknown;
      try {
        saved = JSON.parse(await readFile(path, 'utf8'));
        if (!isRecord(saved) || saved.version !== 1 || !isRecord(saved.agents)) throw new Error('not a version 1 keys file');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        // kept aside, so that the next save cannot overwrite the keys; a SyntaxError quotes the text around the fault, which can be a key
        log.error(`${KEYS_FILE} could not be read; agents start without keys and the file is kept as ${KEYS_FILE}.bad`, error instanceof SyntaxError ? 'not valid JSON' : error);
        await rename(path, `${path}.bad`).catch(() => undefined);
        return;
      }
      for (const [agent, keys] of Object.entries((saved as { agents: Record<string, unknown> }).agents)) {
        if (!isRecord(keys)) continue;
        for (const name of Object.keys(keys)) if (keyNameReserved(name)) refused.push(`${agent}: ${name}`);
        const own = Object.fromEntries(Object.entries(keys).filter(([name, value]) => keyNameProblem(name) === null && typeof value === 'string' && VALUE_RE.test(value))) as Record<string, string>;
        if (Object.keys(own).length > 0) agents.set(agent, own);
      }
      if (refused.length > 0) log.warn(`${KEYS_FILE}: ${refused.length} stored key${refused.length === 1 ? '' : 's'} refused because the name is reserved now (the value is not given to the agent): ${refused.join(', ')}`);
    },
    refused: () => [...refused],
    values: (name) => ({ ...agents.get(name) }),
    apply: (name, patch, fresh = false) =>
      write(() => {
        const keys = { ...(fresh ? {} : agents.get(name)) };
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) delete keys[key];
          else keys[key] = value;
        }
        const empty = Object.keys(keys).length === 0;
        if (empty && !agents.has(name)) return agents;
        const next = new Map(agents);
        if (empty) next.delete(name);
        else next.set(name, keys);
        return next;
      }),
    rename: (oldName, newName) =>
      write(() => {
        const keys = agents.get(oldName);
        if (keys === undefined) return agents;
        const next = new Map(agents);
        next.delete(oldName);
        next.set(newName, keys);
        return next;
      }),
    remove: (name) =>
      write(() => {
        if (!agents.has(name)) return agents;
        const next = new Map(agents);
        next.delete(name);
        return next;
      }),
    close: () => chain.then(() => undefined),
  };
}
