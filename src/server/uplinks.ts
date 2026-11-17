/**
 * Uplink: webhooks that start work (docs/uplink-spec.md).
 *
 * A delivery is `Hub.sendFromUser` with the subject "Uplink: <name>" and the JSON of the body pretty-printed, so Max Q,
 * Redline and held mail apply as to a message typed in the Brief box. The endpoint (POST /uplink/:id) is outside /api and
 * outside the browser token: a delivery proves itself with the uplink's secret, by a signature of the raw body or by the
 * secret itself as a bearer token, compared in constant time. The kind of an uplink says how it proves itself and how its
 * body becomes a message; Relay adds kinds by adding entries to KINDS. The clock and the send are injected for tests.
 *
 * shortcut: the secret is stored in the file as text (a signature cannot be checked against a hash), so the file is 0600
 * and nothing else; encrypt it if the home folder is ever shared.
 * shortcut: the rate limit counts only deliveries that prove themselves, so a stranger who guesses an id (u1) cannot use up
 * the limit of the real sender, but can make the server hash 256 KiB per request; put a rate limit on the reverse proxy.
 * shortcut: `to` is an agent name, so after a rename the deliveries end "refused" (409) until the uplink is edited; follow
 * renames (key by record id) if renames get common.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import type { IncomingHttpHeaders } from 'node:http';
import { join } from 'node:path';
import {
  ACTIVITY_STATUSES,
  AGENT_NAME_PATTERN,
  BODY_MAX_CHARS,
  UPLINK_DELIVERIES_MAX,
  UPLINK_GIVEN_SECRET_KINDS,
  UPLINK_KINDS,
  UPLINK_NAME_MAX_CHARS,
  UPLINKS_MAX,
  uplinkSubject,
} from '../shared/protocol.js';
import type { DownlinkNotify, Logger, SendResult, Uplink, UplinkCreated, UplinkDelivery, UplinkKind, UplinkPatch, UplinkRequest, UplinkView, UserMessageRequest } from '../shared/protocol.js';
import { FILE_MODE, UPLINK_BAD_MAX, UPLINK_BAD_WINDOW_MS, UPLINK_NOTE_MAX_CHARS, UPLINK_RATE_MAX, UPLINK_RATE_WINDOW_MS, UPLINKS_FILE } from './constants.js';
import { HubError } from './hub.js';
import { bearerToken, isRecord } from './hooks.js';
import { RELAY_KINDS } from './relaykinds.js';
import { UNSAFE_IN_NAME } from './schedules.js';

const NAME_RE = new RegExp(AGENT_NAME_PATTERN);
const ID_RE = /^u[1-9]\d{0,5}$/;
/** Made here: 64 hex characters. Given by Slack or Linear: whatever they made, printable. */
const SECRET_RE = /^[\x21-\x7e]{16,256}$/;
const SIGNATURE_RE = /^sha256=([0-9a-f]{64})$/i;
const CREATE_FIELDS = ['name', 'to', 'kind', 'enabled', 'secret'];
const PATCH_FIELDS = ['name', 'to', 'enabled', 'secret'];
/** Room left for the line that says a body was cut. */
const CUT_RESERVE = 120;

export interface UplinksOptions {
  /** gonogo's home: uplinks.json lives here. */
  dir: string;
  now(): number;
  /** Hub.sendFromUser: a message from the Director. May throw a HubError. */
  send(request: UserMessageRequest): SendResult;
  /** The whole list changed (an uplink made, edited, removed or delivered to). */
  emit(uplinks: UplinkView[]): void;
  /** Downlink: requests that did not prove themselves, more than UPLINK_BAD_MAX in UPLINK_BAD_WINDOW_MS. */
  notify?: DownlinkNotify;
  /** Relay: what the slack and telegram kinds know of the messages that were forwarded. Without it no body is a reply. */
  inbound?: Inbound;
  log: Logger;
}

export interface Uplinks {
  load(): Promise<void>;
  list(): UplinkView[];
  /** The input is a JSON value from the wire; a bad one throws a HubError (bad_request, field). The answer carries the secret. */
  create(input: unknown): Promise<UplinkCreated>;
  update(id: string, input: unknown): Promise<UplinkView>;
  remove(id: string): Promise<void>;
  /** A new secret; the old one stops working at once. The answer carries it. */
  rotate(id: string): Promise<UplinkCreated>;
  /** Fires a sample through the same path, whether the uplink is on or off. A refusal is in the delivery, not thrown. */
  test(id: string): Promise<UplinkView>;
  /**
   * The public endpoint. Throws a HubError: not_found for an unknown or a disabled id (the same answer, so nothing says
   * which), unauthorized, rate_limited, bad_request for a body the kind cannot read, conflict when the hub refused the message.
   * `answer` is a body for the sender (a ping, a challenge, an event that is not for the agents) and no message was made.
   */
  deliver(id: string, raw: Buffer, headers: IncomingHttpHeaders): Pick<SendResult, 'ok' | 'id' | 'status'> | { ok: true; answer: unknown };
  close(): Promise<void>;
}

/** A message that an earlier forward left behind: a reply to it goes to the agent that wrote it. */
export interface Thread {
  id: string;
  agent: string;
  subject: string;
}
/** What the slack and telegram kinds ask of Relay. Keys look like `slack:<channel>:<ts>` and `telegram:<chat>:<message id>`. */
export interface Inbound {
  find(key: string): Thread | undefined;
  /** true when the key was handled before (a retry, or a mention that Slack also sends as a message); the first call remembers it. */
  seen(key: string): boolean;
  /** The one chat of the Telegram target, or null when there is none. */
  telegramChat(): string | null;
}
/** What a kind makes of a body: a message, an answer for the sender (a ping, a challenge), or null for an event that is not for the agents. */
export type Made = { text: string; cut: boolean; to?: string; subject?: string; inReplyTo?: string; once?: string } | { answer: unknown; note: string } | null;

export interface KindDef {
  /** The request carries the secret, as a signature of the raw body or as itself. `now` is for the kinds whose signature has a time. */
  authentic(raw: Buffer, headers: IncomingHttpHeaders, secret: string, now: number): boolean;
  /** What the body means; throws a HubError (bad_request) for one it cannot read. `cut` says the text was shortened to fit. */
  read(raw: Buffer, headers: IncomingHttpHeaders, inbound: Inbound): Made;
}

const NO_INBOUND: Inbound = { find: () => undefined, seen: () => false, telegramChat: () => null };
/** The answer to a request that was good and not for the agents. */
const IGNORED = { ok: true as const, answer: { ok: true, ignored: true } };

const digest = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();

/** `X-Gonogo-Signature: sha256=<hex HMAC-SHA256 of the raw body, keyed with the secret text>` or `Authorization: Bearer <secret>`. */
function genericAuthentic(raw: Buffer, headers: IncomingHttpHeaders, secret: string): boolean {
  const signature = headers['x-gonogo-signature'];
  const given = typeof signature === 'string' ? SIGNATURE_RE.exec(signature.trim()) : null;
  if (given !== null && timingSafeEqual(Buffer.from(given[1], 'hex'), createHmac('sha256', secret).update(raw).digest())) return true;
  const token = bearerToken(headers.authorization);
  return token !== null && timingSafeEqual(digest(token), digest(secret));
}

/** Any JSON, pretty-printed; cut to the body limit with a line that says so. */
function genericRead(raw: Buffer): { text: string; cut: boolean } {
  let text: string;
  try {
    // stringify is inside the try: JSON nested a hundred thousand deep parses but overflows the stack when written back
    text = JSON.stringify(JSON.parse(raw.toString('utf8')), null, 2);
  } catch {
    throw new HubError('bad_request', 'the body is not JSON, or is nested too deep');
  }
  if (text.length <= BODY_MAX_CHARS) return { text, cut: false };
  const keep = BODY_MAX_CHARS - CUT_RESERVE;
  return { text: `${text.slice(0, keep)}\n[cut: the delivery has ${text.length} characters, the first ${keep} are shown]`, cut: true };
}

const KINDS: Record<UplinkKind, KindDef> = { generic: { authentic: genericAuthentic, read: genericRead }, ...RELAY_KINDS };

const bad = (message: string, field: string): HubError => new HubError('bad_request', message, field);
const cut = (text: string): string => text.slice(0, UPLINK_NOTE_MAX_CHARS);

/** The fields a request may carry, checked one by one. With `whole` the two that have no default must be there. */
function validate(input: unknown, whole: boolean): UplinkPatch & { kind?: UplinkKind } {
  if (!isRecord(input)) throw new HubError('bad_request', 'request body must be a JSON object');
  const allowed = whole ? CREATE_FIELDS : PATCH_FIELDS;
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw bad(`unknown field "${key}"`, key);
  if (whole) for (const key of ['name', 'to']) if (input[key] === undefined) throw bad(`${key} is required`, key);
  const out: UplinkPatch & { kind?: UplinkKind } = {};
  if (input.name !== undefined) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name === '' || name.length > UPLINK_NAME_MAX_CHARS || UNSAFE_IN_NAME.test(name)) {
      throw bad(`name must be 1 to ${UPLINK_NAME_MAX_CHARS} characters on one line`, 'name');
    }
    out.name = name;
  }
  if (input.to !== undefined) {
    if (typeof input.to !== 'string' || (input.to !== 'boss' && (input.to === 'user' || !NAME_RE.test(input.to)))) {
      throw bad('to must be an agent name or "boss"', 'to');
    }
    out.to = input.to;
  }
  if (input.kind !== undefined) {
    if (typeof input.kind !== 'string' || !(UPLINK_KINDS as readonly string[]).includes(input.kind)) throw bad(`kind must be one of: ${UPLINK_KINDS.join(', ')}`, 'kind');
    out.kind = input.kind as UplinkKind;
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw bad('enabled must be true or false', 'enabled');
    out.enabled = input.enabled;
  }
  if (input.secret !== undefined) {
    if (typeof input.secret !== 'string' || !SECRET_RE.test(input.secret)) throw bad('secret must be 16 to 256 characters without spaces', 'secret');
    out.secret = input.secret;
  }
  return out;
}

const givesSecret = (kind: UplinkKind): boolean => UPLINK_GIVEN_SECRET_KINDS.includes(kind);
/** The secret of a request must be there for the kinds that take the service's own, and not be there for the others. */
function checkSecret(kind: UplinkKind, secret: string | undefined, required: boolean): void {
  if (secret === undefined && required && givesSecret(kind)) throw bad(`secret is required: it is the signing secret ${kind === 'slack' ? 'of the Slack app' : 'of the Linear webhook'}`, 'secret');
  if (secret !== undefined && !givesSecret(kind)) throw bad(`a ${kind} uplink makes its own secret: only ${UPLINK_GIVEN_SECRET_KINDS.join(' and ')} take one`, 'secret');
}

/** What a saved delivery has to look like; anything else in the array is dropped. */
const isDelivery = (x: unknown): x is UplinkDelivery =>
  isRecord(x) && typeof x.at === 'number' && typeof x.note === 'string' && typeof x.status === 'string' && (x.status === 'refused' || x.status === 'answered' || (ACTIVITY_STATUSES as readonly string[]).includes(x.status));

const viewOf = (u: Uplink): UplinkView => ({ id: u.id, name: u.name, kind: u.kind, to: u.to, enabled: u.enabled, createdAt: u.createdAt, deliveries: [...u.deliveries] });
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function createUplinks(options: UplinksOptions): Uplinks {
  const { dir, now, log } = options;
  const inbound = options.inbound ?? NO_INBOUND;
  const path = join(dir, UPLINKS_FILE);
  let uplinks: Uplink[] = [];
  let seq = 0;
  let chain: Promise<unknown> = Promise.resolve();
  /** When each uplink took its deliveries of the last minute, for the rate limit. Memory only. */
  const taken = new Map<string, number[]>();
  /** Uplinks whose limit was hit and noted; cleared by the next delivery that gets through. */
  const limited = new Set<string>();
  /** When each uplink was refused for a bad signature, and when the inbox was last told. Memory only. */
  const refused = new Map<string, { at: number[]; told: number }>();

  const later = (fn: () => Promise<unknown>): Promise<void> => {
    const run = chain.then(fn);
    chain = run.catch((error: unknown) => log.error('uplink could not write', error));
    return run.then(() => undefined);
  };

  const save = (): Promise<void> => {
    const json = JSON.stringify({ version: 1, uplinks }, null, 2);
    return later(async () => {
      const tmp = join(dir, `.${UPLINKS_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
      await writeFile(tmp, json, { mode: FILE_MODE, flag: 'wx' });
      await rename(tmp, path);
    });
  };

  const list = (): UplinkView[] => uplinks.map(viewOf);
  /** Tells the browsers and saves; a failed save is logged by `later`, so a caller that does not wait may ignore it. */
  const changed = (): Promise<void> => {
    options.emit(list());
    return save();
  };

  const find = (id: string): Uplink => {
    const u = ID_RE.test(id) ? uplinks.find((x) => x.id === id) : undefined;
    if (!u) throw new HubError('not_found', 'unknown uplink');
    return u;
  };

  const record = (u: Uplink, status: UplinkDelivery['status'], note: string): void => {
    u.deliveries = [{ at: now(), status, note: cut(note) }, ...u.deliveries].slice(0, UPLINK_DELIVERIES_MAX);
    void changed().catch(() => undefined);
  };

  /** Counts a request that did not prove itself; the inbox hears of it once per window, and never the secret. */
  const refuse = (u: Uplink): void => {
    const t = now();
    const entry = refused.get(u.id) ?? { at: [], told: Number.NEGATIVE_INFINITY };
    // only the newest UPLINK_BAD_MAX + 1 are kept: a flood of bad requests must not grow this list
    entry.at = [...entry.at.filter((at) => t - at < UPLINK_BAD_WINDOW_MS), t].slice(-(UPLINK_BAD_MAX + 1));
    refused.set(u.id, entry);
    if (entry.at.length <= UPLINK_BAD_MAX || t - entry.told < UPLINK_BAD_WINDOW_MS) return;
    entry.told = t;
    options.notify?.('uplink', `${u.name}: more than ${UPLINK_BAD_MAX} requests with a bad signature in ${UPLINK_BAD_WINDOW_MS / 60_000} minutes`);
  };

  /** One delivery of the last minute for `u`, or false when the limit is used up. */
  const takeSlot = (u: Uplink): boolean => {
    const t = now();
    const times = (taken.get(u.id) ?? []).filter((at) => t - at < UPLINK_RATE_WINDOW_MS);
    taken.set(u.id, times);
    if (times.length >= UPLINK_RATE_MAX) return false;
    times.push(t);
    return true;
  };

  /** Sends a message that a kind made and records what became of it. `label` starts the note ("test: "). Throws what `deliver` documents. */
  const receive = (u: Uplink, message: Extract<Made, { text: string }>, label: string): SendResult => {
    try {
      // a reply goes to the agent that wrote the message it answers, not to the one the uplink is set to
      const request = { to: message.to ?? u.to, subject: message.subject ?? uplinkSubject(u.name), body: message.text, inReplyTo: message.inReplyTo };
      let sent: SendResult;
      try {
        sent = options.send(request);
      } catch (error) {
        // that agent was removed or renamed since: the uplink's own recipient gets the reply, so that the service is not
        // answered 409 and does not send the same update again and again (Telegram does)
        if (message.to === undefined || !(error instanceof HubError && error.code === 'not_found')) throw error;
        sent = options.send({ ...request, to: u.to });
      }
      record(u, sent.status, `${label}${sent.id}${sent.note ? `: ${sent.note}` : ''}${message.cut ? ' (cut)' : ''}`);
      return sent;
    } catch (error) {
      record(u, 'refused', `${label}not sent: ${messageOf(error)}`);
      // not "not found": that answer is for an uplink that does not exist
      throw new HubError('conflict', messageOf(error));
    }
  };

  return {
    async load() {
      let saved: unknown = null;
      try {
        saved = JSON.parse(await readFile(path, 'utf8'));
        if (!isRecord(saved) || saved.version !== 1 || !Array.isArray(saved.uplinks)) throw new Error('not a version 1 uplinks file');
      } catch (error) {
        saved = null;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          // kept aside, so that the next save cannot overwrite the secrets the Director has handed out
          // a SyntaxError quotes the text around the fault, which can be part of a secret
          log.error(`${UPLINKS_FILE} could not be read; uplinks start empty and the file is kept as ${UPLINKS_FILE}.bad`, error instanceof SyntaxError ? 'not valid JSON' : error);
          await rename(path, `${path}.bad`).catch(() => undefined);
        }
      }
      const records: unknown[] = isRecord(saved) && Array.isArray(saved.uplinks) ? saved.uplinks : [];
      for (const raw of records) {
        try {
          if (!isRecord(raw) || typeof raw.id !== 'string' || !ID_RE.test(raw.id)) throw new Error('no valid id');
          if (uplinks.some((x) => x.id === raw.id)) throw new Error(`the id ${raw.id} is used twice`);
          if (typeof raw.secret !== 'string' || !SECRET_RE.test(raw.secret)) throw new Error(`${raw.id} has no valid secret`);
          const own = validate({ name: raw.name, to: raw.to, kind: raw.kind, enabled: raw.enabled }, true);
          uplinks.push({
            id: raw.id,
            name: own.name ?? '',
            kind: own.kind ?? 'generic',
            to: own.to ?? '',
            secret: raw.secret,
            enabled: own.enabled === true,
            createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now(),
            deliveries: (Array.isArray(raw.deliveries) ? raw.deliveries.filter(isDelivery) : []).map((d) => ({ at: d.at, status: d.status, note: cut(d.note) })).slice(0, UPLINK_DELIVERIES_MAX),
          });
          seq = Math.max(seq, Number(raw.id.slice(1)));
        } catch (error) {
          log.warn(`${UPLINKS_FILE}: an uplink was skipped: ${messageOf(error)}`);
        }
      }
    },

    list,

    async create(input) {
      const request = validate(input, true) as UplinkRequest;
      const kind = request.kind ?? 'generic';
      checkSecret(kind, request.secret, true);
      if (uplinks.length >= UPLINKS_MAX) throw new HubError('conflict', `at most ${UPLINKS_MAX} uplinks`);
      seq += 1;
      const u: Uplink = {
        id: `u${seq}`,
        name: request.name,
        kind,
        to: request.to,
        secret: request.secret ?? randomBytes(32).toString('hex'),
        enabled: request.enabled ?? true,
        createdAt: now(),
        deliveries: [],
      };
      uplinks.push(u);
      await changed();
      return { ...viewOf(u), secret: u.secret };
    },

    async update(id, input) {
      const u = find(id);
      const patch = validate(input, false);
      checkSecret(u.kind, patch.secret, false);
      Object.assign(u, patch);
      await changed();
      return viewOf(u);
    },

    async remove(id) {
      const u = find(id);
      uplinks = uplinks.filter((x) => x !== u);
      taken.delete(id);
      limited.delete(id);
      refused.delete(id);
      await changed();
    },

    async rotate(id) {
      const u = find(id);
      if (givesSecret(u.kind)) throw new HubError('conflict', `the secret of a ${u.kind} uplink is the one the service made: set it by editing the uplink`);
      u.secret = randomBytes(32).toString('hex');
      await changed();
      return { ...viewOf(u), secret: u.secret };
    },

    async test(id) {
      const u = find(id);
      try {
        // the sample is JSON whatever the kind: it proves the way to the agent, not the signature of a service
        receive(u, genericRead(Buffer.from(JSON.stringify({ test: true, uplink: u.name, at: new Date(now()).toISOString() }))), 'test: ');
      } catch {
        // the refusal is in the delivery that `receive` recorded
      }
      await chain;
      return viewOf(u);
    },

    deliver(id, raw, headers) {
      const u = ID_RE.test(id) ? uplinks.find((x) => x.id === id) : undefined;
      if (!u || !u.enabled) throw new HubError('not_found', 'not found');
      if (!KINDS[u.kind].authentic(raw, headers, u.secret, now())) {
        // not recorded: anyone who guesses an id could fill the list of deliveries
        log.debug(`uplink ${u.id}: a request did not prove itself`);
        refuse(u);
        throw new HubError('unauthorized', 'unauthorized');
      }
      let made: Made;
      try {
        made = KINDS[u.kind].read(raw, headers, inbound);
      } catch (error) {
        record(u, 'refused', messageOf(error));
        throw error;
      }
      // before the rate limit: what the agents never hear of (chatter in a channel) must not use up the deliveries of a minute
      if (made === null) return IGNORED;
      if ('answer' in made) {
        record(u, 'answered', made.note);
        return { ok: true, answer: made.answer };
      }
      if (!takeSlot(u)) {
        // noted once per flood, as the hub does for an agent's limit: a note per refusal would push out the real deliveries
        if (!limited.has(u.id)) {
          limited.add(u.id);
          record(u, 'refused', `rate limit: more than ${UPLINK_RATE_MAX} deliveries in a minute`);
        }
        throw new HubError('rate_limited', `at most ${UPLINK_RATE_MAX} deliveries a minute`);
      }
      limited.delete(u.id);
      // after the limit: an event that was refused for it is not marked handled, so Slack's retry can still get through
      if (made.once !== undefined && inbound.seen(made.once)) return IGNORED;
      const sent = receive(u, made, '');
      return { ok: sent.ok, id: sent.id, status: sent.status };
    },

    close() {
      return chain.then(() => undefined);
    },
  };
}
