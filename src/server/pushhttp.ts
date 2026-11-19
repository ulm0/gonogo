/**
 * The push routes of the supervisor (docs/features/mobile.md), under `/api/push`: the key and the devices, one device subscribed or
 * taken off, and a test. The supervisor has already asked the login who the caller is and checked the Origin of a cookie; what it hands
 * in here is the id of the caller's session, or null for a key, the old token or the local socket (which cannot own a device: a device
 * is tied to a session, and goes with it).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiErrorCode } from '../shared/protocol.js';
import { sendApiError, sendJson } from './hooks.js';
import { HubError } from './hub.js';
import type { Push } from './push.js';

const STATUS: Partial<Record<ApiErrorCode, number>> = { bad_request: 400, forbidden: 403, not_found: 404, conflict: 409 };
const BODY_MAX = 4096;

/** The paths this file answers: `/api/push`, `/api/push/subscription`, `/api/push/test`. */
export const isPushPath = (path: string): boolean => /^\/api\/push(\/(subscription|test))?$/.test(path);

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (!/^application\/json(\s*;|$)/i.test(req.headers['content-type'] ?? '')) return reject(new HubError('bad_request', 'send application/json'));
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_MAX) reject(new HubError('bad_request', `the body is over ${BODY_MAX} bytes`));
      else chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('not an object');
        resolve(body as Record<string, unknown>);
      } catch {
        reject(new HubError('bad_request', 'the body must be a JSON object'));
      }
    });
    req.on('error', () => reject(new HubError('bad_request', 'the body could not be read')));
  });
}

export async function pushApi(push: Push, req: IncomingMessage, res: ServerResponse, path: string, session: string | null): Promise<void> {
  try {
    const method = req.method ?? '';
    const allow = path === '/api/push' ? 'GET' : path === '/api/push/test' ? 'POST' : 'PUT, DELETE';
    if (!allow.split(', ').includes(method)) return sendApiError(res, 405, 'method not allowed', 'bad_request', undefined, { Allow: allow });
    if (path === '/api/push') return sendJson(res, 200, push.view(session), { 'Cache-Control': 'no-store' });
    const body = await readJson(req);
    if (path === '/api/push/test') return sendJson(res, 200, await push.test(body, session), { 'Cache-Control': 'no-store' });
    return sendJson(res, 200, method === 'PUT' ? await push.subscribe(body, session) : await push.unsubscribe(body, session), { 'Cache-Control': 'no-store' });
  } catch (error) {
    if (error instanceof HubError) return sendApiError(res, STATUS[error.code] ?? 500, error.message, error.code, error.field);
    return sendApiError(res, 500, 'internal error', 'internal');
  }
}
