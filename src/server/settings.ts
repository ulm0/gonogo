/**
 * Runtime settings (docs/runtime-settings-spec.md): eight GONOGO_* variables the Director can set from the UI, per room or for every room.
 * First value wins: room file, global file, environment, built-in default. A file is read as data: capped, only the keys listed here,
 * only strings, each value checked by the parser the environment value goes through; whatever fails is dropped with a warning.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MAX_AGENTS } from '../shared/protocol.js';
import type { Logger } from '../shared/protocol.js';
import { parseAgentCmd } from './command.js';
import { CLEAN_ROOM_IMAGE_PATTERN, MAX_HOPS_LIMIT, nullLogger } from './constants.js';

export const SETTINGS_FILE = 'runtime-settings.json';
export const GLOBAL_SETTINGS_FILE = 'runtime-settings-global.json';
export const SETTINGS_MAX_BYTES = 16 * 1024;
const VALUE_MAX_CHARS = 2000;

export type SettingKey = 'maxHops' | 'maxWorking' | 'agentCmd' | 'cleanRoomImage' | 'scrubEnv' | 'logLevel' | 'station' | 'updateCheck';
export type SettingScope = 'room' | 'global';
export type SettingSource = 'room' | 'global' | 'env' | 'default';
export type SettingApplies = 'live' | 'next-start' | 'restart';

export class SettingsError extends Error {
  constructor(
    message: string,
    readonly kind: 'bad_request' | 'not_found' | 'conflict' = 'bad_request',
  ) {
    super(message);
  }
}

interface KeyInfo {
  env: string;
  /** `both`: a room may hold its own, else the global one; `global`: only the global file. */
  scope: 'both' | 'global';
  applies: SettingApplies;
  /** Only an owner's login session may write it (the proxy tells the room who asked). */
  sensitive: boolean;
  /** The text to store, or a SettingsError with the reason. */
  check(text: string): string;
}

const IMAGE_RE = new RegExp(CLEAN_ROOM_IMAGE_PATTERN);
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];
const OFF_WORDS = ['0', 'off', 'false', 'no'];
const ON_WORDS = ['1', 'on', 'true', 'yes'];

const whole = (text: string, max: number, digits: number, what: string): number => {
  const n = new RegExp(`^\\d{1,${digits}}$`).test(text) ? Number(text) : 0;
  if (n < 1 || n > max) throw new SettingsError(`${what}: use a whole number from 1 to ${max}`);
  return n;
};

export const SETTING_KEYS: Record<SettingKey, KeyInfo> = {
  maxHops: { env: 'GONOGO_MAX_HOPS', scope: 'both', applies: 'live', sensitive: false, check: (t) => String(whole(t.trim(), MAX_HOPS_LIMIT, 4, 'max hops')) },
  // empty = Max Q off, set on purpose (a room can switch off a limit the global one sets)
  maxWorking: { env: 'GONOGO_MAX_WORKING', scope: 'both', applies: 'live', sensitive: false, check: (t) => (t.trim() === '' ? '' : String(whole(t.trim(), MAX_AGENTS, 3, 'max working'))) },
  agentCmd: {
    env: 'GONOGO_AGENT_CMD',
    scope: 'both',
    applies: 'next-start',
    sensitive: true,
    check: (t) => {
      try {
        if (parseAgentCmd(t) === null) throw new Error('give a command, or reset to use claude');
      } catch (error) {
        throw new SettingsError(error instanceof Error ? error.message.replace(/^GONOGO_AGENT_CMD: /, '') : 'not a command');
      }
      return t.trim();
    },
  },
  cleanRoomImage: {
    env: 'GONOGO_CLEANROOM_IMAGE',
    scope: 'both',
    applies: 'next-start',
    sensitive: false,
    check: (t) => {
      if (!IMAGE_RE.test(t.trim())) throw new SettingsError('not a Docker image name or id (letters, digits and . _ / : @ -, at most 200)');
      return t.trim();
    },
  },
  scrubEnv: {
    env: 'GONOGO_SCRUB_ENV',
    scope: 'both',
    applies: 'next-start',
    sensitive: true,
    check: (t) => {
      const names = t.split(',').map((n) => n.trim()).filter((n) => n !== '');
      if (!names.every((n) => /^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(n))) throw new SettingsError('names only: letters, digits and _, separated by commas (a name ending in _ is a prefix); no values');
      return names.join(',');
    },
  },
  logLevel: {
    env: 'GONOGO_LOG_LEVEL',
    scope: 'global',
    applies: 'live',
    sensitive: false,
    check: (t) => {
      if (!LOG_LEVELS.includes(t.trim().toLowerCase())) throw new SettingsError('debug, info, warn or error');
      return t.trim().toLowerCase();
    },
  },
  station: {
    env: 'GONOGO_STATION',
    scope: 'both',
    applies: 'restart',
    sensitive: false,
    check: (t) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,30}$/.test(t.trim())) throw new SettingsError('a name of 1 to 31 letters, digits, spaces, dots, dashes or underscores');
      return t.trim();
    },
  },
  updateCheck: {
    env: 'GONOGO_UPDATE_CHECK',
    scope: 'global',
    applies: 'restart',
    sensitive: false,
    check: (t) => {
      const word = t.trim().toLowerCase();
      if (![...OFF_WORDS, ...ON_WORDS].includes(word)) throw new SettingsError('on or off (1, on, true, yes, 0, off, false, no)');
      return word;
    },
  },
};

export const SETTING_NAMES = Object.keys(SETTING_KEYS) as SettingKey[];
export const isSettingKey = (name: string): name is SettingKey => Object.prototype.hasOwnProperty.call(SETTING_KEYS, name);

export interface SettingRow {
  key: SettingKey;
  env: string;
  scope: 'both' | 'global';
  applies: SettingApplies;
  sensitive: boolean;
  /** The effective text (null: nothing set anywhere, the built-in default). */
  value: string | null;
  source: SettingSource;
  /** The environment value, always the default the Reset goes back to; null when unset or refused by the parser. */
  envValue: string | null;
  room: string | null;
  global: string | null;
}

type Values = Partial<Record<SettingKey, string>>;

export interface Settings {
  view(): SettingRow[];
  row(key: SettingKey): SettingRow;
  /** The effective text, or null for the built-in default. */
  get(key: SettingKey): string | null;
  /** Stores (or with null removes) the value of one scope. Throws SettingsError. Returns the row, the old and new effective text. */
  set(key: SettingKey, scope: SettingScope, value: string | null): { row: SettingRow; before: string | null; after: string | null };
  /** Reads both files again (a global change made by another room). */
  reload(): void;
}

function readValues(path: string | null, allowed: (key: SettingKey) => boolean, log: Logger): Values {
  if (path === null) return {};
  let text: string;
  try {
    if (statSync(path).size > SETTINGS_MAX_BYTES) {
      log.warn(`${path} is over ${SETTINGS_MAX_BYTES} bytes: ignored`);
      return {};
    }
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
  const out: Values = {};
  try {
    const raw = (JSON.parse(text) as { values?: unknown }).values;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
    for (const [name, value] of Object.entries(raw)) {
      if (!isSettingKey(name) || !allowed(name) || typeof value !== 'string' || value.length > VALUE_MAX_CHARS) {
        log.warn(`${path}: ${name} is not a setting here: ignored`);
        continue;
      }
      try {
        out[name] = SETTING_KEYS[name].check(value);
      } catch (error) {
        log.warn(`${path}: ${name}: ${error instanceof Error ? error.message : 'refused'}: ignored`);
      }
    }
  } catch {
    log.warn(`${path} is not JSON: ignored`);
  }
  return out;
}

function writeValues(path: string, values: Values): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // a temporary file and a rename: a symlink planted under the final name is replaced, never written through
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ version: 1, values })}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temp, path);
}

/**
 * `roomHome`: this room's folder; `globalPath`: the file of every room (null: started by hand, no supervisor, so there is no global scope).
 * `env` is read at each call, so a test (or the shell) can change it.
 */
export function createSettings(options: { roomHome: string; globalPath: string | null; env: Record<string, string | undefined>; log?: Logger }): Settings {
  const log = options.log ?? nullLogger;
  const roomPath = join(options.roomHome, SETTINGS_FILE);
  let room: Values = {};
  let global: Values = {};
  const load = (): void => {
    room = readValues(roomPath, (k) => SETTING_KEYS[k].scope === 'both', log);
    global = readValues(options.globalPath, () => true, log);
  };
  load();

  const envOf = (key: SettingKey): string | null => {
    const raw = options.env[SETTING_KEYS[key].env];
    if (raw === undefined || raw.trim() === '') return null;
    try {
      return SETTING_KEYS[key].check(raw);
    } catch {
      return null;
    }
  };
  const effective = (key: SettingKey): { value: string | null; source: SettingSource } => {
    if (key === 'scrubEnv') {
      // the scrub list only grows: what the operator put in the environment stays scrubbed whatever the files say; the files add to it
      // the environment's list is read as the launcher reads it (split, trimmed, no check of the names): one odd name must not drop the rest
      const raw = (options.env[SETTING_KEYS[key].env] ?? '').split(',').map((n) => n.trim());
      const names = [...new Set([...raw, ...(global[key] ?? '').split(','), ...(room[key] ?? '').split(',')].filter((n) => n !== ''))];
      return { value: names.length === 0 ? null : names.join(','), source: room[key] !== undefined ? 'room' : global[key] !== undefined ? 'global' : raw.some((n) => n !== '') ? 'env' : 'default' };
    }
    const own = SETTING_KEYS[key].scope === 'both' ? room[key] : undefined;
    if (own !== undefined) return { value: own, source: 'room' };
    const shared = global[key];
    if (shared !== undefined) return { value: shared, source: 'global' };
    const env = envOf(key);
    return env !== null ? { value: env, source: 'env' } : { value: null, source: 'default' };
  };
  const row = (key: SettingKey): SettingRow => {
    const info = SETTING_KEYS[key];
    // the scrub list's fixed part is the environment's names as they are
    const envValue = key === 'scrubEnv' ? (options.env[info.env] ?? '').split(',').map((n) => n.trim()).filter((n) => n !== '').join(',') || null : envOf(key);
    return { key, env: info.env, scope: info.scope, applies: info.applies, sensitive: info.sensitive, ...effective(key), envValue, room: room[key] ?? null, global: global[key] ?? null };
  };

  return {
    view: () => SETTING_NAMES.map(row),
    row,
    get: (key) => effective(key).value,
    set(key, scope, value) {
      const info = SETTING_KEYS[key];
      if (scope === 'room' && info.scope === 'global') throw new SettingsError(`${key} is one setting for every room: change it for all rooms`);
      if (scope === 'global' && options.globalPath === null) throw new SettingsError('this server has no supervisor, so there is no setting for all rooms', 'conflict');
      const checked = value === null ? null : info.check(value.slice(0, VALUE_MAX_CHARS));
      const before = effective(key).value;
      load(); // another room may have written the global file since
      const target = scope === 'room' ? room : global;
      if (checked === null) delete target[key];
      else target[key] = checked;
      writeValues(scope === 'room' ? roomPath : (options.globalPath as string), target);
      return { row: row(key), before, after: effective(key).value };
    },
    reload: load,
  };
}

/** The program of a stored agent command and nothing after it (its arguments may hold a token): what the Black Box shows. */
export function commandProgram(text: string): string {
  try {
    const program = parseAgentCmd(text)?.[0] ?? '';
    return program.split('/').filter((part) => part !== '').pop() ?? '(none)';
  } catch {
    return '(unreadable)';
  }
}

/** One setting of the file of every room, else of the environment, for code that runs before a room exists (the supervisor, the start of a room). */
export function globalSetting(globalPath: string | null, key: SettingKey, env: Record<string, string | undefined>): string | null {
  const shared = readValues(globalPath, () => true, nullLogger)[key];
  if (shared !== undefined) return shared;
  const raw = env[SETTING_KEYS[key].env];
  if (raw === undefined || raw.trim() === '') return null;
  try {
    return SETTING_KEYS[key].check(raw);
  } catch {
    return null;
  }
}
