/**
 * Docking: two gonogo installations connect so that their agents can message each other and hand off work
 * (docs/docking-spec.md).
 *
 * Pairing: the Director of A makes a docking code (A's public address and a one-time token, valid 15 minutes) and the
 * Director of B pastes it. B proves it holds the token with an HMAC and does not send it; A answers with a proof of its own,
 * and both derive the same 32-byte secret from the token and two nonces, so the secret never crosses the wire. Every later
 * call goes to /dock/* (outside /api and the browser token) signed with HMAC-SHA256 over the method, the path, a timestamp,
 * a nonce and the body; a timestamp more than 5 minutes from now or a nonce seen before is refused, and a dock may make 60
 * calls a minute. What crosses: the roster (pulled every 30 s), a message (it becomes a message from "name@station" there),
 * a task of the Flight Plan, and the undock. The clock, the fetch and the timer are injected for tests.
 *
 * shortcut: the secret is stored in docking.json as text, a 0600 file; encrypt it if the home folder is ever shared.
 * shortcut: the answer of another station is read whole before it is looked at; it is a station the Director chose to
 * dock with. Cap it if a station you do not trust is ever docked.
 * shortcut: the address of a station is an origin (no path), so a station behind a path prefix cannot be docked.
 * shortcut: a docking code and the nonces seen live in memory; a restart forgets them (a code stops working, a replay of a
 * call from the last 5 minutes before the restart would be accepted once).
 */
import type { TriggerInput } from './triggers.js';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import type { IncomingHttpHeaders } from 'node:http';
import { join } from 'node:path';
import {
  AGENT_NAME_PATTERN,
  AGENT_STATES,
  API_ERROR_CODES,
  DOCKS_MAX,
  MAX_AGENTS,
  STATION_NAME_PATTERN,
  TASK_DETAIL_MAX_CHARS,
} from '../shared/protocol.js';
import { LINK_INCOMING_OPEN_MAX, LINK_IN_PER_HOUR, LINK_OUT_PER_HOUR, LINKS_PER_TASK_MAX } from './constants.js';
import type {
  ApiErrorCode,
  DockCode,
  DockedAgent,
  DockLink,
  DockHints,
  DockingView,
  DockView,
  LinkEventView,
  LinkView,
  Logger,
  OutboundEntry,
  SendResult,
  StationMessage,
  Task,
} from '../shared/protocol.js';
import {
  DOCK_BODY_MAX_BYTES,
  DOCK_CODE_TTL_MS,
  DOCK_CODES_MAX,
  DOCK_PULL_MS,
  DOCK_RATE_MAX,
  DOCK_RATE_WINDOW_MS,
  DOCK_SKEW_MS,
  DOCK_TIMEOUT_MS,
  DOCK_UNDOCK_TIMEOUT_MS,
  DOCKING_FILE,
  FILE_MODE,
  ROSTER_ROLE_CHARS,
  STATION_FILE,
} from './constants.js';
import { isRecord } from './hooks.js';
import { HubError } from './hub.js';
import type { Actor, Tasks } from './tasks.js';
import { cleanLine, createLinks, LINK_ID_RE, readOffer } from './links.js';
import type { Links } from './links.js';

const NAME_RE = new RegExp(AGENT_NAME_PATTERN);
const STATION_RE = new RegExp(STATION_NAME_PATTERN);
const HEX32_RE = /^[0-9a-f]{32}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const NONCE_RE = /^[0-9a-f]{16,64}$/;
const TASK_ID_RE = /^t[1-9]\d{0,5}$/;
const CODE_PREFIX = 'gonogo-dock:';
/** The routes under /dock and the one method each takes. */
export const DOCK_ROUTES: Readonly<Record<string, 'GET' | 'POST'>> = { pair: 'POST', roster: 'GET', message: 'POST', task: 'POST', link: 'POST', undock: 'POST' };

/** The name of this station: GONOGO_STATION, else the first label of the host name, cut to the shape of a name. */
export function stationName(raw: string | undefined, host: string): string {
  const cut = (text: string): string =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')
      .slice(0, 31)
      .replace(/-+$/, '');
  return cut(raw ?? '') || cut(host.split('.')[0] ?? '') || 'station';
}

/**
 * The signature of one call: HMAC-SHA256 with the secret (hex) over the sender's station id, method, path, timestamp, nonce
 * and body. The id is signed because both sides hold the same secret: without it a call of ours could be sent back to us as
 * one from the other side. Exported for the tests and the docs.
 */
export function signCall(secret: string, station: string, method: string, path: string, timestamp: string, nonce: string, body: Buffer | string): string {
  return createHmac('sha256', Buffer.from(secret, 'hex')).update(`${station}\n${method}\n${path}\n${timestamp}\n${nonce}\n`).update(body).digest('hex');
}

/** The proofs of the pairing, keyed with the token of the code. The first part says which proof it is, so one cannot stand for another. */
const mac = (token: string, ...parts: string[]): string => createHmac('sha256', token).update(parts.join('\n')).digest('hex');
const sameText = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const random = (bytes: number): string => randomBytes(bytes).toString('hex');
const bad = (message: string, field?: string): HubError => new HubError('bad_request', message, field);
/** Text another station sent, as it lands in a note or an error here. */
const clip = (text: string): string => text.slice(0, 300);

interface Dock {
  /** The station id of the other side. */
  id: string;
  name: string;
  /** Its origin. */
  url: string;
  /** 32 bytes in hex. */
  secret: string;
  since: number;
}

/** What is known of a dock and not kept in the file. */
interface Live {
  status: DockView['status'];
  seenAt: number | null;
  error: string | null;
  agents: DockedAgent[];
  pulling: boolean;
  /** Nonces of the calls that were accepted, each with the time after which a call carrying it is refused for its timestamp anyway. */
  nonces: Map<string, number>;
  /** When the accepted calls of the last minute were made. */
  calls: number[];
}

export interface DockingOptions {
  /** gonogo's home: station.json and docking.json live here. */
  dir: string;
  /** The name this station gives itself (stationName). */
  name: string;
  now(): number;
  fetch: typeof fetch;
  /** Hub.sendFromStation: a message that came from the station of that name. May throw a HubError. */
  deliver(station: string, message: StationMessage): SendResult;
  /** The agents of this station, for the pull of the other side. */
  roster(): DockedAgent[];
  /** The network addresses of this computer (not loopback), for the page's Address box. */
  addresses?(): string[];
  /** gonogo runs in a container: no address of its own is the computer's. */
  container?: boolean;
  tasks: Pick<Tasks, 'list' | 'create' | 'handOff' | 'attach'>;
  /** Docking 2: the links changed; carries the whole list. */
  emitLinks?(links: LinkView[]): void;
  /** The history of triggers (docs/features/triggers.md): a hand-off to a station and every call that came in from one. */
  trigger?(entry: TriggerInput): void;
  /** The view changed (a dock was made or removed, a pull saw something new). */
  emit(view: DockingView): void;
  /** Calls `fn` every `ms` until the function that comes back is called. Default: setInterval, which does not keep the process alive. */
  every?(fn: () => void, ms: number): () => void;
  log: Logger;
}

export interface Docking extends DockLink {
  /** Reads (or makes) the station id and the docks. */
  load(): Promise<void>;
  /** Pulls every roster now and every DOCK_PULL_MS. */
  start(): void;
  view(): DockingView;
  /** What the Address box may start with. The route decides who is told. */
  hints(): DockHints;
  /** The input is a JSON value from the wire. The code is shown once and holds a token that works once. */
  createCode(input: unknown): DockCode;
  pair(input: unknown): Promise<DockView>;
  /** Removes the dock, here and (when the other side answers within a few seconds) there. `told` says whether it did. */
  undock(id: string): Promise<{ told: boolean }>;
  handOff(id: string, input: unknown): Promise<Task>;
  /** Docking 2: a task that is bound to a link changed: its status and note become events of the link. */
  taskChanged(before: Task, after: Task, actor: Actor, note: string | undefined): void;
  linkViews(): LinkView[];
  /** The trail of one link, or null. */
  linkTrail(id: string): LinkEventView[] | null;
  /** What left for a dock, as it left, with the acks: the Director's Outbound view. */
  outbound(dockId: string): OutboundEntry[];
  /** One call to /dock/<route> from another station: the answer is a JSON value, a failure a HubError (401 for a call that does not prove itself). */
  handle(route: string, method: string, url: string, headers: IncomingHttpHeaders, body: Buffer): Promise<unknown>;
  /** Asks every docked station for its roster once. Never rejects. */
  pull(): Promise<void>;
  close(): Promise<void>;
}

/** A web address with no path: the origin of a station, as the other side will reach it. */
function publicUrl(value: unknown, field: string): string {
  const fail = bad(`${field} must be a web address with no path, such as https://gonogo.example.com`, field);
  let url: URL;
  try {
    url = new URL(typeof value === 'string' ? value.trim() : '');
  } catch {
    throw fail;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || url.pathname !== '/') throw fail;
  return url.origin;
}

/** The addresses of this computer that another computer on the network may reach, best first: not a container's, not a bridge or a virtual interface, not link-local; 192.168.x, then 10.x, then the rest, 172.16/12 last. */
export function lanAddresses(nets: Record<string, ReadonlyArray<{ family: string | number; address: string; internal: boolean }> | undefined>, container: boolean): string[] {
  if (container) return [];
  const rank = (a: string): number => (a.startsWith('192.168.') ? 0 : a.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(a) ? 3 : 2);
  const found: string[] = [];
  for (const [name, list] of Object.entries(nets)) {
    if (/^(lo|docker|br-|veth|virbr|cni|flannel|cali|tun|tap|vmnet|utun|awdl|llw)/i.test(name)) continue;
    for (const a of list ?? []) if ((a.family === 'IPv4' || a.family === 4) && !a.internal && !a.address.startsWith('169.254.')) found.push(a.address);
  }
  return [...new Set(found)].sort((x, y) => rank(x) - rank(y)).slice(0, 4);
}

/** Whether a host name is this computer only: loopback, `localhost`, the wildcard. */
export const isLoopbackHost = (host: string): boolean => {
  const bare = host.toLowerCase().replace(/^\[|\]$/g, '');
  return bare === 'localhost' || bare === '::1' || bare === '::' || bare === '0.0.0.0' || /^127\./.test(bare);
};

/**
 * A docking code as people actually carry it: with or without the `gonogo-dock:` words, with spaces, line breaks, quotes or a trailing dot from a chat, a ticket or
 * a terminal. Throws a bad_request on field `code` that says what is wrong with it: cut short, not a code, no address worth trying.
 */
export function readCode(raw: unknown): { u: string; t: string } {
  const fail = (why: string): HubError => bad(`${why}. Copy the whole code again from the other station.`, 'code');
  if (typeof raw !== 'string' || raw.trim() === '') throw bad('paste the code from the other station', 'code');
  // everything that is not part of a code and is added by a chat, a mail or a terminal: white space, zero-width marks, quotes, brackets, a final dot or comma
  const cleaned = raw.replace(/[\s\u200b-\u200f\u2060\ufeff"'`<>()\[\]]/g, '').replace(/[.,;]+$/, '');
  const body = cleaned.replace(/^gonogo-dock(?::|%3a|[-_.])?/i, '');
  if (body === '') throw fail('the code is empty after its first words');
  if (!/^[A-Za-z0-9_+/=-]+$/.test(body)) throw fail('this is not a docking code (it has characters a code never has)');
  let text: string;
  try {
    text = Buffer.from(body.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), 'base64url').toString('utf8');
  } catch {
    throw fail('this is not a docking code');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // it starts like one and stops in the middle: the copy lost its end
    const partToken = /"t":"([0-9a-f]*)$/.exec(text)?.[1];
    throw fail(text.startsWith('{"u":') ? `the code is cut short (${body.length} characters arrived, and it stops in the middle${partToken === undefined ? '' : `: its token has ${partToken.length} of 64 characters`})` : 'this is not a docking code');
  }
  if (!isRecord(parsed) || typeof parsed.t !== 'string' || typeof parsed.u !== 'string') throw fail('this is not a docking code');
  if (!HEX64_RE.test(parsed.t)) throw fail(/^[0-9a-f]*$/.test(parsed.t) && parsed.t.length < 64 ? `the code is cut short (its token has ${parsed.t.length} of 64 characters)` : 'this is not a docking code (its token is wrong)');
  const url = publicUrl(parsed.u, 'code');
  return { u: url, t: parsed.t };
}

function readObject(body: Buffer): Record<string, unknown> {
  let value: unknown = null;
  try {
    value = JSON.parse(body.toString('utf8'));
  } catch {
    // answered below, like a body that parses to something else than an object
  }
  if (!isRecord(value)) throw bad('request body must be a JSON object');
  return value;
}

const one = (value: string | string[] | undefined): string => (typeof value === 'string' ? value : '');

/** Why a call to another station did not answer, in a few words. */
function causeOf(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') return `no answer within ${DOCK_TIMEOUT_MS / 1000} s`;
  const code = error instanceof Error ? (error.cause as { code?: unknown } | undefined)?.code : undefined;
  return typeof code === 'string' ? code : error instanceof Error ? error.message : String(error);
}

/** What another station refused with, as an error of ours. Its 401, 403 and 404 are not ours: the browser reads a 401 as a lost key. */
function remoteError(label: string, status: number, data: unknown): HubError {
  const info = isRecord(data) ? data : {};
  const message = typeof info.error === 'string' ? clip(info.error) : `answered ${status}`;
  const code = (API_ERROR_CODES as readonly string[]).includes(String(info.code)) ? (info.code as ApiErrorCode) : 'unavailable';
  const field = typeof info.field === 'string' ? info.field : undefined;
  if (code === 'unauthorized' || code === 'forbidden' || code === 'not_found') return new HubError('conflict', `${label} refused: ${message}`);
  return new HubError(code, `${label}: ${message}`, code === 'bad_request' ? field : undefined);
}

function readAgents(value: unknown): DockedAgent[] {
  if (!Array.isArray(value)) return [];
  const agents: DockedAgent[] = [];
  for (const raw of value) {
    if (agents.length >= MAX_AGENTS) break;
    if (!isRecord(raw) || typeof raw.name !== 'string' || !NAME_RE.test(raw.name)) continue;
    const state = (AGENT_STATES as readonly unknown[]).includes(raw.state) ? (raw.state as DockedAgent['state']) : 'stopped';
    agents.push({ name: raw.name, role: typeof raw.role === 'string' ? raw.role.slice(0, ROSTER_ROLE_CHARS) : '', state, boss: raw.boss === true });
  }
  return agents;
}

export function createDocking(options: DockingOptions): Docking {
  const { dir, now, log } = options;
  const path = join(dir, DOCKING_FILE);
  let id = '';
  let docks: Dock[] = [];
  const live = new Map<string, Live>();
  /** Docking codes that were made and not used: token to expiry. */
  const pending = new Map<string, number>();
  const pairCalls: number[] = [];
  /** Tasks on their way to another station, so that two clicks do not copy one twice. */
  const handing = new Set<string>();
  let lastSig = '';
  let stopTimer: (() => void) | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  const later = (fn: () => Promise<unknown>): Promise<void> => {
    const run = chain.then(fn);
    chain = run.catch((error: unknown) => log.error('docking could not write', error));
    return run.then(() => undefined);
  };

  const writeAtomic = (file: string, text: string): Promise<void> =>
    later(async () => {
      const tmp = join(dir, `.${file}.${process.pid}.${random(4)}.tmp`);
      await writeFile(tmp, text, { mode: FILE_MODE, flag: 'wx' });
      await rename(tmp, join(dir, file));
    });
  const save = (): Promise<void> => writeAtomic(DOCKING_FILE, JSON.stringify({ version: 1, docks }, null, 2));

  const links: Links = createLinks({
    dir,
    now,
    station: () => ({ id, name: options.name }),
    dockName: (dockId) => docks.find((d) => d.id === dockId)?.name,
    write: writeAtomic,
    send: async (dockId, events) => {
      const answer = await call(find(dockId), 'POST', 'link', { events });
      const acked: Record<string, number> = {};
      if (isRecord(answer.acked)) for (const [k, v] of Object.entries(answer.acked)) if (LINK_ID_RE.test(k) && typeof v === 'number' && Number.isSafeInteger(v)) acked[k] = v;
      return acked;
    },
    // the history of triggers keeps what happened by kind and id, never the text of an event
    trace: (dockId, what, outcome = 'delivered') => options.trigger?.({ kind: 'docking', source: dockId, name: docks.find((d) => d.id === dockId)?.name ?? dockId, outcome, what }),
    changed: () => {
      options.emitLinks?.(links.views());
      publish();
    },
    log,
  });

  const liveOf = (dock: Dock): Live => {
    let state = live.get(dock.id);
    if (!state) {
      state = { status: 'new', seenAt: null, error: null, agents: [], pulling: false, nonces: new Map(), calls: [] };
      live.set(dock.id, state);
    }
    return state;
  };

  const dockView = (dock: Dock): DockView => {
    const state = liveOf(dock);
    return { id: dock.id, name: dock.name, url: dock.url, since: dock.since, status: state.status, seenAt: state.seenAt, error: state.error, agents: state.agents.map((a) => ({ ...a })), waiting: links.waiting(dock.id) };
  };
  const view = (): DockingView => ({ station: options.name, docks: docks.map(dockView) });
  /** Tells the browsers, unless nothing they show has changed since the last time. */
  const publish = (): void => {
    const next = view();
    const sig = JSON.stringify(next);
    if (sig === lastSig) return;
    lastSig = sig;
    options.emit(next);
  };

  const find = (dockId: string): Dock => {
    const dock = docks.find((d) => d.id === dockId);
    if (!dock) throw new HubError('not_found', 'unknown dock');
    return dock;
  };
  const byName = (name: string): Dock | undefined => docks.find((d) => d.name === name);
  /** A name another station may take: not ours and not the name of another dock. */
  const nameFree = (name: string, except: string): boolean => name !== options.name && !docks.some((d) => d.name === name && d.id !== except);

  const dropOldCodes = (): void => {
    for (const [token, expiresAt] of pending) if (expiresAt <= now()) pending.delete(token);
  };

  /** The accepted calls of a minute against DOCK_RATE_MAX. */
  const takeCall = (calls: number[]): void => {
    const at = now();
    while (calls.length > 0 && at - calls[0] >= DOCK_RATE_WINDOW_MS) calls.shift();
    if (calls.length >= DOCK_RATE_MAX) throw new HubError('rate_limited', 'too many calls this minute');
    calls.push(at);
  };

  /* ---------------------------------------------------------------- the calls we make */

  async function transport(label: string, url: string, method: 'GET' | 'POST', headers: Record<string, string>, body: string | undefined, timeoutMs: number): Promise<Record<string, unknown>> {
    let text: string;
    let status: number;
    try {
      const response = await options.fetch(url, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      status = response.status;
      text = await response.text();
    } catch (error) {
      throw new HubError('unavailable', `could not reach ${label}: ${causeOf(error)}`);
    }
    let data: unknown = null;
    try {
      data = JSON.parse(text);
    } catch {
      // not JSON: an error below
    }
    // a station answers a Host name it was not started for with these two words, and nothing else: say what to do about it
    if (status === 403 && text.trim().split('\n')[0] === 'forbidden host') {
      const host = new URL(url).hostname;
      throw new HubError('unavailable', `${label} does not accept the address ${host}: on that station start gonogo with --allow-host ${host} (or set GONOGO_ALLOWED_HOSTS=${host}); --allow-host ${host}:hooks opens only docking and webhooks to that name`);
    }
    if (status < 200 || status > 299) throw remoteError(label, status, data);
    if (!isRecord(data)) throw new HubError('unavailable', `${label} sent an answer that is not JSON`);
    return data;
  }

  /** A signed call to a docked station. */
  function call(dock: Dock, method: 'GET' | 'POST', route: string, payload?: unknown, timeoutMs = DOCK_TIMEOUT_MS): Promise<Record<string, unknown>> {
    const urlPath = `/dock/${route}`;
    const body = method === 'POST' ? JSON.stringify(payload ?? {}) : '';
    const timestamp = String(now());
    const nonce = random(16);
    const headers: Record<string, string> = {
      'x-gonogo-station': id,
      'x-gonogo-timestamp': timestamp,
      'x-gonogo-nonce': nonce,
      'x-gonogo-signature': signCall(dock.secret, id, method, urlPath, timestamp, nonce, body),
    };
    if (method === 'POST') headers['content-type'] = 'application/json';
    return transport(dock.name, dock.url + urlPath, method, headers, method === 'POST' ? body : undefined, timeoutMs);
  }

  /** Asks one station for its roster. Its failure is what the dock shows, not an error. */
  async function pullOne(dock: Dock): Promise<void> {
    const state = liveOf(dock);
    if (state.pulling) return;
    state.pulling = true;
    try {
      const answer = await call(dock, 'GET', 'roster');
      const station = isRecord(answer.station) ? answer.station : {};
      if (station.id !== dock.id) throw new HubError('conflict', 'the station at this address is not the one that was docked');
      // it may rename itself; the name is the part after the @, so two docks never share one
      if (typeof station.name === 'string' && station.name !== dock.name && STATION_RE.test(station.name) && nameFree(station.name, dock.id)) {
        dock.name = station.name;
        // a write that fails is logged by the chain; nobody waits for it here
        save().catch(() => undefined);
      }
      state.agents = readAgents(answer.agents);
      const wasDown = state.status === 'down';
      state.status = 'ok';
      state.seenAt = now();
      state.error = null;
      // it is back: what waited for it goes now, not at the next retry
      if (wasDown) void links.flush(dock.id, true);
    } catch (error) {
      state.status = 'down';
      state.error = error instanceof Error ? error.message : String(error);
      log.debug(`pull of ${dock.name} failed`, error);
    } finally {
      state.pulling = false;
    }
  }

  async function pull(): Promise<void> {
    await Promise.all(docks.map((d) => pullOne(d)));
    publish();
    // the retries of the outbox ride on the same clock
    void links.flush();
  }

  /* ---------------------------------------------------------------- the calls we get */

  /** Who sent this call, or a 401. The signature comes first, so that what it covers (the time, the nonce) can be told to the sender. */
  function authenticate(method: string, url: string, headers: IncomingHttpHeaders, body: Buffer): Dock {
    const refused = new HubError('unauthorized', 'the call is not signed by a docked station');
    const station = one(headers['x-gonogo-station']);
    const timestamp = one(headers['x-gonogo-timestamp']);
    const nonce = one(headers['x-gonogo-nonce']);
    const signature = one(headers['x-gonogo-signature']);
    const dock = HEX32_RE.test(station) ? docks.find((d) => d.id === station) : undefined;
    if (!dock || !/^\d{10,16}$/.test(timestamp) || !NONCE_RE.test(nonce) || !HEX64_RE.test(signature)) throw refused;
    if (!sameText(signature, signCall(dock.secret, station, method, url, timestamp, nonce, body))) throw refused;
    const at = now();
    if (Math.abs(at - Number(timestamp)) > DOCK_SKEW_MS) throw new HubError('unauthorized', 'the timestamp is more than 5 minutes from this station\'s clock');
    const state = liveOf(dock);
    for (const [seen, until] of state.nonces) if (until <= at) state.nonces.delete(seen);
    if (state.nonces.has(nonce)) throw new HubError('unauthorized', 'this call was made before');
    takeCall(state.calls);
    // a call with this timestamp is refused for its age from the moment it is DOCK_SKEW_MS old, so the nonce is of no use after that
    state.nonces.set(nonce, Number(timestamp) + DOCK_SKEW_MS);
    return dock;
  }

  /** The other side proves it holds a code; the answer proves we made it. Both then have the secret. */
  async function acceptPair(body: Record<string, unknown>): Promise<unknown> {
    takeCall(pairCalls);
    const { id: theirId, name, url, nonce, proof } = body;
    if (typeof theirId !== 'string' || !HEX32_RE.test(theirId)) throw bad('id must be a station id', 'id');
    if (typeof name !== 'string' || !STATION_RE.test(name)) throw bad('name must be a station name', 'name');
    if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) throw bad('nonce must be hex text', 'nonce');
    if (typeof proof !== 'string' || !HEX64_RE.test(proof)) throw bad('proof must be hex text', 'proof');
    const theirUrl = publicUrl(url, 'url');
    dropOldCodes();
    let token: string | null = null;
    for (const candidate of pending.keys()) if (sameText(proof, mac(candidate, 'pair', nonce, theirId, name, theirUrl))) token = candidate;
    if (token === null) throw new HubError('unauthorized', 'the code is wrong, used or expired');
    if (theirId === id) throw new HubError('conflict', 'a station cannot dock with itself');
    if (docks.some((d) => d.id === theirId)) throw new HubError('conflict', `already docked with ${name}`);
    if (!nameFree(name, theirId)) throw new HubError('conflict', `a station called ${name} is this one or is docked already: one of them has to change its name (GONOGO_STATION)`);
    if (docks.length >= DOCKS_MAX) throw new HubError('conflict', `at most ${DOCKS_MAX} stations can be docked`);
    pending.delete(token);
    const mine = random(16);
    const dock: Dock = { id: theirId, name, url: theirUrl, secret: mac(token, 'secret', mine, nonce, id, theirId), since: now() };
    docks.push(dock);
    await save();
    publish();
    // no pull yet: the other side has not saved the dock until it reads this answer. Its first pull, right after, makes us pull.
    return { id, name: options.name, nonce: mine, ack: mac(token, 'ack', nonce, mine, id, options.name) };
  }

  function acceptMessage(dock: Dock, body: Record<string, unknown>): SendResult {
    // the hub checks every field of a message from a station, as it does for one from an agent
    return options.deliver(dock.name, body as unknown as StationMessage);
  }

  /** What the sender is told when a task is not taken: a plain refusal with its reason, which it keeps in the trail of the link. */
  const refusal = (reason: string): { ok: false; refused: string } => ({ ok: false, refused: reason });

  async function acceptTask(dock: Dock, body: Record<string, unknown>): Promise<unknown> {
    const theirs = typeof body.id === 'string' && TASK_ID_RE.test(body.id) ? ` (its task ${body.id})` : '';
    const detail = typeof body.detail === 'string' ? body.detail : '';
    const linkId = typeof body.link === 'string' && LINK_ID_RE.test(body.link) ? body.link : null;
    // a station without links (an older gonogo) copies the task once, as before
    const offer = linkId === null ? null : readOffer(body);
    if (linkId !== null) {
      const have = links.find(linkId);
      if (have !== undefined) {
        // the same offer again (the answer was lost): the same task, not a second one
        if (have.peer !== dock.id || have.role !== 'receiver') throw new HubError('conflict', 'that link belongs to another station', 'link');
        const accept = have.trail.find((e) => e.kind === 'accept' && e.author === id);
        return { ok: true, id: have.mine, link: linkId, ...(accept === undefined ? {} : { accept }) };
      }
      if (links.incomingThisHour(dock.id) >= LINK_IN_PER_HOUR) return refusal(`more than ${LINK_IN_PER_HOUR} tasks in the last hour from this station`);
      if (links.openIncoming(dock.id) >= LINK_INCOMING_OPEN_MAX) return refusal(`this station already holds ${LINK_INCOMING_OPEN_MAX} open tasks from ${dock.name}`);
    }
    const marks = offer === null ? '' : `${offer.due === null ? '' : ` Due ${offer.due}.`}${offer.priority === 'normal' ? '' : ` Priority ${offer.priority}.`}`;
    const request: Record<string, unknown> = {
      title: body.title,
      detail: `Handed off from ${dock.name}${theirs}.${marks}${detail === '' ? '' : `\n\n${detail}`}`.slice(0, TASK_DETAIL_MAX_CHARS),
    };
    if (body.assignee !== undefined && body.assignee !== null) request.assignee = body.assignee;
    let task: Task;
    try {
      task = await options.tasks.create({ kind: 'dock', station: dock.name }, request);
    } catch (error) {
      // a board that is full is a reason, not a failure of the call: the sender keeps the link and says why
      if (linkId !== null && error instanceof HubError && error.code === 'conflict') return refusal(error.message);
      throw error;
    }
    if (linkId === null || offer === null) return { ok: true, id: task.id };
    await options.tasks.attach(task.id, { link: linkId, note: `handed off from ${dock.name}${theirs} on link ${linkId}` });
    const link = links.incoming(dock, linkId, task.id, offer, task.title, `director@${dock.name}`);
    const accept = links.record(link, 'accept', `station@${options.name}`, '', undefined, false);
    return { ok: true, id: task.id, link: linkId, accept };
  }

  /** An inbound call from a station, kept in the history of triggers with how it ended (the payload is not kept). */
  function traced<T>(dock: Dock, what: string, run: () => T): T {
    const done = (outcome: string, error?: unknown): void =>
      options.trigger?.({ kind: 'docking', source: dock.id, name: dock.name, outcome, what: `from ${dock.name}: ${what}`, ...(error === undefined ? {} : { note: error instanceof Error ? error.message : 'failed' }) });
    const failed = (error: unknown): void => done(error instanceof HubError && error.code !== 'internal' ? 'refused' : 'failed', error);
    try {
      const result = run();
      if (result instanceof Promise) {
        return result.then(
          (value) => (done('delivered'), value),
          (error: unknown) => {
            failed(error);
            throw error;
          },
        ) as T;
      }
      done('delivered');
      return result;
    } catch (error) {
      failed(error);
      throw error;
    }
  }

  /* ---------------------------------------------------------------- the public API */

  return {
    async load() {
      let saved: unknown = null;
      try {
        saved = JSON.parse(await readFile(join(dir, STATION_FILE), 'utf8'));
      } catch {
        // none yet, or not readable: a new id below
      }
      id = isRecord(saved) && typeof saved.id === 'string' && HEX32_RE.test(saved.id) ? saved.id : '';
      if (id === '') {
        id = random(16);
        await writeAtomic(STATION_FILE, JSON.stringify({ version: 1, id }, null, 2));
      }
      saved = null;
      try {
        saved = JSON.parse(await readFile(path, 'utf8'));
        if (!isRecord(saved) || saved.version !== 1 || !Array.isArray(saved.docks)) throw new Error('not a version 1 docking file');
      } catch (error) {
        saved = null;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          // kept aside, so that the next save cannot overwrite the secrets that were agreed
          log.error(`${DOCKING_FILE} could not be read; no station is docked and the file is kept as ${DOCKING_FILE}.bad`, error instanceof SyntaxError ? 'not valid JSON' : error);
          await rename(path, `${path}.bad`).catch(() => undefined);
        }
      }
      for (const raw of isRecord(saved) && Array.isArray(saved.docks) ? saved.docks : []) {
        if (!isRecord(raw) || typeof raw.id !== 'string' || !HEX32_RE.test(raw.id) || typeof raw.name !== 'string' || !STATION_RE.test(raw.name)) continue;
        if (typeof raw.secret !== 'string' || !HEX64_RE.test(raw.secret) || typeof raw.url !== 'string' || docks.some((d) => d.id === raw.id || d.name === raw.name)) continue;
        docks.push({ id: raw.id, name: raw.name, url: raw.url, secret: raw.secret, since: typeof raw.since === 'number' ? raw.since : now() });
      }
      lastSig = JSON.stringify(view());
      await links.load();
    },

    start() {
      const every = options.every ?? ((fn, ms) => {
        const timer = setInterval(fn, ms);
        timer.unref();
        return () => clearInterval(timer);
      });
      stopTimer = every(() => void pull(), DOCK_PULL_MS);
      void pull();
    },

    view,
    hints: () => ({ addresses: options.addresses?.() ?? [], container: options.container === true }),

    stations: () => docks.map((d) => d.name),

    rosters: () => docks.filter((d) => liveOf(d).status === 'ok' && liveOf(d).agents.length > 0).map((d) => ({ station: d.name, agents: liveOf(d).agents.map((a) => ({ ...a })) })),

    async send(station, message) {
      const dock = byName(station);
      if (!dock) return { ok: false, note: `${station} is not docked` };
      try {
        const answer = await call(dock, 'POST', 'message', message);
        const status = typeof answer.status === 'string' ? clip(answer.status) : 'unknown';
        const note = typeof answer.note === 'string' && answer.note !== '' ? `, ${clip(answer.note)}` : '';
        // the other hub's own words: its message is "undelivered" when it went to its Director
        if (answer.ok !== true) return { ok: false, note: `${station} did not deliver it: ${status}${note}` };
        return { ok: true, note: `accepted by ${station}: ${status}${note}` };
      } catch (error) {
        return { ok: false, note: error instanceof Error ? error.message : String(error) };
      }
    },

    createCode(input) {
      if (!isRecord(input)) throw bad('request body must be a JSON object');
      const url = publicUrl(input.url, 'url');
      dropOldCodes();
      while (pending.size >= DOCK_CODES_MAX) pending.delete(pending.keys().next().value as string);
      const token = random(32);
      const expiresAt = now() + DOCK_CODE_TTL_MS;
      pending.set(token, expiresAt);
      const loopback = isLoopbackHost(new URL(url).hostname);
      return { code: CODE_PREFIX + Buffer.from(JSON.stringify({ u: url, t: token })).toString('base64url'), expiresAt, ...(loopback ? { warning: `${url} works only on this computer: a station on another computer cannot dock with this code. Type this station's network address and make the code again.` } : {}) };
    },

    async pair(input) {
      if (!isRecord(input)) throw bad('request body must be a JSON object');
      const own = publicUrl(input.url, 'url');
      const theirs = readCode(input.code);
      // a code made on the page of a station that was opened as localhost carries that address, which only that computer can reach
      const loopbackNote = isLoopbackHost(new URL(theirs.u).hostname) ? ` The code carries ${theirs.u}, an address that works only on the station that made it: on that station make a new code with its network address (the Address box).` : '';
      if (docks.length >= DOCKS_MAX) throw new HubError('conflict', `at most ${DOCKS_MAX} stations can be docked`);
      if (isLoopbackHost(new URL(own).hostname) && !isLoopbackHost(new URL(theirs.u).hostname)) {
        throw bad(`the address of this station is ${own}, which works only on this computer, so ${new URL(theirs.u).host} could never reach it: type this station's network address`, 'url');
      }
      const nonce = random(16);
      const answer = await transport(
        new URL(theirs.u).host,
        `${theirs.u}/dock/pair`,
        'POST',
        { 'content-type': 'application/json' },
        JSON.stringify({ id, name: options.name, url: own, nonce, proof: mac(theirs.t, 'pair', nonce, id, options.name, own) }),
        DOCK_TIMEOUT_MS,
      ).catch((error: unknown) => {
        if (error instanceof HubError && error.code === 'unavailable' && loopbackNote !== '') throw new HubError('unavailable', `${error.message}.${loopbackNote}`);
        throw error;
      });
      const { id: theirId, name, nonce: mine, ack } = answer;
      if (typeof theirId !== 'string' || !HEX32_RE.test(theirId) || typeof name !== 'string' || !STATION_RE.test(name) || typeof mine !== 'string' || !NONCE_RE.test(mine) || typeof ack !== 'string') {
        throw bad('the station at that address did not answer as a gonogo station', 'code');
      }
      if (!sameText(ack, mac(theirs.t, 'ack', nonce, mine, theirId, name))) throw bad('the station at that address did not prove it made this code: check the address and ask for a new code', 'code');
      const dock: Dock = { id: theirId, name, url: theirs.u, secret: mac(theirs.t, 'secret', mine, nonce, theirId, id), since: now() };
      const refusal = docks.some((d) => d.id === theirId)
        ? new HubError('conflict', `already docked with ${name}: undock it here first`)
        : !nameFree(name, theirId)
          ? new HubError('conflict', `a station called ${name} is this one or is docked already: one of them has to change its name (GONOGO_STATION)`)
          : null;
      if (refusal) {
        // the other side docked already: it is told to undock, so that it does not keep a dock that this side never made
        await call(dock, 'POST', 'undock', {}, DOCK_UNDOCK_TIMEOUT_MS).catch((error: unknown) => log.debug(`${name} was not told to undo the pairing`, error));
        throw refusal;
      }
      docks.push(dock);
      await save();
      publish();
      void pullOne(dock).then(publish);
      return dockView(dock);
    },

    async undock(dockId) {
      const dock = find(dockId);
      let told = true;
      try {
        await call(dock, 'POST', 'undock', {}, DOCK_UNDOCK_TIMEOUT_MS);
      } catch (error) {
        told = false;
        log.debug(`${dock.name} was not told of the undock`, error);
      }
      docks = docks.filter((d) => d !== dock);
      live.delete(dock.id);
      links.detach(dock.id);
      await save();
      publish();
      return { told };
    },

    async handOff(dockId, input) {
      const dock = find(dockId);
      if (!isRecord(input)) throw bad('request body must be a JSON object');
      for (const key of Object.keys(input)) if (!['task', 'assignee', 'due', 'priority', 'onward', 'budget'].includes(key)) throw bad(`unknown field "${key}"`, key);
      const task = options.tasks.list().find((t) => t.id === input.task);
      if (!task) throw new HubError('not_found', 'unknown task', 'task');
      if (task.status === 'done' || task.handedOff !== undefined || handing.has(task.id)) throw new HubError('conflict', 'only a task that is open here can be handed off', 'task');
      const assignee = input.assignee ?? null;
      if (assignee !== null && (typeof assignee !== 'string' || !NAME_RE.test(assignee))) throw bad('assignee must be the name of an agent of that station, or null', 'assignee');
      const offer = readOffer(input);
      if ((task.links?.length ?? 0) >= LINKS_PER_TASK_MAX) throw new HubError('conflict', `a task has at most ${LINKS_PER_TASK_MAX} links to other stations`, 'task');
      if (links.outgoingThisHour(dock.id) >= LINK_OUT_PER_HOUR) throw new HubError('rate_limited', `at most ${LINK_OUT_PER_HOUR} tasks an hour to one station`);
      handing.add(task.id);
      const trace = (outcome: string, note?: string): void => options.trigger?.({ kind: 'docking', source: dock.id, name: dock.name, outcome, what: `hand-off of ${task.id}: ${task.title}`, ...(assignee === null ? {} : { agent: assignee }), ...(note === undefined ? {} : { note }) });
      const link = links.outgoing(dock, task, offer);
      try {
        // the offer is the first event of the link, authored here; it travels on this call and the answer acks it
        if (link.outSeq === 0) links.record(link, 'offer', `director@${options.name}`, '');
        const answer = await call(dock, 'POST', 'task', { id: task.id, title: task.title, detail: task.detail, assignee, link: link.id, ...offer });
        if (answer.ok === false) {
          const reason = cleanLine(answer.refused) || 'no reason given';
          links.applyOne(dock, { link: link.id, author: dock.id, seq: 1, at: now(), kind: 'refuse', by: 'station', text: reason });
          trace('refused', reason);
          throw new HubError('conflict', `${dock.name} did not take it: ${reason}`, 'task');
        }
        link.theirs = typeof answer.id === 'string' && TASK_ID_RE.test(answer.id) ? answer.id : null;
        // the accept comes with the answer, authored by the other station (its own checks apply to it like to any event of it)
        if (isRecord(answer.accept)) links.applyOne(dock, answer.accept);
        links.noteOutgoing(dock.id);
        const handed = await options.tasks.attach(task.id, { outgoing: link.id, note: `handed off to ${assignee === null ? '' : `${assignee}@`}${dock.name} on link ${link.id}` });
        trace('delivered');
        return handed;
      } catch (error) {
        if (!(error instanceof HubError && error.code === 'conflict' && link.state === 'refused')) trace('failed', error instanceof Error ? error.message : 'hand-off failed');
        throw error;
      } finally {
        handing.delete(task.id);
      }
    },

    taskChanged(before, after, actor, note) {
      const link = after.link === undefined ? undefined : links.find(after.link);
      if (link === undefined || link.role !== 'receiver' || link.state === 'detached' || link.state === 'recalled') return;
      const by = `${actor.kind === 'agent' ? actor.name : 'director'}@${options.name}`;
      const text = after.localNotes === true ? '' : (note ?? '');
      if (after.status !== before.status) links.record(link, 'status', by, text, after.status);
      else if (note !== undefined && after.localNotes !== true) links.record(link, 'note', by, text);
    },
    linkViews: () => links.views(),
    linkTrail: (linkId) => links.trail(linkId),
    outbound: (dockId) => links.outbound(dockId),

    async handle(route, method, url, headers, body) {
      if (body.length > DOCK_BODY_MAX_BYTES) throw new HubError('too_large', 'request body too large');
      if (route === 'pair') return acceptPair(readObject(body));
      const dock = authenticate(method, url, headers, body);
      // it calls in, so it answers calls too: this is the first pull of the side that made the code, and the next one of a dock that was down
      if (route !== 'undock' && liveOf(dock).status !== 'ok') void pullOne(dock).then(publish);
      switch (route) {
        case 'roster':
          return { station: { id, name: options.name }, agents: options.roster() };
        case 'message':
          return traced(dock, 'a message', () => acceptMessage(dock, readObject(body)));
        case 'task':
          return traced(dock, 'a task handed off to this station', () => acceptTask(dock, readObject(body)));
        case 'link':
          return traced(dock, 'link events', () => ({ acked: links.apply(dock, readObject(body)) }));
        default: {
          // undock: gone from here too, and the answer is the last thing this dock gets
          docks = docks.filter((d) => d !== dock);
          live.delete(dock.id);
          links.detach(dock.id);
          await save();
          publish();
          return { ok: true };
        }
      }
    },

    pull,

    close() {
      stopTimer?.();
      stopTimer = null;
      return links.close().then(() => chain).then(() => undefined);
    },
  };
}
