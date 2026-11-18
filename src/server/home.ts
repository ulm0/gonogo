import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { appendFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { POSITION_IDS } from '../shared/positions.js';
import { ACTIVITY_STATUSES, KEYS_MAX, MODEL_PATTERN, PERMISSION_MODES, PROVIDERS, providerInfo, RESERVED_NAMES } from '../shared/protocol.js';
import type {
  ActivityStatus,
  AgentRecord,
  Home,
  Logger,
  MessageRecord,
  PermissionMode,
  Provider,
  RosterFile,
} from '../shared/protocol.js';
import {
  AGENT_NAME_PATTERN,
  AGENTS_DIR,
  AGENTS_FILE,
  BROWSER_TOKEN_FILE,
  COMMAND_MAX_CHARS,
  DIR_MODE,
  FILE_MODE,
  LOCK_FILE,
  MESSAGES_FILE,
  MESSAGES_ROTATE_BYTES,
  MESSAGES_ROTATED_FILE,
  MESSAGES_TAIL_BYTES,
  TOKEN_BYTES,
  nullLogger,
} from './constants.js';
import { readCustomCommand } from './command.js';
import { migrateHome } from './migrate.js';
import { parseCleanRoom } from './cleanroom.js';
import { keyNameProblem } from './clearance.js';
import { parsePayload, payloadRefusal } from './payload.js';

const MODEL_RE = new RegExp(MODEL_PATTERN);
const NAME_RE = new RegExp(AGENT_NAME_PATTERN);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[0-9a-f]{64}$/i;
const MESSAGE_ID_RE = /^m(\d+)$/;
const LOCK_ATTEMPTS = 5;

/**
 * Directories this process holds a lock on. A pid in a lock file can name this very process (containers reuse pids), so
 * the file alone cannot tell "my own lock" from "the lock of a previous run that had my pid".
 */
const heldDirs = new Set<string>();

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function errCode(e: unknown): string | undefined {
  if (typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string') return e.code;
  return undefined;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function lockError(dir: string, pid: number | string): Error {
  return new Error(
    `another gonogo is using ${dir} (pid ${pid}). Stop it, or delete ${join(dir, LOCK_FILE)} if none is running.`,
  );
}

/** The pid in a lock file, or null when the content is not a positive integer. Throws ENOENT when the file is gone. */
function readLockPid(path: string): number | null {
  const m = /^\s*(\d+)\s*$/.exec(readFileSync(path, 'utf8'));
  const pid = m ? Number(m[1]) : 0;
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but belongs to someone else: still a live owner
    return errCode(e) !== 'ESRCH';
  }
}

/**
 * A home or a token that another user owns, or that group and other can still reach after the chmod, is not private: the
 * browser token and the roster would be theirs too, so the start is refused instead of carried on. A path that is not
 * there yet is skipped (whoever creates it makes it private).
 */
function requirePrivate(path: string, mode: number, what: 'directory' | 'file'): void {
  const found = statSync(path, { throwIfNoEntry: false });
  if (found === undefined) return;
  const own = 'use --home with a directory of your own';
  if (what === 'directory' ? !found.isDirectory() : !found.isFile()) throw new Error(`${path} is not a ${what}; remove it or ${own}`);
  const owner = process.getuid?.();
  if (owner !== undefined && found.uid !== owner) {
    throw new Error(`${path} belongs to another user (uid ${found.uid}); ${what === 'file' ? `delete it (a new token is made) or ${own}` : own}`);
  }
  let refused = '';
  try {
    chmodSync(path, mode);
  } catch (e) {
    refused = ` (${errMessage(e)})`;
  }
  const bits = statSync(path).mode & 0o777;
  if ((bits & 0o077) !== 0) {
    throw new Error(`${path} is open to other users (mode ${bits.toString(8)}) and chmod ${mode.toString(8)} did not close it${refused}; have its owner run chmod ${mode.toString(8)} on it, or ${own}`);
  }
}

function acquireLock(dir: string, key: string): void {
  if (heldDirs.has(key)) throw lockError(dir, process.pid);
  const path = join(dir, LOCK_FILE);
  let lastPid: number | string = '?';
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      const fd = openSync(path, 'wx', FILE_MODE);
      try {
        writeSync(fd, `${process.pid}\n`);
      } finally {
        closeSync(fd);
      }
      heldDirs.add(key);
      return;
    } catch (e) {
      if (errCode(e) !== 'EEXIST') throw e;
    }
    let pid: number | null;
    try {
      pid = readLockPid(path);
    } catch (e) {
      if (errCode(e) === 'ENOENT') continue;
      throw e;
    }
    if (pid !== null) {
      lastPid = pid;
      // heldDirs does not have this directory, so a lock naming our own pid is a leftover of an earlier run
      if (pid !== process.pid && isProcessAlive(pid)) throw lockError(dir, pid);
    }
    // shortcut: two servers that both find the same stale lock in the same millisecond can both win; use flock if that ever matters
    try {
      unlinkSync(path);
    } catch (e) {
      if (errCode(e) !== 'ENOENT') throw e;
    }
  }
  throw lockError(dir, lastPid);
}

function isPermissionMode(x: unknown): x is PermissionMode {
  return typeof x === 'string' && (PERMISSION_MODES as readonly string[]).includes(x);
}

function parseAgent(a: unknown): AgentRecord | string {
  if (!isRecord(a)) return 'not an object';
  const { name, role, dir, mode, sessionId, desk, boss, createdAt } = a;
  if (typeof name !== 'string' || !NAME_RE.test(name)) return 'invalid name';
  if ((RESERVED_NAMES as readonly string[]).includes(name)) return `${name}: a reserved name`;
  if (typeof role !== 'string') return `${name}: role must be a string`;
  if (typeof dir !== 'string') return `${name}: dir must be a string`;
  if (!isPermissionMode(mode)) return `${name}: mode must be one of ${PERMISSION_MODES.join(', ')}`;
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) return `${name}: sessionId must be a UUID`;
  if (typeof desk !== 'number' || !Number.isInteger(desk) || desk < 0) return `${name}: desk must be a non-negative integer`;
  if (typeof boss !== 'boolean') return `${name}: boss must be true or false`;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return `${name}: createdAt must be a number`;
  const record: AgentRecord = { name, role, dir, mode, sessionId, desk, boss, createdAt };
  const { position, provider, command, payload, cleanRoom } = a;
  if (position !== undefined) {
    if (typeof position !== 'string' || !POSITION_IDS.includes(position)) return `${name}: unknown position`;
    record.position = position;
  }
  if (provider !== undefined && !(PROVIDERS as readonly unknown[]).includes(provider)) {
    return `${name}: provider must be one of ${PROVIDERS.join(', ')}`;
  }
  if (provider !== undefined && provider !== 'claude') record.provider = provider as Provider;
  if (command !== undefined) {
    if (provider !== 'custom') return `${name}: only a custom agent has a command`;
    if (typeof command !== 'string' || command.length === 0 || command.length > COMMAND_MAX_CHARS) {
      return `${name}: command must be 1 to ${COMMAND_MAX_CHARS} characters`;
    }
    try {
      readCustomCommand(command);
    } catch (error) {
      return `${name}: ${error instanceof Error ? error.message : String(error)}`;
    }
    record.command = command;
  } else if (provider === 'custom') return `${name}: a custom agent needs a command`;
  if (provider === 'custom' && boss) return `${name}: the boss cannot be a custom agent`;
  if (payload !== undefined) {
    const checked = parsePayload(payload);
    if (!checked.ok) return `${name}: ${checked.error}`;
    const refused = checked.payload && payloadRefusal(record.provider, checked.payload);
    if (refused) return `${name}: ${refused.error}`;
    if (checked.payload) record.payload = checked.payload;
  }
  if (cleanRoom !== undefined) {
    const checked = parseCleanRoom(cleanRoom, record.provider);
    if (!checked.ok) return `${name}: ${checked.error}`;
    record.cleanRoom = checked.cleanRoom;
  }
  const { model, keys } = a;
  if (model !== undefined) {
    if (typeof model !== 'string' || !MODEL_RE.test(model)) return `${name}: model is not a usable name`;
    if (providerInfo(record.provider).model === null) return `${name}: ${providerInfo(record.provider).label} takes no model setting`;
    record.model = model;
  }
  if (keys !== undefined) {
    if (!isRecord(keys) || Object.keys(keys).length > KEYS_MAX) return `${name}: keys must be an object of at most ${KEYS_MAX} names`;
    const names: Record<string, number> = {};
    for (const [key, at] of Object.entries(keys)) {
      if (keyNameProblem(key) !== null || typeof at !== 'number' || !Number.isFinite(at)) return `${name}: keys holds a name or a time that is not usable`;
      names[key] = at;
    }
    if (Object.keys(names).length > 0) record.keys = names;
  }
  return record;
}

function parseRoster(text: string, path: string): RosterFile {
  const fail = (reason: string): Error => new Error(`${path} is not usable (${reason}); fix or delete this file`);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw fail('not valid JSON');
  }
  if (!isRecord(data) || data.version !== 1 || !Array.isArray(data.agents)) {
    throw fail('expected {"version":1,"agents":[...]}');
  }
  const seen = new Set<string>();
  const agents = data.agents.map((item: unknown, i: number): AgentRecord => {
    const parsed = parseAgent(item);
    if (typeof parsed === 'string') throw fail(`agent ${i + 1}: ${parsed}`);
    if (seen.has(parsed.name)) throw fail(`agent name "${parsed.name}" appears twice`);
    seen.add(parsed.name);
    return parsed;
  });
  return { version: 1, agents };
}

interface PartialLine {
  id: string;
  status: ActivityStatus;
  note: string | null;
  updatedAt: number;
}

function isStatus(x: unknown): x is ActivityStatus {
  return typeof x === 'string' && (ACTIVITY_STATUSES as readonly string[]).includes(x);
}

/** A whole record opens an entry, a four-field line updates one. Anything else is unreadable (null). */
function parseMessageLine(line: string): MessageRecord | PartialLine | null {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(o) || typeof o.id !== 'string' || !isStatus(o.status)) return null;
  const { id, status } = o;
  const note = typeof o.note === 'string' ? o.note : null;
  if (typeof o.from !== 'string') {
    return typeof o.updatedAt === 'number' && Number.isFinite(o.updatedAt) ? { id, status, note, updatedAt: o.updatedAt } : null;
  }
  const { to, body, at } = o;
  if (typeof to !== 'string' || typeof body !== 'string' || typeof at !== 'number' || !Number.isFinite(at)) return null;
  return {
    id,
    from: o.from,
    to,
    subject: typeof o.subject === 'string' ? o.subject : '',
    body,
    inReplyTo: typeof o.inReplyTo === 'string' ? o.inReplyTo : null,
    hops: typeof o.hops === 'number' && Number.isFinite(o.hops) ? o.hops : 0,
    at,
    status,
    note,
    updatedAt: typeof o.updatedAt === 'number' && Number.isFinite(o.updatedAt) ? o.updatedAt : at,
  };
}

/**
 * Whole lines inside the last `maxBytes` of a file; a line that starts before the window is dropped. null when the file
 * does not exist. Reads only the window, so start-up stays fast whatever the file size.
 */
function readTailLines(path: string, maxBytes: number): string[] | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (e) {
    if (errCode(e) === 'ENOENT') return null;
    throw e;
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    // the byte before the window tells whether the window begins on a line boundary
    const from = start > 0 ? start - 1 : 0;
    const buf = Buffer.alloc(size - from);
    let read = 0;
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, from + read);
      if (n === 0) break;
      read += n;
    }
    let begin = 0;
    if (start > 0) {
      const nl = buf.indexOf(0x0a);
      if (nl === -1 || nl >= read) return [];
      begin = nl + 1;
    }
    return buf
      .subarray(begin, read)
      .toString('utf8')
      .split('\n')
      .filter((l) => l.trim() !== '');
  } finally {
    closeSync(fd);
  }
}

export function openHome(dir: string, log: Logger = nullLogger): Home {
  const logger = log.child('home');
  const root = resolve(dir);
  const agentsRoot = join(root, AGENTS_DIR);
  const rosterPath = join(root, AGENTS_FILE);
  const messagesPath = join(root, MESSAGES_FILE);
  const rotatedPath = join(root, MESSAGES_ROTATED_FILE);
  const tokenPath = join(root, BROWSER_TOKEN_FILE);

  // a home that exists is looked at before anything is put into it
  requirePrivate(root, DIR_MODE, 'directory');
  try {
    mkdirSync(agentsRoot, { recursive: true, mode: DIR_MODE });
  } catch (e) {
    throw new Error(`cannot create ${root}: ${errMessage(e)}`);
  }
  // mkdir's mode is cut by the umask and ignored for a directory that already exists (a restore or rsync may leave 0755)
  for (const d of [root, agentsRoot]) requirePrivate(d, DIR_MODE, 'directory');

  /** Sync on purpose: inside the append chain nothing can write between the check and the rename. Never throws. */
  const rotateMessagesIfLarge = (): void => {
    // shortcut: a rename that keeps failing warns on every append; add a latch if that ever floods the log
    try {
      if (statSync(messagesPath).size > MESSAGES_ROTATE_BYTES) {
        renameSync(messagesPath, rotatedPath);
        logger.info(`${MESSAGES_FILE} was larger than ${MESSAGES_ROTATE_BYTES} bytes; moved to ${MESSAGES_ROTATED_FILE}`);
      }
    } catch (e) {
      if (errCode(e) !== 'ENOENT') logger.warn(`could not rotate ${MESSAGES_FILE}: ${errMessage(e)}`);
    }
  };

  const lockKey = realpathSync(root);
  acquireLock(root, lockKey);
  const lockPath = join(root, LOCK_FILE);
  const releaseLock = (): void => {
    try {
      if (readLockPid(lockPath) === process.pid) unlinkSync(lockPath);
    } catch (e) {
      if (errCode(e) !== 'ENOENT') logger.warn(`could not remove ${lockPath}: ${errMessage(e)}`);
    }
    heldDirs.delete(lockKey);
  };

  let browserToken: string;
  try {
    requirePrivate(tokenPath, FILE_MODE, 'file');
    let existing = '';
    try {
      existing = readFileSync(tokenPath, 'utf8').trim();
    } catch (e) {
      if (errCode(e) !== 'ENOENT') throw e;
    }
    if (TOKEN_RE.test(existing)) {
      browserToken = existing;
    } else {
      if (existing !== '') logger.warn(`${tokenPath} did not hold a 64 character hex token; replacing it`);
      browserToken = randomBytes(TOKEN_BYTES).toString('hex');
      // only this process writes it (it holds the lock), and a torn write is replaced at the next start by the check above
      writeFileSync(tokenPath, browserToken + '\n', { mode: FILE_MODE });
    }
    chmodSync(tokenPath, FILE_MODE);

    // under the lock, before any store reads a file: an upgrade is written once, and a file of a newer gonogo stops the start
    migrateHome(root, logger);
    rotateMessagesIfLarge();
  } catch (e) {
    releaseLock();
    throw e;
  }

  let rosterChain: Promise<void> = Promise.resolve();
  let messageChain: Promise<void> = Promise.resolve();
  const writtenIds = new Set<string>();
  let closing: Promise<void> | null = null;

  // shortcut: no fsync before the rename, so a power cut can lose the last save but never leaves half a file; add one if that ever hurts
  const writeRoster = async (data: string): Promise<void> => {
    const tmp = join(root, `.${AGENTS_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    try {
      await writeFile(tmp, data, { mode: FILE_MODE, flag: 'wx' });
      await rename(tmp, rosterPath);
    } catch (e) {
      await unlink(tmp).catch(() => undefined);
      throw e;
    }
  };

  const maxSeqIn = (path: string): number => {
    const lines = readTailLines(path, MESSAGES_TAIL_BYTES);
    let max = 0;
    for (const line of lines ?? []) {
      let o: unknown;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const m = isRecord(o) && typeof o.id === 'string' ? MESSAGE_ID_RE.exec(o.id) : null;
      const n = m ? Number(m[1]) : 0;
      if (Number.isSafeInteger(n) && n > max) max = n;
    }
    return max;
  };

  return {
    dir: root,
    browserToken,

    agentDir(name: string): string {
      if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error(`invalid agent name "${String(name)}"`);
      return join(agentsRoot, name);
    },

    loadRoster(): RosterFile {
      let text: string;
      try {
        text = readFileSync(rosterPath, 'utf8');
      } catch (e) {
        if (errCode(e) === 'ENOENT') return { version: 1, agents: [] };
        throw new Error(`cannot read ${rosterPath}: ${errMessage(e)}; fix or delete this file`);
      }
      return parseRoster(text, rosterPath);
    },

    saveRoster(file: RosterFile): Promise<void> {
      // serialised now: the caller may change the object before the chain gets to it
      const json = JSON.stringify(file, null, 2);
      const run = rosterChain.then(() => writeRoster(json));
      rosterChain = run.catch(() => undefined);
      return run;
    },

    appendMessage(record: MessageRecord): void {
      let line: string;
      try {
        line = writtenIds.has(record.id)
          ? JSON.stringify({ id: record.id, status: record.status, note: record.note, updatedAt: record.updatedAt })
          : JSON.stringify(record);
      } catch (e) {
        logger.error(`could not serialise message ${String(record.id)}: ${errMessage(e)}`);
        return;
      }
      writtenIds.add(record.id);
      messageChain = messageChain
        .then(() => {
          // a run adds lines for as long as it lives: the limit is checked here too, not only when the home is opened
          rotateMessagesIfLarge();
          return appendFile(messagesPath, line + '\n', { mode: FILE_MODE });
        })
        .catch((e: unknown) => logger.error(`could not append to ${MESSAGES_FILE}: ${errMessage(e)}`));
    },

    loadRecentMessages(limit: number): MessageRecord[] {
      const lines = readTailLines(messagesPath, MESSAGES_TAIL_BYTES);
      if (!lines || !(limit >= 1)) return [];
      let unreadable = 0;
      const byId = new Map<string, MessageRecord>();
      for (const line of lines) {
        const parsed = parseMessageLine(line);
        if (parsed === null) {
          unreadable += 1;
        } else if ('from' in parsed) {
          byId.set(parsed.id, parsed);
        } else {
          const current = byId.get(parsed.id);
          if (current) byId.set(parsed.id, { ...current, status: parsed.status, note: parsed.note, updatedAt: parsed.updatedAt });
        }
      }
      if (unreadable > 0) logger.warn(`${MESSAGES_FILE}: ignored ${unreadable} line(s) that could not be read`);
      return [...byId.values()].sort((a, b) => a.at - b.at).slice(-Math.floor(limit));
    },

    lastMessageSeq(): number {
      return maxSeqIn(messagesPath) || maxSeqIn(rotatedPath);
    },

    close(): Promise<void> {
      closing ??= (async () => {
        await Promise.all([rosterChain, messageChain]);
        releaseLock();
      })();
      return closing;
    },
  };
}
