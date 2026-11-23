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
  MISSION_GOAL_MAX_CHARS,
  MISSION_NAME_MAX_CHARS,
  TASK_DETAIL_MAX_CHARS,
  type TaskStatus,
} from '../shared/protocol.js';
import { LINK_INCOMING_OPEN_MAX, LINK_MISSIONS_OPEN_MAX, LINK_IN_PER_HOUR, LINK_OUT_PER_HOUR, LINKS_PER_TASK_MAX } from './constants.js';
import type {
  ApiErrorCode,
  DockCode,
  DockedAgent,
  Deliverable,
  DockLink,
  DockRules,
  HandoffAsk,
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
import type { Link, LinkEvent, Links } from './links.js';
import type { Missions } from './missions.js';
import { redactSecrets } from './triggers.js';
import { tokenize, stem } from './logsearch.js';
import { createShares } from './shares.js';

const NAME_RE = new RegExp(AGENT_NAME_PATTERN);
const STATION_RE = new RegExp(STATION_NAME_PATTERN);
const HEX32_RE = /^[0-9a-f]{32}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const NONCE_RE = /^[0-9a-f]{16,64}$/;
const TASK_ID_RE = /^t[1-9]\d{0,5}$/;
const CODE_PREFIX = 'gonogo-dock:';
/** The routes under /dock and the one method each takes. */
/** A thread: a message whose subject starts with `[dl_<16 hex>]` belongs to that link. The link has to be one with the dock the message goes to or comes from. */
const THREAD_RE = /^\[(dl_[0-9a-f]{16})\]/;

export const DOCK_ROUTES: Readonly<Record<string, 'GET' | 'POST'>> = { pair: 'POST', roster: 'GET', message: 'POST', task: 'POST', link: 'POST', knowledge: 'POST', undock: 'POST' };

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
  /** What this station may do with this one; absent in a file of before Docking 2 (the defaults). */
  rules?: DockRules;
}

const DEFAULT_RULES: DockRules = { handoff: 'ask', incoming: 'auto', autoAccept: false, staleHours: 24, reportCost: false, serve: false };

/** Rules from a file or a request, field by field: what is not valid keeps its default. */
function readRules(raw: unknown, base: DockRules = DEFAULT_RULES): DockRules {
  const r = isRecord(raw) ? raw : {};
  return {
    handoff: r.handoff === 'allow' || r.handoff === 'ask' ? r.handoff : base.handoff,
    incoming: r.incoming === 'off' || r.incoming === 'auto' ? r.incoming : base.incoming,
    autoAccept: typeof r.autoAccept === 'boolean' ? r.autoAccept : base.autoAccept,
    staleHours: typeof r.staleHours === 'number' && Number.isInteger(r.staleHours) && r.staleHours >= 0 && r.staleHours <= 24 * 30 ? r.staleHours : base.staleHours,
    reportCost: typeof r.reportCost === 'boolean' ? r.reportCost : base.reportCost,
    serve: typeof r.serve === 'boolean' ? r.serve : base.serve,
  };
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
  tasks: Pick<Tasks, 'list' | 'create' | 'handOff' | 'attach' | 'system'>;
  /** Docking 2: a mission is offered like a task; the receiver makes its own. Absent: this station takes no missions. */
  missions?: Pick<Missions, 'create' | 'list'>;
  /** Docking 2, S5: what a request for knowledge may read. `entries` ranks the Mission Log for a query (best first, up to 50); `claims` lists the active claims as { key: "<repo id>/<claim id>", statement, date }. */
  knowledge?: {
    entries(query: string): Array<{ id: string; title: string; snippet: string; date: string }>;
    claims(): Promise<Array<{ key: string; statement: string; date: string }>>;
  };
  /** Docking 2: the links changed; carries the whole list. */
  emitLinks?(links: LinkView[]): void;
  /** Docking budgets: the cap of a linked task goes into this station's Propellant (links scope); null clears it. */
  setLinkBudget?(linkId: string, usd: number | null): void;
  /** What a task has cost here: dollars (an estimate) of the ledger lines that carry it, or undefined when nothing is known. */
  spentOnTask?(taskId: string): number | undefined;
  /** The most this station's own room budget allows, when it has one (a cap from a peer is cut to it). */
  roomBudgetCap?(): number | undefined;
  /** One line for the Director's Downlink (return, refusal, delivery, recall, an incoming task, a digest). */
  notify?(text: string): void;
  /** A message to this station's boss, labelled as from the docked station and not from the Director. */
  tellBoss?(station: string, subject: string, body: string): void;
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
  taskChanged(before: Task, after: Task, actor: Actor, note: string | undefined, attachments?: Deliverable[]): void;
  linkViews(): LinkView[];
  /** An agent's question to a docked station's shared knowledge: its answer, as data, not stored. 20 an hour per dock. */
  askKnowledge(station: unknown, query: unknown): Promise<{ text: string; results: number }>;
  /** FLIGHT's read-only tool: the three agents, here or docked, whose names and roles match the task best. Sends nothing. */
  suggest(taskId: unknown): { text: string; suggestions: Array<{ station: string; agent: string; state: string; stopped: boolean; why: string[] }> };
  /** The Director's marks (Mission Log entries and claims shareable for docks). */
  shares(): Array<{ kind: 'log' | 'claim'; key: string; docks: string[] }>;
  setShare(kind: unknown, key: unknown, docks: unknown): Promise<{ kind: 'log' | 'claim'; key: string; docks: string[] }>;
  /** Offers a mission to a station like a task: the other station makes its own, and tells counts only (never titles). */
  handOffMission(dockId: string, input: unknown): Promise<LinkView>;
  /** The task a link is bound to on this station when it holds that task for another (the one a link cap holds). */
  linkTask(linkId: string): string | undefined;
  /** The rules of a dock, changed field by field (the Director's own login). */
  rules(dockId: string): DockRules;
  setRules(dockId: string, input: unknown): DockRules;
  /** The receiver gives the task back: it is done here, and the sender's task reopens there as todo. */
  returnTask(linkId: string, reason: unknown): Promise<LinkView>;
  /** The sender withdraws the task: the other station's task closes there unless it is done. */
  recallTask(linkId: string, reason: unknown): Promise<LinkView>;
  /** The sender accepts a delivery: its task is done. */
  acceptDelivery(linkId: string): Promise<LinkView>;
  /** FLIGHT's tool: send a task to a station. With `handoff: allow` it goes; with `ask` the Director sees the whole text first. */
  requestHandoff(input: unknown): Promise<{ state: 'sent' | 'waiting'; link?: string; ask?: string; note: string }>;
  asks(): HandoffAsk[];
  /** The Director's answer to a waiting hand-off; `always` sets that dock to `allow`. */
  answerAsk(id: string, go: boolean, always: boolean): Promise<{ state: 'sent' | 'refused'; link?: string }>;
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
  /** What the Director marked shareable for each dock (shares.json). */
  const shares = createShares({ dir, write: writeAtomic, log });
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
    applied: (link, event, ours) => onApplied(link, event, ours),
    log,
  });

  const rulesOf = (dock: Dock): DockRules => dock.rules ?? DEFAULT_RULES;

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
    return { id: dock.id, name: dock.name, url: dock.url, since: dock.since, status: state.status, seenAt: state.seenAt, error: state.error, agents: state.agents.map((a) => ({ ...a })), waiting: links.waiting(dock.id), rules: rulesOf(dock) };
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

  /** Once per start and dock, after the first answer: what the dock holds of each link, and what it lacks (a file lost, an outbox dropped) goes again. A dock that cannot say is left alone; the outbox does the rest. */
  const repaired = new Set<string>();
  async function repairLinks(dock: Dock): Promise<void> {
    if (repaired.has(dock.id)) return;
    repaired.add(dock.id);
    for (const view of links.views().filter((l) => l.peer === dock.id && l.state !== 'detached' && l.state !== 'refused')) {
      try {
        const answer = await call(dock, 'GET', `link/${view.id}`);
        links.repair(dock.id, view.id, answer.held);
      } catch (error) {
        log.debug(`repair of ${view.id} with ${dock.name} did not go: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Asks one station for its roster. Its failure is what the dock shows, not an error. */
  async function pullOne(dock: Dock): Promise<void> {
    const state = liveOf(dock);
    if (state.pulling) return;
    state.pulling = true;
    try {
      const answer = await call(dock, 'GET', 'roster');
      void repairLinks(dock);
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
    checkStale();
    reportCosts();
    reportMissions();
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
    links.reattach(dock.id);
    await save();
    publish();
    // no pull yet: the other side has not saved the dock until it reads this answer. Its first pull, right after, makes us pull.
    return { id, name: options.name, nonce: mine, ack: mac(token, 'ack', nonce, mine, id, options.name) };
  }

  function acceptMessage(dock: Dock, body: Record<string, unknown>): SendResult {
    // a thread tag has to name a link with the station that sends the message, else the message is refused (a station cannot write into the thread of another)
    const tag = typeof body.subject === 'string' ? THREAD_RE.exec(body.subject)?.[1] : undefined;
    if (tag !== undefined && links.of(dock.id, tag) === undefined) throw new HubError('bad_request', `the thread ${tag} is not a link with ${dock.name}`, 'subject');
    // the hub checks every field of a message from a station, as it does for one from an agent
    return options.deliver(dock.name, body as unknown as StationMessage);
  }

  /* ---------------------------------------------------------------- what a link does to the tasks and to the Director */

  /** What a link does to the task bound to it; a mission link touches no task (neither side's mission closes the other's). */
  const sys = (link: Link, change: { status?: TaskStatus; note: string; returned?: boolean }): Promise<unknown> => (link.kind === 'mission' ? Promise.resolve() : options.tasks.system(link.mine, change));
  const said = (promise: Promise<unknown>): void => void promise.catch((error: unknown) => log.warn('a link could not change its task', error));

  /** An event was applied: the side effects on the tasks and the Downlink. An event of ours changed our own task already. */
  function onApplied(link: Link, event: LinkEvent, ours: boolean): void {
    if (ours) return;
    const dock = docks.find((d) => d.id === link.peer);
    const name = dock?.name ?? link.peerName;
    if (link.role === 'sender') {
      if (event.kind === 'status' && event.status === 'done' && link.state === 'delivered') {
        said(sys(link, { status: 'review', note: `delivered by ${name}` }));
        options.notify?.(`${name} delivered "${link.title}"`);
        if (dock !== undefined && rulesOf(dock).autoAccept) said(acceptDelivery(link.id, true));
      } else if (event.kind === 'return') {
        said(sys(link, { status: 'todo', note: `returned by ${event.by}${event.text === '' ? '' : `: ${event.text}`}`, returned: true }));
        options.notify?.(`${name} gave back "${link.title}"${event.text === '' ? '' : `: ${event.text}`}`);
      } else if (event.kind === 'refuse') {
        options.notify?.(`${name} did not take "${link.title}"${event.text === '' ? '' : `: ${event.text}`}`);
      }
      // hop by hop: this task is also held here for the station above, which hears what the station below says, as "reported by <station>"
      const above = links.incomingByTask(link.mine);
      if (above !== undefined && above.state === 'accepted' && event.kind === 'status' && event.status !== undefined && /^[a-z0-9][a-z0-9-]{0,30}$/.test(link.peerName)) {
        links.record(above, 'status', `station@${options.name}`, event.status, undefined, { via: link.peerName });
      }
    } else if (event.kind === 'recall') {
      // only the task that is bound to this link, and only if it is not done
      const mine = options.tasks.list().find((t) => t.id === link.mine);
      if (mine !== undefined && mine.status !== 'done') said(sys(link, { status: 'done', note: `recalled by ${name}${event.text === '' ? '' : `: ${event.text}`}` }));
      options.notify?.(`${name} recalled "${link.title}"`);
    }
  }

  const peerOf = (link: Link): Dock => {
    const dock = docks.find((d) => d.id === link.peer);
    if (dock === undefined) throw new HubError('conflict', 'the station of this link is not docked any more', 'link');
    return dock;
  };
  const linkView = (link: Link): LinkView => links.views().find((v) => v.id === link.id) as LinkView;
  const reasonOf = (value: unknown): string => {
    if (value !== undefined && value !== null && typeof value !== 'string') throw bad('reason must be text', 'reason');
    return cleanLine(value ?? '', 200);
  };
  const mineLink = (linkId: unknown, role: 'sender' | 'receiver', states: readonly string[], what: string): Link => {
    const link = typeof linkId === 'string' && LINK_ID_RE.test(linkId) ? links.find(linkId) : undefined;
    if (link === undefined) throw new HubError('not_found', 'unknown link', 'link');
    if (link.role !== role || !states.includes(link.state)) throw new HubError('conflict', `${what}: a ${link.role} link in the state ${link.state} cannot`, 'link');
    return link;
  };

  async function acceptDelivery(linkId: string, auto = false): Promise<LinkView> {
    const link = mineLink(linkId, 'sender', ['delivered'], 'only a delivered task is accepted');
    peerOf(link);
    links.record(link, 'accept', `director@${options.name}`, auto ? 'auto-accepted' : 'accepted');
    await sys(link, { status: 'done', note: auto ? `auto-accepted from ${link.peerName}` : `accepted from ${link.peerName}` });
    return linkView(link);
  }

  /** Incoming tasks tell the Director with one line each; more than 3 from one dock in 10 minutes become one digest line. */
  const incomingTimes = new Map<string, number[]>();
  function tellIncoming(dock: Dock, title: string): void {
    const recent = (incomingTimes.get(dock.id) ?? []).filter((t) => now() - t < 600_000);
    recent.push(now());
    incomingTimes.set(dock.id, recent);
    if (recent.length <= 3) options.notify?.(`${dock.name} handed over a task: ${title}`);
    else if (recent.length === 4) options.notify?.(`${dock.name} is handing over several tasks: more than 3 in 10 minutes (see the Docking module)`);
  }

  /** A mission link held here reports counts of its tasks when they change, and its being done once; titles never leave. */
  function reportMissions(): void {
    if (options.missions === undefined) return;
    const tasks = options.tasks.list();
    for (const view of links.views()) {
      const link = view.kind === 'mission' && view.role === 'receiver' && view.state === 'accepted' ? links.find(view.id) : undefined;
      if (link === undefined) continue;
      const mine = tasks.filter((t) => t.missionId === link.mine);
      const counts = { done: mine.filter((t) => t.status === 'done').length, total: mine.length, blocked: mine.filter((t) => t.status === 'blocked').length, review: mine.filter((t) => t.status === 'review').length };
      if (link.progress === undefined || JSON.stringify(link.progress) !== JSON.stringify(counts)) {
        link.progress = counts;
        links.record(link, 'progress', `station@${options.name}`, `${counts.done}/${counts.total} ${counts.blocked} ${counts.review}`);
      }
      if (options.missions.list().find((m) => m.id === link.mine)?.status === 'done') links.record(link, 'status', `station@${options.name}`, 'the mission is done', 'done');
    }
  }

  /** The receiver's cost report: per dock with `reportCost` on, at most one an hour per link, and one when the task is delivered. Dollars to the cent, an estimate, and nothing else leaves. */
  function reportCosts(force?: Link): void {
    for (const view of links.views()) {
      const link = links.find(view.id);
      const dock = link === undefined ? undefined : docks.find((d) => d.id === link.peer);
      if (link === undefined || dock === undefined || link.role !== 'receiver' || !rulesOf(dock).reportCost) continue;
      if (link.state !== 'accepted' && link.state !== 'delivered') continue;
      if (force !== undefined && force !== link) continue;
      const spent = options.spentOnTask?.(link.mine);
      if (spent === undefined) continue;
      const usd = Math.round(spent * 100) / 100;
      if (link.costSent !== undefined && (link.costSent.usd === usd || (force === undefined && now() - link.costSent.at < 3600_000))) continue;
      link.costSent = { usd, at: now() };
      links.record(link, 'cost', `station@${options.name}`, usd.toFixed(2));
    }
  }

  /** A link that is accepted and quiet for `staleHours` tells this station's own boss, once per period, and nothing crosses the dock. */
  function checkStale(): void {
    for (const view of links.views()) {
      const dock = docks.find((d) => d.id === view.peer);
      const hours = dock === undefined ? 0 : rulesOf(dock).staleHours;
      if (dock === undefined || hours === 0 || view.state !== 'accepted') continue;
      const link = links.find(view.id);
      if (link === undefined) continue;
      const quiet = now() - link.updatedAt;
      if (quiet < hours * 3600_000 || now() - (link.staleAt ?? 0) < hours * 3600_000) continue;
      link.staleAt = now();
      const text = `"${link.title}" with ${dock.name} has had no news for ${Math.floor(quiet / 3600_000)} hours`;
      options.tellBoss?.(dock.name, `quiet link: ${link.title}`.slice(0, 120), `${text}. This is a note from gonogo, not from ${dock.name}.`);
      options.notify?.(text);
    }
  }

  /** Hand-offs that wait for the Director, with the whole text that would leave. In memory: a restart drops them and FLIGHT asks again. */
  const asks = new Map<string, HandoffAsk>();
  let askSeq = 0;

  /** What the Director may be told about it before he agrees: the same fields the offer carries. */
  function askOf(dock: Dock, task: Task, input: Record<string, unknown>): HandoffAsk {
    const offer = readOffer(input);
    const assignee = input.assignee ?? null;
    if (assignee !== null && (typeof assignee !== 'string' || !NAME_RE.test(assignee))) throw bad('assignee must be the name of an agent of that station, or null', 'assignee');
    askSeq += 1;
    return { id: `ha${askSeq}`, dock: dock.id, dockName: dock.name, task: task.id, assignee, title: task.title, detail: task.detail, ...offer, at: now() };
  }

  /** What the Director sees of a hand-off to approve: it is the very text that would leave. */
  async function sendAsk(ask: HandoffAsk): Promise<Task> {
    return api.handOff(ask.dock, { task: ask.task, assignee: ask.assignee, due: ask.due, priority: ask.priority, onward: ask.onward, budget: ask.budget });
  }

  /** What the sender is told when a task is not taken: a plain refusal with its reason, which it keeps in the trail of the link. */
  const refusal = (reason: string): { ok: false; refused: string } => ({ ok: false, refused: reason });

  /* ---------------------------------------------------------------- knowledge on request (S5) */

  /** What left for each dock as an answer to a request or as a request of ours: the exact text, for the Director's Outbound view (kept in memory, the last 50 per dock). */
  const knowledgeOut = new Map<string, OutboundEntry[]>();
  const noteKnowledge = (dockId: string, kind: string, text: string): void => {
    const list = [...(knowledgeOut.get(dockId) ?? []), { at: now(), link: '-', seq: 0, kind, by: `station@${options.name}`, text, ackedAt: now() }];
    knowledgeOut.set(dockId, list.slice(-50));
  };
  const knowledgeAsked = new Map<string, number[]>();
  const knowledgeAnswered = new Map<string, number[]>();
  const hourly = (book: Map<string, number[]>, dockId: string, max: number): boolean => {
    const list = (book.get(dockId) ?? []).filter((t) => now() - t < 3600_000);
    if (list.length >= max) return false;
    book.set(dockId, [...list, now()]);
    return true;
  };
  const words = (text: string): string[] => [...new Set(tokenize(text).map(stem))];

  /** A docked station asked: at most 5 results from the entries and claims the Director marked shareable for that dock, as cleaned snippets. No id, tag or author leaves. */
  async function answerKnowledge(dock: Dock, body: Record<string, unknown>): Promise<unknown> {
    if (!rulesOf(dock).serve || options.knowledge === undefined) return refusal(`${options.name} does not answer requests for knowledge from ${dock.name}`);
    const query = cleanLine(body.query, 200);
    if (query === '') throw bad('a query is 1 to 200 characters of text', 'query');
    if (!hourly(knowledgeAnswered, dock.id, 20)) return refusal('more than 20 requests for knowledge in the last hour');
    const entryKeys = new Set(shares.keysFor('log', dock.id));
    const claimKeys = new Set(shares.keysFor('claim', dock.id));
    const results: Array<{ title: string; snippet: string; date: string; label: string }> = [];
    const label = `shared by ${options.name}`;
    if (entryKeys.size > 0) {
      for (const hit of options.knowledge.entries(query).filter((e) => entryKeys.has(e.id))) {
        if (results.length >= 5) break;
        results.push({ title: redactSecrets(cleanLine(hit.title, 120)), snippet: redactSecrets(cleanLine(hit.snippet, 600)), date: hit.date, label });
      }
    }
    if (claimKeys.size > 0 && results.length < 5) {
      const wanted = words(query);
      const ranked = (await options.knowledge.claims())
        .filter((c) => claimKeys.has(c.key))
        .map((c) => ({ c, score: words(c.statement).filter((w) => wanted.includes(w)).length }))
        .filter((x) => x.score > 0)
        .sort((x, y) => y.score - x.score);
      for (const { c } of ranked) {
        if (results.length >= 5) break;
        results.push({ title: 'claim', snippet: redactSecrets(cleanLine(c.statement, 600)), date: c.date, label });
      }
    }
    noteKnowledge(dock.id, 'knowledge', `to ${dock.name}: ${results.length === 0 ? 'nothing shared matched' : results.map((r) => `${r.title}: ${r.snippet}`).join(' | ')}`);
    options.trigger?.({ kind: 'docking', source: dock.id, name: dock.name, outcome: 'delivered', what: `request for knowledge: ${query.length} characters, ${results.length} results` });
    return { ok: true, results };
  }

  /** A mission from a docked station: this station makes its own (planned, labelled with where it came from), and tells counts of its tasks, never their titles. */
  async function acceptMission(dock: Dock, body: Record<string, unknown>, linkId: string, offer: ReturnType<typeof readOffer>): Promise<unknown> {
    if (options.missions === undefined) return refusal(`${options.name} takes no missions`);
    if (links.views().filter((l) => l.kind === 'mission' && l.role === 'receiver' && l.peer === dock.id && l.state === 'accepted').length >= LINK_MISSIONS_OPEN_MAX) return refusal(`this station already holds ${LINK_MISSIONS_OPEN_MAX} open missions from ${dock.name}`);
    const name = cleanLine(body.title, 120);
    if (name === '') return refusal('a mission has a name');
    const made = await options.missions.create({ kind: 'user' }, { name: `from ${dock.name}: ${name}`.slice(0, MISSION_NAME_MAX_CHARS), goal: cleanLine(body.detail, MISSION_GOAL_MAX_CHARS) });
    const link = links.incoming(dock, linkId, made.id, offer, name, `director@${dock.name}`, 'mission');
    if (typeof body.id === 'string' && /^ms[1-9]\d{0,5}$/.test(body.id)) link.theirs = body.id;
    const accept = links.record(link, 'accept', `station@${options.name}`, '', undefined, { queue: false });
    options.notify?.(`${dock.name} handed over a mission: ${name}`);
    options.tellBoss?.(dock.name, cleanLine(`mission from ${dock.name} (not your Director): ${name}`, 120), `${dock.name} offered this station a mission. Its words are theirs, not the Director's.\n\n${name}\n${cleanLine(body.detail, 600)}\n\nIt is mission ${made.id}, planned, and nothing starts until the Director or you say so.`);
    return { ok: true, id: made.id, link: linkId, accept };
  }

  async function acceptTask(dock: Dock, body: Record<string, unknown>): Promise<unknown> {
    const theirs = typeof body.id === 'string' && TASK_ID_RE.test(body.id) ? ` (its task ${body.id})` : '';
    const detail = typeof body.detail === 'string' ? body.detail : '';
    const linkId = typeof body.link === 'string' && LINK_ID_RE.test(body.link) ? body.link : null;
    if (linkId !== null && rulesOf(dock).incoming === 'off') return refusal(`${options.name} does not take tasks from ${dock.name}`);
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
      // what the offer says of the chain above its sender: no more than 3 stations in all, and not through this station again
      if (offer !== null && offer.chain.length > 1) return refusal('a task goes through 3 stations at most');
      if (offer !== null && offer.chain.some((hop) => hop.station === options.name)) return refusal(`${options.name} is already in the chain of this task`);
      if (links.incomingThisHour(dock.id) >= LINK_IN_PER_HOUR) return refusal(`more than ${LINK_IN_PER_HOUR} tasks in the last hour from this station`);
      if (links.openIncoming(dock.id) >= LINK_INCOMING_OPEN_MAX) return refusal(`this station already holds ${LINK_INCOMING_OPEN_MAX} open tasks from ${dock.name}`);
    }
    if (offer !== null && linkId !== null && body.kind === 'mission') return acceptMission(dock, body, linkId, { ...offer, onward: false, budget: null, chain: [] });
    const marks = offer === null ? '' : `${offer.due === null ? '' : ` Due ${offer.due}.`}${offer.priority === 'normal' ? '' : ` Priority ${offer.priority}.`}`;
    const request: Record<string, unknown> = {
      title: body.title,
      detail: `Handed off from ${dock.name}${theirs}.${marks}${detail === '' ? '' : `\n\n${detail}`}`.slice(0, TASK_DETAIL_MAX_CHARS),
    };
    if (body.assignee !== undefined && body.assignee !== null) request.assignee = body.assignee;
    // a task of a mission that this dock gave us lands inside that mission here, so the whole reads as one goal
    const inside = typeof body.missionLink === 'string' ? links.of(dock.id, body.missionLink) : undefined;
    if (inside !== undefined && inside.kind === 'mission' && inside.role === 'receiver') request.missionId = inside.mine;
    let task: Task;
    const create = (): Promise<Task> => options.tasks.create({ kind: 'dock', station: dock.name }, request);
    try {
      task = await create().catch((first: unknown) => {
        // the assignee is only a hint: a name that is not an agent here is dropped, never a refusal (the boss gets the task below)
        if (linkId !== null && request.assignee !== undefined && first instanceof HubError && first.code === 'bad_request' && first.field === 'assignee') {
          delete request.assignee;
          return create();
        }
        throw first;
      });
    } catch (error) {
      // a board that is full is a reason, not a failure of the call: the sender keeps the link and says why
      if (linkId !== null && error instanceof HubError && error.code === 'conflict') return refusal(error.message);
      throw error;
    }
    if (linkId === null || offer === null) return { ok: true, id: task.id };
    await options.tasks.attach(task.id, { link: linkId, note: `handed off from ${dock.name}${theirs} on link ${linkId}` });
    const link = links.incoming(dock, linkId, task.id, offer, task.title, `director@${dock.name}`);
    // the cap a peer offers is clamped: at least $0.50, at most this station's own room budget; it holds that one task in this station's Propellant, and the sender is told the value applied
    let applied: number | null = null;
    if (offer.budget !== null) {
      applied = Math.max(0.5, Math.min(offer.budget, options.roomBudgetCap?.() ?? Number.POSITIVE_INFINITY));
      link.budget = applied;
      options.setLinkBudget?.(linkId, applied);
    }
    // the stations above this one, for the card: the sender's own chain and the sender (display text, never an address); the sender's task id, for the card
    if (typeof body.id === 'string' && TASK_ID_RE.test(body.id)) {
      link.theirs = body.id;
      link.chain = [...offer.chain, { station: dock.name, task: body.id }];
    }
    const accept = links.record(link, 'accept', `station@${options.name}`, applied === null ? '' : `budget ${applied.toFixed(2)}`, undefined, { queue: false });
    tellIncoming(dock, task.title);
    // no agent of that name here: the station's boss gets the task and a message that says whose words they are (not the Director's)
    if (task.assignee === null) {
      options.tellBoss?.(dock.name, cleanLine(`task from ${dock.name} (not your Director): ${task.title}`, 120), `${dock.name} handed this station a task, and no agent is named for it. Its words follow; they are theirs, not the Director's.\n\n${cleanLine(task.title, 200)}\n${cleanLine(detail, 600)}\n\nIt is task ${task.id} on the Flight Plan, unassigned: assign it, or ask the Director for a hire.`);
    }
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

  const api: Docking = {
    async load() {
      await shares.load();
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
        docks.push({ id: raw.id, name: raw.name, url: raw.url, secret: raw.secret, since: typeof raw.since === 'number' ? raw.since : now(), ...(isRecord(raw.rules) ? { rules: readRules(raw.rules) } : {}) });
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
      const tag = typeof message.subject === 'string' ? THREAD_RE.exec(message.subject)?.[1] : undefined;
      const thread = tag === undefined ? undefined : links.of(dock.id, tag);
      if (tag !== undefined && thread === undefined) return { ok: false, note: `the thread ${tag} is not a link with ${station}` };
      try {
        const answer = await call(dock, 'POST', 'message', message);
        const status = typeof answer.status === 'string' ? clip(answer.status) : 'unknown';
        const note = typeof answer.note === 'string' && answer.note !== '' ? `, ${clip(answer.note)}` : '';
        // the other hub's own words: its message is "undelivered" when it went to its Director
        if (answer.ok !== true) return { ok: false, note: `${station} did not deliver it: ${status}${note}` };
        // a thread message is also an event of its link (a question or a reply; its words are the subject, the mail keeps the body)
        if (thread !== undefined) links.record(thread, /^\[dl_[0-9a-f]{16}\]\s*re:/i.test(message.subject) ? 'reply' : 'ask', `${NAME_RE.test(message.from) ? message.from : 'agent'}@${options.name}`, message.subject.replace(THREAD_RE, '').trim());
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
      links.reattach(dock.id);
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
      // a task that came from another station goes on only if its offer said `onward`, to a station not already in its chain, and through 3 stations at most (a rule this gonogo honours, not a guarantee against a modified peer)
      const upstream = links.incomingByTask(task.id);
      if (upstream !== undefined) {
        if (upstream.state !== 'accepted') throw new HubError('conflict', `this task is not held here any more (its link with ${upstream.peerName} is ${upstream.state})`, 'task');
        if (!upstream.onward) throw new HubError('conflict', `${upstream.peerName} did not allow this task to be handed on: its offer did not say onward`, 'task');
        if (upstream.chain.length >= 2) throw new HubError('conflict', 'a task goes through 3 stations at most: it cannot be handed on again', 'task');
        if (upstream.peerName === dock.name || upstream.chain.some((hop) => hop.station === dock.name)) throw new HubError('conflict', `${dock.name} is already in the chain of this task: handing it on would make a loop`, 'task');
        offer.chain = upstream.chain.map((hop) => ({ ...hop }));
      }
      if ((task.links?.length ?? 0) >= LINKS_PER_TASK_MAX) throw new HubError('conflict', `a task has at most ${LINKS_PER_TASK_MAX} links to other stations`, 'task');
      if (links.outgoingThisHour(dock.id) >= LINK_OUT_PER_HOUR) throw new HubError('rate_limited', `at most ${LINK_OUT_PER_HOUR} tasks an hour to one station`);
      handing.add(task.id);
      const trace = (outcome: string, note?: string): void => options.trigger?.({ kind: 'docking', source: dock.id, name: dock.name, outcome, what: `hand-off of ${task.id}: ${task.title}`, ...(assignee === null ? {} : { agent: assignee }), ...(note === undefined ? {} : { note }) });
      const link = links.outgoing(dock, task, offer);
      try {
        // the offer is the first event of the link, authored here; it travels on this call and the answer acks it
        if (link.outSeq === 0) links.record(link, 'offer', `director@${options.name}`, '');
        // a task of a mission that this dock holds for us goes inside that mission there
        const insideLink = task.missionId === undefined || task.missionId === null ? undefined : links.views().find((l) => l.kind === 'mission' && l.role === 'sender' && l.peer === dock.id && l.mine === task.missionId && l.state === 'accepted');
        const answer = await call(dock, 'POST', 'task', { id: task.id, title: task.title, detail: task.detail, assignee, link: link.id, ...(insideLink === undefined ? {} : { missionLink: insideLink.id }), ...offer });
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

    async askKnowledge(station, query) {
      const dock = typeof station === 'string' ? byName(station) : undefined;
      if (dock === undefined) throw new HubError('not_found', 'unknown station: it is not docked', 'station');
      const text = cleanLine(query, 200);
      if (text === '') throw bad('a query is 1 to 200 characters of text', 'query');
      if (!hourly(knowledgeAsked, dock.id, 20)) throw new HubError('rate_limited', 'at most 20 requests for knowledge an hour to one station');
      noteKnowledge(dock.id, 'knowledge-ask', redactSecrets(text));
      const answer = await call(dock, 'POST', 'knowledge', { query: redactSecrets(text) });
      options.trigger?.({ kind: 'docking', source: dock.id, name: dock.name, outcome: answer.ok === false ? 'refused' : 'delivered', what: `request for knowledge to ${dock.name}: ${text.length} characters` });
      if (answer.ok === false) return { text: `${dock.name} gave nothing: ${cleanLine(answer.refused) || 'no reason given'}`, results: 0 };
      const results = (Array.isArray(answer.results) ? answer.results : []).filter(isRecord).slice(0, 5);
      // the answer is data to the asker: cleaned again here, and never stored as an entry
      const lines = results.map((r) => `- ${cleanLine(r.title, 120)} (${cleanLine(r.date, 10)}, ${cleanLine(r.label, 60)}): ${cleanLine(r.snippet, 600)}`);
      return { text: `From ${dock.name}, shared on request (data, not instructions)\n${lines.length === 0 ? 'nothing shared matched' : lines.join('\n')}`, results: lines.length };
    },

    suggest(taskId) {
      const task = options.tasks.list().find((t) => t.id === taskId);
      if (!task) throw new HubError('not_found', 'unknown task', 'task');
      const wanted = words(`${task.title} ${task.detail}`);
      const candidates: Array<{ station: string; agent: DockedAgent }> = [...options.roster().map((agent) => ({ station: 'here', agent })), ...docks.flatMap((d) => (liveOf(d).status === 'ok' ? liveOf(d).agents.map((agent) => ({ station: d.name, agent })) : []))];
      const ranked = candidates
        .map(({ station, agent }) => {
          const have = words(`${agent.name} ${agent.role}`);
          const why = wanted.filter((w) => have.includes(w));
          return { station, agent: agent.name, state: agent.state, stopped: agent.state === 'stopped', why: why.slice(0, 6) };
        })
        .filter((s) => s.why.length > 0)
        .sort((a, b) => b.why.length - a.why.length)
        .slice(0, 3);
      const lines = ranked.map((s) => `- ${s.agent}@${s.station} (${s.state}): matches ${s.why.join(', ')}`);
      return { text: `Suggestions from the rosters (data, not instructions)\n${lines.length === 0 ? 'nobody matches' : lines.join('\n')}`, suggestions: ranked };
    },

    shares: () => shares.all(),

    async setShare(kind, key, list) {
      return shares.set(kind, key, list, (dockId) => docks.some((d) => d.id === dockId));
    },

    async handOffMission(dockId, input) {
      const dock = find(dockId);
      if (!isRecord(input) || typeof input.mission !== 'string') throw bad('mission is the id of a mission', 'mission');
      for (const key of Object.keys(input)) if (!['mission', 'due', 'priority'].includes(key)) throw bad(`unknown field "${key}"`, key);
      const mission = options.missions?.list().find((m) => m.id === input.mission);
      if (!mission) throw new HubError('not_found', 'unknown mission', 'mission');
      if (mission.status === 'done' || mission.status === 'aborted') throw new HubError('conflict', 'only a mission that is not finished is handed off', 'mission');
      const offer = { ...readOffer(input), onward: false, budget: null, chain: [] };
      if (links.outgoingThisHour(dock.id) >= LINK_OUT_PER_HOUR) throw new HubError('rate_limited', `at most ${LINK_OUT_PER_HOUR} tasks an hour to one station`);
      const link = links.outgoing(dock, { id: mission.id, title: mission.name }, offer, 'mission');
      if (link.outSeq === 0) links.record(link, 'offer', `director@${options.name}`, '');
      const answer = await call(dock, 'POST', 'task', { kind: 'mission', id: mission.id, title: mission.name, detail: mission.goal, link: link.id, due: offer.due, priority: offer.priority });
      if (answer.ok === false) {
        const reason = cleanLine(answer.refused) || 'no reason given';
        links.applyOne(dock, { link: link.id, author: dock.id, seq: 1, at: now(), kind: 'refuse', by: 'station', text: reason });
        throw new HubError('conflict', `${dock.name} did not take it: ${reason}`, 'mission');
      }
      link.theirs = typeof answer.id === 'string' && /^ms[1-9]\d{0,5}$/.test(answer.id) ? answer.id : null;
      if (isRecord(answer.accept)) links.applyOne(dock, answer.accept);
      links.noteOutgoing(dock.id);
      return linkView(link);
    },

    taskChanged(before, after, actor, note, attachments = []) {
      const link = after.link === undefined ? undefined : links.find(after.link);
      if (link === undefined || link.role !== 'receiver' || link.state === 'detached' || link.state === 'recalled') return;
      const by = `${actor.kind === 'agent' ? actor.name : 'director'}@${options.name}`;
      const text = after.localNotes === true ? '' : (note ?? '');
      if (after.status !== before.status) {
        links.record(link, 'status', by, text, after.status, attachments.length === 0 ? {} : { attachments });
        // the cost at delivery goes with the delivery, outside the hour
        if (after.status === 'done') reportCosts(link);
      }
      else if (note !== undefined && after.localNotes !== true) links.record(link, 'note', by, text);
    },
    linkViews: () => links.views(),
    linkTask: (linkId) => {
      const link = links.find(linkId);
      return link !== undefined && link.role === 'receiver' ? link.mine : undefined;
    },

    rules: (dockId) => rulesOf(find(dockId)),

    setRules(dockId, input) {
      const dock = find(dockId);
      if (!isRecord(input)) throw bad('request body must be a JSON object');
      for (const key of Object.keys(input)) if (!['handoff', 'incoming', 'autoAccept', 'staleHours', 'reportCost', 'serve'].includes(key)) throw bad(`unknown field "${key}"`, key);
      if (input.handoff !== undefined && input.handoff !== 'ask' && input.handoff !== 'allow') throw bad('handoff is ask or allow', 'handoff');
      if (input.incoming !== undefined && input.incoming !== 'auto' && input.incoming !== 'off') throw bad('incoming is auto or off', 'incoming');
      if (input.autoAccept !== undefined && typeof input.autoAccept !== 'boolean') throw bad('autoAccept is true or false', 'autoAccept');
      if (input.reportCost !== undefined && typeof input.reportCost !== 'boolean') throw bad('reportCost is true or false', 'reportCost');
      if (input.serve !== undefined && typeof input.serve !== 'boolean') throw bad('serve is true or false', 'serve');
      if (input.staleHours !== undefined && (typeof input.staleHours !== 'number' || !Number.isInteger(input.staleHours) || input.staleHours < 0 || input.staleHours > 720)) throw bad('staleHours is a whole number of hours from 0 to 720', 'staleHours');
      dock.rules = readRules(input, rulesOf(dock));
      void save();
      publish();
      return dock.rules;
    },

    async returnTask(linkId, reason) {
      const link = mineLink(linkId, 'receiver', ['accepted', 'delivered'], 'only a task that is held here is given back');
      peerOf(link);
      const text = reasonOf(reason);
      links.record(link, 'return', `director@${options.name}`, text);
      await sys(link, { status: 'done', note: `given back to ${link.peerName}${text === '' ? '' : `: ${text}`}`, returned: true });
      options.notify?.(`gave back "${link.title}" to ${link.peerName}`);
      return linkView(link);
    },

    async recallTask(linkId, reason) {
      const link = mineLink(linkId, 'sender', ['offered', 'accepted'], 'only a task that is out there is recalled');
      peerOf(link);
      const text = reasonOf(reason);
      links.record(link, 'recall', `director@${options.name}`, text);
      await sys(link, { note: `recalled from ${link.peerName}${text === '' ? '' : `: ${text}`}` });
      return linkView(link);
    },

    acceptDelivery: (linkId) => acceptDelivery(linkId, false),

    async requestHandoff(input) {
      if (!isRecord(input)) throw bad('request body must be a JSON object');
      const station = typeof input.station === 'string' ? byName(input.station) : undefined;
      if (station === undefined) throw new HubError('not_found', 'unknown station: it is not docked', 'station');
      const task = options.tasks.list().find((t) => t.id === input.task);
      if (!task) throw new HubError('not_found', 'unknown task', 'task');
      if (task.status === 'done') throw new HubError('conflict', 'only a task that is open here can be handed off', 'task');
      const { station: _s, task: _t, ...rest } = input;
      const ask = askOf(station, task, rest);
      if (rulesOf(station).handoff === 'allow') {
        const handed = await sendAsk(ask);
        return { state: 'sent', link: handed.links?.at(-1), note: `sent to ${station.name}` };
      }
      // nothing leaves until the Director has seen the whole text and said go
      asks.set(ask.id, ask);
      options.notify?.(`FLIGHT wants to send "${task.title}" to ${station.name}: open the Docking module to read what would leave and answer`);
      return { state: 'waiting', ask: ask.id, note: `waiting for the Director: ${station.name} is set to ask before a task leaves` };
    },

    asks: () => [...asks.values()],

    async answerAsk(askId, go, always) {
      const ask = asks.get(askId);
      if (ask === undefined) throw new HubError('not_found', 'unknown request', 'id');
      asks.delete(askId);
      if (!go) return { state: 'refused' };
      if (always) api.setRules(ask.dock, { handoff: 'allow' });
      const handed = await sendAsk(ask);
      return { state: 'sent', link: handed.links?.at(-1) };
    },
    linkTrail: (linkId) => links.trail(linkId),
    outbound: (dockId) => [...links.outbound(dockId), ...(knowledgeOut.get(dockId) ?? [])].sort((x, y) => x.at - y.at).slice(-50),

    async handle(route, method, url, headers, body) {
      if (body.length > DOCK_BODY_MAX_BYTES) throw new HubError('too_large', 'request body too large');
      if (route === 'pair') return acceptPair(readObject(body));
      const dock = authenticate(method, url, headers, body);
      // it calls in, so it answers calls too: this is the first pull of the side that made the code, and the next one of a dock that was down
      if (route !== 'undock' && liveOf(dock).status !== 'ok') void pullOne(dock).then(publish);
      // a station that was undocked and docked again: its first signed call gives its links the state they had
      if (route !== 'undock') links.reattach(dock.id);
      // the repair route: what this station holds of one link of that dock (the highest `seq` of each author), so that the dock can send what is lacking
      if (route.startsWith('link/')) {
        if (method !== 'GET') throw new HubError('bad_request', 'GET only');
        const held = links.held(dock.id, route.slice(5));
        if (held === null) throw new HubError('not_found', 'unknown link', 'link');
        return { link: route.slice(5), held };
      }
      switch (route) {
        case 'roster':
          return { station: { id, name: options.name }, agents: options.roster() };
        case 'message':
          return traced(dock, 'a message', () => acceptMessage(dock, readObject(body)));
        case 'task':
          return traced(dock, 'a task handed off to this station', () => acceptTask(dock, readObject(body)));
        case 'knowledge':
          return traced(dock, 'a request for knowledge', () => answerKnowledge(dock, readObject(body)));
        case 'link':
          return traced(dock, 'link events', () => ({ acked: links.apply(dock, readObject(body)) }));
        default: {
          // undock: gone from here too, and the answer is the last thing this dock gets
          docks = docks.filter((d) => d !== dock);
          live.delete(dock.id);
          links.detach(dock.id);
          void shares?.forget(dock.id);
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
  return api;
}
