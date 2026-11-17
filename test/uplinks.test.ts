import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BODY_MAX_CHARS, UPLINK_DELIVERIES_MAX, UPLINK_NAME_MAX_CHARS, UPLINKS_MAX } from '../src/shared/protocol.js';
import type { Logger, SendResult, UplinkCreated, UplinkView, UserMessageRequest } from '../src/shared/protocol.js';
import { UPLINK_RATE_MAX } from '../src/server/constants.js';
import { HubError } from '../src/server/hub.js';
import { createUplinks } from '../src/server/uplinks.js';
import type { Inbound, Uplinks } from '../src/server/uplinks.js';

const MIN = 60_000;
let dir: string;
let now: number;
let sent: UserMessageRequest[];
let emitted: UplinkView[][];
let logs: string[];
let posted: Array<[string, string]>;
let answer: (request: UserMessageRequest) => SendResult;
const open: Uplinks[] = [];

const quiet = (sink: string[]): Logger => {
  const log: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message) => void sink.push(message),
    error: (message, ...extra) => void sink.push([message, ...extra.map(String)].join(' ')),
    child: () => log,
  };
  return log;
};

function make(inbound?: Inbound): Uplinks {
  const u = createUplinks({
    dir,
    inbound,
    now: () => now,
    send: (request) => {
      sent.push(request);
      return answer(request);
    },
    emit: (list) => void emitted.push(list),
    notify: (kind, text) => void posted.push([kind, text]),
    log: quiet(logs),
  });
  open.push(u);
  return u;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gonogo-uplinks-'));
  now = Date.UTC(2026, 10, 17, 9, 0);
  sent = [];
  emitted = [];
  logs = [];
  posted = [];
  let n = 0;
  answer = (request) => ({ ok: true, id: `m${++n}`, to: request.to === 'boss' ? 'flight' : request.to, status: 'queued', note: null });
});

afterEach(async () => {
  for (const u of open.splice(0)) await u.close();
  await rm(dir, { recursive: true, force: true });
});

const sign = (secret: string, raw: string | Buffer): Record<string, string> => ({ 'x-gonogo-signature': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` });
const refusal = (fn: () => unknown): HubError => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HubError);
    return error as HubError;
  }
  throw new Error('did not throw');
};

async function made(u: Uplinks, over: Record<string, unknown> = {}): Promise<UplinkCreated> {
  return u.create({ name: 'GitHub', to: 'ana', ...over });
}

describe('uplink: make, edit, rotate, remove', () => {
  it('makes an uplink with a 32-byte secret that only the answer to create shows', async () => {
    const u = make();
    await u.load();
    const first = await made(u);
    expect(first).toMatchObject({ id: 'u1', name: 'GitHub', kind: 'generic', to: 'ana', enabled: true, createdAt: now, deliveries: [] });
    expect(first.secret).toMatch(/^[0-9a-f]{64}$/);
    expect((await made(u)).secret).not.toBe(first.secret);
    for (const view of [...u.list(), ...emitted.flat()]) expect(view).not.toHaveProperty('secret');
    expect(u.list().map((v) => v.id)).toEqual(['u1', 'u2']);
    const file = join(dir, 'uplinks.json');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(await readFile(file, 'utf8')) as { version: number; uplinks: Array<{ secret: string }> };
    expect(saved.version).toBe(1);
    expect(saved.uplinks[0]?.secret).toBe(first.secret);
  });

  it('refuses a bad request with the name of the field', async () => {
    const u = make();
    await u.load();
    const fails = async (input: unknown, field: string | undefined): Promise<void> => {
      const error = await u.create(input).then(
        () => null,
        (e: unknown) => e as HubError,
      );
      expect(error, JSON.stringify(input)).toBeInstanceOf(HubError);
      expect(error).toMatchObject({ code: 'bad_request', field });
    };
    await fails([1], undefined);
    await fails({ to: 'ana' }, 'name');
    await fails({ name: 'x' }, 'to');
    await fails({ name: '  ', to: 'ana' }, 'name');
    await fails({ name: 'x'.repeat(UPLINK_NAME_MAX_CHARS + 1), to: 'ana' }, 'name');
    await fails({ name: 'two\nlines', to: 'ana' }, 'name');
    await fails({ name: 'x', to: 'user' }, 'to');
    await fails({ name: 'x', to: 'Not A Name' }, 'to');
    await fails({ name: 'x', to: 'ana', kind: 'sms' }, 'kind');
    await fails({ name: 'x', to: 'ana', enabled: 'yes' }, 'enabled');
    await fails({ name: 'x', to: 'ana', secret: 'a'.repeat(64) }, 'secret');
    expect(u.list()).toEqual([]);
    expect(await made(u, { to: 'boss', enabled: false, name: '  Padded  ' })).toMatchObject({ to: 'boss', enabled: false, name: 'Padded' });
  });

  it(`takes at most ${UPLINKS_MAX} uplinks`, async () => {
    const u = make();
    await u.load();
    for (let i = 0; i < UPLINKS_MAX; i++) await made(u);
    await expect(made(u)).rejects.toMatchObject({ code: 'conflict' });
    await u.remove('u1');
    expect((await made(u)).id).toBe(`u${UPLINKS_MAX + 1}`);
  });

  it('edits name, recipient and switch, and refuses the kind and the secret', async () => {
    const u = make();
    await u.load();
    const { id, secret } = await made(u);
    expect(await u.update(id, { enabled: false, to: 'boss', name: 'Renamed' })).toMatchObject({ enabled: false, to: 'boss', name: 'Renamed' });
    expect(await u.update(id, {})).toMatchObject({ name: 'Renamed' });
    await expect(u.update(id, { kind: 'generic' })).rejects.toMatchObject({ code: 'bad_request', field: 'kind' });
    await expect(u.update(id, { secret: 'x' })).rejects.toMatchObject({ code: 'bad_request', field: 'secret' });
    await expect(u.update('u9', {})).rejects.toMatchObject({ code: 'not_found' });
    await expect(u.update('nope', {})).rejects.toMatchObject({ code: 'not_found' });
    const saved = JSON.parse(await readFile(join(dir, 'uplinks.json'), 'utf8')) as { uplinks: Array<{ secret: string; name: string }> };
    expect(saved.uplinks[0]).toMatchObject({ name: 'Renamed', secret });
  });

  it('rotates the secret: the old one stops working at once, the deliveries stay', async () => {
    const u = make();
    await u.load();
    const first = await made(u);
    const body = Buffer.from('{"a":1}');
    u.deliver('u1', body, sign(first.secret, body));
    const second = await u.rotate('u1');
    expect(second.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(second.secret).not.toBe(first.secret);
    expect(second.deliveries).toHaveLength(1);
    expect(refusal(() => u.deliver('u1', body, sign(first.secret, body))).code).toBe('unauthorized');
    expect(refusal(() => u.deliver('u1', body, { authorization: `Bearer ${first.secret}` })).code).toBe('unauthorized');
    expect(u.deliver('u1', body, sign(second.secret, body)).ok).toBe(true);
    expect(u.list()[0]).not.toHaveProperty('secret');
    await expect(u.rotate('u2')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('removes an uplink, and its endpoint answers not found from then on', async () => {
    const u = make();
    await u.load();
    const { secret } = await made(u);
    await u.remove('u1');
    expect(u.list()).toEqual([]);
    expect(refusal(() => u.deliver('u1', Buffer.from('{}'), { authorization: `Bearer ${secret}` })).code).toBe('not_found');
    await expect(u.remove('u1')).rejects.toMatchObject({ code: 'not_found' });
    expect(JSON.parse(await readFile(join(dir, 'uplinks.json'), 'utf8'))).toEqual({ version: 1, uplinks: [] });
  });
});

describe('uplink: a delivery', () => {
  it('becomes a message from the Director: "Uplink: <name>" and the JSON pretty-printed', async () => {
    const u = make();
    await u.load();
    const { secret } = await made(u);
    const raw = Buffer.from('{"action":"opened","issue":{"n":7,"tags":["a","b"]}}');
    expect(u.deliver('u1', raw, sign(secret, raw))).toEqual({ ok: true, id: 'm1', status: 'queued' });
    expect(sent).toEqual([{ to: 'ana', subject: 'Uplink: GitHub', body: JSON.stringify({ action: 'opened', issue: { n: 7, tags: ['a', 'b'] } }, null, 2) }]);
    expect(sent[0]?.body).toContain('\n  "issue": {\n    "n": 7,');
    expect(u.list()[0]?.deliveries).toEqual([{ at: now, status: 'queued', note: 'm1' }]);
    expect(emitted.at(-1)?.[0]?.deliveries).toHaveLength(1);
  });

  it('sends to the boss by the word, and keeps the note of the hub in the delivery', async () => {
    const u = make();
    await u.load();
    const { secret } = await made(u, { to: 'boss' });
    answer = () => ({ ok: true, id: 'm5', to: 'flight', status: 'held', note: 'waiting for Max Q: 3 of 3 agents working' });
    u.deliver('u1', Buffer.from('1'), { authorization: `Bearer ${secret}` });
    expect(sent[0]?.to).toBe('boss');
    expect(u.list()[0]?.deliveries[0]).toMatchObject({ status: 'held', note: 'm5: waiting for Max Q: 3 of 3 agents working' });
    answer = () => ({ ok: false, id: 'm6', to: 'flight', status: 'undelivered', note: 'flight is stopped; the message went to the user' });
    expect(u.deliver('u1', Buffer.from('1'), { authorization: `Bearer ${secret}` })).toEqual({ ok: false, id: 'm6', status: 'undelivered' });
    expect(u.list()[0]?.deliveries[0]).toMatchObject({ status: 'undelivered' });
  });

  it('proves itself by a signature of the raw body or by the secret as a bearer token', async () => {
    const u = make();
    await u.load();
    const { secret } = await made(u);
    const raw = Buffer.from('{ "spaces":   "kept" }');
    expect(u.deliver('u1', raw, sign(secret, raw)).ok).toBe(true);
    expect(u.deliver('u1', raw, { 'x-gonogo-signature': `SHA256=${createHmac('sha256', secret).update(raw).digest('hex').toUpperCase()}` }).ok).toBe(true);
    expect(u.deliver('u1', raw, { authorization: `Bearer ${secret}` }).ok).toBe(true);
    expect(u.deliver('u1', raw, { authorization: `bearer ${secret}` }).ok).toBe(true);
    expect(sent).toHaveLength(4);
    const refused = (headers: Record<string, string>, body = raw): void => expect(refusal(() => u.deliver('u1', body, headers)).code, JSON.stringify(headers)).toBe('unauthorized');
    refused({});
    refused(sign(secret, 'other body'));
    refused(sign('b'.repeat(64), raw));
    // the key is the text of the secret, not the bytes it spells
    refused({ 'x-gonogo-signature': `sha256=${createHmac('sha256', Buffer.from(secret, 'hex')).update(raw).digest('hex')}` });
    refused({ 'x-gonogo-signature': sign(secret, raw)['x-gonogo-signature'].slice(7) });
    refused({ 'x-gonogo-signature': 'sha256=abcd' });
    refused({ 'x-gonogo-signature': `sha256=${'z'.repeat(64)}` });
    refused({ authorization: `Bearer ${secret.slice(1)}` });
    refused({ authorization: `Bearer ${secret}x` });
    refused({ authorization: secret });
    refused({ authorization: `Basic ${secret}` });
    // a good signature for a body that was changed on the way
    refused(sign(secret, raw), Buffer.from('{ "spaces": "changed" }'));
    expect(sent).toHaveLength(4);
  });

  it('tells the Downlink once when more than 3 requests in 10 minutes had a bad signature, and never the secret', async () => {
    const u = make();
    await u.load();
    const { secret } = await made(u);
    const raw = Buffer.from('{"k":1}');
    const refused = (): void => void refusal(() => u.deliver('u1', raw, sign('b'.repeat(64), raw)));
    refused();
    refused();
    refused();
    expect(posted).toEqual([]);
    // a request that proves itself counts for nothing
    expect(u.deliver('u1', raw, sign(secret, raw)).ok).toBe(true);
    refused();
    expect(posted).toEqual([['uplink', 'GitHub: more than 3 requests with a bad signature in 10 minutes']]);
    // a flood is one event per window, not one per request
    for (let i = 0; i < 50; i += 1) refused();
    expect(posted).toHaveLength(1);
    // the old ones fall out of the window: three more are not "more than 3", the fourth is, and it is a second event
    now += 10 * MIN;
    refused();
    refused();
    refused();
    expect(posted).toHaveLength(1);
    refused();
    expect(posted).toHaveLength(2);
    expect(JSON.stringify(posted)).not.toContain(secret);
    // an id that does not exist, or one that is off, is not an uplink to tell about
    void refusal(() => u.deliver('u9', raw, {}));
    expect(posted).toHaveLength(2);
  });

  it('says not found for an id that is unknown and for one that is off, the same way, and leaves no trace', async () => {
    const u = make();
    await u.load();
    const { secret } = await made(u, { enabled: false });
    const headers = { authorization: `Bearer ${secret}` };
    const off = refusal(() => u.deliver('u1', Buffer.from('{}'), headers));
    const unknown = refusal(() => u.deliver('u2', Buffer.from('{}'), headers));
    const odd = refusal(() => u.deliver('constructor', Buffer.from('{}'), headers));
    expect([off.code, unknown.code, odd.code]).toEqual(['not_found', 'not_found', 'not_found']);
    expect([off.message, odd.message]).toEqual([unknown.message, unknown.message]);
    expect(sent).toEqual([]);
    expect(u.list()[0]?.deliveries).toEqual([]);
    await u.update('u1', { enabled: true });
    expect(u.deliver('u1', Buffer.from('{}'), headers).ok).toBe(true);
  });

  it('does not record a request that did not prove itself, so a stranger cannot fill the list', async () => {
    const u = make();
    await u.load();
    const { secret } = await made(u);
    for (let i = 0; i < 100; i++) refusal(() => u.deliver('u1', Buffer.from('{}'), { authorization: 'Bearer wrong' }));
    expect(u.list()[0]?.deliveries).toEqual([]);
    // and they do not use up the limit of the real sender
    expect(u.deliver('u1', Buffer.from('{}'), { authorization: `Bearer ${secret}` }).ok).toBe(true);
    expect(JSON.stringify(logs)).not.toContain(secret);
  });

  it('refuses a body that is not JSON and records it', async () => {
    const u = make();
    await u.load();
    const { secret } = await made(u);
    const headers = { authorization: `Bearer ${secret}` };
    for (const text of ['', 'hello', '{"a":', 'a=1&b=2']) {
      expect(refusal(() => u.deliver('u1', Buffer.from(text), headers))).toMatchObject({ code: 'bad_request', message: 'the body is not JSON, or is nested too deep' });
    }
    // parses, but cannot be written back without overflowing the stack
    expect(refusal(() => u.deliver('u1', Buffer.from('['.repeat(120_000) + ']'.repeat(120_000)), headers)).code).toBe('bad_request');
    expect(sent).toEqual([]);
    expect(u.list()[0]?.deliveries[0]).toMatchObject({ status: 'refused', note: 'the body is not JSON, or is nested too deep' });
    // JSON that is not an object is still JSON
    expect(u.deliver('u1', Buffer.from('"just text"'), headers).ok).toBe(true);
    expect(sent[0]?.body).toBe('"just text"');
  });

  it('cuts a body that is longer than a message may be, and says so', async () => {
    const u = make();
    await u.load();
    const { secret } = await made(u);
    const big = JSON.stringify({ text: 'x'.repeat(50_000) });
    u.deliver('u1', Buffer.from(big), { authorization: `Bearer ${secret}` });
    const body = sent[0]?.body ?? '';
    expect(body.length).toBeLessThanOrEqual(BODY_MAX_CHARS);
    expect(body).toMatch(/\n\[cut: the delivery has 50\d{3} characters, the first \d+ are shown\]$/);
    expect(body.startsWith('{\n  "text": "xxx')).toBe(true);
    expect(u.list()[0]?.deliveries[0]?.note).toBe('m1 (cut)');
    // one that fits exactly is not cut
    const fits = JSON.stringify({ t: 'y'.repeat(BODY_MAX_CHARS - '{\n  "t": ""\n}'.length) });
    u.deliver('u1', Buffer.from(fits), { authorization: `Bearer ${secret}` });
    expect(sent[1]?.body.length).toBe(BODY_MAX_CHARS);
    expect(sent[1]?.body).not.toContain('[cut');
  });

  it('answers conflict when the hub refuses, and records the reason', async () => {
    const u = make();
    await u.load();
    const { secret } = await made(u, { to: 'ghost' });
    answer = () => {
      throw new HubError('not_found', 'unknown recipient "ghost". Known: ana', 'to');
    };
    expect(refusal(() => u.deliver('u1', Buffer.from('{}'), { authorization: `Bearer ${secret}` }))).toMatchObject({ code: 'conflict', message: 'unknown recipient "ghost". Known: ana' });
    expect(u.list()[0]?.deliveries[0]).toMatchObject({ status: 'refused', note: 'not sent: unknown recipient "ghost". Known: ana' });
  });

  it(`takes ${UPLINK_RATE_MAX} a minute per uplink, notes the flood once and starts again as the minute passes`, async () => {
    const u = make();
    await u.load();
    const one = await made(u);
    const two = await made(u);
    const go = (id: string, secret: string): unknown => u.deliver(id, Buffer.from('{}'), { authorization: `Bearer ${secret}` });
    for (let i = 0; i < UPLINK_RATE_MAX; i++) {
      go('u1', one.secret);
      now += 1000;
    }
    expect(sent).toHaveLength(UPLINK_RATE_MAX);
    for (let i = 0; i < 5; i++) expect(refusal(() => go('u1', one.secret))).toMatchObject({ code: 'rate_limited' });
    expect(sent).toHaveLength(UPLINK_RATE_MAX);
    const refused = u.list()[0]?.deliveries.filter((d) => d.status === 'refused') ?? [];
    expect(refused).toHaveLength(1);
    expect(refused[0]?.note).toMatch(/^rate limit: more than 30/);
    // the other uplink has its own limit
    expect(go('u2', two.secret)).toMatchObject({ ok: true });
    // the first delivery is 60.5 s old now, the second 59.5 s: a window that slides frees one place at a time
    now += 30_500;
    expect(go('u1', one.secret)).toMatchObject({ ok: true });
    expect(refusal(() => go('u1', one.secret)).code).toBe('rate_limited');
    expect(u.list()[0]?.deliveries.slice(0, 2).map((d) => d.status)).toEqual(['refused', 'queued']);
    now += MIN;
    for (let i = 0; i < UPLINK_RATE_MAX; i++) go('u1', one.secret);
    expect(refusal(() => go('u1', one.secret)).code).toBe('rate_limited');
    // a flood that came after a good delivery is noted again
    expect(u.list()[0]?.deliveries[0]?.status).toBe('refused');
  });

  it(`keeps the last ${UPLINK_DELIVERIES_MAX} deliveries, newest first`, async () => {
    const u = make();
    await u.load();
    const { secret } = await made(u);
    for (let i = 0; i < UPLINK_DELIVERIES_MAX + 5; i++) {
      u.deliver('u1', Buffer.from('{}'), { authorization: `Bearer ${secret}` });
      now += 10_000;
    }
    const list = u.list()[0]?.deliveries ?? [];
    expect(list).toHaveLength(UPLINK_DELIVERIES_MAX);
    expect(list[0]?.note).toBe(`m${UPLINK_DELIVERIES_MAX + 5}`);
    expect(list.at(-1)?.note).toBe('m6');
  });
});

describe('uplink: test', () => {
  it('fires a sample through the same path, on or off, and records it as a test', async () => {
    const u = make();
    await u.load();
    await made(u, { enabled: false, name: 'Hook' });
    const view = await u.test('u1');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'ana', subject: 'Uplink: Hook' });
    expect(JSON.parse(sent[0]?.body ?? '')).toEqual({ test: true, uplink: 'Hook', at: new Date(now).toISOString() });
    expect(view.deliveries[0]).toEqual({ at: now, status: 'queued', note: 'test: m1' });
    await expect(u.test('u3')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('does not use the limit of the sender, and puts a refusal in the delivery instead of throwing', async () => {
    const u = make();
    await u.load();
    const { secret } = await made(u);
    for (let i = 0; i < UPLINK_RATE_MAX; i++) u.deliver('u1', Buffer.from('{}'), { authorization: `Bearer ${secret}` });
    expect((await u.test('u1')).deliveries[0]?.note).toBe('test: m31');
    answer = () => {
      throw new HubError('bad_request', 'there is no boss agent', 'to');
    };
    expect((await u.test('u1')).deliveries[0]).toMatchObject({ status: 'refused', note: 'test: not sent: there is no boss agent' });
  });
});

describe('uplink: the file', () => {
  it('is read again with secrets and deliveries, and the numbering goes on', async () => {
    const first = make();
    await first.load();
    const a = await made(first);
    await made(first, { name: 'Second', enabled: false });
    first.deliver('u1', Buffer.from('{"k":1}'), sign(a.secret, '{"k":1}'));
    await first.close();

    const again = make();
    await again.load();
    expect(again.list()).toEqual(first.list());
    expect(again.list()[0]?.deliveries).toHaveLength(1);
    expect(again.deliver('u1', Buffer.from('{"k":2}'), sign(a.secret, '{"k":2}')).ok).toBe(true);
    expect((await made(again)).id).toBe('u3');
    expect(again.list()[1]?.enabled).toBe(false);
  });

  it('keeps a file it cannot read as uplinks.json.bad and starts empty', async () => {
    await writeFile(join(dir, 'uplinks.json'), '{ not json', { mode: 0o600 });
    const u = make();
    await u.load();
    expect(u.list()).toEqual([]);
    expect(logs.join('\n')).toMatch(/uplinks\.json could not be read/);
    expect(await readFile(join(dir, 'uplinks.json.bad'), 'utf8')).toBe('{ not json');
    expect((await made(u)).id).toBe('u1');
    await writeFile(join(dir, 'uplinks.json'), JSON.stringify({ version: 2, uplinks: [] }));
    const other = make();
    await other.load();
    expect(await readFile(join(dir, 'uplinks.json.bad'), 'utf8')).toContain('"version":2');
  });

  it('does not log the text of a broken file, which can hold a secret', async () => {
    // V8 quotes the text around a JSON fault in the message of the error
    await writeFile(join(dir, 'uplinks.json'), `{"secret":${'ab'.repeat(32)}}`, { mode: 0o600 });
    await make().load();
    expect(logs.join('\n')).toMatch(/could not be read.*not valid JSON/);
    expect(logs.join('\n')).not.toContain('abab');
  });

  it('skips a record that is not good and loads the others', async () => {
    const good = { id: 'u2', name: 'Good', kind: 'generic', to: 'ana', secret: 'a'.repeat(64), enabled: true, createdAt: 5, deliveries: [{ at: 1, status: 'queued', note: 'm1' }, { at: 2, status: 'nonsense', note: 'x' }, 'junk'] };
    const records = [
      { ...good, id: 'x1' },
      { ...good, id: 'u1', secret: 'short' },
      { ...good, id: 'u3', kind: 'sms' },
      { ...good, id: 'u4', to: 'user' },
      { ...good, id: 'u5', name: '' },
      good,
      { ...good, name: 'Twin' },
      'junk',
    ];
    await writeFile(join(dir, 'uplinks.json'), JSON.stringify({ version: 1, uplinks: records }));
    const u = make();
    await u.load();
    expect(u.list()).toEqual([{ id: 'u2', name: 'Good', kind: 'generic', to: 'ana', enabled: true, createdAt: 5, deliveries: [{ at: 1, status: 'queued', note: 'm1' }] }]);
    expect(logs).toHaveLength(7);
    expect(u.deliver('u2', Buffer.from('{}'), { authorization: `Bearer ${'a'.repeat(64)}` }).ok).toBe(true);
    expect((await made(u)).id).toBe('u3');
  });

  it('survives a failed write: the delivery still goes, and the failure is logged', async () => {
    const u = make();
    await u.load();
    const { secret } = await made(u);
    await rm(dir, { recursive: true, force: true });
    expect(u.deliver('u1', Buffer.from('{}'), { authorization: `Bearer ${secret}` }).ok).toBe(true);
    await u.close();
    expect(logs.join('\n')).toMatch(/uplink could not write/);
  });
});

describe('uplink: the kinds of Relay', () => {
  const githubSign = (secret: string, raw: Buffer): Record<string, string> => ({ 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` });
  const slackSign = (secret: string, raw: Buffer, stamp = String(now / 1000)): Record<string, string> => ({
    'x-slack-request-timestamp': stamp,
    'x-slack-signature': `v0=${createHmac('sha256', secret).update(`v0:${stamp}:`).update(raw).digest('hex')}`,
  });
  const SLACK_SECRET = '8f742231b10e8888abcd99yyyzzz85a5';
  const threads = new Map<string, { id: string; agent: string; subject: string }>();
  const handled = new Set<string>();
  const inbound: Inbound = { find: (key) => threads.get(key), seen: (key) => (handled.has(key) ? true : (handled.add(key), false)), telegramChat: () => '555' };
  const slackEvent = (over: Record<string, unknown>): Buffer =>
    Buffer.from(JSON.stringify({ type: 'event_callback', event: { type: 'app_mention', user: 'U111', channel: 'C0123456789', ts: '1700000000.000200', text: 'status?', ...over } }));
  beforeEach(() => {
    threads.clear();
    handled.clear();
  });

  it('makes a GitHub uplink with a secret of its own, and takes only the signature of GitHub', async () => {
    const u = make();
    await u.load();
    const { secret, kind } = await made(u, { kind: 'github' });
    expect([kind, secret]).toEqual(['github', expect.stringMatching(/^[0-9a-f]{64}$/)]);
    const raw = Buffer.from(JSON.stringify({ ref: 'refs/heads/main', repository: { full_name: 'a/b' }, sender: { login: 'ana' }, commits: [{ id: '1234567890', message: 'Fix' }] }));
    expect(refusal(() => u.deliver('u1', raw, sign(secret, raw))).code).toBe('unauthorized');
    expect(refusal(() => u.deliver('u1', raw, { authorization: `Bearer ${secret}`, 'x-github-event': 'push' })).code).toBe('unauthorized');
    expect(refusal(() => u.deliver('u1', raw, { ...githubSign('wrong secret', raw), 'x-github-event': 'push' })).code).toBe('unauthorized');
    expect(sent).toEqual([]);
    expect(u.deliver('u1', raw, { ...githubSign(secret, raw), 'x-github-event': 'push' })).toEqual({ ok: true, id: 'm1', status: 'queued' });
    expect(sent).toEqual([{ to: 'ana', subject: 'Uplink: GitHub', body: 'GitHub push to a/b refs/heads/main by ana: 1 commit\n- 1234567 Fix' }]);
  });

  it('answers a ping with 200 and records it as answered, without a message and without a slot of the rate limit', async () => {
    const u = make();
    await u.load();
    const { secret } = await made(u, { kind: 'github' });
    const ping = Buffer.from('{"zen":"Keep it simple.","repository":{"full_name":"a/b"}}');
    expect(u.deliver('u1', ping, { ...githubSign(secret, ping), 'x-github-event': 'ping' })).toEqual({ ok: true, answer: { ok: true, ping: true } });
    expect(u.list()[0]?.deliveries).toEqual([{ at: now, status: 'answered', note: 'ping from a/b' }]);
    expect(sent).toEqual([]);
  });

  it(`does not record or count an event that is not for the agents, so that chatter cannot use the ${UPLINK_RATE_MAX} a minute`, async () => {
    const u = make();
    await u.load();
    const { secret } = await made(u, { kind: 'github' });
    const star = Buffer.from('{"action":"created"}');
    for (let i = 0; i < UPLINK_RATE_MAX * 2; i++) expect(u.deliver('u1', star, { ...githubSign(secret, star), 'x-github-event': 'star' })).toEqual({ ok: true, answer: { ok: true, ignored: true } });
    expect(u.list()[0]?.deliveries).toEqual([]);
    const issue = Buffer.from('{"action":"opened","issue":{"number":1,"title":"T"},"repository":{"full_name":"a/b"},"sender":{"login":"x"}}');
    expect(u.deliver('u1', issue, { ...githubSign(secret, issue), 'x-github-event': 'issues' })).toMatchObject({ ok: true, status: 'queued' });
  });

  it('refuses a body that is not JSON with a good signature, and records it', async () => {
    const u = make();
    await u.load();
    const { secret } = await made(u, { kind: 'github' });
    const form = Buffer.from('payload=%7B%7D');
    expect(refusal(() => u.deliver('u1', form, { ...githubSign(secret, form), 'x-github-event': 'push' }))).toMatchObject({ code: 'bad_request' });
    expect(u.list()[0]?.deliveries[0]).toMatchObject({ status: 'refused', note: 'the body is not JSON' });
  });

  it('makes a Linear uplink that takes the signing secret of Linear, and no other', async () => {
    const u = make();
    await u.load();
    const given = 'lin_wh_0123456789abcdef0123456789abcdef';
    await expect(made(u, { kind: 'linear' })).rejects.toMatchObject({ code: 'bad_request', field: 'secret' });
    const created = await made(u, { kind: 'linear', secret: given });
    expect(created.secret).toBe(given);
    const raw = Buffer.from(JSON.stringify({ action: 'create', type: 'Issue', data: { identifier: 'ENG-1', title: 'T' } }));
    const signature = createHmac('sha256', given).update(raw).digest('hex');
    expect(refusal(() => u.deliver('u1', raw, { 'linear-signature': 'a'.repeat(64) })).code).toBe('unauthorized');
    expect(u.deliver('u1', raw, { 'linear-signature': signature })).toMatchObject({ ok: true });
    expect(sent[0]?.body).toBe('Linear issue ENG-1 created: T');
    expect(u.list()[0]).not.toHaveProperty('secret');
  });

  it('checks the secret that a slack or linear uplink is given, and refuses one for the other kinds', async () => {
    const u = make();
    await u.load();
    for (const secret of ['short', 'with a space in it 12345', 'a'.repeat(257), 42, '']) {
      await expect(made(u, { kind: 'slack', secret }), String(secret)).rejects.toMatchObject({ code: 'bad_request', field: 'secret' });
    }
    for (const kind of ['generic', 'github', 'telegram']) {
      await expect(made(u, { kind, secret: SLACK_SECRET }), kind).rejects.toMatchObject({ code: 'bad_request', field: 'secret' });
    }
    expect(u.list()).toEqual([]);
  });

  it('changes the secret of a slack uplink by Edit, not by rotate, and not the secret of the other kinds', async () => {
    const u = make();
    await u.load();
    await made(u, { kind: 'slack', secret: SLACK_SECRET });
    await made(u, { kind: 'github' });
    await expect(u.rotate('u1')).rejects.toMatchObject({ code: 'conflict' });
    await expect(u.update('u2', { secret: SLACK_SECRET })).rejects.toMatchObject({ code: 'bad_request', field: 'secret' });
    const raw = slackEvent({});
    expect(u.deliver('u1', raw, slackSign(SLACK_SECRET, raw))).toMatchObject({ ok: true });
    const next = 'b'.repeat(32);
    await u.update('u1', { secret: next });
    expect(refusal(() => u.deliver('u1', raw, slackSign(SLACK_SECRET, raw))).code).toBe('unauthorized');
    expect(u.deliver('u1', raw, slackSign(next, raw))).toMatchObject({ ok: true });
    const saved = JSON.parse(await readFile(join(dir, 'uplinks.json'), 'utf8')) as { uplinks: Array<{ secret: string }> };
    expect(saved.uplinks[0]?.secret).toBe(next);
    await u.close();
    const again = make();
    await again.load();
    expect(again.list().map((v) => v.kind)).toEqual(['slack', 'github']);
  });

  it('answers the challenge of Slack with the challenge, and refuses a request that is older than five minutes', async () => {
    const u = make(inbound);
    await u.load();
    await made(u, { kind: 'slack', secret: SLACK_SECRET });
    const challenge = Buffer.from('{"type":"url_verification","challenge":"3eZbrw1aBm2rZgRN"}');
    expect(u.deliver('u1', challenge, slackSign(SLACK_SECRET, challenge))).toEqual({ ok: true, answer: { challenge: '3eZbrw1aBm2rZgRN' } });
    expect(u.list()[0]?.deliveries[0]).toMatchObject({ status: 'answered', note: 'challenge answered' });
    const old = String(now / 1000 - 301);
    expect(refusal(() => u.deliver('u1', challenge, slackSign(SLACK_SECRET, challenge, old))).code).toBe('unauthorized');
    expect(sent).toEqual([]);
  });

  it('turns a mention of the bot into a message to the target, and delivers a Slack retry only once', async () => {
    const u = make(inbound);
    await u.load();
    await made(u, { kind: 'slack', secret: SLACK_SECRET, to: 'boss' });
    const raw = slackEvent({});
    expect(u.deliver('u1', raw, slackSign(SLACK_SECRET, raw))).toMatchObject({ ok: true, id: 'm1' });
    expect(sent).toEqual([{ to: 'boss', subject: 'Uplink: GitHub', body: 'Slack mention from U111 in C0123456789:\n\nstatus?' }]);
    // the same message again (Slack tries again when it hears nothing, or sends it as a message as well)
    expect(u.deliver('u1', raw, slackSign(SLACK_SECRET, raw))).toEqual({ ok: true, answer: { ok: true, ignored: true } });
    expect(sent).toHaveLength(1);
  });

  it('does not mark a Slack event handled when the rate limit refused it, so that its retry gets through', async () => {
    const u = make(inbound);
    await u.load();
    await made(u, { kind: 'slack', secret: SLACK_SECRET });
    for (let i = 0; i < UPLINK_RATE_MAX; i++) {
      const raw = slackEvent({ ts: `1700000000.${String(i).padStart(6, '0')}` });
      u.deliver('u1', raw, slackSign(SLACK_SECRET, raw));
    }
    const late = slackEvent({ ts: '1700000001.000000' });
    expect(refusal(() => u.deliver('u1', late, slackSign(SLACK_SECRET, late))).code).toBe('rate_limited');
    now += MIN + 1000;
    expect(u.deliver('u1', late, slackSign(SLACK_SECRET, late))).toMatchObject({ ok: true, id: `m${UPLINK_RATE_MAX + 1}` });
  });

  it('sends a reply in a thread to the agent that wrote the message, in reply to it', async () => {
    const u = make(inbound);
    await u.load();
    await made(u, { kind: 'slack', secret: SLACK_SECRET, to: 'ana' });
    threads.set('slack:C0123456789:1700000000.000100', { id: 'm12', agent: 'bo', subject: 'Need a decision' });
    const raw = slackEvent({ type: 'message', thread_ts: '1700000000.000100', text: 'go ahead', ts: '1700000000.000300' });
    expect(u.deliver('u1', raw, slackSign(SLACK_SECRET, raw))).toMatchObject({ ok: true });
    expect(sent).toEqual([{ to: 'bo', subject: 'Re: Need a decision', body: 'go ahead', inReplyTo: 'm12' }]);
    expect(u.list()[0]?.deliveries[0]).toMatchObject({ status: 'queued', note: 'm1' });
  });

  it('sends a reply to the uplink recipient when the agent that wrote the original is gone, so that the service is not told 409', async () => {
    const u = make(inbound);
    await u.load();
    await made(u, { kind: 'slack', secret: SLACK_SECRET, to: 'ana' });
    threads.set('slack:C0123456789:1700000000.000100', { id: 'm12', agent: 'bo', subject: 'Need a decision' });
    const base = answer;
    answer = (request) => {
      if (request.to === 'bo') throw new HubError('not_found', 'unknown recipient "bo"', 'to');
      return base(request);
    };
    const raw = slackEvent({ type: 'message', thread_ts: '1700000000.000100', text: 'go ahead', ts: '1700000000.000300' });
    expect(u.deliver('u1', raw, slackSign(SLACK_SECRET, raw))).toMatchObject({ ok: true });
    expect(sent.map((s) => s.to)).toEqual(['bo', 'ana']);
    expect(sent[1]).toEqual({ to: 'ana', subject: 'Re: Need a decision', body: 'go ahead', inReplyTo: 'm12' });
    // any other refusal is still a refusal
    answer = () => {
      throw new HubError('conflict', 'held');
    };
    const next = slackEvent({ type: 'message', thread_ts: '1700000000.000100', text: 'again', ts: '1700000000.000400' });
    expect(refusal(() => u.deliver('u1', next, slackSign(SLACK_SECRET, next))).code).toBe('conflict');
  });

  it('makes a Telegram uplink with a secret that Telegram accepts as secret_token, and takes only the chat of the target', async () => {
    const u = make(inbound);
    await u.load();
    const { secret } = await made(u, { kind: 'telegram' });
    expect(secret).toMatch(/^[A-Za-z0-9_-]{1,256}$/);
    const text = (chat: number): Buffer => Buffer.from(JSON.stringify({ update_id: 1, message: { message_id: 4, chat: { id: chat }, from: { first_name: 'Ulm' }, text: 'hi' } }));
    expect(refusal(() => u.deliver('u1', text(555), { 'x-telegram-bot-api-secret-token': 'x'.repeat(64) })).code).toBe('unauthorized');
    expect(u.deliver('u1', text(556), { 'x-telegram-bot-api-secret-token': secret })).toEqual({ ok: true, answer: { ok: true, ignored: true } });
    expect(sent).toEqual([]);
    expect(u.deliver('u1', text(555), { 'x-telegram-bot-api-secret-token': secret })).toMatchObject({ ok: true, id: 'm1' });
    expect(sent[0]?.body).toBe('Telegram message from Ulm in chat 555:\n\nhi');
  });

  it('tests a service uplink with the same sample as any other', async () => {
    const u = make();
    await u.load();
    await made(u, { kind: 'telegram', name: 'Bot' });
    expect((await u.test('u1')).deliveries[0]).toEqual({ at: now, status: 'queued', note: 'test: m1' });
    expect(JSON.parse(sent[0]?.body ?? '')).toMatchObject({ test: true, uplink: 'Bot' });
  });

  it('counts bad signatures of a service as it does for the generic kind', async () => {
    const u = make();
    await u.load();
    await made(u, { kind: 'github' });
    for (let i = 0; i < 4; i++) refusal(() => u.deliver('u1', Buffer.from('{}'), { 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` }));
    expect(posted).toEqual([['uplink', 'GitHub: more than 3 requests with a bad signature in 10 minutes']]);
  });
});
