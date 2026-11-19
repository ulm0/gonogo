/**
 * The Director's login (docs/login-spec.md): the account, the setup token, the sessions, the device cookie and the failure buckets, the API
 * keys, the alerts and the tamper alarm. It lives in the supervisor only (single mode); a room never sees any of it.
 *
 * Everything the account is made of is `<home>/auth.json` (0600, atomic writes). The password is argon2id from Node's crypto (scrypt when the
 * Node is older than 24.7), the sessions and API keys are stored as SHA-256 of their secret, and nothing here puts a secret in a log, an alert
 * or a return value other than the one the caller must hand to its owner once.
 */
import { createHash, createHmac, randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import * as crypto from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../shared/protocol.js';
import { nullLogger } from './constants.js';

export const AUTH_FILE = 'auth.json';
export const SETUP_TOKEN_FILE = 'setup-token';
const DIRECTOR_TOKEN_FILE = 'token';

export type HostClass = 'loopback' | 'private' | 'public';
export type KeyScope = 'read' | 'act' | 'full';
export const KEY_SCOPES: readonly KeyScope[] = ['read', 'act', 'full'];

const SETUP_TOKEN_MS = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const BACKOFF_MAX_S = 15 * 60;
const FAILURE_ALERT = { count: 20, windowMs: 10 * MINUTE };
const BUCKET_KEEP_MS = 60 * MINUTE;
const BUCKETS_MAX = 20000;
const KEY_DEFAULT_DAYS = 90;
const KEY_PREFIX = 'gnk_';
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;
const TAMPER_EVERY_MS = 5000;
const TAMPER_CHECK_MIN_MS = 1000;
/** The last use of a session is written at most this often (an API call refreshes it in memory at once). */
const SESSION_WRITE_MS = MINUTE;

/** Lifetimes: a public name is short, a loopback or private one long (spec, sessions). */
export const LIFETIME = {
  public: { idle: 2 * 60 * MINUTE, absolute: 7 * DAY },
  local: { idle: 12 * 60 * MINUTE, absolute: 30 * DAY },
} as const;

/* ------------------------------------------------------------------ hosts */

/** Loopback, private or public, from a Host header (or a bare name): an IP by its range, a name by its shape. */
export function hostClass(header: string | undefined): HostClass {
  if (header === undefined) return 'public';
  let name = header.trim().toLowerCase();
  const bracket = /^\[([^\]]*)\](?::\d+)?$/.exec(name);
  if (bracket !== null) name = bracket[1] as string;
  else if ((name.match(/:/g) ?? []).length === 1) name = name.slice(0, name.indexOf(':'));
  if (name.endsWith('.')) name = name.slice(0, -1);
  if (name === 'localhost' || name.endsWith('.localhost') || name === '::1' || /^127(\.\d{1,3}){3}$/.test(name)) return 'loopback';
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  if (v4 !== null) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) ? 'private' : 'public';
  }
  if (name.includes(':')) return /^(f[cd]|fe[89ab])/.test(name) ? 'private' : 'public';
  // a name with no dot is a LAN host name; these suffixes are never on the public DNS
  if (!name.includes('.') || /\.(local|lan|internal|home\.arpa|intranet|corp|home)$/.test(name)) return 'private';
  return 'public';
}

/** The loopback/private test for the setup screen, the plain-http cookie and the key rules. */
export const isLocalClass = (cls: HostClass): boolean => cls !== 'public';

/* ------------------------------------------------------------------ passwords */

export interface PasswordHash {
  algo: 'argon2id' | 'scrypt';
  /** argon2id: memory (KiB), passes, parallelism. scrypt: N, r, p. */
  m: number;
  t: number;
  p: number;
  salt: string;
  hash: string;
}

export interface HashCosts {
  argon2?: { memory: number; passes: number; parallelism: number };
  scrypt?: { N: number; r: number; p: number };
}

/** The OWASP Password Storage cheat-sheet's minimum for argon2id (19 MiB, 2 passes, 1 lane) and for scrypt (N=2^17, r=8, p=1). */
export const DEFAULT_COSTS: Required<HashCosts> = { argon2: { memory: 19456, passes: 2, parallelism: 1 }, scrypt: { N: 131072, r: 8, p: 1 } };

type Argon2 = (algorithm: string, params: Record<string, unknown>, callback: (error: Error | null, key: Buffer) => void) => void;
const argon2Fn = (crypto as unknown as { argon2?: Argon2 }).argon2;
export const argon2Available = typeof argon2Fn === 'function';

const TAG = 32;

function derive(algo: PasswordHash['algo'], password: string, salt: Buffer, m: number, t: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (algo === 'argon2id') {
      if (argon2Fn === undefined) return reject(new Error('argon2id is not in this Node'));
      argon2Fn('argon2id', { message: password, nonce: salt, parallelism: p, tagLength: TAG, memory: m, passes: t }, (error, key) => (error === null ? resolve(key) : reject(error)));
    } else {
      // m is N here; maxmem has to cover 128 * N * r
      scryptCb(password, salt, TAG, { N: m, r: t, p, maxmem: 128 * m * t * 2 + 1024 * 1024 }, (error, key) => (error === null ? resolve(key) : reject(error)));
    }
  });
}

export async function hashPassword(password: string, costs: HashCosts = {}, algo: PasswordHash['algo'] = argon2Available ? 'argon2id' : 'scrypt'): Promise<PasswordHash> {
  const salt = randomBytes(16);
  if (algo === 'argon2id') {
    const c = costs.argon2 ?? DEFAULT_COSTS.argon2;
    return { algo: 'argon2id', m: c.memory, t: c.passes, p: c.parallelism, salt: salt.toString('base64'), hash: (await derive('argon2id', password, salt, c.memory, c.passes, c.parallelism)).toString('base64') };
  }
  const c = costs.scrypt ?? DEFAULT_COSTS.scrypt;
  return { algo: 'scrypt', m: c.N, t: c.r, p: c.p, salt: salt.toString('base64'), hash: (await derive('scrypt', password, salt, c.N, c.r, c.p)).toString('base64') };
}

/** True when the password is the one stored; `stale` says the stored hash is not the algorithm and cost this server would make now. */
export async function verifyPassword(password: string, stored: PasswordHash, costs: HashCosts = {}): Promise<{ ok: boolean; stale: boolean }> {
  let key: Buffer;
  try {
    key = await derive(stored.algo, password, Buffer.from(stored.salt, 'base64'), stored.m, stored.t, stored.p);
  } catch {
    return { ok: false, stale: false };
  }
  const want = Buffer.from(stored.hash, 'base64');
  const ok = want.length === key.length && timingSafeEqual(want, key);
  const best = argon2Available ? 'argon2id' : 'scrypt';
  const c = costs.argon2 ?? DEFAULT_COSTS.argon2;
  const s = costs.scrypt ?? DEFAULT_COSTS.scrypt;
  const same = stored.algo === best && (best === 'argon2id' ? stored.m === c.memory && stored.t === c.passes && stored.p === c.parallelism : stored.m === s.N && stored.t === s.r && stored.p === s.p);
  return { ok, stale: ok && !same };
}

/* ------------------------------------------------------------------ the second factor */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export const TOTP_STEP_S = 30;
/** RFC 6238 with HMAC-SHA1, six digits: the code of one 30-second step. */
export function totpCode(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', secret).update(counter).digest();
  const at = (mac[mac.length - 1] as number) & 0x0f;
  const binary = (((mac[at] as number) & 0x7f) << 24) | (((mac[at + 1] as number) & 0xff) << 16) | (((mac[at + 2] as number) & 0xff) << 8) | ((mac[at + 3] as number) & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}
/** The step a code is valid for, one step either side of now and after `lastStep` (a code works once), or null. */
export function matchTotp(secret: Buffer, code: string, nowMs: number, lastStep: number): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const center = Math.floor(nowMs / 1000 / TOTP_STEP_S);
  let found: number | null = null;
  // all three are compared, so the time taken does not say which one matched
  for (const step of [center - 1, center, center + 1]) if (safeEqualText(totpCode(secret, step), code) && step > lastStep && (found === null || step > found)) found = step;
  return found;
}
function safeEqualText(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Ten characters from an alphabet with nothing to mistake for another (no 0, O, 1, I, L). */
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const RECOVERY_COUNT = 10;
const recoveryCode = (): string => Array.from({ length: 10 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join('');
/** What a person types (spaces, dashes and case do not matter), as stored. */
const recoveryKey = (text: string): string => createHash('sha256').update(text.replace(/[\s-]/g, '').toUpperCase(), 'utf8').digest('hex');
export const STEP_UP_MS = 5 * 60 * 1000;
const PENDING_MS = 5 * 60 * 1000;

/* ------------------------------------------------------------------ the file */

export interface Session {
  /** SHA-256 (hex) of the cookie value. */
  id: string;
  created: number;
  last: number;
  address: string;
  agent: string;
  device: string;
  cls: 'public' | 'local';
  /** When the password (and the second factor) was last checked for this session: step-up asks again after 5 minutes. */
  step: number;
}
/** A passkey (WebAuthn credential): the public key only, and the rp id it was made for, fixed at its registration. */
export interface Passkey {
  /** The credential id (base64url): the browser names the passkey with it. */
  id: string;
  /** The COSE public key (base64url). */
  publicKey: string;
  counter: number;
  transports: string[];
  name: string;
  rpId: string;
  created: number;
  last: number | null;
  backedUp: boolean;
}
export interface Device {
  id: string;
  created: number;
  last: number;
  address: string;
  agent: string;
}
export interface ApiKey {
  /** SHA-256 (hex) of the key. */
  id: string;
  name: string;
  scope: KeyScope;
  remote: boolean;
  created: number;
  expires: number;
  last: number | null;
  lastAddress: string | null;
}
interface AuthFile {
  version: 1;
  user: string;
  password: PasswordHash | null;
  sessions: Session[];
  devices: Device[];
  keys: ApiKey[];
  serverKey: string;
  /** Set once an account has existed: kept by a reset, so "no account" after a reset never brings the old token back. */
  tombstone: { created: number } | null;
  /** The second factor: a TOTP secret (base64url), switched on by a first valid code, and the last step accepted (a code works once). */
  totp: { secret: string; enabled: boolean; lastStep: number } | null;
  /** SHA-256 (hex) of the recovery codes not yet used. */
  recovery: string[];
  passkeys: Passkey[];
  /** Top-level fields this version does not know (a newer gonogo wrote them): kept and written back, so a rollback and a return lose nothing. */
  extra: Record<string, unknown>;
}

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const rand = (bytes = 32): string => randomBytes(bytes).toString('base64url');
const safeEqual = (a: string, b: string): boolean => {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const num = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const str = (value: unknown): value is string => typeof value === 'string';

function parseHash(value: unknown): PasswordHash | null | undefined {
  if (value === null) return null;
  if (!isObject(value)) return undefined;
  if ((value.algo !== 'argon2id' && value.algo !== 'scrypt') || !num(value.m) || !num(value.t) || !num(value.p) || !str(value.salt) || !str(value.hash)) return undefined;
  // the parameters of a file are the file's word, and they decide how much memory and time one login takes: a planted hash must not be able to make it enormous
  const whole = (n: number, low: number, high: number): boolean => Number.isInteger(n) && n >= low && n <= high;
  if (value.algo === 'argon2id' ? !(whole(value.p, 1, 16) && whole(value.m, 8 * value.p, 1_048_576) && whole(value.t, 1, 12)) : !(whole(value.m, 2, 1_048_576) && (value.m & (value.m - 1)) === 0 && whole(value.t, 1, 16) && whole(value.p, 1, 16))) return undefined;
  return { algo: value.algo, m: value.m, t: value.t, p: value.p, salt: value.salt, hash: value.hash };
}

/** The file as the server knows it, or undefined when it is not one (a wrong shape is damage, as for every store). */
function parseAuth(text: string): AuthFile | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(raw) || raw.version !== 1 || !str(raw.user) || !str(raw.serverKey) || !Array.isArray(raw.sessions) || !Array.isArray(raw.devices) || !Array.isArray(raw.keys)) return undefined;
  const password = parseHash(raw.password);
  if (password === undefined) return undefined;
  const sessions: Session[] = [];
  for (const s of raw.sessions) {
    if (!isObject(s) || !str(s.id) || !num(s.created) || !num(s.last) || !str(s.address) || !str(s.agent) || !str(s.device) || (s.cls !== 'public' && s.cls !== 'local')) return undefined;
    sessions.push({ id: s.id, created: s.created, last: s.last, address: s.address, agent: s.agent, device: s.device, cls: s.cls, step: num(s.step) ? s.step : s.created });
  }
  const devices: Device[] = [];
  for (const d of raw.devices) {
    if (!isObject(d) || !str(d.id) || !num(d.created) || !num(d.last) || !str(d.address) || !str(d.agent)) return undefined;
    devices.push({ id: d.id, created: d.created, last: d.last, address: d.address, agent: d.agent });
  }
  const keys: ApiKey[] = [];
  for (const k of raw.keys) {
    if (!isObject(k) || !str(k.id) || !str(k.name) || !KEY_SCOPES.includes(k.scope as KeyScope) || typeof k.remote !== 'boolean' || !num(k.created) || !num(k.expires) || (k.last !== null && !num(k.last)) || (k.lastAddress !== null && !str(k.lastAddress))) return undefined;
    keys.push({ id: k.id, name: k.name, scope: k.scope as KeyScope, remote: k.remote, created: k.created, expires: k.expires, last: k.last as number | null, lastAddress: k.lastAddress as string | null });
  }
  let tombstone: AuthFile['tombstone'] = null;
  if (isObject(raw.tombstone) && num(raw.tombstone.created)) tombstone = { created: raw.tombstone.created };
  let totp: AuthFile['totp'] = null;
  if (isObject(raw.totp)) {
    if (!str(raw.totp.secret) || typeof raw.totp.enabled !== 'boolean' || !num(raw.totp.lastStep)) return undefined;
    totp = { secret: raw.totp.secret, enabled: raw.totp.enabled, lastStep: raw.totp.lastStep };
  }
  const recovery: string[] = [];
  if (Array.isArray(raw.recovery)) {
    for (const code of raw.recovery) {
      if (!str(code)) return undefined;
      recovery.push(code);
    }
  }
  const passkeys: Passkey[] = [];
  if (Array.isArray(raw.passkeys)) {
    for (const p of raw.passkeys) {
      if (!isObject(p) || !str(p.id) || !str(p.publicKey) || !num(p.counter) || !Array.isArray(p.transports) || !p.transports.every(str) || !str(p.name) || !str(p.rpId) || !num(p.created) || (p.last !== null && !num(p.last)) || typeof p.backedUp !== 'boolean') return undefined;
      // the sizes of a file are the file's word: a credential id is at most 1023 bytes, a key a few hundred
      if (p.id.length > 1400 || p.publicKey.length > 4000 || p.name.length > 80 || p.rpId.length > 253 || p.counter < 0) return undefined;
      passkeys.push({ id: p.id, publicKey: p.publicKey, counter: p.counter, transports: p.transports.slice(0, 8), name: p.name, rpId: p.rpId, created: p.created, last: p.last as number | null, backedUp: p.backedUp });
    }
  }
  const KNOWN = ['version', 'user', 'password', 'sessions', 'devices', 'keys', 'serverKey', 'tombstone', 'totp', 'recovery', 'passkeys', 'reset'];
  const extra = Object.fromEntries(Object.entries(raw).filter(([key]) => !KNOWN.includes(key)));
  return { version: 1, user: raw.user, password, sessions, devices, keys, serverKey: raw.serverKey, tombstone, totp, recovery, passkeys, extra };
}

const empty = (tombstone: AuthFile['tombstone']): AuthFile => ({ version: 1, user: 'director', password: null, sessions: [], devices: [], keys: [], serverKey: rand(), tombstone, totp: null, recovery: [], passkeys: [], extra: {} });

function writeAtomic(path: string, text: string): void {
  const temp = `${path}.${process.pid}.tmp`;
  rmSync(temp, { force: true });
  writeFileSync(temp, text, { mode: 0o600, flag: 'wx' });
  renameSync(temp, path);
}

/** A reset-labelled file is the one outside write allowed (`gonogo auth reset`): it says nothing but the label and the tombstone. */
function isResetFile(text: string): boolean {
  try {
    const raw: unknown = JSON.parse(text);
    return isObject(raw) && raw.reset === true;
  } catch {
    return false;
  }
}

/**
 * `gonogo auth reset`, offline or against a running server: the account is emptied, the setup token is made again (and not printed), the old
 * Director token stays dead. The server notices the changed file and does the rest (alert, every session and key ends).
 */
export function resetAuthFiles(home: string, now = Date.now()): string {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = join(home, AUTH_FILE);
  let created = now;
  try {
    const old = parseAuth(readFileSync(path, 'utf8'));
    if (old?.tombstone) created = old.tombstone.created;
  } catch {
    // none, or damaged: the tombstone is made now, which is what "an account may have existed" means
  }
  writeAtomic(path, `${JSON.stringify({ reset: true, version: 1, tombstone: { created } })}\n`);
  rmSync(join(home, DIRECTOR_TOKEN_FILE), { force: true });
  writeSetupToken(home);
  return `the account was reset: login is off until a new one is set up. The setup token is in ${join(home, SETUP_TOKEN_FILE)} (mode 0600, valid 1 hour, once); it is not printed.`;
}

/** What `auth.json` says without opening a store: a fresh install has none; an account or a reset leaves its mark. */
export function authStateOf(home: string): AccountState {
  let text: string;
  try {
    text = readFileSync(join(home, AUTH_FILE), 'utf8');
  } catch {
    return 'fresh';
  }
  if (isResetFile(text)) return 'none';
  const parsed = parseAuth(text);
  if (parsed === undefined) return 'damaged';
  return parsed.password !== null ? 'account' : parsed.tombstone !== null ? 'none' : 'fresh';
}

function writeSetupToken(home: string): string {
  const path = join(home, SETUP_TOKEN_FILE);
  const token = randomBytes(32).toString('hex');
  writeAtomic(path, `${token}\n`);
  return token;
}

/* ------------------------------------------------------------------ the store */

export interface AuthOptions {
  home: string;
  /** The Downlink `redline` event and Relay: a text with the address and device, never a secret. */
  alert: (text: string) => void;
  log?: Logger;
  now?: () => number;
  costs?: HashCosts;
  /** The tamper timer (ms); 0 turns the timer off (tests call `checkTamper()` themselves). */
  tamperEveryMs?: number;
}

export type AccountState = 'fresh' | 'none' | 'account' | 'damaged';

export interface Who {
  address: string;
  agent: string;
  /** The Host header's class: decides the cookie, the lifetime, setup and the key rule. */
  cls: HostClass;
  /** The `gonogo-device` cookie value, when the request had one. */
  device?: string;
}

export type LoginResult =
  | { ok: true; session: string; device: string; user: string; newDevice: boolean }
  /** The password was right and a second factor is on: the code goes with this single-use, five-minute token. */
  | { ok: false; reason: 'second'; pending: string }
  | { ok: false; reason: 'wrong' | 'wait' | 'locked' | 'off' | 'damaged' | 'weak' | 'setup' | 'needmfa'; retryAfter?: number };

interface Bucket {
  fails: number;
  until: number;
  last: number;
}

export interface AuthStore {
  state(): AccountState;
  /** The user name. */
  user(): string;
  /** A token on TCP is accepted only on a fresh install; this is the old Director token's say in it. */
  tokenAllowed(): boolean;
  /** Setup: the account is made from the setup token (or, until it exists, the old Director token). */
  setup(who: Who, input: { token: string; user: string; password: string }, legacyToken: string | null): Promise<LoginResult>;
  login(who: Who, input: { user: string; password: string }): Promise<LoginResult>;
  /** The session a cookie value names, refreshed; null when it is none, expired or revoked. */
  session(cookie: string | undefined, who: Who, touch?: 'api' | 'input' | 'none'): Session | null;
  /** The second factor: the second step of a login that said 'second'. */
  second(who: Who, pending: string, code: string): Promise<LoginResult>;
  mfa(): { enabled: boolean; pending: boolean; recoveryLeft: number };
  /** Makes a secret (not on yet) and returns it for the authenticator: the text, and the otpauth URI. */
  mfaBegin(): { secret: string; uri: string };
  /** The first valid code switches it on, and makes the ten recovery codes, returned once. */
  mfaEnable(sessionId: string, who: Who, code: string): { ok: true; recovery: string[] } | { ok: false; reason: 'wrong' | 'none' | 'wait' };
  /** Needs the password and a current code (or a recovery code). */
  mfaDisable(sessionId: string, who: Who, input: { password: string; code: string }): Promise<'ok' | 'wrong' | 'wait'>;
  mfaRecovery(sessionId: string, who: Who, input: { password: string; code: string }): Promise<{ ok: true; recovery: string[] } | { ok: false; reason: 'wrong' | 'wait' | 'none' }>;
  /** True while the session's password check is under five minutes old. */
  stepFresh(sessionId: string): boolean;
  /** Asks the password (and the code when a second factor is on) again; answers a new cookie value: the id is minted again. */
  stepUp(sessionId: string, who: Who, input: { password: string; code: string }): Promise<{ ok: true; session: string } | { ok: false; reason: 'wrong' | 'wait' | 'gone' }>;
  /** The passkeys (credentials) of the account, newest last. */
  passkeys(): Passkey[];
  passkeyAdd(sessionId: string, who: Who, input: { id: string; publicKey: string; counter: number; transports: string[]; name: string; rpId: string; backedUp: boolean }): boolean;
  /** Takes a passkey off the list: asks the password and a code (or a recovery code), as turning TOTP off does. */
  passkeyRemove(sessionId: string, who: Who, short: string, input: { password: string; code: string }): Promise<'ok' | 'wrong' | 'wait' | 'none'>;
  /** The same, when a passkey assertion that verified stands for both (the caller checked it). */
  passkeyRemoveConfirmed(short: string, credentialId: string, counter: number): boolean;
  /** Whether a first passkey may be made: there has to be a second way in that does not depend on the name. */
  passkeysMayStart(): boolean;
  /** A passkey assertion that was verified: the counter moves, and a session starts (a passkey is both factors; no waits, as a passkey cannot be guessed). */
  passkeyLogin(who: Who, credentialId: string, counter: number): LoginResult;
  /** The same for step-up: the session's id is minted again. */
  passkeyStepUp(sessionId: string, credentialId: string, counter: number): { ok: true; session: string } | { ok: false; reason: 'gone' };
  /** A counter that did not go up: a copy of the passkey may exist. */
  passkeyCounterAlert(credentialId: string): void;
  /** Called when a session's id is minted again: its sockets move to the new one. */
  onReminted(listener: (from: string, to: string) => void): void;
  /** The key a Bearer value names (refused on a public Host unless made with --remote), or null. */
  key(secret: string, who: Who): ApiKey | null;
  deviceOf(cookie: string | undefined): Device | null;
  /** Input to a console counts as use of the session (written at most once a minute). */
  touchSession(id: string): void;
  /** True while the session exists and has not expired (no refresh): the check a WebSocket makes every minute. */
  alive(id: string): boolean;
  logout(sessionId: string): void;
  revoke(id: string): boolean;
  logoutEverywhere(exceptId?: string): number;
  changePassword(sessionId: string, current: string, next: string): Promise<'ok' | 'wrong' | 'weak' | 'wait'>;
  sessions(): Array<Omit<Session, 'id'> & { id: string; short: string }>;
  devices(): Device[];
  keys(): Array<ApiKey & { short: string }>;
  addKey(name: string, scope: KeyScope, days: number | null, remote: boolean): { secret: string; key: ApiKey };
  revokeKey(short: string): boolean;
  /** Tamper alarm: true while remote logins are refused until the Director confirms. */
  locked(): boolean;
  confirm(who: Who, password: string): Promise<'ok' | 'wrong' | 'wait' | 'none'>;
  checkTamper(force?: boolean): void;
  /** Called with the ids of sessions that ended (revoke, logout, password change, expiry, reset, tamper): sockets bound to them close. */
  onEnded(listener: (ids: string[]) => void): void;
  /** Called when the account has been made: a socket opened with the old browser token (bound to nothing) must not outlive it. */
  onAccountMade(listener: () => void): void;
  /** The cookie of a session or device is signed with this. */
  signDevice(id: string): string;
  /** A keyed hash of a text (HMAC-SHA-256 with the server key, base64url): for tokens that need no memory. */
  mac(text: string): string;
  setupTokenFile(): string;
  /** Makes the setup token when there is no account and none valid; returns it only when it was just made. */
  ensureSetupToken(): string | null;
  expiredSweep(): void;
  close(): void;
}

export function openAuth(options: AuthOptions): AuthStore {
  const log = options.log ?? nullLogger;
  const now = options.now ?? Date.now;
  const path = join(options.home, AUTH_FILE);
  mkdirSync(options.home, { recursive: true, mode: 0o700 });

  let data: AuthFile;
  let damaged = false;
  /** SHA-256 of the file as this server last wrote it. */
  let written = '';
  let lastCheck = 0;
  let isLocked = false;
  let settingUp = false;
  let serverKey = '';
  const ended: Array<(ids: string[]) => void> = [];
  const madeListeners: Array<() => void> = [];
  const buckets = new Map<string, Bucket>();
  const failures: number[] = [];
  let failureAlerted = 0;
  const lastWrite = new Map<string, number>();
  /** A login whose password was right and which waits for the second factor: id -> who and when. */
  const pending = new Map<string, { at: number; address: string; device: string | null; tries: number }>();
  const reminted: Array<(from: string, to: string) => void> = [];

  const fileText = (): string | null => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  };

  let inGuard = false;
  const save = (): void => {
    // a file that changed since this server wrote it (a reset, an outside edit) is looked at before it is written over, or the change would be lost unseen
    if (!inGuard && written !== '') {
      const on = fileText();
      if (on === null || sha(on) !== written) checkTamper(true);
    }
    const { extra, ...known } = data;
    // what this version does not know goes back as it was; what it does know wins
    const text = `${JSON.stringify({ ...extra, ...known })}\n`;
    try {
      writeAtomic(path, text);
      written = sha(text);
      chmodSync(path, 0o600);
    } catch (error) {
      log.error('auth.json could not be written', error);
    }
  };

  const emitEnded = (ids: string[]): void => {
    if (ids.length === 0) return;
    for (const listener of ended) {
      try {
        listener(ids);
      } catch (error) {
        log.error('session end listener failed', error);
      }
    }
  };

  const load = (): void => {
    const text = fileText();
    if (text === null) {
      data = empty(null);
      serverKey = data.serverKey;
      written = '';
      return;
    }
    if (isResetFile(text)) {
      // a reset made while the server was stopped: the empty account, and the alert once the server is up
      const parsed = JSON.parse(text) as { tombstone?: { created?: number } };
      data = empty({ created: num(parsed.tombstone?.created) ? parsed.tombstone.created : now() });
      serverKey = data.serverKey;
      save();
      options.alert('gonogo auth reset: the account was emptied; every session and key ended');
      return;
    }
    const parsed = parseAuth(text);
    if (parsed === undefined) {
      damaged = true;
      try {
        writeAtomic(`${path}.bad`, text);
      } catch {
        // the damaged file stays where it is
      }
      data = empty({ created: now() });
      serverKey = data.serverKey;
      written = sha(text);
      log.error('auth.json is damaged: page logins are refused until `gonogo auth reset`; a copy is auth.json.bad');
      return;
    }
    data = parsed;
    serverKey = parsed.serverKey;
    written = sha(text);
  };
  load();

  const state = (): AccountState => (damaged ? 'damaged' : data.password !== null ? 'account' : data.tombstone !== null ? 'none' : 'fresh');

  const sign = (id: string): string => `${id}.${createHmac('sha256', serverKey).update(id).digest('base64url')}`;
  const unsign = (cookie: string | undefined): string | null => {
    if (cookie === undefined) return null;
    const dot = cookie.indexOf('.');
    if (dot < 1) return null;
    const id = cookie.slice(0, dot);
    const want = sign(id);
    return safeEqual(cookie, want) ? id : null;
  };
  const deviceOf = (cookie: string | undefined): Device | null => {
    const id = unsign(cookie);
    return id === null ? null : (data.devices.find((d) => d.id === id) ?? null);
  };

  /* ---- failure buckets (R6) ---- */

  const prune = (): void => {
    const t = now();
    for (const [key, bucket] of buckets) if (t - bucket.last > BUCKET_KEEP_MS && t >= bucket.until) buckets.delete(key);
    if (buckets.size > BUCKETS_MAX) for (const key of [...buckets.keys()].slice(0, buckets.size - BUCKETS_MAX)) buckets.delete(key);
  };
  const bucketsFor = (who: Who, device: Device | null): string[] => (device === null ? [`addr:${who.address}`, 'unknown'] : [`dev:${device.id}`]);
  const wait = (keys: string[]): number => {
    let seconds = 0;
    for (const key of keys) {
      const b = buckets.get(key);
      if (b !== undefined && b.until > now()) seconds = Math.max(seconds, Math.ceil((b.until - now()) / 1000));
    }
    return seconds;
  };
  /** A failed try from a device gonogo does not know, answered or turned away by the wait: twenty in ten minutes is an alert (once per window). */
  const tally = (who: Who, device: Device | null): void => {
    if (device !== null) return;
    const t = now();
    failures.push(t);
    while (failures.length > 0 && (failures[0] as number) < t - FAILURE_ALERT.windowMs) failures.shift();
    if (failures.length >= FAILURE_ALERT.count && t - failureAlerted > FAILURE_ALERT.windowMs) {
      failureAlerted = t;
      options.alert(`${failures.length} failed logins in 10 minutes from devices gonogo does not know (last from ${who.address})`);
    }
  };
  const fail = (keys: string[], who: Who, device: Device | null): void => {
    const t = now();
    for (const key of keys) {
      const b = buckets.get(key) ?? { fails: 0, until: 0, last: t };
      b.fails += 1;
      b.last = t;
      b.until = t + Math.min(BACKOFF_MAX_S, 2 ** (b.fails - 1)) * 1000;
      buckets.set(key, b);
    }
    tally(who, device);
    prune();
  };
  const succeed = (keys: string[]): void => {
    for (const key of keys) if (key !== 'unknown') buckets.delete(key);
  };

  /* ---- passwords ---- */

  let dummy: Promise<PasswordHash> | null = null;
  const dummyHash = (): Promise<PasswordHash> => (dummy ??= hashPassword(rand(), options.costs));
  const checkPassword = async (password: string): Promise<boolean> => {
    // a wrong name hashes a dummy password, and a missing account too, so the answer and its time are the same
    const stored = data.password ?? (await dummyHash());
    const { ok, stale } = await verifyPassword(password, stored, options.costs);
    if (ok && data.password !== null && stale) {
      data.password = await hashPassword(password, options.costs);
      save();
    }
    return ok && data.password !== null;
  };

  const startSession = (who: Who, device: Device): { session: string; sessionRow: Session } => {
    const session = rand();
    const row: Session = { id: sha(session), created: now(), last: now(), address: who.address, agent: who.agent.slice(0, 200), device: device.id, cls: isLocalClass(who.cls) ? 'local' : 'public', step: now() };
    data.sessions.push(row);
    return { session, sessionRow: row };
  };
  const knownOrNewDevice = (who: Who): { device: Device; fresh: boolean } => {
    const known = deviceOf(who.device);
    if (known !== null) {
      known.last = now();
      known.address = who.address;
      return { device: known, fresh: false };
    }
    const device: Device = { id: randomBytes(16).toString('hex'), created: now(), last: now(), address: who.address, agent: who.agent.slice(0, 200) };
    data.devices.push(device);
    if (data.devices.length > 50) data.devices.splice(0, data.devices.length - 50);
    return { device, fresh: true };
  };

  /* ---- sessions ---- */

  const expired = (s: Session, t: number): boolean => {
    const life = LIFETIME[s.cls];
    return t - s.last > life.idle || t - s.created > life.absolute;
  };
  const drop = (ids: string[]): void => {
    if (ids.length === 0) return;
    const set = new Set(ids);
    data.sessions = data.sessions.filter((s) => !set.has(s.id));
    save();
    emitEnded(ids);
  };
  const expiredSweep = (): void => {
    const t = now();
    drop(data.sessions.filter((s) => expired(s, t)).map((s) => s.id));
    const gone = data.keys.filter((k) => k.expires <= t);
    if (gone.length > 0) {
      data.keys = data.keys.filter((k) => k.expires > t);
      save();
      emitEnded(gone.map((k) => `key:${k.id}`));
    }
  };

  /* ---- tamper alarm ---- */

  /** One look at a time: what the look itself writes (the file made again, the account emptied) is not looked at again. */
  const checkTamper = (force = false): void => {
    if (inGuard) return;
    inGuard = true;
    try {
      checkTamperOnce(force);
    } finally {
      inGuard = false;
    }
  };
  const checkTamperOnce = (force: boolean): void => {
    const t = now();
    if (!force && t - lastCheck < TAMPER_CHECK_MIN_MS) return;
    lastCheck = t;
    const text = fileText();
    if (text === null) {
      // the file was removed: remade from memory, and the same alarm
      if (written === '') return;
      tamper('auth.json was removed outside gonogo');
      return;
    }
    if (sha(text) === written) return;
    if (isResetFile(text)) {
      const parsed = JSON.parse(text) as { tombstone?: { created?: number } };
      const ids = [...data.sessions.map((s) => s.id), ...data.keys.map((k) => `key:${k.id}`)];
      data = empty({ created: num(parsed.tombstone?.created) ? parsed.tombstone.created : (data.tombstone?.created ?? t) });
      serverKey = data.serverKey;
      damaged = false;
      isLocked = false;
      buckets.clear();
      save();
      emitEnded(ids);
      options.alert('gonogo auth reset: the account was emptied; every session and key ended; login is off until setup');
      return;
    }
    tamper('auth.json changed outside gonogo');
  };

  const tamper = (what: string): void => {
    // the in-memory record is the truth: the file is written back from it. Whatever the outside write added (a session, a key, a device, a password, a
    // server key) was never loaded, so it is gone; what gonogo made is kept. Only the Director's password and second factor, checked against this
    // record, lift the pause on remote logins.
    isLocked = true;
    save();
    options.alert(`${what}: sessions, API keys and devices gonogo did not make are gone; remote logins are refused until the Director confirms on this machine`);
  };

  /** Makes the setup token when there is no account and none is valid; the token itself is returned only when it was just made. */
  function ensureSetupToken(): string | null {
    if (state() === 'account' || state() === 'damaged') return null;
    const file = join(options.home, SETUP_TOKEN_FILE);
    try {
      const age = now() - statSync(file).mtimeMs;
      if (age < SETUP_TOKEN_MS && /^[0-9a-f]{64}$/.test(readFileSync(file, 'utf8').trim())) return null;
    } catch {
      // none yet
    }
    return writeSetupToken(options.home);
  }

  let timer: NodeJS.Timeout | null = null;
  const every = options.tamperEveryMs ?? TAMPER_EVERY_MS;
  if (every > 0) {
    timer = setInterval(() => {
      checkTamper(true);
      expiredSweep();
      // an hour-old setup token is renewed in its file (not printed), so the setup page is never stuck on a token nobody has
      ensureSetupToken();
    }, every);
    timer.unref();
  }

  /* ---- the store ---- */

  const refused = (reason: Exclude<Extract<LoginResult, { ok: false }>['reason'], 'second'>, retryAfter?: number): LoginResult => ({ ok: false, reason, ...(retryAfter === undefined ? {} : { retryAfter }) });

  /** A TOTP code of the current step or a recovery code; a code is used once. The failure counts in the buckets the caller passes (R6). */
  const verifySecond = (code: string): boolean => {
    const text = code.trim();
    const totp = data.totp;
    // nothing is a second factor while none is on: a recovery code left in the file by an earlier one is not
    if (totp === null || !totp.enabled) return false;
    const step = matchTotp(Buffer.from(totp.secret, 'base64url'), text.replace(/\s/g, ''), now(), totp.lastStep);
    if (step !== null) {
      totp.lastStep = step;
      save();
      return true;
    }
    if (/^[A-Za-z0-9 -]{10,14}$/.test(text) && !/^\d{6}$/.test(text)) {
      const key = recoveryKey(text);
      const at = data.recovery.findIndex((k) => timingSafeEqual(Buffer.from(k, 'hex'), Buffer.from(key, 'hex')));
      if (at >= 0) {
        data.recovery.splice(at, 1);
        save();
        options.alert(`a recovery code was used (${data.recovery.length} left)`);
        return true;
      }
    }
    return false;
  };

  /** Mints the id of a session again: whatever knew the old cookie value is of no use. */
  const remint = (found: Session): string => {
    const cookie = rand();
    const next: Session = { ...found, id: sha(cookie), step: now(), last: now() };
    data.sessions = data.sessions.map((x) => (x === found ? next : x));
    save();
    for (const listener of reminted) listener(found.id, next.id);
    return cookie;
  };

  const finish = (who: Who, alertNew: boolean): LoginResult => {
    const { device, fresh } = knownOrNewDevice(who);
    const { session } = startSession(who, device);
    save();
    if (fresh && alertNew) options.alert(`first login from a new device (${who.address}, ${who.agent.slice(0, 80) || 'unknown browser'})`);
    return { ok: true, session, device: sign(device.id), user: data.user, newDevice: fresh };
  };

  const validUser = (user: string): boolean => /^[\w.@ -]{1,64}$/.test(user);

  return {
    state,
    user: () => data.user,
    tokenAllowed: () => state() === 'fresh',
    setupTokenFile: () => join(options.home, SETUP_TOKEN_FILE),
    signDevice: sign,
    mac: (text) => createHmac('sha256', serverKey).update(text).digest('base64url'),
    deviceOf,
    touchSession(id) {
      const found = data.sessions.find((s) => s.id === id);
      const t = now();
      if (found === undefined || t - found.last < MINUTE) return;
      found.last = t;
      save();
    },
    alive(id) {
      checkTamper();
      // a socket opened by a key: alive while the key is
      if (id.startsWith('key:')) return data.keys.some((k) => k.id === id.slice(4) && k.expires > now());
      const found = data.sessions.find((s) => s.id === id);
      if (found === undefined) return false;
      if (expired(found, now())) {
        drop([found.id]);
        return false;
      }
      return true;
    },
    onEnded: (listener) => void ended.push(listener),
    onAccountMade: (listener) => void madeListeners.push(listener),
    locked: () => isLocked,
    expiredSweep,
    close() {
      if (timer !== null) clearInterval(timer);
    },

    ensureSetupToken,

    async setup(who, input, legacyToken) {
      checkTamper();
      const st = state();
      if (st === 'damaged') return refused('damaged');
      if (st === 'account') return refused('off');
      // R3: setup is answered on loopback or private Hosts only, and never takes a token from a public one
      if (!isLocalClass(who.cls)) return refused('setup');
      const device = deviceOf(who.device);
      const keys = bucketsFor(who, device);
      const waiting = wait(keys);
      if (waiting > 0) return (tally(who, device), refused('wait', waiting));
      let ok = false;
      const file = join(options.home, SETUP_TOKEN_FILE);
      try {
        const age = now() - statSync(file).mtimeMs;
        const have = readFileSync(file, 'utf8').trim();
        ok = age < SETUP_TOKEN_MS && safeEqual(input.token, have);
      } catch {
        // no setup token
      }
      // the old Director token is a convenience for an existing home, until the account exists
      if (!ok && st === 'fresh' && legacyToken !== null && input.token !== '' && safeEqual(input.token, legacyToken)) ok = true;
      if (!ok) {
        fail(keys, who, device);
        return refused('wrong');
      }
      if (!validUser(input.user) || input.password.length < PASSWORD_MIN || input.password.length > PASSWORD_MAX) return refused('weak');
      // the token is good once: a second setup that arrives while this one is hashing is turned away, and the state is looked at again after the wait
      if (settingUp) return refused('off');
      settingUp = true;
      let made: PasswordHash;
      try {
        made = await hashPassword(input.password, options.costs);
      } finally {
        settingUp = false;
      }
      if (state() === 'account') return refused('off');
      data.user = input.user;
      data.password = made;
      data.tombstone = { created: now() };
      data.sessions = [];
      // R1: the old browser token and the setup token die with the account, and nothing replaces them
      rmSync(join(options.home, DIRECTOR_TOKEN_FILE), { force: true });
      rmSync(file, { force: true });
      succeed(keys);
      const result = finish(who, false);
      for (const listener of madeListeners) listener();
      options.alert('the Director account was created; the old browser token no longer works');
      return result;
    },

    async login(who, input) {
      checkTamper();
      const st = state();
      if (st === 'damaged') return refused('damaged');
      if (st !== 'account') return refused(st === 'none' || st === 'fresh' ? 'off' : 'damaged');
      if (isLocked && !isLocalClass(who.cls)) return refused('locked');
      const device = deviceOf(who.device);
      const keys = bucketsFor(who, device);
      const waiting = wait(keys);
      if (waiting > 0) return (tally(who, device), refused('wait', waiting));
      const userOk = safeEqual(input.user, data.user);
      const passwordOk = await checkPassword(input.password);
      if (!userOk || !passwordOk) {
        fail(keys, who, device);
        return refused('wrong');
      }
      if (data.totp?.enabled === true) {
        // the failure buckets are NOT cleared by a right password: a second factor cannot be guessed round after round by alternating
        const id = rand();
        if (pending.size > 200) for (const [k, v] of pending) if (now() - v.at > PENDING_MS) pending.delete(k);
        pending.set(id, { at: now(), address: who.address, device: device?.id ?? null, tries: 0 });
        return { ok: false, reason: 'second', pending: id };
      }
      // a public name needs a second factor: a password alone is not enough once the page can be reached from the internet
      if (!isLocalClass(who.cls)) return refused('needmfa');
      succeed(keys);
      return finish(who, true);
    },

    async second(who, id, code) {
      checkTamper();
      const found = pending.get(id);
      if (found === undefined || now() - found.at > PENDING_MS || data.totp?.enabled !== true || state() !== 'account') {
        pending.delete(id);
        return refused('wrong');
      }
      if (isLocked && !isLocalClass(who.cls)) return refused('locked');
      const device = deviceOf(who.device);
      // the token belongs to the address and the browser that gave the password: another one holding it is a stranger
      if (found.address !== who.address || found.device !== (device?.id ?? null)) {
        pending.delete(id);
        return refused('wrong');
      }
      const keys = bucketsFor(who, device);
      const waiting = wait(keys);
      if (waiting > 0) return (tally(who, device), refused('wait', waiting));
      if (!verifySecond(code)) {
        fail(keys, who, device);
        found.tries += 1;
        // five wrong codes end this login: the password has to be given again
        if (found.tries >= 5) pending.delete(id);
        return refused('wrong');
      }
      pending.delete(id);
      succeed(keys);
      return finish(who, true);
    },

    session(cookie, who, touch) {
      if (cookie === undefined || cookie === '' || state() !== 'account') return null;
      checkTamper();
      const id = sha(cookie);
      const found = data.sessions.find((s) => s.id === id);
      if (found === undefined) return null;
      const t = now();
      if (expired(found, t)) {
        drop([found.id]);
        return null;
      }
      // the class of the session is the one it was made on: a session cannot gain the long lifetime by being used from a private name
      if (touch === 'api' || (touch === 'input' && t - found.last >= MINUTE)) {
        found.last = t;
        const written0 = lastWrite.get(found.id) ?? 0;
        if (t - written0 >= SESSION_WRITE_MS) {
          lastWrite.set(found.id, t);
          save();
        }
      }
      return found;
    },

    key(secret, who) {
      if (!secret.startsWith(KEY_PREFIX) || state() !== 'account') return null;
      checkTamper();
      const id = sha(secret);
      const found = data.keys.find((k) => safeEqual(k.id, id));
      if (found === undefined || found.expires <= now()) return null;
      if (!isLocalClass(who.cls) && !found.remote) return null;
      found.last = now();
      found.lastAddress = who.address;
      return found;
    },

    logout: (sessionId) => drop([sessionId]),
    revoke(id) {
      if (id.length < 8) return false;
      // a prefix names one session or none: two that start alike are not guessed between
      const matches = data.sessions.filter((s) => s.id === id || s.id.startsWith(id));
      if (matches.length !== 1) return false;
      drop([(matches[0] as Session).id]);
      return true;
    },
    logoutEverywhere(exceptId) {
      const ids = data.sessions.filter((s) => s.id !== exceptId).map((s) => s.id);
      drop(ids);
      return ids.length;
    },

    async changePassword(sessionId, current, next) {
      const who = data.sessions.find((s) => s.id === sessionId);
      const keys = [`pw:${sessionId}`];
      const waiting = wait(keys);
      if (waiting > 0) return 'wait';
      if (!(await checkPassword(current))) {
        fail(keys, { address: who?.address ?? '', agent: '', cls: 'loopback' }, who === undefined ? null : ({ id: who.device } as Device));
        return 'wrong';
      }
      if (next.length < PASSWORD_MIN || next.length > PASSWORD_MAX) return 'weak';
      data.password = await hashPassword(next, options.costs);
      // every other session ends; the one that asked stays
      const others = data.sessions.filter((s) => s.id !== sessionId).map((s) => s.id);
      data.sessions = data.sessions.filter((s) => s.id === sessionId);
      save();
      emitEnded(others);
      // a login that was waiting for its code was started with the old password
      pending.clear();
      options.alert('the password was changed');
      return 'ok';
    },

    sessions: () => data.sessions.map((s) => ({ ...s, short: s.id.slice(0, 16) })),
    devices: () => data.devices.map((d) => ({ ...d })),
    keys: () => data.keys.map((k) => ({ ...k, short: k.id.slice(0, 12) })),

    addKey(name, scope, days, remote) {
      const secret = `${KEY_PREFIX}${rand()}`;
      const t = now();
      const key: ApiKey = { id: sha(secret), name: name.slice(0, 60), scope, remote, created: t, expires: t + (days ?? KEY_DEFAULT_DAYS) * DAY, last: null, lastAddress: null };
      data.keys.push(key);
      save();
      options.alert(`a new API key was made (${key.name}, ${scope}${remote ? ', remote' : ''})`);
      return { secret, key };
    },
    revokeKey(short) {
      if (short.length < 8) return false;
      const matches = data.keys.filter((k) => k.id.startsWith(short));
      if (matches.length !== 1) return false;
      const found = matches[0] as ApiKey;
      data.keys = data.keys.filter((k) => k !== found);
      save();
      emitEnded([`key:${found.id}`]);
      return true;
    },

    mfa: () => ({ enabled: data.totp?.enabled === true, pending: data.totp !== null && !data.totp.enabled, recoveryLeft: data.recovery.length }),
    mfaBegin() {
      const secret = randomBytes(20);
      data.totp = { secret: secret.toString('base64url'), enabled: false, lastStep: 0 };
      save();
      const text = base32(secret);
      return { secret: text, uri: `otpauth://totp/gonogo:${encodeURIComponent(data.user)}?secret=${text}&issuer=gonogo&algorithm=SHA1&digits=6&period=${TOTP_STEP_S}` };
    },
    mfaEnable(sessionId, who, code) {
      const totp = data.totp;
      if (totp === null || totp.enabled) return { ok: false, reason: 'none' };
      const keys = [`mfa:${sessionId}`];
      if (wait(keys) > 0) return { ok: false, reason: 'wait' };
      const step = matchTotp(Buffer.from(totp.secret, 'base64url'), code.trim().replace(/\s/g, ''), now(), 0);
      if (step === null) {
        fail(keys, who, null);
        return { ok: false, reason: 'wrong' };
      }
      totp.enabled = true;
      totp.lastStep = step;
      const codes = Array.from({ length: RECOVERY_COUNT }, recoveryCode);
      data.recovery = codes.map(recoveryKey);
      save();
      options.alert('a second factor (TOTP) was turned on');
      return { ok: true, recovery: codes };
    },
    async mfaDisable(sessionId, who, input) {
      const keys = [`mfa:${sessionId}`];
      if (wait(keys) > 0) return 'wait';
      // the current password AND the current second factor: a stolen session alone cannot turn it off
      if (!(await checkPassword(input.password)) || !verifySecond(input.code)) {
        fail(keys, who, null);
        return 'wrong';
      }
      data.totp = null;
      data.recovery = [];
      save();
      options.alert('the second factor (TOTP) was turned off');
      return 'ok';
    },
    async mfaRecovery(sessionId, who, input) {
      if (data.totp?.enabled !== true) return { ok: false, reason: 'none' };
      const keys = [`mfa:${sessionId}`];
      if (wait(keys) > 0) return { ok: false, reason: 'wait' };
      if (!(await checkPassword(input.password)) || !verifySecond(input.code)) {
        fail(keys, who, null);
        return { ok: false, reason: 'wrong' };
      }
      const codes = Array.from({ length: RECOVERY_COUNT }, recoveryCode);
      data.recovery = codes.map(recoveryKey);
      save();
      options.alert('new recovery codes were made; the old ones no longer work');
      return { ok: true, recovery: codes };
    },
    stepFresh(sessionId) {
      const found = data.sessions.find((x) => x.id === sessionId);
      return found !== undefined && now() - found.step <= STEP_UP_MS;
    },
    async stepUp(sessionId, who, input) {
      const found = data.sessions.find((x) => x.id === sessionId);
      if (found === undefined) return { ok: false, reason: 'gone' };
      const keys = [`step:${sessionId}`];
      if (wait(keys) > 0) return { ok: false, reason: 'wait' };
      const passwordOk = await checkPassword(input.password);
      // a second factor that is on is asked for here too (a code given again within the same 30 s step is refused: wait for the next one); only
      // after a right password, so a wrong one does not use up a code or a recovery code
      const secondOk = !passwordOk ? false : data.totp?.enabled === true ? verifySecond(input.code) : true;
      if (!passwordOk || !secondOk) {
        fail(keys, who, null);
        return { ok: false, reason: 'wrong' };
      }
      succeed(keys);
      return { ok: true, session: remint(found) };
    },

    passkeys: () => data.passkeys.map((p) => ({ ...p })),
    passkeyAdd(sessionId, _who, input) {
      if (data.passkeys.length >= 20 || data.passkeys.some((p) => p.id === input.id) || !data.sessions.some((s) => s.id === sessionId)) return false;
      data.passkeys.push({ id: input.id, publicKey: input.publicKey, counter: input.counter, transports: input.transports.slice(0, 8), name: input.name.replace(/[\u0000-\u001f\u007f<>&"'`]/g, '?').slice(0, 60) || 'passkey', rpId: input.rpId, created: now(), last: null, backedUp: input.backedUp });
      save();
      options.alert(`a passkey was added (${data.passkeys.at(-1)?.name}, for ${input.rpId})`);
      return true;
    },
    passkeysMayStart: () => data.totp?.enabled === true,
    async passkeyRemove(sessionId, who, short, input) {
      if (short.length < 8) return 'none';
      const matches = data.passkeys.filter((p) => p.id.startsWith(short));
      if (matches.length !== 1) return 'none';
      const keys = [`pk:${sessionId}`];
      if (wait(keys) > 0) return 'wait';
      // the password and the second factor, as turning TOTP off asks: a stolen session alone cannot take a passkey away
      if (!(await checkPassword(input.password)) || !verifySecond(input.code)) {
        fail(keys, who, null);
        return 'wrong';
      }
      const found = matches[0] as Passkey;
      data.passkeys = data.passkeys.filter((p) => p !== found);
      save();
      options.alert(`a passkey was removed (${found.name})`);
      return 'ok';
    },
    passkeyRemoveConfirmed(short, credentialId, counter) {
      const used = data.passkeys.find((p) => p.id === credentialId);
      if (used !== undefined) {
        used.counter = counter;
        used.last = now();
      }
      const matches = data.passkeys.filter((p) => p.id.startsWith(short));
      if (short.length < 8 || matches.length !== 1) return false;
      const found = matches[0] as Passkey;
      data.passkeys = data.passkeys.filter((p) => p !== found);
      save();
      options.alert(`a passkey was removed (${found.name})`);
      return true;
    },
    passkeyLogin(who, credentialId, counter) {
      checkTamper();
      const found = data.passkeys.find((p) => p.id === credentialId);
      if (found === undefined || state() !== 'account') return refused('wrong');
      if (isLocked && !isLocalClass(who.cls)) return refused('locked');
      found.counter = counter;
      found.last = now();
      return finish(who, true);
    },
    passkeyStepUp(sessionId, credentialId, counter) {
      const session = data.sessions.find((x) => x.id === sessionId);
      const found = data.passkeys.find((p) => p.id === credentialId);
      if (session === undefined || found === undefined) return { ok: false, reason: 'gone' };
      found.counter = counter;
      found.last = now();
      return { ok: true, session: remint(session) };
    },
    passkeyCounterAlert(credentialId) {
      const found = data.passkeys.find((p) => p.id === credentialId);
      options.alert(`a passkey's counter did not go up (${found?.name ?? 'unknown'}): a copy of it may exist`);
    },
    onReminted: (listener) => void reminted.push(listener),

    async confirm(who, password) {
      if (!isLocked) return 'none';
      const keys = [`confirm:${who.address}`];
      const waiting = wait(keys);
      if (waiting > 0) return 'wait';
      // against the in-memory account: a password planted in the file was never loaded
      if (!(await checkPassword(password))) {
        fail(keys, who, null);
        return 'wrong';
      }
      isLocked = false;
      succeed(keys);
      save();
      return 'ok';
    },

    checkTamper,
  };
}

/** Whether a key may do this: the scopes of the spec (read: state and lists; act: read plus messages, answers, hold and resume; full: all but the account). */
export function keyMayDo(scope: KeyScope, method: string, path: string): boolean {
  if (path.startsWith('/api/auth')) return false;
  const get = method === 'GET' || method === 'HEAD';
  if (scope === 'full') return true;
  if (get) return !/^\/(?:api\/)?(?:terminal|clearance|keys)/.test(path);
  if (scope === 'read') return false;
  return method === 'POST' && (/^\/api\/messages$/.test(path) || /^\/api\/agents\/[^/]+\/(?:hold|resume|answer)$/.test(path) || /^\/api\/(?:poll\/(?:hold|abort)|relief\/[^/]+\/(?:go|no-go))$/.test(path));
}

