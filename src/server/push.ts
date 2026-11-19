/**
 * Web Push for the installed app (docs/mobile-spec.md, docs/features/mobile.md): a push to the Director's phone when something waits
 * for them, with no relay of ours. The supervisor holds ONE VAPID key pair and the subscriptions in <home>/push.json (0600), next to
 * the login sessions they belong to, and talks straight to the browser vendor's push service; that service only ever sees an encrypted
 * body and the endpoint. A room (a child process) only says what happened, on its pipe to the supervisor (supervisor.ts).
 *
 * What it does, in order of care:
 * - the endpoint of a subscription is the one place a session can make the server send a request, so it is checked when it is stored
 *   and again before every send (R9): https only, port 443, a host on the allow-list of the vendors' push hosts, no address, no
 *   redirect, the answer is never shown. A session cannot make the server POST to 127.0.0.1 or the LAN;
 * - the body is encrypted as RFC 8291 says (aes128gcm) and signed as RFC 8292 says (VAPID, ES256), with node's crypto;
 * - a subscription belongs to the login session that made it, and goes with the session (revoked, ended, tamper alarm, reset);
 * - the payload is generic by default ("An agent needs you"): a lock screen shows it. The sender and the first words of the text
 *   are an opt-in of each device, cut and cleaned as the page's own notifications are;
 * - nothing is approved from a notification: a tap opens the page at the ask.
 */
import { createECDH, createHash, createPrivateKey, hkdfSync, createCipheriv, randomBytes, sign } from 'node:crypto';
import type { ECDH } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DOCS_URL } from '../shared/protocol.js';
import { PUSH_KINDS } from '../shared/protocol.js';
import type { HubEvent, Logger, PushDevice, PushKind, PushView } from '../shared/protocol.js';
import { FILE_MODE } from './constants.js';
import { isRecord } from './hooks.js';
import { cutText, HubError } from './hub.js';

export const PUSH_FILE = 'push.json';
/** At most this many devices; a new one beyond it is refused, so a session cannot grow the file without end. */
export const PUSH_DEVICES_MAX = 20;
export const PUSH_DEVICE_NAME_MAX = 60;
export const PUSH_ENDPOINT_MAX = 1024;
export const PUSH_TIMEOUT_MS = 10_000;
/** How long the push service may hold the message when the phone is off. */
export const PUSH_TTL_S = 3600;
/** A record of 4096 bytes holds 4096 - 86 (header and key) - 17 (padding byte and tag) bytes of text. */
const RECORD = 4096;
const PAYLOAD_MAX = RECORD - 103;
export const SNIPPET_CHARS = 80;

/** The hosts a subscription's endpoint may name: FCM (Chrome, Edge and Firefox on Android), Apple, Mozilla and Windows. One constant, one place to widen. */
export const PUSH_HOSTS: readonly RegExp[] = [/^fcm\.googleapis\.com$/, /^([a-z0-9-]+\.)+push\.apple\.com$/, /^([a-z0-9-]+\.)*push\.services\.mozilla\.com$/, /^([a-z0-9-]+\.)+notify\.windows\.com$/];

/** The endpoint as a URL when it may be pushed to, else the reason it may not. Used at store time and at send time. */
export function checkEndpoint(endpoint: unknown): { ok: true; url: URL } | { ok: false; reason: string } {
  if (typeof endpoint !== 'string' || endpoint === '' || endpoint.length > PUSH_ENDPOINT_MAX) return { ok: false, reason: `endpoint must be a URL of at most ${PUSH_ENDPOINT_MAX} characters` };
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, reason: 'endpoint is not a URL' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'endpoint must be https' };
  if (url.username !== '' || url.password !== '' || (url.port !== '' && url.port !== '443')) return { ok: false, reason: 'endpoint must have no credentials and the https port' };
  // the URL parser has lower-cased the host and turned an address into its canonical form; a trailing dot is a different name for the same host, so it is refused
  const host = url.hostname;
  if (host.endsWith('.') || !PUSH_HOSTS.some((re) => re.test(host))) return { ok: false, reason: 'endpoint is not a push service of a known browser vendor' };
  return { ok: true, url };
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

/* ---------------------------------------------------------------- the crypto (RFC 8291, RFC 8292) */

export interface VapidKeys {
  /** The private scalar, base64url. */
  d: string;
  /** The public key as an uncompressed point (65 bytes), base64url: what the browser's `applicationServerKey` takes. */
  publicKey: string;
}

export function makeVapid(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { d: b64(ecdh.getPrivateKey()), publicKey: b64(ecdh.getPublicKey()) };
}

/** The `Authorization` header of RFC 8292 for a push to this endpoint's origin. */
export function vapidHeader(vapid: VapidKeys, endpoint: URL, now: number): string {
  const pub = Buffer.from(vapid.publicKey, 'base64url');
  const header = b64(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  // the subject is the docs site, not an address of the Director: some push services want one and none of them needs a real mailbox
  const claims = b64(Buffer.from(JSON.stringify({ aud: endpoint.origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: DOCS_URL })));
  const key = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: vapid.d, x: b64(pub.subarray(1, 33)), y: b64(pub.subarray(33, 65)) }, format: 'jwk' });
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64(signature)}, k=${vapid.publicKey}`;
}

/**
 * The body of a push, encrypted for one subscription (RFC 8291 section 3, one record). `ephemeral` and `salt` are for the tests of the
 * RFC's own example; a real send leaves them out and gets fresh ones.
 */
export function encryptPayload(plain: Uint8Array, p256dh: string, authSecret: string, ephemeral?: ECDH, salt: Buffer = randomBytes(16)): Buffer {
  const as = ephemeral ?? createECDH('prime256v1');
  if (ephemeral === undefined) as.generateKeys();
  const uaPublic = Buffer.from(p256dh, 'base64url');
  const asPublic = as.getPublicKey();
  const ecdhSecret = as.computeSecret(uaPublic);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, Buffer.from(authSecret, 'base64url'), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02 is the delimiter of the last record
  const sealed = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plain), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const head = Buffer.alloc(21);
  salt.copy(head, 0);
  head.writeUInt32BE(RECORD, 16);
  head.writeUInt8(asPublic.length, 20);
  return Buffer.concat([head, asPublic, sealed]);
}

/* ---------------------------------------------------------------- what is pushed */

/** One push: what the lock screen shows, and where a tap goes (the page of `room`, at the inbox or at the room itself). */
export interface PushNotice {
  tag: string;
  title: string;
  body: string;
  open: 'downlink' | 'room';
  /** The id of the room it came from: the tap opens `/r/<room>/` (`/` for main). */
  room: string;
}

/** What a room says happened, as it travels its pipe: the kind, the text (cut), and the sender of a message. */
export interface PushEvent {
  kind: PushKind;
  text: string;
  from?: string;
}

const oneLine = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
const cut = (text: string, max: number): string => cutText(oneLine(text), max);

const GENERIC: Record<PushKind, { body: string; open: PushNotice['open'] }> = {
  message: { body: '1 new message', open: 'downlink' },
  redline: { body: 'A limit tripped (Redline)', open: 'room' },
  tminus: { body: 'A T-minus poll wants a call', open: 'room' },
  relief: { body: 'A hire request waits for your GO', open: 'room' },
  permission: { body: 'An agent needs you', open: 'room' },
};

/** The room a push comes from: its id (where a tap goes) and its name (said in the title when it is not main). */
export interface PushRoom {
  id: string;
  name: string;
}

/**
 * The notice of one event for one device. Generic unless the device chose to see more: the title says the room when it is not main
 * ("gonogo, Team B"), the body is a fixed line for the kind. With the opt-in the title is the sender of a message and the body the first
 * words of the text, cut and cleaned. One notification for a kind of a room (and a sender), so a burst is one.
 */
export function pushNotice(room: PushRoom, ev: PushEvent, snippet: boolean): PushNotice {
  const base = GENERIC[ev.kind];
  const where = room.id === 'main' ? '' : `, ${cut(room.name, 40)}`;
  const tag = `gonogo-${room.id}-${ev.kind}${ev.from === undefined ? '' : `-${cut(ev.from, 40)}`}`;
  const title = snippet && ev.from !== undefined ? `${cut(ev.from, 40)}${where}` : `gonogo${where}`;
  return { tag, title, body: snippet ? cut(ev.text, SNIPPET_CHARS) : base.body, open: base.open, room: room.id };
}

/**
 * The kind of a Downlink event that is also pushed, or null. A T-minus event is pushed only for the results that want the Director, as the
 * page's own notifications do (notify.ts POLL_NEWS): HOLD and GO, not an abort. The hub words them `HOLD: ...`, `GO: ...`, and for a Static
 * fire `Static fire on <subject>: HOLD: ...`.
 */
export const pushKindOf = (kind: string, text = ''): PushKind | null => {
  if (kind === 'tminus') return /^(?:Static fire on [^\n]*?: )?(?:GO|HOLD):/.test(text) ? 'tminus' : null;
  return kind === 'redline' || kind === 'relief' || kind === 'permission' ? kind : null;
};

/** What a hub frame says that is worth a push: a message to the Director. */
export function pushEventOfHub(event: HubEvent): PushEvent | null {
  if (event.t !== 'activity' || event.item.to !== 'user') return null;
  return { kind: 'message', text: `${event.item.subject === '' ? '' : `${event.item.subject}: `}${event.item.body}`, from: event.item.from };
}

/** The line a room writes on its pipe (supervisor.ts reads it). */
export const PUSH_LINE = 'gonogo-push ';
export const pushLineOf = (ev: PushEvent): string => `${PUSH_LINE}${JSON.stringify({ kind: ev.kind, text: cut(ev.text, 200), ...(ev.from === undefined ? {} : { from: cut(ev.from, 40) }) })}\n`;

/** A line from a room's pipe, checked: anything that is not a push event of a known kind is null. The text is cut again, here, whatever the room sent. */
export function parsePushLine(json: string): PushEvent | null {
  if (json.length > 1000) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.kind !== 'string' || !(PUSH_KINDS as readonly string[]).includes(value.kind) || typeof value.text !== 'string') return null;
  return { kind: value.kind as PushKind, text: cut(value.text, 200), ...(typeof value.from === 'string' ? { from: cut(value.from, 40) } : {}) };
}

/* ---------------------------------------------------------------- the store */

interface Device {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  name: string;
  snippet: boolean;
  /** The login session that made it: it ends with that session. */
  session: string;
  at: number;
}

export interface PushOptions {
  /** The supervisor's home: push.json lives here. */
  dir: string;
  now(): number;
  fetch: typeof fetch;
  log: Logger;
}

export interface Push {
  load(): Promise<void>;
  /** The public key, and the devices; `session` marks which one belongs to the caller. */
  view(session: string | null): PushView;
  /** Stores or replaces the device of this endpoint. Needs a session; a bad body, a refused endpoint, too many devices throw a HubError. */
  subscribe(input: unknown, session: string | null): Promise<PushView>;
  unsubscribe(input: unknown, session: string | null): Promise<PushView>;
  /** Sends a generic test to one device (the key in Flight Rules); resolves with what the push service said. */
  test(input: unknown, session: string | null): Promise<{ ok: boolean; note: string }>;
  /** Something happened in a room that waits for the Director: every device is told. */
  notify(room: PushRoom, ev: PushEvent): void;
  /** These sessions ended (revoked, logged out, expired, password changed): their devices go. */
  dropSessions(ids: readonly string[]): Promise<void>;
  /** A step-up gave the session a new id: its devices follow it, or a later revoke would never find them. */
  rebind(from: string, to: string): Promise<void>;
  /** Drops every device whose session is not alive in the login: ids that ended unseen, a reset, the tamper alarm, an entry planted in the file. */
  prune(alive: (session: string) => boolean): Promise<void>;
  /** Every device goes. */
  dropAll(): Promise<void>;
  close(): Promise<void>;
}

const bad = (message: string, field?: string): HubError => new HubError('bad_request', message, field);

export function createPush(options: PushOptions): Push {
  const { now, log } = options;
  const path = join(options.dir, PUSH_FILE);
  let vapid: VapidKeys | null = null;
  let devices: Device[] = [];
  let chain: Promise<unknown> = Promise.resolve();
  const inflight = new Set<Promise<unknown>>();
  const closing = new AbortController();

  const idOf = (endpoint: string): string => createHash('sha256').update(endpoint).digest('hex').slice(0, 16);

  async function save(): Promise<void> {
    const temp = join(options.dir, `.${PUSH_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    await writeFile(temp, JSON.stringify({ version: 1, vapid, devices }, null, 2), { mode: FILE_MODE, flag: 'wx' });
    await rename(temp, path);
  }
  /** Changes run one after the other: two sessions subscribing at once do not lose each other's device. */
  const change = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn);
    chain = run.catch(() => undefined);
    return run;
  };

  const view = (session: string | null): PushView => ({
    publicKey: vapid?.publicKey ?? '',
    devices: devices.map((d): PushDevice => ({ id: d.id, name: d.name, snippet: d.snippet, at: d.at, mine: session !== null && d.session === session })),
  });

  async function deliver(device: Device, notice: PushNotice): Promise<{ ok: boolean; note: string; gone: boolean }> {
    const checked = checkEndpoint(device.endpoint);
    if (!checked.ok || vapid === null) return { ok: false, note: checked.ok ? 'no key' : checked.reason, gone: !checked.ok };
    const plain = Buffer.from(JSON.stringify({ title: notice.title, body: notice.body, tag: notice.tag, open: notice.open, room: notice.room }));
    if (plain.length > PAYLOAD_MAX) return { ok: false, note: 'payload too long', gone: false };
    try {
      const res = await options.fetch(checked.url, {
        method: 'POST',
        headers: {
          Authorization: vapidHeader(vapid, checked.url, now()),
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          TTL: String(PUSH_TTL_S),
          Urgency: 'high',
        },
        body: new Uint8Array(encryptPayload(plain, device.p256dh, device.auth)),
        // a redirect would be a request to a place the allow-list never saw
        redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(PUSH_TIMEOUT_MS), closing.signal]),
      });
      // the answer is never read or shown: the status is all that matters
      void res.body?.cancel().catch(() => undefined);
      return { ok: res.status >= 200 && res.status < 300, note: `push service answered ${res.status}`, gone: res.status === 404 || res.status === 410 };
    } catch {
      return { ok: false, note: 'the push service could not be reached', gone: false };
    }
  }

  function send(room: PushRoom, ev: PushEvent): void {
    if (devices.length === 0 || vapid === null) return;
    for (const device of [...devices]) {
      const job = deliver(device, pushNotice(room, ev, device.snippet)).then(async (result) => {
        if (!result.ok) log.warn(`push: ${device.name}: ${result.note}`);
        if (result.gone) await change(async () => void ((devices = devices.filter((d) => d.id !== device.id)), await save().catch(() => undefined)));
      });
      inflight.add(job);
      void job.finally(() => inflight.delete(job));
    }
  }

  const find = (input: unknown): Device => {
    if (!isRecord(input) || typeof input.id !== 'string') throw bad('id is required', 'id');
    const found = devices.find((d) => d.id === input.id);
    if (found === undefined) throw new HubError('not_found', 'no such device');
    return found;
  };

  return {
    async load() {
      try {
        const saved: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!isRecord(saved) || saved.version !== 1 || !isRecord(saved.vapid) || typeof saved.vapid.d !== 'string' || typeof saved.vapid.publicKey !== 'string') throw new Error('not a version 1 push file');
        vapid = { d: saved.vapid.d, publicKey: saved.vapid.publicKey };
        // a device whose endpoint no longer passes the check is not kept: the file is mode 0600 but it is still a file an agent can edit
        devices = (Array.isArray(saved.devices) ? saved.devices : []).filter((d): d is Device => isRecord(d) && typeof d.endpoint === 'string' && checkEndpoint(d.endpoint).ok && typeof d.p256dh === 'string' && typeof d.auth === 'string' && typeof d.session === 'string' && typeof d.name === 'string' && typeof d.id === 'string' && typeof d.at === 'number').map((d) => ({ ...d, snippet: d.snippet === true })).slice(0, PUSH_DEVICES_MAX);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          log.error(`${PUSH_FILE} could not be read; a new key is made, so devices must subscribe again, and the file is kept as ${PUSH_FILE}.bad`);
          await rename(path, `${path}.bad`).catch(() => undefined);
        }
        vapid = makeVapid();
        devices = [];
        await save().catch((e: unknown) => log.error(`${PUSH_FILE} could not be written`, e));
      }
    },

    view,

    subscribe: (input, session) =>
      change(async () => {
        if (session === null) throw new HubError('forbidden', 'push needs a login session');
        if (!isRecord(input)) throw bad('request body must be a JSON object');
        for (const key of Object.keys(input)) if (!['endpoint', 'keys', 'device', 'snippet'].includes(key)) throw bad(`unknown field "${key}"`, key);
        const checked = checkEndpoint(input.endpoint);
        if (!checked.ok) throw bad(checked.reason, 'endpoint');
        const keys = input.keys;
        const p256dh = isRecord(keys) && typeof keys.p256dh === 'string' ? keys.p256dh : '';
        const auth = isRecord(keys) && typeof keys.auth === 'string' ? keys.auth : '';
        if (Buffer.from(p256dh, 'base64url').length !== 65 || Buffer.from(p256dh, 'base64url')[0] !== 4 || Buffer.from(auth, 'base64url').length !== 16) throw bad('keys must hold p256dh (a 65-byte point) and auth (16 bytes), base64url', 'keys');
        if (input.snippet !== undefined && typeof input.snippet !== 'boolean') throw bad('snippet must be true or false', 'snippet');
        const name = cut(typeof input.device === 'string' ? input.device : '', PUSH_DEVICE_NAME_MAX) || 'device';
        const id = idOf(checked.url.href);
        const others = devices.filter((d) => d.id !== id);
        if (others.length >= PUSH_DEVICES_MAX) throw new HubError('conflict', `at most ${PUSH_DEVICES_MAX} devices: remove one first`);
        const before = devices;
        devices = [...others, { id, endpoint: checked.url.href, p256dh, auth, name, snippet: input.snippet === true, session, at: now() }];
        try {
          await save();
        } catch (error) {
          devices = before;
          throw new HubError('internal', `could not save the device: ${error instanceof Error ? error.message : String(error)}`);
        }
        return view(session);
      }),

    unsubscribe: (input, session) =>
      change(async () => {
        const device = find(input);
        devices = devices.filter((d) => d !== device);
        await save();
        return view(session);
      }),

    test: async (input, session) => {
      if (session === null) throw new HubError('forbidden', 'push needs a login session');
      const device = find(input);
      const result = await deliver(device, { tag: 'gonogo-test', title: 'gonogo', body: 'Test: this device gets pushes.', open: 'room', room: 'main' });
      return { ok: result.ok, note: result.note };
    },

    notify: send,

    dropSessions: (ids) =>
      change(async () => {
        const gone = new Set(ids);
        const kept = devices.filter((d) => !gone.has(d.session));
        if (kept.length === devices.length) return;
        devices = kept;
        await save();
      }),

    rebind: (from, to) =>
      change(async () => {
        if (!devices.some((d) => d.session === from)) return;
        devices = devices.map((d) => (d.session === from ? { ...d, session: to } : d));
        await save();
      }),

    prune: (alive) =>
      change(async () => {
        const kept = devices.filter((d) => alive(d.session));
        if (kept.length === devices.length) return;
        devices = kept;
        await save();
      }),

    dropAll: () =>
      change(async () => {
        if (devices.length === 0) return;
        devices = [];
        await save();
      }),

    async close() {
      closing.abort();
      await Promise.allSettled([...inflight]);
      await chain.catch(() => undefined);
    },
  };
}
