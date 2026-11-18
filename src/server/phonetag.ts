/**
 * Phone approvals: the signed `callback_data` of a Telegram button (docs/phone-approvals-spec.md, Path A).
 *
 * `a:<kind>:<id>:<verdict>:<tag>` fits Telegram's 64 bytes. `<tag>` is the first 8 hex characters (32 bits) of
 * HMAC-SHA256(secret, "kind:id:verdict"): it binds a button to one request and one verdict, so an edited or forwarded button
 * cannot approve something else. Pure: no clock, no network, no files; the secret is the Telegram uplink's, handed in.
 *
 * shortcut: 32 bits are enough only because the uplink limits callbacks to 10 a minute and a request lives minutes;
 * lengthen the tag (there is room up to 64 bytes) if that ever stops being true.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const PHONE_KINDS = ['permission', 'relief'] as const;
export type PhoneKind = (typeof PHONE_KINDS)[number];
export const PHONE_VERDICTS = ['go', 'nogo', 'open'] as const;
export type PhoneVerdict = (typeof PHONE_VERDICTS)[number];

export interface PhoneCallback {
  kind: PhoneKind;
  id: string;
  verdict: PhoneVerdict;
}

/** An id as the hub makes them: the needs_you sequence number or a Relief id. */
const ID_RE = /^[A-Za-z0-9_-]{1,24}$/;
const TAG_RE = /^[0-9a-f]{8}$/;
const TELEGRAM_CALLBACK_MAX_BYTES = 64;

const digest = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();
const same = (a: string, b: string): boolean => timingSafeEqual(digest(a), digest(b));

/** The tag of one button; null when the parts are not valid (so nothing odd is ever signed). */
export function callbackTag(secret: string, call: PhoneCallback): string | null {
  if (secret === '' || !ID_RE.test(call.id) || !(PHONE_KINDS as readonly string[]).includes(call.kind) || !(PHONE_VERDICTS as readonly string[]).includes(call.verdict)) return null;
  return createHmac('sha256', secret).update(`${call.kind}:${call.id}:${call.verdict}`).digest('hex').slice(0, 8);
}

/** The `callback_data` of a button, or null when it would not be valid or would not fit. */
export function callbackData(secret: string, call: PhoneCallback): string | null {
  const tag = callbackTag(secret, call);
  if (tag === null) return null;
  const data = `a:${call.kind}:${call.id}:${call.verdict}:${tag}`;
  return Buffer.byteLength(data, 'utf8') <= TELEGRAM_CALLBACK_MAX_BYTES ? data : null;
}

/** What a button says if, and only if, its tag is right for this secret; anything else is null. Constant-time compare. */
export function verifyCallback(secret: string, data: unknown): PhoneCallback | null {
  if (typeof data !== 'string' || Buffer.byteLength(data, 'utf8') > TELEGRAM_CALLBACK_MAX_BYTES) return null;
  const parts = data.split(':');
  if (parts.length !== 5 || parts[0] !== 'a') return null;
  const [, kind, id, verdict, tag] = parts as [string, string, string, string, string];
  if (!(PHONE_KINDS as readonly string[]).includes(kind) || !(PHONE_VERDICTS as readonly string[]).includes(verdict) || !TAG_RE.test(tag)) return null;
  const call = { kind, id, verdict } as PhoneCallback;
  const expected = callbackTag(secret, call);
  return expected !== null && same(tag, expected) ? call : null;
}
