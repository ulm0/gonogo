import { createHash, timingSafeEqual } from 'node:crypto';
import type { Stats } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { extname, join, resolve as resolvePath, sep } from 'node:path';
import type { Duplex } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import { PERMISSION_MODES, PROVIDERS, WS_BINARY_OUTPUT, WS_SUBPROTOCOL, WS_TOKEN_PROTOCOL_PREFIX } from '../shared/protocol.js';
import type {
  PropellantView,
  AgentIdentity,
  AnswerRequest,
  ApiErrorCode,
  Attachment,
  EditRequest,
  EngineCheck,
  ErrorFrame,
  GovernorRequest,
  HireRequest,
  HubEvent,
  Hub,
  InputEffect,
  Logger,
  OutputListener,
  PermissionMode,
  PollRequest,
  Provider,
  ServerFrame,
  ServerInfo,
  StateSnapshot,
  TerminalHost,
  UserMessageRequest,
} from '../shared/protocol.js';
import {
  AGENT_NAME_PATTERN,
  CLEAN_ROOM_HOST,
  MAX_COLS,
  MAX_REST_BODY_BYTES,
  MAX_ROWS,
  MIN_COLS,
  MIN_ROWS,
  UPLINK_BODY_MAX_BYTES,
  DOCK_BODY_MAX_BYTES,
  WS_CLOSE_BACKPRESSURE,
  WS_CLOSE_GOING_AWAY,
  WS_MAX_BUFFERED_BYTES,
  WS_MAX_FRAME_BYTES,
  WS_PING_INTERVAL_MS,
} from './constants.js';
import {
  bearerToken,
  createHookHandler,
  hubErrorInfo,
  isRecord,
  readBody,
  sendApiError,
  sendJson,
  sendMethodNotAllowed,
  sendNotFound,
  sendText,
  sendUnauthorized,
} from './hooks.js';
import { readCustomCommand } from './command.js';
import type { Downlink } from './downlink.js';
import { DOCK_ROUTES } from './docking.js';
import type { Docking } from './docking.js';
import { createMcpHandler } from './mcp.js';
import { parsePropellantRequest } from './propellant.js';
import type { Liveries } from './livery.js';
import type { MassBudget } from './massbudget.js';
import type { MissionLog } from './missionlog.js';
import type { Propellant } from './propellant.js';
import type { Telemetry } from './telemetry.js';
import type { Relay } from './relay.js';
import type { Relief } from './relief.js';
import type { Rollout } from './rollout.js';
import type { Schedules } from './schedules.js';
import type { Tasks } from './tasks.js';
import type { Uplinks } from './uplinks.js';

export interface WebOptions {
  /** Bind address. */
  host: string;
  /** 0 = any free port. */
  port: number;
  browserToken: string;
  /** Extra Host header names (contract 3.2); loopback names are always allowed. */
  allowedHosts: string[];
  /** Built client; null = serve no static files. */
  staticDir: string | null;
  hub: Hub;
  terminals: TerminalHost;
  resolveToken(token: string): AgentIdentity | null;
  info: () => ServerInfo;
  /** false until hub.start() has resolved: /api and /ws answer 503 meanwhile. */
  isReady: () => boolean;
  /** Token use and limits; absent in tests that do not need them (the snapshot then shows no use and no limits). */
  propellant?: Pick<Propellant, 'view' | 'setLimits'>;
  /** Telemetry: GET /api/agents/:name/telemetry. Without it the list is empty. */
  telemetry?: Pick<Telemetry, 'calls'>;
  /** Launch Window; absent in tests that do not need it (the snapshot then lists none and the routes answer 404). It tells the browsers itself. */
  schedules?: Pick<Schedules, 'list' | 'create' | 'update' | 'remove' | 'run'>;
  /** Uplink; absent in tests that do not need it (the snapshot then lists none and the routes answer 404). It tells the browsers itself. */
  uplinks?: Pick<Uplinks, 'list' | 'create' | 'update' | 'remove' | 'rotate' | 'test' | 'deliver'>;
  /** Flight Plan; absent in tests that do not need it (the snapshot then lists none, the routes answer 404 and the task tools say it is not available). It tells the browsers itself. */
  tasks?: Pick<Tasks, 'list' | 'create' | 'update' | 'remove'>;
  /** Downlink; absent in tests that do not need it (the snapshot then shows an empty inbox and the routes answer 404). It tells the browsers itself. */
  downlink?: Pick<Downlink, 'view' | 'read' | 'archive' | 'readAll'>;
  /** Mission Log; absent in tests that do not need it (the routes answer 404 and the log tools say it is not available). It tells the browsers itself. */
  missionLog?: Pick<MissionLog, 'search' | 'get' | 'chart' | 'create' | 'update' | 'remove'>;
  /** Mass Budget; absent in tests that do not need it (the routes answer 404). The page asks; no frame. */
  massBudget?: Pick<MassBudget, 'view' | 'reflect'>;
  /** Livery; absent in tests that do not need it (the snapshot then has no livery, the routes answer 404 and the livery tool says it is not available). It tells the browsers itself. */
  liveries?: Pick<Liveries, 'view' | 'select' | 'remove' | 'submit' | 'design'>;
  /** Relay; absent in tests that do not need it (the routes answer 404). The page asks again after each change; no frame. */
  relay?: Pick<Relay, 'view' | 'set' | 'remove' | 'forward' | 'test'>;
  /** Docking; absent in tests that do not need it (the snapshot then has no docks, the routes and /dock answer 404). It tells the browsers itself. */
  docking?: Pick<Docking, 'view' | 'createCode' | 'pair' | 'undock' | 'handOff' | 'handle'>;
  /** Relief; absent in tests that do not need it (the snapshot then has none, the routes answer 404 and the hire tool says it is not available). It tells the browsers itself. */
  relief?: Pick<Relief, 'request' | 'view' | 'decide'>;
  /** Rollout; absent in tests that do not need it (the snapshot then has none). It tells the browsers itself. */
  rollout?: Pick<Rollout, 'view'>;
  /** Pad Check: where each engine is and what it calls itself; absent in tests that do not need it (the route answers 404). */
  engines?: () => Promise<EngineCheck[]>;
  log: Logger;
}

const NO_PROPELLANT: PropellantView = {
  room: { used: { '5h': 0, day: 0, week: 0, month: 0 }, limits: {} },
  agents: {},
};

export interface WebServer {
  /** Rejects on EADDRINUSE and the like; resolves with the first bind. */
  listen(): Promise<{ host: string; port: number }>;
  /** Closes sockets (WebSocket code 1001) and the server(s). Idempotent. */
  close(): Promise<void>;
  /** To every connected WebSocket (all of them passed the token check). */
  broadcast(event: HubEvent): void;
}

const ERROR_STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  too_large: 413,
  unsupported: 415,
  internal: 500,
  unavailable: 503,
  rate_limited: 429,
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const STATUS_TEXT: Record<number, string> = {
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  503: 'Service Unavailable',
};

/** A terminal size in cells. Every client remembers the last one it sent or attached with: that is the size a keystroke of its own claims (contract 3.4). */
interface Size {
  cols: number;
  rows: number;
}

interface Client {
  ws: WebSocket;
  /** Cleared by every ping, set by the pong: a socket that is still false at the next ping is dead. */
  alive: boolean;
  /** Set once the snapshot went out; size frames and input only concern this agent. */
  attached: { agent: string; seq: number } | null;
  attachment: Attachment | null;
  /** Bumped by every attach, detach and close; an attach that finds another value when its snapshot arrives gives up. */
  attachToken: number;
  size: Size | null;
  closed: boolean;
}

type RouteKind = 'api' | 'hook' | 'mcp' | 'uplink' | 'dock' | 'ws' | 'static';

interface ApiRoute {
  allow: readonly string[];
  run: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string; field: string };

const noop = (): void => undefined;

const sha256 = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();

function isPermissionMode(x: unknown): x is PermissionMode {
  return typeof x === 'string' && (PERMISSION_MODES as readonly string[]).includes(x);
}

/** Host part of a Host header (port stripped, brackets removed, lower-cased), or null when it is not host[:port]. Exported for the tests. */
export function hostName(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (v === '') return null;
  if (v.startsWith('[')) {
    const end = v.indexOf(']');
    if (end < 2) return null;
    const rest = v.slice(end + 1);
    return rest === '' || /^:\d{1,5}$/.test(rest) ? v.slice(1, end) : null;
  }
  const colon = v.indexOf(':');
  if (colon === -1) return v;
  // an IPv6 address without brackets cannot carry a port, so it is not a valid Host value
  if (v.indexOf(':', colon + 1) !== -1) return null;
  return /^\d{1,5}$/.test(v.slice(colon + 1)) ? v.slice(0, colon) : null;
}

/** An allow-list entry or the bind host, in the same form hostName gives for a Host header. */
function listedHost(entry: string): string {
  return hostName(entry) ?? entry.trim().toLowerCase();
}

const WILDCARD_HOSTS = ['0.0.0.0', '::'];
const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost'];

/** A specific bind address that is not loopback also needs a 127.0.0.1 listener: agents are only ever told the loopback URL (contract 2.7). Exported for the tests. */
export function needsLoopbackTwin(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return !WILDCARD_HOSTS.includes(h) && !LOOPBACK_HOSTS.includes(h);
}

/**
 * The decoded path segments of a request target, or null for anything the server will not look at: no leading slash, a
 * leading `//`, bad percent-encoding, a NUL byte. Never goes through `new URL` (it throws on `//` and `//[`, contract 3.2).
 */
function parseTarget(rawUrl: string | undefined): string[] | null {
  const url = rawUrl ?? '';
  const q = url.indexOf('?');
  const path = q === -1 ? url : url.slice(0, q);
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\0')) return null;
  const segments: string[] = [];
  for (const raw of path.slice(1).split('/')) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (segment.includes('\0')) return null;
    segments.push(segment);
  }
  return segments;
}

function classify(segments: string[]): RouteKind {
  switch (segments[0]) {
    case 'api':
      return 'api';
    case 'hook':
      return 'hook';
    case 'mcp':
      return 'mcp';
    case 'uplink':
      return 'uplink';
    case 'dock':
      return 'dock';
    case 'ws':
      return 'ws';
    default:
      return 'static';
  }
}

const ALLOW_BY_KIND: Record<RouteKind, string> = {
  api: 'GET, POST, PATCH, DELETE',
  hook: 'POST',
  mcp: 'POST',
  uplink: 'POST',
  dock: 'GET, POST',
  ws: 'GET',
  static: 'GET, HEAD',
};

function fitSize(cols: unknown, rows: unknown): Size | null {
  if (typeof cols !== 'number' || typeof rows !== 'number' || !Number.isInteger(cols) || !Number.isInteger(rows)) return null;
  return { cols: Math.min(MAX_COLS, Math.max(MIN_COLS, cols)), rows: Math.min(MAX_ROWS, Math.max(MIN_ROWS, rows)) };
}

function fieldError(field: string, expected: string): { ok: false; error: string; field: string } {
  return { ok: false, error: `${field} must be ${expected}`, field };
}

function isProvider(x: unknown): x is Provider {
  return typeof x === 'string' && (PROVIDERS as readonly string[]).includes(x);
}

/** A command the launcher could not read is refused here, so nothing is hired or saved for it. */
function commandProblem(command: string): { ok: false; error: string; field: string } | null {
  try {
    readCustomCommand(command);
    return null;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), field: 'command' };
  }
}

function parseHire(o: Record<string, unknown>): Parsed<HireRequest> {
  const { name, role, dir, mode, confirmBypass, position, provider, command, payload, cleanRoom, model, keys } = o;
  if (typeof name !== 'string') return fieldError('name', 'a string');
  if (typeof role !== 'string') return fieldError('role', 'a string');
  if (typeof dir !== 'string') return fieldError('dir', 'a string');
  if (!isPermissionMode(mode)) return fieldError('mode', `one of ${PERMISSION_MODES.join(', ')}`);
  if (confirmBypass !== undefined && typeof confirmBypass !== 'boolean') return fieldError('confirmBypass', 'true or false');
  const value: HireRequest = { name, role, dir, mode };
  if (confirmBypass !== undefined) value.confirmBypass = confirmBypass;
  if (position !== undefined) {
    if (typeof position !== 'string') return fieldError('position', 'a string');
    value.position = position;
  }
  if (provider !== undefined) {
    if (!isProvider(provider)) return fieldError('provider', `one of ${PROVIDERS.join(', ')}`);
    value.provider = provider;
  }
  if (command !== undefined) {
    if (typeof command !== 'string') return fieldError('command', 'a string');
    const problem = commandProblem(command);
    if (problem) return problem;
    value.command = command;
  }
  // The hub reads the inside of a payload and names the field that is wrong.
  if (payload !== undefined) {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return fieldError('payload', 'an object');
    value.payload = payload;
  }
  if (cleanRoom !== undefined) {
    if (typeof cleanRoom !== 'object' || cleanRoom === null || Array.isArray(cleanRoom)) return fieldError('cleanRoom', 'an object');
    value.cleanRoom = cleanRoom;
  }
  // The hub reads the text of a model and the inside of keys, and names the field that is wrong.
  if (model !== undefined) {
    if (typeof model !== 'string') return fieldError('model', 'a string');
    value.model = model;
  }
  if (keys !== undefined) {
    if (!isRecord(keys)) return fieldError('keys', 'an object');
    value.keys = keys as Record<string, string>;
  }
  return { ok: true, value };
}

function parsePoll(o: Record<string, unknown>): Parsed<PollRequest> {
  const value: PollRequest = {};
  if (o.agents !== undefined) {
    if (!Array.isArray(o.agents) || !o.agents.every((a) => typeof a === 'string')) return fieldError('agents', 'a list of names');
    value.agents = o.agents as string[];
  }
  if (o.subject !== undefined) {
    if (typeof o.subject !== 'string') return fieldError('subject', 'text');
    value.subject = o.subject;
  }
  return { ok: true, value };
}

function parseGovernor(o: Record<string, unknown>): Parsed<GovernorRequest> {
  // range (1 to MAX_AGENTS) is the hub's to judge; here only the type
  if (o.limit !== null && (typeof o.limit !== 'number' || !Number.isInteger(o.limit))) return fieldError('limit', 'a whole number or null');
  return { ok: true, value: { limit: o.limit } };
}

function parseAnswer(o: Record<string, unknown>): Parsed<AnswerRequest> {
  if (typeof o.go !== 'boolean') return fieldError('go', 'true or false');
  return { ok: true, value: { go: o.go } };
}

function parseEdit(o: Record<string, unknown>): Parsed<EditRequest> {
  const value: EditRequest = {};
  for (const key of ['name', 'role', 'dir'] as const) {
    const v = o[key];
    if (v === undefined) continue;
    if (typeof v !== 'string') return fieldError(key, 'a string');
    value[key] = v;
  }
  if (o.mode !== undefined) {
    if (!isPermissionMode(o.mode)) return fieldError('mode', `one of ${PERMISSION_MODES.join(', ')}`);
    value.mode = o.mode;
  }
  if (o.confirmBypass !== undefined) {
    if (typeof o.confirmBypass !== 'boolean') return fieldError('confirmBypass', 'true or false');
    value.confirmBypass = o.confirmBypass;
  }
  if (o.position !== undefined) {
    if (o.position !== null && typeof o.position !== 'string') return fieldError('position', 'a string or null');
    value.position = o.position;
  }
  if (o.command !== undefined) {
    if (typeof o.command !== 'string') return fieldError('command', 'a string');
    const problem = commandProblem(o.command);
    if (problem) return problem;
    value.command = o.command;
  }
  if (o.payload !== undefined) {
    if (o.payload !== null && (typeof o.payload !== 'object' || Array.isArray(o.payload))) return fieldError('payload', 'an object or null');
    value.payload = o.payload;
  }
  if (o.cleanRoom !== undefined) {
    if (o.cleanRoom !== null && (typeof o.cleanRoom !== 'object' || Array.isArray(o.cleanRoom))) return fieldError('cleanRoom', 'an object or null');
    value.cleanRoom = o.cleanRoom;
  }
  if (o.model !== undefined) {
    if (o.model !== null && typeof o.model !== 'string') return fieldError('model', 'a string or null');
    value.model = o.model;
  }
  if (o.keys !== undefined) {
    if (!isRecord(o.keys)) return fieldError('keys', 'an object');
    value.keys = o.keys as Record<string, string | null>;
  }
  return { ok: true, value };
}

function parseUserMessage(o: Record<string, unknown>): Parsed<UserMessageRequest> {
  const { to, subject, body, inReplyTo } = o;
  if (typeof to !== 'string') return fieldError('to', 'a string');
  if (typeof body !== 'string') return fieldError('body', 'a string');
  if (subject !== undefined && typeof subject !== 'string') return fieldError('subject', 'a string');
  if (inReplyTo !== undefined && typeof inReplyTo !== 'string') return fieldError('inReplyTo', 'a string');
  const value: UserMessageRequest = { to, body };
  if (subject !== undefined) value.subject = subject;
  if (inReplyTo !== undefined) value.inReplyTo = inReplyTo;
  return { ok: true, value };
}

function rawToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

/** Answers an upgrade request that must not become a WebSocket: a plain HTTP response, then the socket goes. */
function rejectUpgrade(socket: Duplex, status: number, contentType: string, body: string, extra: string[] = []): void {
  const head = [
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}`,
    'Connection: close',
    `Content-Type: ${contentType}`,
    `Content-Length: ${Buffer.byteLength(body)}`,
    'X-Content-Type-Options: nosniff',
    'Referrer-Policy: no-referrer',
    'X-Frame-Options: DENY',
    ...extra,
  ];
  socket.once('finish', () => socket.destroy());
  socket.end(head.join('\r\n') + '\r\n\r\n' + body);
}

export function createWebServer(options: WebOptions): WebServer {
  const { hub, terminals, log } = options;
  const nameRe = new RegExp(AGENT_NAME_PATTERN);
  const tokenDigest = sha256(options.browserToken);
  const hookHandler = createHookHandler({ hub, resolveToken: options.resolveToken, log: log.child('hook') });
  const mcpHandler = createMcpHandler({
    hub,
    resolveToken: options.resolveToken,
    tasks: options.tasks,
    missionLog: options.missionLog,
    liveries: options.liveries,
    relief: options.relief,
    log: log.child('mcp'),
    version: () => options.info().version,
  });

  const allowedNames = new Set<string>(['127.0.0.1', 'localhost', '::1']);
  for (const entry of options.allowedHosts) {
    const listed = listedHost(entry);
    if (listed !== '') allowedNames.add(listed);
  }
  if (!WILDCARD_HOSTS.includes(options.host)) allowedNames.add(listedHost(options.host));

  const staticRoot = options.staticDir === null ? null : resolvePath(options.staticDir);
  const clients = new Set<Client>();
  const servers: Server[] = [];
  let pingTimer: NodeJS.Timeout | null = null;
  let started: Promise<{ host: string; port: number }> | null = null;
  let closing: Promise<void> | null = null;

  /* ---------------------------------------------------------------- checks of contract 3.2 */

  const tokenMatches = (candidate: string): boolean => timingSafeEqual(sha256(candidate), tokenDigest);

  const restAuthorized = (req: IncomingMessage): boolean => {
    const token = bearerToken(req.headers.authorization);
    return token !== null && tokenMatches(token);
  };

  const wsAuthorized = (req: IncomingMessage): boolean => {
    const offered = req.headers['sec-websocket-protocol'];
    if (typeof offered !== 'string') return false;
    for (const entry of offered.split(',')) {
      const protocol = entry.trim();
      if (protocol.startsWith(WS_TOKEN_PROTOCOL_PREFIX)) return tokenMatches(protocol.slice(WS_TOKEN_PROTOCOL_PREFIX.length));
    }
    return false;
  };

  const hostAllowed = (hostHeader: string | undefined): boolean => {
    const name = hostHeader === undefined ? null : hostName(hostHeader);
    return name !== null && allowedNames.has(name);
  };

  /** Browser routes need an Origin that is this very server; hooks, MCP, uplinks and docks never get one from their senders, so any Origin is a web page. */
  const originAllowed = (req: IncomingMessage, kind: RouteKind): boolean => {
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    if (kind === 'hook' || kind === 'mcp' || kind === 'uplink' || kind === 'dock') return false;
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    const host = req.headers.host ?? '';
    return url.host.toLowerCase() === host.toLowerCase() && hostAllowed(url.host);
  };

  /* ---------------------------------------------------------------- REST */

  function broadcast(event: HubEvent): void {
    if (clients.size === 0) return;
    try {
      const text = JSON.stringify(event);
      for (const client of clients) sendRaw(client, text, false);
    } catch (e) {
      log.error('broadcast failed', e);
    }
  }

  const snapshot = (): StateSnapshot => ({
    agents: hub.views(),
    activity: hub.activity(),
    info: options.info(),
    poll: hub.poll(),
    governor: hub.governor(),
    propellant: options.propellant?.view() ?? NO_PROPELLANT,
    schedules: options.schedules?.list() ?? [],
    uplinks: options.uplinks?.list() ?? [],
    tasks: options.tasks?.list() ?? [],
    downlink: options.downlink?.view() ?? { unread: 0, items: [] },
    livery: options.liveries?.view(),
    docking: options.docking?.view(),
    relief: options.relief?.view(),
    rollout: options.rollout?.view(),
  });

  const sendHubError = (res: ServerResponse, e: unknown): void => {
    const info = hubErrorInfo(e);
    if (info) {
      sendApiError(res, ERROR_STATUS[info.code], info.message, info.code, info.field, info.code === 'rate_limited' ? { 'Retry-After': '60' } : {});
      return;
    }
    log.error('request failed', e);
    sendApiError(res, 500, 'internal error', 'internal');
  };

  const hasBody = (req: IncomingMessage): boolean =>
    req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) > 0;

  const isJsonRequest = (req: IncomingMessage): boolean =>
    (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() === 'application/json';

  /** The JSON object in the body, or null after the error answer went out. */
  const jsonObject = async (req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> => {
    const body = await readBody(req, MAX_REST_BODY_BYTES);
    if (!body.ok) {
      if (body.reason === 'too_large') sendApiError(res, 413, 'request body too large', 'too_large');
      else res.destroy();
      return null;
    }
    let value: unknown = null;
    try {
      value = JSON.parse(body.body.toString('utf8'));
    } catch {
      // answered below, like a body that parses to something else than an object
    }
    if (!isRecord(value)) {
      sendApiError(res, 400, 'request body must be a JSON object', 'bad_request');
      return null;
    }
    return value;
  };

  const agentName = (res: ServerResponse, raw: string | undefined): string | null => {
    if (raw !== undefined && nameRe.test(raw)) return raw;
    sendNotFound(res, 'unknown agent');
    return null;
  };

  const matchApi = (s: string[]): ApiRoute | null => {
    if (s.length === 2 && s[1] === 'state') {
      return { allow: ['GET'], run: (_req, res) => sendJson(res, 200, snapshot()) };
    }
    if (s.length === 2 && s[1] === 'engines') {
      const engines = options.engines;
      if (!engines) return null;
      return { allow: ['GET'], run: async (_req, res) => sendJson(res, 200, await engines()) };
    }
    if (s.length === 2 && s[1] === 'agents') {
      return {
        allow: ['POST'],
        run: async (req, res) => {
          const body = await jsonObject(req, res);
          if (!body) return;
          const parsed = parseHire(body);
          if (!parsed.ok) sendApiError(res, 400, parsed.error, 'bad_request', parsed.field);
          else sendJson(res, 201, await hub.hire(parsed.value));
        },
      };
    }
    if (s.length === 2 && s[1] === 'messages') {
      return {
        allow: ['POST'],
        run: async (req, res) => {
          const body = await jsonObject(req, res);
          if (!body) return;
          const parsed = parseUserMessage(body);
          if (!parsed.ok) sendApiError(res, 400, parsed.error, 'bad_request', parsed.field);
          else sendJson(res, 201, hub.sendFromUser(parsed.value));
        },
      };
    }
    if (s.length === 2 && s[1] === 'governor') {
      return {
        allow: ['PUT'],
        run: async (req, res) => {
          const body = await jsonObject(req, res);
          if (!body) return;
          const parsed = parseGovernor(body);
          if (!parsed.ok) sendApiError(res, 400, parsed.error, 'bad_request', parsed.field);
          else sendJson(res, 200, hub.setGovernor(parsed.value));
        },
      };
    }
    if (s.length === 2 && s[1] === 'propellant') {
      return {
        allow: ['PUT'],
        run: async (req, res) => {
          const propellant = options.propellant;
          if (!propellant) {
            sendNotFound(res);
            return;
          }
          const body = await jsonObject(req, res);
          if (!body) return;
          const parsed = parsePropellantRequest(body);
          if (!parsed.ok) {
            sendApiError(res, 400, parsed.error, 'bad_request', parsed.field);
            return;
          }
          const view = await propellant.setLimits(parsed.value);
          broadcast({ t: 'propellant', propellant: view });
          sendJson(res, 200, view);
        },
      };
    }
    if (s[1] === 'schedules' && s.length <= 4) {
      const schedules = options.schedules;
      if (!schedules) return null;
      if (s.length === 2) {
        return {
          allow: ['GET', 'POST'],
          run: async (req, res) => {
            if (req.method === 'GET') {
              sendJson(res, 200, schedules.list());
              return;
            }
            const body = await jsonObject(req, res);
            if (body) sendJson(res, 201, await schedules.create(body));
          },
        };
      }
      const id = s[2] ?? '';
      if (s.length === 3) {
        return {
          allow: ['PATCH', 'DELETE'],
          run: async (req, res) => {
            if (req.method === 'DELETE') {
              await schedules.remove(id);
              res.writeHead(204);
              res.end();
              return;
            }
            const body = await jsonObject(req, res);
            if (body) sendJson(res, 200, await schedules.update(id, body));
          },
        };
      }
      if (s[3] === 'run') return { allow: ['POST'], run: async (_req, res) => sendJson(res, 200, await schedules.run(id)) };
      return null;
    }
    if (s[1] === 'uplinks' && s.length <= 4) {
      const uplinks = options.uplinks;
      if (!uplinks) return null;
      if (s.length === 2) {
        return {
          allow: ['GET', 'POST'],
          run: async (req, res) => {
            if (req.method === 'GET') {
              sendJson(res, 200, uplinks.list());
              return;
            }
            const body = await jsonObject(req, res);
            if (body) sendJson(res, 201, await uplinks.create(body));
          },
        };
      }
      const id = s[2] ?? '';
      if (s.length === 3) {
        return {
          allow: ['PATCH', 'DELETE'],
          run: async (req, res) => {
            if (req.method === 'DELETE') {
              await uplinks.remove(id);
              res.writeHead(204);
              res.end();
              return;
            }
            const body = await jsonObject(req, res);
            if (body) sendJson(res, 200, await uplinks.update(id, body));
          },
        };
      }
      if (s[3] === 'rotate') return { allow: ['POST'], run: async (_req, res) => sendJson(res, 200, await uplinks.rotate(id)) };
      if (s[3] === 'test') return { allow: ['POST'], run: async (_req, res) => sendJson(res, 200, await uplinks.test(id)) };
      return null;
    }
    if (s[1] === 'docking' && s.length <= 4) {
      const docking = options.docking;
      if (!docking) return null;
      if (s.length === 2) return { allow: ['GET'], run: (_req, res) => sendJson(res, 200, docking.view()) };
      const id = s[2] ?? '';
      if (s.length === 3 && (id === 'code' || id === 'pair')) {
        return {
          allow: ['POST'],
          run: async (req, res) => {
            const body = await jsonObject(req, res);
            if (body) sendJson(res, 201, id === 'code' ? docking.createCode(body) : await docking.pair(body));
          },
        };
      }
      if (s.length === 3) return { allow: ['DELETE'], run: async (_req, res) => sendJson(res, 200, await docking.undock(id)) };
      if (s[3] !== 'handoff') return null;
      return {
        allow: ['POST'],
        run: async (req, res) => {
          const body = await jsonObject(req, res);
          if (body) sendJson(res, 200, await docking.handOff(id, body));
        },
      };
    }
    if (s[1] === 'tasks' && s.length <= 3) {
      const tasks = options.tasks;
      if (!tasks) return null;
      const director = { kind: 'user' } as const;
      if (s.length === 2) {
        return {
          allow: ['GET', 'POST'],
          run: async (req, res) => {
            if (req.method === 'GET') {
              sendJson(res, 200, tasks.list());
              return;
            }
            const body = await jsonObject(req, res);
            if (body) sendJson(res, 201, await tasks.create(director, body));
          },
        };
      }
      const id = s[2] ?? '';
      return {
        allow: ['PATCH', 'DELETE'],
        run: async (req, res) => {
          if (req.method === 'DELETE') {
            await tasks.remove(id);
            res.writeHead(204);
            res.end();
            return;
          }
          const body = await jsonObject(req, res);
          if (body) sendJson(res, 200, await tasks.update(director, id, body));
        },
      };
    }
    if (s[1] === 'log' && s.length <= 3) {
      const missionLog = options.missionLog;
      if (!missionLog) return null;
      if (s.length === 2) {
        return {
          allow: ['GET', 'POST'],
          run: async (req, res) => {
            if (req.method === 'GET') {
              sendJson(res, 200, missionLog.search(new URL(req.url ?? '/', 'http://localhost').searchParams.get('q') ?? ''));
              return;
            }
            const body = await jsonObject(req, res);
            if (body) sendJson(res, 201, await missionLog.create('user', body));
          },
        };
      }
      const id = s[2] ?? '';
      if (id === 'chart') return { allow: ['GET'], run: (_req, res) => sendJson(res, 200, missionLog.chart()) };
      return {
        allow: ['GET', 'PUT', 'DELETE'],
        run: async (req, res) => {
          if (req.method === 'GET') {
            sendJson(res, 200, missionLog.get(id));
            return;
          }
          if (req.method === 'DELETE') {
            await missionLog.remove(id);
            res.writeHead(204);
            res.end();
            return;
          }
          const body = await jsonObject(req, res);
          if (body) sendJson(res, 200, await missionLog.update(id, body, null));
        },
      };
    }
    if (s[1] === 'liveries' || s[1] === 'livery') {
      const liveries = options.liveries;
      if (!liveries) return null;
      if (s.length === 2 && s[1] === 'liveries') return { allow: ['GET'], run: async (_req, res) => sendJson(res, 200, liveries.view()) };
      if (s.length === 2) {
        return {
          allow: ['PUT'],
          run: async (req, res) => {
            const body = await jsonObject(req, res);
            if (body) sendJson(res, 200, await liveries.select(body));
          },
        };
      }
      if (s.length !== 3 || s[1] !== 'liveries') return null;
      if (s[2] === 'design') {
        return {
          allow: ['POST'],
          run: async (req, res) => {
            const body = await jsonObject(req, res);
            if (body) sendJson(res, 201, liveries.design(body));
          },
        };
      }
      return { allow: ['DELETE'], run: async (_req, res) => sendJson(res, 200, await liveries.remove(s[2] ?? '')) };
    }
    if (s[1] === 'relay' && s.length <= 4) {
      const relay = options.relay;
      if (!relay) return null;
      if (s.length === 2) return { allow: ['GET'], run: async (_req, res) => sendJson(res, 200, relay.view()) };
      const name = s[2] ?? '';
      if (s.length === 4) return s[3] === 'test' ? { allow: ['POST'], run: async (_req, res) => sendJson(res, 200, await relay.test(name)) } : null;
      return {
        allow: ['PUT', 'DELETE'],
        run: async (req, res) => {
          if (req.method === 'DELETE') {
            sendJson(res, 200, await relay.remove(name));
            return;
          }
          const body = await jsonObject(req, res);
          if (body) sendJson(res, 200, await (name === 'forward' ? relay.forward(body) : relay.set(name, body)));
        },
      };
    }
    if (s[1] === 'relief' && s.length <= 4) {
      const relief = options.relief;
      if (!relief) return null;
      if (s.length === 2) return { allow: ['GET'], run: async (_req, res) => sendJson(res, 200, relief.view()) };
      // browser token only, like every /api route: an agent's token never reaches here, so the boss cannot answer its own request
      if (s.length !== 4 || (s[3] !== 'go' && s[3] !== 'no-go')) return null;
      const verdict = s[3];
      return { allow: ['POST'], run: async (_req, res) => sendJson(res, 200, await relief.decide(s[2] ?? '', verdict, { kind: 'user' })) };
    }
    if (s[1] === 'downlink' && s.length <= 3) {
      const downlink = options.downlink;
      if (!downlink) return null;
      if (s.length === 2) return { allow: ['GET'], run: async (_req, res) => sendJson(res, 200, downlink.view()) };
      if (s[2] === 'read-all') return { allow: ['POST'], run: async (_req, res) => sendJson(res, 200, await downlink.readAll()) };
      const action = s[2] === 'read' || s[2] === 'archive' ? s[2] : null;
      if (action === null) return null;
      return {
        allow: ['POST'],
        run: async (req, res) => {
          const body = await jsonObject(req, res);
          if (body) sendJson(res, 200, await downlink[action](body));
        },
      };
    }
    if (s[1] === 'poll' && s.length <= 3) {
      const action = s[2];
      if (s.length === 2) {
        return {
          allow: ['POST', 'DELETE'],
          run: async (req, res) => {
            if (req.method === 'DELETE') {
              hub.clearPoll();
              res.writeHead(204);
              res.end();
              return;
            }
            // the Director's Poll button may send no body: that is the default set
            const body = hasBody(req) ? await jsonObject(req, res) : {};
            if (!body) return;
            const parsed = parsePoll(body);
            if (!parsed.ok) sendApiError(res, 400, parsed.error, 'bad_request', parsed.field);
            else sendJson(res, 201, hub.startPoll(parsed.value));
          },
        };
      }
      if (action === 'hold' || action === 'abort') {
        return {
          allow: ['POST'],
          run: (_req, res) => sendJson(res, 200, action === 'hold' ? hub.holdPoll() : hub.abortPoll()),
        };
      }
      return null;
    }
    if (s[1] !== 'agents') return null;
    if (s.length === 3) {
      return {
        allow: ['PATCH', 'DELETE'],
        run: async (req, res) => {
          const name = agentName(res, s[2]);
          if (name === null) return;
          if (req.method === 'DELETE') {
            await hub.remove(name);
            res.writeHead(204);
            res.end();
            return;
          }
          const body = await jsonObject(req, res);
          if (!body) return;
          const parsed = parseEdit(body);
          if (!parsed.ok) sendApiError(res, 400, parsed.error, 'bad_request', parsed.field);
          else sendJson(res, 200, await hub.edit(name, parsed.value));
        },
      };
    }
    if (s.length === 4 && (s[3] === 'stop' || s[3] === 'restart')) {
      return {
        allow: ['POST'],
        run: async (_req, res) => {
          const name = agentName(res, s[2]);
          if (name === null) return;
          sendJson(res, 200, await (s[3] === 'stop' ? hub.stop(name) : hub.restart(name)));
        },
      };
    }
    if (s.length === 4 && (s[3] === 'memory' || s[3] === 'reflect') && options.massBudget) {
      const massBudget = options.massBudget;
      return {
        allow: [s[3] === 'memory' ? 'GET' : 'POST'],
        run: async (_req, res) => {
          const name = agentName(res, s[2]);
          if (name !== null) sendJson(res, s[3] === 'memory' ? 200 : 201, await (s[3] === 'memory' ? massBudget.view(name) : massBudget.reflect(name)));
        },
      };
    }
    if (s.length === 4 && (s[3] === 'resume' || s[3] === 'hold')) {
      return {
        allow: ['POST'],
        run: (_req, res) => {
          const name = agentName(res, s[2]);
          if (name !== null) sendJson(res, 200, s[3] === 'hold' ? hub.hold(name) : hub.resume(name));
        },
      };
    }
    if (s.length === 4 && s[3] === 'telemetry') {
      return {
        allow: ['GET'],
        run: (_req, res) => {
          const name = agentName(res, s[2]);
          if (name !== null) sendJson(res, 200, { calls: options.telemetry?.calls(name) ?? [] });
        },
      };
    }
    if (s.length === 4 && s[3] === 'answer') {
      return {
        allow: ['POST'],
        run: async (req, res) => {
          const name = agentName(res, s[2]);
          if (name === null) return;
          const body = await jsonObject(req, res);
          if (!body) return;
          const parsed = parseAnswer(body);
          if (!parsed.ok) sendApiError(res, 400, parsed.error, 'bad_request', parsed.field);
          else sendJson(res, 200, hub.answer(name, parsed.value));
        },
      };
    }
    return null;
  };

  const handleApi = async (req: IncomingMessage, res: ServerResponse, segments: string[]): Promise<void> => {
    if (!restAuthorized(req)) {
      sendUnauthorized(res);
      return;
    }
    if (!options.isReady()) {
      sendApiError(res, 503, 'starting', 'unavailable');
      return;
    }
    const route = matchApi(segments);
    if (!route) {
      sendNotFound(res);
      return;
    }
    const method = req.method ?? 'GET';
    if (!route.allow.includes(method)) {
      sendMethodNotAllowed(res, route.allow.join(', '));
      return;
    }
    if ((method === 'POST' || method === 'PATCH' || method === 'PUT') && hasBody(req) && !isJsonRequest(req)) {
      sendApiError(res, 415, 'content type must be application/json', 'unsupported');
      return;
    }
    try {
      await route.run(req, res);
    } catch (e) {
      sendHubError(res, e);
    }
  };

  /* ---------------------------------------------------------------- static client (contract 3.7) */

  const statOrNull = async (path: string): Promise<Stats | null> => {
    try {
      return await stat(path);
    } catch {
      return null;
    }
  };

  /**
   * The descriptor is opened here and closed in `finally`, never left to a stream: a stream that pipeline() refuses because
   * the client is already gone is never destroyed, so the descriptor it opened stays open for good, and enough of those end
   * the process with EMFILE.
   */
  const sendFile = async (req: IncomingMessage, res: ServerResponse, root: string, file: string, size: number): Promise<void> => {
    const underAssets = file.startsWith(join(root, 'assets') + sep);
    const head = {
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': size,
      'Cache-Control': underAssets ? 'public, max-age=31536000, immutable' : 'no-cache',
    };
    if (req.method === 'HEAD') {
      res.writeHead(200, head);
      res.end();
      return;
    }
    if (res.destroyed) return;
    const handle = await open(file, 'r');
    try {
      res.writeHead(200, head);
      await pipeline(handle.createReadStream(), res);
    } catch (e) {
      log.debug('static file stream failed', e);
      res.destroy();
    } finally {
      await handle.close();
    }
  };

  const serveStatic = async (req: IncomingMessage, res: ServerResponse, segments: string[]): Promise<void> => {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      sendMethodNotAllowed(res, ALLOW_BY_KIND.static);
      return;
    }
    if (staticRoot === null) {
      sendText(res, 404, 'not found');
      return;
    }
    const relative = segments.join('/');
    const file = resolvePath(staticRoot, relative === '' ? 'index.html' : relative);
    // shortcut: a symlink inside the static directory is followed; the directory is the client build, which holds none
    if (!file.startsWith(staticRoot + sep)) {
      sendText(res, 404, 'not found');
      return;
    }
    const info = await statOrNull(file);
    if (info?.isFile()) {
      await sendFile(req, res, staticRoot, file, info.size);
      return;
    }
    // a client route (no file extension, nothing there) gets the app; a directory or a missing asset is a 404
    if (info === null && extname(segments[segments.length - 1] ?? '') === '') {
      const index = join(staticRoot, 'index.html');
      const indexInfo = await statOrNull(index);
      if (indexInfo?.isFile()) {
        await sendFile(req, res, staticRoot, index, indexInfo.size);
        return;
      }
    }
    sendText(res, 404, 'not found');
  };

  /**
   * POST /uplink/:id: outside /api and the browser token. The sender proves itself with the uplink's secret (uplinks.ts), the
   * Host and Origin checks of handleRequest ran before, and an unknown or disabled id is the same 404 as a path that is not there.
   */
  const handleUplink = async (req: IncomingMessage, res: ServerResponse, segments: string[]): Promise<void> => {
    const uplinks = options.uplinks;
    const id = segments[1];
    if (!uplinks || segments.length !== 2 || !id) {
      sendNotFound(res);
      return;
    }
    if (!options.isReady()) {
      sendApiError(res, 503, 'starting', 'unavailable');
      return;
    }
    if (req.method !== 'POST') {
      sendMethodNotAllowed(res, ALLOW_BY_KIND.uplink);
      return;
    }
    const body = await readBody(req, UPLINK_BODY_MAX_BYTES);
    if (!body.ok) {
      if (body.reason === 'too_large') sendApiError(res, 413, 'request body too large', 'too_large');
      else res.destroy();
      return;
    }
    try {
      const done = uplinks.deliver(id, body.body, req.headers);
      // a ping or a challenge gets its answer with 200; a message that was made gets 202
      if ('answer' in done) sendJson(res, 200, done.answer);
      else sendJson(res, 202, done);
    } catch (e) {
      sendHubError(res, e);
    }
  };

  /**
   * /dock/<route>: another station's calls, outside /api and the browser token. They prove themselves with a signature
   * (docking.ts); the Host and Origin checks of handleRequest ran before.
   */
  const handleDock = async (req: IncomingMessage, res: ServerResponse, segments: string[]): Promise<void> => {
    const docking = options.docking;
    const route = segments[1] ?? '';
    if (!docking || segments.length !== 2 || !Object.hasOwn(DOCK_ROUTES, route)) {
      sendNotFound(res);
      return;
    }
    if (!options.isReady()) {
      sendApiError(res, 503, 'starting', 'unavailable');
      return;
    }
    if (req.method !== DOCK_ROUTES[route]) {
      sendMethodNotAllowed(res, DOCK_ROUTES[route] ?? 'POST');
      return;
    }
    const body = await readBody(req, DOCK_BODY_MAX_BYTES);
    if (!body.ok) {
      if (body.reason === 'too_large') sendApiError(res, 413, 'request body too large', 'too_large');
      else res.destroy();
      return;
    }
    try {
      sendJson(res, 200, await docking.handle(route, req.method, req.url ?? '', req.headers, body.body));
    } catch (e) {
      sendHubError(res, e);
    }
  };

  /* ---------------------------------------------------------------- one HTTP request */

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    // A Clean Room agent reaches the hooks and MCP by the host's name for containers: no other route may be reached by it.
    const viaContainer = !hostAllowed(req.headers.host) && hostName(req.headers.host ?? '') === CLEAN_ROOM_HOST;
    if (!viaContainer && !hostAllowed(req.headers.host)) {
      sendText(res, 403, 'forbidden host');
      return;
    }
    const segments = parseTarget(req.url);
    const kind = segments === null ? null : classify(segments);
    if (viaContainer && kind !== 'hook' && kind !== 'mcp') {
      sendText(res, 403, 'forbidden host');
      return;
    }
    if (segments === null || kind === null) {
      sendText(res, 404, 'not found');
      return;
    }
    if (kind !== 'static') res.setHeader('Cache-Control', 'no-store');
    const method = req.method ?? 'GET';
    const staticRead = kind === 'static' && (method === 'GET' || method === 'HEAD');
    if (!staticRead && !originAllowed(req, kind)) {
      sendText(res, 403, 'forbidden origin');
      return;
    }
    // a preflight carries no token and gets no CORS headers: nothing here answers it
    if (method === 'OPTIONS') {
      sendMethodNotAllowed(res, ALLOW_BY_KIND[kind]);
      return;
    }

    switch (kind) {
      case 'hook':
        if (segments.length === 3 && segments[1] && segments[2]) await hookHandler(req, res, segments[1], segments[2]);
        else sendNotFound(res);
        return;
      case 'mcp':
        if (segments.length === 1) await mcpHandler(req, res);
        else sendNotFound(res);
        return;
      case 'ws':
        // a real WebSocket never gets here (it is an upgrade); this is a plain GET, a probe or a mistake
        if (!restAuthorized(req) && !wsAuthorized(req)) sendUnauthorized(res);
        else if (!options.isReady()) sendApiError(res, 503, 'starting', 'unavailable');
        else if (segments.length !== 1) sendNotFound(res);
        else if (method !== 'GET') sendMethodNotAllowed(res, ALLOW_BY_KIND.ws);
        else sendApiError(res, 400, 'this endpoint needs a WebSocket upgrade', 'bad_request');
        return;
      case 'uplink':
        await handleUplink(req, res, segments);
        return;
      case 'dock':
        await handleDock(req, res, segments);
        return;
      case 'api':
        await handleApi(req, res, segments);
        return;
      case 'static':
        await serveStatic(req, res, segments);
        return;
    }
  };

  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    // a late write to a response whose socket is gone emits 'error' on it; without a listener that ends the process
    res.on('error', (e) => log.debug('response error', e));
    void handleRequest(req, res).catch((e: unknown) => {
      log.error('request failed', e);
      if (res.headersSent) res.destroy();
      else sendApiError(res, 500, 'internal error', 'internal');
    });
  };

  /* ---------------------------------------------------------------- WebSocket (contract 3.4) */

  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: WS_MAX_FRAME_BYTES,
    // the client offers the token as a second protocol; selecting only the real one keeps the secret out of the response
    handleProtocols: (protocols) => (protocols.has(WS_SUBPROTOCOL) ? WS_SUBPROTOCOL : false),
  });
  wss.on('error', (e) => log.error('websocket server error', e));

  const sendRaw = (client: Client, data: string | Buffer, binary: boolean): void => {
    const { ws } = client;
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > WS_MAX_BUFFERED_BYTES) {
      // the browser reconnects and gets a fresh snapshot, so dropping the slow reader loses nothing
      ws.close(WS_CLOSE_BACKPRESSURE, 'too slow');
      setTimeout(() => ws.terminate(), 2000).unref();
      return;
    }
    ws.send(data, { binary }, (err) => {
      if (err) log.debug('websocket send failed', err);
    });
  };

  const sendFrame = (client: Client, frame: ServerFrame): void => sendRaw(client, JSON.stringify(frame), false);

  const sendError = (client: Client, message: string, ref: NonNullable<ErrorFrame['ref']>): void =>
    sendFrame(client, { t: 'error', message, ref });

  const sendOutput = (client: Client, seq: number, chunk: Uint8Array): void => {
    const frame = Buffer.allocUnsafe(5 + chunk.length);
    frame[0] = WS_BINARY_OUTPUT;
    frame.writeUInt32BE(seq, 1);
    frame.set(chunk, 5);
    sendRaw(client, frame, true);
  };

  const releaseAttachment = (client: Client): void => {
    client.attachment?.detach();
    client.attachment = null;
    client.attached = null;
  };

  /** Makes this socket's size the pty's size, and tells every socket attached to that agent when it changed. */
  const takeSize = (agent: string, size: Size): void => {
    const before = terminals.info(agent);
    if (!before?.running || (before.cols === size.cols && before.rows === size.rows)) return;
    terminals.resize(agent, size.cols, size.rows);
    const after = terminals.info(agent);
    if (!after || (after.cols === before.cols && after.rows === before.rows)) return;
    for (const other of clients) {
      if (other.attached?.agent === agent) sendFrame(other, { t: 'size', agent, cols: after.cols, rows: after.rows });
    }
  };

  const onAttach = async (client: Client, frame: Record<string, unknown>): Promise<void> => {
    const { seq, agent } = frame;
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0 || seq > 0xffffffff || typeof agent !== 'string') {
      sendError(client, 'bad frame', 'attach');
      return;
    }
    if (!nameRe.test(agent) || !hub.views().some((v) => v.name === agent)) {
      sendError(client, 'unknown agent', 'attach');
      return;
    }
    const token = (client.attachToken += 1);
    releaseAttachment(client);
    const size = fitSize(frame.cols, frame.rows);
    if (size) {
      client.size = size;
      takeSize(agent, size);
    }
    const listener: OutputListener = (chunk) => {
      if (client.attachToken !== token) return;
      try {
        sendOutput(client, seq, chunk);
      } catch (e) {
        log.error('terminal output could not be sent', e);
      }
    };
    let attachment: Attachment;
    try {
      attachment = await terminals.attach(agent, listener);
    } catch (e) {
      log.error('terminal attach failed', e);
      if (client.attachToken === token) sendError(client, 'could not attach', 'attach');
      return;
    }
    if (client.closed || client.attachToken !== token) {
      attachment.detach();
      return;
    }
    client.attachment = attachment;
    client.attached = { agent, seq };
    const snap = attachment.snapshot;
    sendFrame(client, {
      t: 'snapshot',
      seq,
      agent,
      generation: snap.generation,
      cols: snap.cols,
      rows: snap.rows,
      running: snap.running,
      data: snap.data,
    });
    attachment.start();
  };

  const onInput = (client: Client, frame: Record<string, unknown>): void => {
    const { agent, data, binary } = frame;
    if (typeof agent !== 'string' || typeof data !== 'string' || (binary !== undefined && typeof binary !== 'boolean')) {
      sendError(client, 'bad frame', 'input');
      return;
    }
    if (client.attached?.agent !== agent) {
      sendError(client, 'not attached to that agent', 'input');
      return;
    }
    if (!terminals.write(agent, binary === true ? Buffer.from(data, 'latin1') : data)) return;
    let effect: InputEffect = 'none';
    try {
      effect = hub.onUserInput(agent, data);
    } catch (e) {
      log.error('hub.onUserInput failed', e);
    }
    // only a keystroke a person made owns the size: focus, mouse and terminal replies arrive as input too (contract 3.4)
    if (effect !== 'none' && client.size) takeSize(agent, client.size);
  };

  const onResize = (client: Client, frame: Record<string, unknown>): void => {
    const { agent } = frame;
    if (typeof agent !== 'string' || client.attached?.agent !== agent) {
      sendError(client, 'not attached to that agent', 'resize');
      return;
    }
    const size = fitSize(frame.cols, frame.rows);
    if (!size) {
      sendError(client, 'bad size', 'resize');
      return;
    }
    client.size = size;
    takeSize(agent, size);
  };

  const onMessage = async (client: Client, data: RawData, isBinary: boolean): Promise<void> => {
    let frame: unknown = null;
    if (!isBinary) {
      try {
        frame = JSON.parse(rawToString(data));
      } catch {
        // falls through to the bad frame answer
      }
    }
    if (!isRecord(frame)) {
      sendError(client, 'bad frame', 'frame');
      return;
    }
    switch (frame.t) {
      case 'attach':
        await onAttach(client, frame);
        return;
      case 'detach':
        client.attachToken += 1;
        releaseAttachment(client);
        return;
      case 'input':
        onInput(client, frame);
        return;
      case 'resize':
        onResize(client, frame);
        return;
      default:
        sendError(client, 'bad frame', 'frame');
    }
  };

  const onConnection = (ws: WebSocket): void => {
    ws.on('error', (e) => log.warn('websocket error', e));
    const client: Client = { ws, alive: true, attached: null, attachment: null, attachToken: 0, size: null, closed: false };
    clients.add(client);
    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      void onMessage(client, data, isBinary).catch((e: unknown) => {
        log.error('websocket frame failed', e);
        sendError(client, 'internal error', 'frame');
      });
    });
    ws.on('close', () => {
      client.closed = true;
      client.attachToken += 1;
      clients.delete(client);
      try {
        releaseAttachment(client);
      } catch (e) {
        log.error('terminal detach failed', e);
      }
    });
    try {
      sendFrame(client, { t: 'state', state: snapshot() });
    } catch (e) {
      log.error('could not send the state snapshot', e);
      ws.terminate();
    }
  };

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    // after 'upgrade' the raw socket has no error listener: a reset during the handshake would end the process
    socket.on('error', noop);
    try {
      // the order of contract 3.2: Host, Origin, token, ready; a path that is not /ws is a 404 like it is for a request
      const segments = parseTarget(req.url);
      if (!hostAllowed(req.headers.host)) {
        rejectUpgrade(socket, 403, 'text/plain', 'forbidden host');
      } else if (segments === null) {
        rejectUpgrade(socket, 404, 'text/plain', 'not found');
      } else if (!originAllowed(req, 'ws')) {
        rejectUpgrade(socket, 403, 'text/plain', 'forbidden origin');
      } else if (classify(segments) !== 'ws' || segments.length !== 1) {
        rejectUpgrade(socket, 404, 'text/plain', 'not found');
      } else if (req.method !== 'GET') {
        rejectUpgrade(socket, 405, 'text/plain', 'method not allowed', ['Allow: GET']);
      } else if (!wsAuthorized(req)) {
        rejectUpgrade(socket, 401, 'application/json', '{"error":"unauthorized","code":"unauthorized"}', ['WWW-Authenticate: Bearer']);
      } else if (!options.isReady()) {
        rejectUpgrade(socket, 503, 'application/json', '{"error":"starting","code":"unavailable"}');
      } else {
        socket.removeListener('error', noop);
        wss.handleUpgrade(req, socket, head, onConnection);
      }
    } catch (e) {
      log.error('upgrade failed', e);
      socket.on('error', noop);
      socket.destroy();
    }
  };

  /* ---------------------------------------------------------------- lifecycle */

  const createHttpServer = (): Server => {
    const server = createServer(onRequest);
    server.on('upgrade', onUpgrade);
    return server;
  };

  const listenOn = (server: Server, port: number, host: string): Promise<void> =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ port, host }, () => {
        server.removeListener('error', reject);
        server.on('error', (e) => log.error('http server error', e));
        resolve();
      });
    });

  const closeHttp = (server: Server): Promise<void> =>
    new Promise((resolve) => {
      const force = setTimeout(() => server.closeAllConnections(), 1000);
      server.close(() => {
        clearTimeout(force);
        resolve();
      });
      server.closeIdleConnections();
    });

  const startListening = async (): Promise<{ host: string; port: number }> => {
    const primary = createHttpServer();
    servers.push(primary);
    await listenOn(primary, options.port, options.host);
    const address = primary.address();
    if (address === null || typeof address === 'string') throw new Error('the web server has no address');
    if (needsLoopbackTwin(options.host)) {
      const twin = createHttpServer();
      servers.push(twin);
      try {
        await listenOn(twin, address.port, '127.0.0.1');
      } catch (e) {
        await closeHttp(primary);
        throw e;
      }
    }
    pingTimer = setInterval(() => {
      for (const client of [...clients]) {
        try {
          if (!client.alive) {
            client.ws.terminate();
            continue;
          }
          client.alive = false;
          client.ws.ping();
        } catch (e) {
          log.debug('websocket ping failed', e);
        }
      }
    }, WS_PING_INTERVAL_MS);
    pingTimer.unref();
    return { host: address.address, port: address.port };
  };

  const waitClosed = (client: Client): Promise<void> =>
    new Promise((resolve) => {
      if (client.ws.readyState === WebSocket.CLOSED) resolve();
      else client.ws.once('close', () => resolve());
    });

  const closeAll = async (): Promise<void> => {
    if (pingTimer) clearInterval(pingTimer);
    const open = [...clients];
    for (const client of open) client.ws.close(WS_CLOSE_GOING_AWAY, 'server shutting down');
    let giveUp: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(open.map(waitClosed)),
      new Promise<void>((resolve) => {
        giveUp = setTimeout(resolve, 1000);
      }),
    ]);
    clearTimeout(giveUp);
    for (const client of open) client.ws.terminate();
    await Promise.all(servers.map(closeHttp));
    wss.close();
  };

  return {
    listen: () => (started ??= startListening()),
    close: () => (closing ??= closeAll()),
    broadcast,
  };
}
