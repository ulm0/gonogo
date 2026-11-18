import type { IncomingMessage, ServerResponse } from 'node:http';
import { API_ERROR_CODES, HOOK_EVENTS } from '../shared/protocol.js';
import type {
  AgentIdentity,
  ApiError,
  ApiErrorCode,
  HookEvent,
  HookPayload,
  HookReply,
  Hub,
  Logger,
} from '../shared/protocol.js';
import { AGENT_NAME_PATTERN, MAX_HOOK_BODY_BYTES } from './constants.js';

export interface HookDeps {
  hub: Pick<Hub, 'onHook'>;
  resolveToken(token: string): AgentIdentity | null;
  /** Plan quota: the body of a status-line post (docs/quota-spec.md). Not a hook event, so the hub never sees it. */
  statusLine?(agent: string, body: unknown): void;
  log: Logger;
}

/* ---- HTTP plumbing shared by hooks.ts, mcp.ts and web.ts (this file sits at the bottom of their import order) ---- */

export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

export interface HubErrorInfo {
  code: ApiErrorCode;
  message: string;
  field?: string;
}

/** Recognises a HubError by its name and code, not by instanceof (protocol.ts: the hub's class is not imported here). */
export function hubErrorInfo(e: unknown): HubErrorInfo | null {
  if (!(e instanceof Error) || e.name !== 'HubError' || !('code' in e)) return null;
  const { code } = e;
  if (typeof code !== 'string' || !(API_ERROR_CODES as readonly string[]).includes(code)) return null;
  const field = 'field' in e && typeof e.field === 'string' ? e.field : undefined;
  const info: HubErrorInfo = { code: code as ApiErrorCode, message: e.message };
  if (field !== undefined) info.field = field;
  return info;
}

/** The token of an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(header: string | undefined): string | null {
  const m = header === undefined ? null : /^Bearer +(\S+)$/i.exec(header);
  return m ? m[1] : null;
}

export function sendText(res: ServerResponse, status: number, text: string): void {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent || res.writableEnded) return;
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

export function sendApiError(
  res: ServerResponse,
  status: number,
  error: string,
  code: ApiErrorCode,
  field?: string,
  headers: Record<string, string> = {},
): void {
  const body: ApiError = field === undefined ? { error, code } : { error, code, field };
  sendJson(res, status, body, headers);
}

export function sendUnauthorized(res: ServerResponse): void {
  sendApiError(res, 401, 'unauthorized', 'unauthorized', undefined, { 'WWW-Authenticate': 'Bearer' });
}

export function sendNotFound(res: ServerResponse, error = 'not found'): void {
  sendApiError(res, 404, error, 'not_found');
}

export function sendMethodNotAllowed(res: ServerResponse, allow: string): void {
  sendApiError(res, 405, 'method not allowed', 'bad_request', undefined, { Allow: allow });
}

export type BodyResult = { ok: true; body: Buffer } | { ok: false; reason: 'too_large' | 'aborted' };

/**
 * Collects a request body of at most `limit` bytes. Past the limit nothing more is kept and the rest is read and thrown
 * away, so the client can finish sending and read the 413 instead of meeting a reset.
 */
export function readBody(req: IncomingMessage, limit: number): Promise<BodyResult> {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length']);
    if (req.destroyed) {
      resolve({ ok: false, reason: 'aborted' });
      return;
    }
    if (req.readableEnded) {
      resolve({ ok: true, body: Buffer.alloc(0) });
      return;
    }
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      resolve({ ok: false, reason: 'too_large' });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (result: BodyResult): void => {
      if (settled) return;
      settled = true;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onAbort);
      req.removeListener('close', onAbort);
      resolve(result);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limit) {
        settle({ ok: false, reason: 'too_large' });
        req.resume();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => settle({ ok: true, body: Buffer.concat(chunks, size) });
    const onAbort = (): void => settle({ ok: false, reason: 'aborted' });
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onAbort);
    req.on('close', onAbort);
  });
}

/* ---- the hook endpoint ---- */

/** The name of the status-line post beside the hook events. */
const STATUS_LINE = 'StatusLine';

function isHookEvent(event: string): event is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(event);
}

/** Only a Stop reply may carry a decision, and only a block with a reason; every other shape lets the agent go on. */
function stopReplyBody(reply: unknown): HookReply {
  if (isRecord(reply) && reply.decision === 'block' && typeof reply.reason === 'string' && reply.reason !== '') {
    return { decision: 'block', reason: reply.reason };
  }
  return {};
}

export function createHookHandler(
  deps: HookDeps,
): (req: IncomingMessage, res: ServerResponse, agentName: string, event: string) => Promise<void> {
  const { hub, log } = deps;
  const nameRe = new RegExp(AGENT_NAME_PATTERN);

  return async (req, res, agentName, event) => {
    const token = bearerToken(req.headers.authorization);
    const identity = token === null ? null : deps.resolveToken(token);
    if (!identity) {
      sendUnauthorized(res);
      return;
    }
    if (req.method !== 'POST') {
      sendMethodNotAllowed(res, 'POST');
      return;
    }
    if (!nameRe.test(agentName) || !(isHookEvent(event) || event === STATUS_LINE)) {
      sendNotFound(res);
      return;
    }
    if (identity.agent !== agentName) {
      sendApiError(res, 403, 'token does not belong to this agent', 'forbidden');
      return;
    }

    const body = await readBody(req, MAX_HOOK_BODY_BYTES);
    if (!body.ok) {
      if (body.reason === 'too_large') sendApiError(res, 413, 'hook body too large', 'too_large');
      else res.destroy();
      return;
    }
    let payload: unknown = null;
    try {
      payload = JSON.parse(body.body.toString('utf8'));
    } catch {
      // answered below: a body that is not JSON is the same 400 as one that is not an object
    }
    if (!isRecord(payload)) {
      sendApiError(res, 400, 'hook body must be a JSON object', 'bad_request');
      return;
    }

    if (event === STATUS_LINE) {
      deps.statusLine?.(agentName, payload);
      sendJson(res, 200, {});
      return;
    }
    let reply: HookReply;
    try {
      // the hub reads every field defensively (protocol.ts), so the unchecked shape is what it expects
      reply = hub.onHook({ agent: agentName, generation: identity.generation, event, payload: payload as HookPayload });
    } catch (e) {
      log.error(`hook ${event} of ${agentName} failed`, e);
      sendApiError(res, 500, 'internal error', 'internal');
      return;
    }
    log.debug(`hook ${event} of ${agentName}`);
    sendJson(res, 200, event === 'Stop' ? stopReplyBody(reply) : {});
  };
}
