import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RELAY_FORWARD_KINDS } from '../src/shared/protocol.js';
import type { ActivityItem, HubEvent, Logger } from '../src/shared/protocol.js';
import { RELAY_QUEUE_MAX, RELAY_SEEN_MAX, RELAY_TEXT_MAX_CHARS, RELAY_THREADS_MAX } from '../src/server/constants.js';
import { createRelay } from '../src/server/relay.js';
import type { Relay } from '../src/server/relay.js';

// Relay's targets and the outbound half, with a fetch that never leaves the process (src/server/relay.ts).

const SLACK_TOKEN = 'xoxb-1234567890-abcdefghijklmnop';
const TELEGRAM_TOKEN = '123456789:AAFabcdefghijklmnopqrstuvwxyz012345';
const CHANNEL = 'C0123456789';
const CHAT = '555';

interface Call {
  url: string;
  init: RequestInit;
  json: { text: string; channel?: string; chat_id?: string };
}
let dir: string;
let now: number;
let calls: Call[];
let sleeps: number[];
let logs: string[];
/** The answers to the next calls, in order; the last one repeats. */
let answers: Array<() => Response | Promise<Response>>;
const open: Relay[] = [];

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
const reply = (body: unknown, status = 200, headers: Record<string, string> = {}): (() => Response) => () => new Response(JSON.stringify(body), { status, headers });
const slackOk = (n: number): (() => Response) => reply({ ok: true, channel: CHANNEL, ts: `1700000000.${String(n).padStart(6, '0')}` });
const telegramOk = (id: number): (() => Response) => reply({ ok: true, result: { message_id: id, chat: { id: Number(CHAT) } } });

function make(): Relay {
  const relay = createRelay({
    dir,
    now: () => now,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {}, json: JSON.parse(String(init?.body)) });
      const next = answers.length > 1 ? answers.shift() : answers[0];
      if (!next) throw new Error('no answer');
      return next();
    },
    sleep: async (ms) => void sleeps.push(ms),
    log: quiet(logs),
  });
  open.push(relay);
  return relay;
}
const message = (over: Partial<ActivityItem> = {}): HubEvent => ({
  t: 'activity',
  item: { id: 'm12', from: 'ana', to: 'user', subject: 'Build is green', body: 'All 40 tests pass.', inReplyTo: null, hops: 1, at: 1, status: 'to_user', note: null, updatedAt: 1, truncated: false, ...over },
});
const sent = (n: number): Promise<void> => vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(n));
const quietly = async (relay: Relay): Promise<void> => {
  // the queue is drained by promises: wait until nothing more is sent
  let before = -1;
  while (before !== calls.length) {
    before = calls.length;
    await new Promise((done) => setTimeout(done, 5));
  }
  void relay;
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gonogo-relay-'));
  now = Date.UTC(2026, 10, 17, 9, 0);
  calls = [];
  sleeps = [];
  logs = [];
  answers = [slackOk(1)];
});
afterEach(async () => {
  for (const r of open.splice(0)) await r.close();
  await rm(dir, { recursive: true, force: true });
});

describe('relay: the targets', () => {
  it('has none at first and forwards every kind', async () => {
    const relay = make();
    await relay.load();
    expect(relay.view()).toEqual({ slack: null, telegram: null, forward: [...RELAY_FORWARD_KINDS], phone: 'off' });
    expect(relay.telegramChat()).toBeNull();
  });

  it('saves a target in a 0600 file, and never gives the token back', async () => {
    const relay = make();
    await relay.load();
    const view = await relay.set('slack', { token: SLACK_TOKEN, to: CHANNEL });
    expect(view).toEqual({ slack: { to: CHANNEL, last: null }, telegram: null, forward: [...RELAY_FORWARD_KINDS], phone: 'off' });
    await relay.set('telegram', { token: TELEGRAM_TOKEN, to: CHAT });
    expect(relay.telegramChat()).toBe(CHAT);
    expect(JSON.stringify(relay.view())).not.toMatch(/xoxb|AAF/);
    const file = join(dir, 'relay.json');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 1,
      slack: { token: SLACK_TOKEN, to: CHANNEL },
      telegram: { token: TELEGRAM_TOKEN, to: CHAT },
      forward: [...RELAY_FORWARD_KINDS],
      phone: 'off',
    });
  });

  it('keeps the saved token when the request has none, and wants one when there is nothing saved', async () => {
    const relay = make();
    await relay.load();
    await expect(relay.set('slack', { to: CHANNEL })).rejects.toMatchObject({ code: 'bad_request', field: 'token', message: 'token is required' });
    await relay.set('slack', { token: SLACK_TOKEN, to: CHANNEL });
    await relay.set('slack', { to: 'C0000000001' });
    expect(relay.view().slack?.to).toBe('C0000000001');
    expect(JSON.parse(await readFile(join(dir, 'relay.json'), 'utf8')).slack).toEqual({ token: SLACK_TOKEN, to: 'C0000000001' });
  });

  it('refuses a bad request with the name of the field, and never repeats a token in the message', async () => {
    const relay = make();
    await relay.load();
    const fails = async (service: string, input: unknown, field: string | undefined): Promise<string> => {
      const error = await relay.set(service, input).then(
        () => null,
        (e: unknown) => e as Error & { code: string; field?: string },
      );
      expect(error, JSON.stringify(input)).not.toBeNull();
      expect(error).toMatchObject({ code: 'bad_request', field });
      return (error as Error).message;
    };
    await fails('slack', [1], undefined);
    await fails('slack', { token: SLACK_TOKEN }, 'to');
    await fails('slack', { token: SLACK_TOKEN, to: '#general' }, 'to');
    await fails('slack', { token: SLACK_TOKEN, to: 'c0123456789' }, 'to');
    await fails('slack', { token: 'xoxp-1234567890-abcdefghijklmnop', to: CHANNEL }, 'token');
    await fails('slack', { token: 'a'.repeat(32), to: CHANNEL }, 'token');
    await fails('slack', { token: 42, to: CHANNEL }, 'token');
    await fails('slack', { token: `${SLACK_TOKEN}\nX-Evil: 1`, to: CHANNEL }, 'token');
    await fails('slack', { token: SLACK_TOKEN, to: CHANNEL, extra: 1 }, 'extra');
    await fails('telegram', { token: TELEGRAM_TOKEN, to: 'abc' }, 'to');
    await fails('telegram', { token: TELEGRAM_TOKEN, to: '0123' }, 'to');
    await fails('telegram', { token: `${TELEGRAM_TOKEN}/../x`, to: CHAT }, 'token');
    await fails('telegram', { token: 'not a token', to: CHAT }, 'token');
    const text = await fails('slack', { token: 'a-secret-that-was-pasted-by-mistake', to: CHANNEL }, 'token');
    expect(text).not.toContain('pasted');
    await expect(relay.set('discord', { token: 'x', to: 'y' })).rejects.toMatchObject({ code: 'not_found' });
    expect(relay.view()).toMatchObject({ slack: null, telegram: null });
    await relay.set('telegram', { token: TELEGRAM_TOKEN, to: '-1001234567890' });
    expect(relay.telegramChat()).toBe('-1001234567890');
  });

  it('removes a target and says no to one that is not there', async () => {
    const relay = make();
    await relay.load();
    await relay.set('slack', { token: SLACK_TOKEN, to: CHANNEL });
    expect((await relay.remove('slack')).slack).toBeNull();
    expect(JSON.parse(await readFile(join(dir, 'relay.json'), 'utf8'))).not.toHaveProperty('slack');
    await expect(relay.test('slack')).rejects.toMatchObject({ code: 'not_found' });
    await expect(relay.remove('discord')).rejects.toMatchObject({ code: 'not_found' });
    expect((await relay.remove('telegram')).telegram).toBeNull();
  });

  it('chooses what is forwarded, with the kinds checked', async () => {
    const relay = make();
    await relay.load();
    expect((await relay.forward({ kinds: ['redline', 'message'] })).forward).toEqual(['message', 'redline']);
    expect((await relay.forward({ kinds: [] })).forward).toEqual([]);
    for (const input of [[1], {}, { kinds: 'message' }, { kinds: ['uplink'] }, { kinds: ['message', 'launch-window'] }, { kinds: [1] }]) {
      await expect(relay.forward(input), JSON.stringify(input)).rejects.toMatchObject({ code: 'bad_request' });
    }
    await expect(relay.forward({ kinds: [], other: 1 })).rejects.toMatchObject({ field: 'other' });
    expect(JSON.parse(await readFile(join(dir, 'relay.json'), 'utf8')).forward).toEqual([]);
  });

  it('is read again from the file, and skips a target that is not good', async () => {
    await writeFile(
      join(dir, 'relay.json'),
      JSON.stringify({ version: 1, slack: { token: 'oops', to: CHANNEL }, telegram: { token: TELEGRAM_TOKEN, to: CHAT }, forward: ['redline', 'bogus', 'tminus'] }),
    );
    const relay = make();
    await relay.load();
    expect(relay.view()).toEqual({ slack: null, telegram: { to: CHAT, last: null }, forward: ['redline', 'tminus'], phone: 'off' });
    expect(logs.join('\n')).toMatch(/the slack target was skipped/);
    expect(logs.join('\n')).not.toContain('oops');
  });

  it('keeps a file it cannot read as relay.json.bad and starts empty, without logging its text', async () => {
    await writeFile(join(dir, 'relay.json'), `{ "slack": { "token": "${SLACK_TOKEN}" `);
    const relay = make();
    await relay.load();
    expect(relay.view().slack).toBeNull();
    expect(await readFile(join(dir, 'relay.json.bad'), 'utf8')).toContain(SLACK_TOKEN);
    expect(logs.join('\n')).toMatch(/could not be read.*not valid JSON/);
    expect(logs.join('\n')).not.toContain('xoxb');
  });
});

describe('relay: forwarding', () => {
  async function both(): Promise<Relay> {
    const relay = make();
    await relay.load();
    await relay.set('slack', { token: SLACK_TOKEN, to: CHANNEL });
    await relay.set('telegram', { token: TELEGRAM_TOKEN, to: CHAT });
    answers = [slackOk(1), telegramOk(77)];
    return relay;
  }

  it('sends a message to the Director to every target, with the right call for each service', async () => {
    const relay = await both();
    relay.observe(message({ body: 'Tests <pass> & more' }));
    await sent(2);
    const [slack, telegram] = calls;
    expect(slack?.url).toBe('https://slack.com/api/chat.postMessage');
    expect(slack?.init.method).toBe('POST');
    expect(slack?.init.headers).toMatchObject({ Authorization: `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' });
    // Slack's markup is escaped, so that an agent cannot write <!channel>
    expect(slack?.json).toEqual({ channel: CHANNEL, text: 'Message from ana: Build is green\n\nTests &lt;pass&gt; &amp; more' });
    expect(telegram?.url).toBe(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`);
    expect(telegram?.json).toEqual({ chat_id: CHAT, text: 'Message from ana: Build is green\n\nTests <pass> & more' });
    for (const call of calls) {
      expect(call.init.redirect).toBe('error');
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
    }
    await quietly(relay);
    expect(relay.view().slack?.last).toEqual({ at: now, ok: true, note: 'sent' });
    expect(relay.view().telegram?.last).toEqual({ at: now, ok: true, note: 'sent' });
  });

  it('forwards only the messages to the Director, and only when messages are chosen', async () => {
    const relay = await both();
    relay.observe(message({ to: 'bo' }));
    relay.observe({ t: 'poll', poll: null });
    await relay.forward({ kinds: ['redline'] });
    relay.observe(message());
    await quietly(relay);
    expect(calls).toHaveLength(0);
    await relay.forward({ kinds: ['message'] });
    relay.observe(message());
    await sent(2);
  });

  it('forwards a Redline trip, a T-minus result and a blocked task, and no other event', async () => {
    const relay = await both();
    answers = [slackOk(1)];
    relay.event('redline', 'ana: loop: Bash: npm test 5 times in a row');
    relay.event('tminus', 'HOLD: no-go: simsup');
    relay.event('flight-plan', 'ana moved t1 to blocked: Write the spec');
    relay.event('launch-window', 'Standup: undelivered');
    relay.event('uplink', 'GitHub: bad signature');
    await sent(6);
    await quietly(relay);
    expect(calls.filter((c) => c.url.includes('slack')).map((c) => c.json.text)).toEqual([
      'Redline: ana: loop: Bash: npm test 5 times in a row',
      'T-minus: HOLD: no-go: simsup',
      'Flight Plan: ana moved t1 to blocked: Write the spec',
    ]);
    expect(calls).toHaveLength(6);
    await relay.forward({ kinds: ['tminus'] });
    relay.event('redline', 'ana: again');
    relay.event('tminus', 'GO: all go');
    await sent(8);
    await quietly(relay);
    expect(calls.slice(6).map((c) => c.json.text.split(': ')[0])).toEqual(['T-minus', 'T-minus']);
  });

  it('sends nothing when there is no target, and keeps the order of what it sends', async () => {
    const relay = make();
    await relay.load();
    relay.observe(message());
    await relay.set('telegram', { token: TELEGRAM_TOKEN, to: CHAT });
    answers = [telegramOk(1)];
    for (let i = 0; i < 5; i++) relay.event('redline', `n${i}`);
    await sent(5);
    await quietly(relay);
    expect(calls.map((c) => c.json.text)).toEqual(['Redline: n0', 'Redline: n1', 'Redline: n2', 'Redline: n3', 'Redline: n4']);
  });

  it(`cuts a long text to ${RELAY_TEXT_MAX_CHARS} characters`, async () => {
    const relay = await both();
    relay.observe(message({ body: 'x'.repeat(10_000) }));
    await sent(2);
    expect(calls[1]?.json.text).toHaveLength(RELAY_TEXT_MAX_CHARS);
    expect(calls[1]?.json.text.endsWith('…')).toBe(true);
  });
});

describe('relay: a call that fails', () => {
  async function slack(): Promise<Relay> {
    const relay = make();
    await relay.load();
    await relay.set('slack', { token: SLACK_TOKEN, to: CHANNEL });
    return relay;
  }

  it('tries again after a server error with a wait that doubles, and stops at the first good answer', async () => {
    const relay = await slack();
    answers = [reply({}, 500), reply({}, 502), slackOk(1)];
    relay.event('redline', 'x');
    await sent(3);
    await quietly(relay);
    expect(sleeps).toEqual([1000, 2000]);
    expect(relay.view().slack?.last).toEqual({ at: now, ok: true, note: 'sent' });
  });

  it('gives up after three tries and says what the service said', async () => {
    const relay = await slack();
    answers = [reply({ ok: false, error: 'fatal_error' }, 503)];
    relay.event('redline', 'x');
    await sent(3);
    await quietly(relay);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1000, 2000]);
    expect(relay.view().slack?.last).toEqual({ at: now, ok: false, note: 'Slack answered 503: fatal_error' });
    expect(logs).toEqual(['relay: slack: Slack answered 503: fatal_error']);
  });

  it('waits as long as the service asks after a 429, but never more than ten seconds', async () => {
    const relay = await slack();
    answers = [reply({}, 429, { 'Retry-After': '3' }), reply({}, 429, { 'Retry-After': '600' }), slackOk(1)];
    relay.event('redline', 'x');
    await sent(3);
    await quietly(relay);
    expect(sleeps).toEqual([3000, 10_000]);
  });

  it('does not try again when the service refuses: a wrong token or a channel that is not there will be the same next time', async () => {
    const relay = await slack();
    // Slack says it with a 200 and ok: false
    answers = [reply({ ok: false, error: 'channel_not_found' })];
    relay.event('redline', 'x');
    await sent(1);
    await quietly(relay);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(relay.view().slack?.last).toMatchObject({ ok: false, note: 'Slack answered 200: channel_not_found' });
    answers = [reply({ ok: false, error: 'invalid_auth' }, 401)];
    relay.event('redline', 'y');
    await sent(2);
    await quietly(relay);
    expect(calls).toHaveLength(2);
    expect(relay.view().slack?.last?.note).toBe('Slack answered 401: invalid_auth');
  });

  it('tries again after a network error and a timeout', async () => {
    const relay = await slack();
    answers = [
      () => {
        throw new TypeError('fetch failed');
      },
      () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
      () => {
        throw new TypeError('fetch failed');
      },
    ];
    relay.event('redline', 'x');
    await sent(3);
    await quietly(relay);
    expect(sleeps).toEqual([1000, 2000]);
    expect(relay.view().slack?.last).toEqual({ at: now, ok: false, note: 'Slack: fetch failed' });
    answers = [() => Promise.reject(new DOMException('x', 'TimeoutError')), slackOk(1)];
    relay.event('redline', 'y');
    await sent(5);
    await quietly(relay);
    expect(relay.view().slack?.last?.ok).toBe(true);
  });

  it('never puts a token in a log line or a note, even when the error carries it', async () => {
    const relay = make();
    await relay.load();
    await relay.set('telegram', { token: TELEGRAM_TOKEN, to: CHAT });
    answers = [
      () => {
        throw new Error(`getaddrinfo failed for https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`);
      },
    ];
    relay.event('redline', 'x');
    await sent(3);
    await quietly(relay);
    const last = relay.view().telegram?.last;
    expect(last?.note).toContain('(token)');
    expect(JSON.stringify([last, logs, relay.view()])).not.toContain(TELEGRAM_TOKEN);
    expect(JSON.stringify([last, logs])).not.toContain('AAFabc');
  });

  it(`drops the oldest queued message past ${RELAY_QUEUE_MAX} and says so`, async () => {
    const relay = await slack();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((done) => (release = done));
    answers = [async () => (await gate, slackOk(1)())];
    for (let i = 0; i <= RELAY_QUEUE_MAX + 10; i++) relay.event('redline', `n${i}`);
    release();
    await sent(RELAY_QUEUE_MAX + 1);
    await quietly(relay);
    // the first was already on its way; of the rest the first ten were dropped
    expect(calls).toHaveLength(RELAY_QUEUE_MAX + 1);
    expect(calls[0]?.json.text).toBe('Redline: n0');
    expect(calls[1]?.json.text).toBe('Redline: n11');
    expect(logs.filter((l) => /queue is full/.test(l))).toHaveLength(10);
  });

  it('stops what is in flight when it is closed, and sends nothing more', async () => {
    const relay = await slack();
    answers = [(): Promise<Response> => new Promise(() => undefined)];
    relay.event('redline', 'x');
    relay.event('redline', 'y');
    await sent(1);
    await relay.close();
    await quietly(relay);
    expect(calls).toHaveLength(1);
    expect((calls[0]?.init.signal as AbortSignal).aborted).toBe(true);
    relay.event('redline', 'after close');
    await quietly(relay);
    expect(calls).toHaveLength(1);
  });

  it('sends nothing that was waiting to a target that was removed meanwhile', async () => {
    const relay = await slack();
    let release: (r: Response) => void = () => undefined;
    answers = [(): Promise<Response> => new Promise((done) => (release = done)), slackOk(2)];
    relay.event('redline', 'first');
    relay.event('redline', 'second');
    await sent(1);
    await relay.remove('slack');
    release(slackOk(1)());
    await quietly(relay);
    expect(calls.map((c) => c.json.text)).toEqual(['Redline: first']);
  });
});

describe('relay: test', () => {
  it('sends one message, one try, and puts the answer in `last`', async () => {
    const relay = make();
    await relay.load();
    await relay.set('slack', { token: SLACK_TOKEN, to: CHANNEL });
    const view = await relay.test('slack');
    expect(calls.map((c) => c.json.text)).toEqual(['gonogo relay test: this target is connected.']);
    expect(view.slack?.last).toEqual({ at: now, ok: true, note: 'test sent' });
    answers = [reply({}, 500)];
    now += 1000;
    expect((await relay.test('slack')).slack?.last).toEqual({ at: now, ok: false, note: 'Slack answered 500' });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([]);
    // a reply to a test message has no agent to go to
    expect(relay.find(`slack:${CHANNEL}:1700000000.000001`)).toBeUndefined();
  });

  it('says no for a service that has no target', async () => {
    const relay = make();
    await relay.load();
    await expect(relay.test('telegram')).rejects.toMatchObject({ code: 'not_found', message: 'no Telegram target' });
    await expect(relay.test('discord')).rejects.toMatchObject({ code: 'not_found' });
    expect(calls).toHaveLength(0);
  });

  it('forgets how the last send went when the target is changed', async () => {
    const relay = make();
    await relay.load();
    await relay.set('slack', { token: SLACK_TOKEN, to: CHANNEL });
    await relay.test('slack');
    expect((await relay.set('slack', { to: 'C0000000002' })).slack).toEqual({ to: 'C0000000002', last: null });
  });
});

describe('relay: replies', () => {
  it('remembers a forwarded message by the id the service gave it, with the agent and the subject', async () => {
    const relay = make();
    await relay.load();
    await relay.set('slack', { token: SLACK_TOKEN, to: CHANNEL });
    await relay.set('telegram', { token: TELEGRAM_TOKEN, to: CHAT });
    answers = [slackOk(5), telegramOk(77)];
    relay.observe(message());
    await sent(2);
    await vi.waitFor(() => expect(relay.find('telegram:555:77')).toBeDefined());
    expect(relay.find(`slack:${CHANNEL}:1700000000.000005`)).toEqual({ id: 'm12', agent: 'ana', subject: 'Build is green' });
    expect(relay.find('telegram:555:77')).toEqual({ id: 'm12', agent: 'ana', subject: 'Build is green' });
    expect(relay.find('telegram:555:78')).toBeUndefined();
  });

  it('does not remember a message that did not go, or an event', async () => {
    const relay = make();
    await relay.load();
    await relay.set('slack', { token: SLACK_TOKEN, to: CHANNEL });
    answers = [reply({ ok: false, error: 'channel_not_found' })];
    relay.observe(message());
    await sent(1);
    answers = [slackOk(6)];
    relay.event('redline', 'x');
    await sent(2);
    await quietly(relay);
    expect(relay.find(`slack:${CHANNEL}:1700000000.000006`)).toBeUndefined();
  });

  it(`keeps the newest ${RELAY_THREADS_MAX} and forgets the oldest`, async () => {
    const relay = make();
    await relay.load();
    await relay.set('telegram', { token: TELEGRAM_TOKEN, to: CHAT });
    let n = 0;
    answers = [() => telegramOk(++n)()];
    // one at a time: a burst past the queue's limit is dropped, which is another test
    for (let i = 0; i <= RELAY_THREADS_MAX; i++) {
      relay.observe(message({ id: `m${i}` }));
      await vi.waitFor(() => expect(relay.find(`telegram:${CHAT}:${i + 1}`)).toBeDefined(), { interval: 1 });
    }
    expect(relay.find(`telegram:${CHAT}:1`)).toBeUndefined();
    expect(relay.find(`telegram:${CHAT}:2`)).toMatchObject({ id: 'm1' });
  });

  it(`remembers ${RELAY_SEEN_MAX} handled keys: the first time is new, the second is not`, async () => {
    const relay = make();
    expect(relay.seen('slack:C1:1')).toBe(false);
    expect(relay.seen('slack:C1:1')).toBe(true);
    for (let i = 0; i < RELAY_SEEN_MAX; i++) relay.seen(`k${i}`);
    expect(relay.seen('slack:C1:1')).toBe(false);
  });
});

describe('phone approvals: the setting and the two calls', () => {
  const target = async (relay: Relay): Promise<void> => void (await relay.load(), await relay.set('telegram', { token: TELEGRAM_TOKEN, to: CHAT }));

  it('is off at first, is chosen by the Director, is saved, and refuses a mode it does not know', async () => {
    const relay = make();
    await relay.load();
    expect(relay.view().phone).toBe('off');
    await expect(relay.setPhone({ mode: 'sms' })).rejects.toMatchObject({ field: 'mode' });
    await expect(relay.setPhone({ mode: 'both', x: 1 })).rejects.toMatchObject({ field: 'x' });
    expect((await relay.setPhone({ mode: 'both' })).phone).toBe('both');
    const again = make();
    await again.load();
    expect(again.view().phone).toBe('both');
  });

  it('uses the Telegram path only for telegram or both, and only with a Telegram target', async () => {
    const relay = make();
    await relay.load();
    await relay.setPhone({ mode: 'telegram' });
    expect(relay.phoneTelegram()).toBe(false);
    await relay.set('telegram', { token: TELEGRAM_TOKEN, to: CHAT });
    expect(relay.phoneTelegram()).toBe(true);
    for (const [mode, on] of [['off', false], ['remote-control', false], ['both', true]] as const) {
      await relay.setPhone({ mode });
      expect(relay.phoneTelegram(), mode).toBe(on);
    }
  });

  it('sends a message with its buttons, and one call of the bot API, never saying the token', async () => {
    const relay = make();
    await target(relay);
    answers = [telegramOk(7)];
    const markup = { inline_keyboard: [[{ text: 'GO', callback_data: 'a:permission:p1:go:abcdef12' }]] };
    expect(await relay.sendButtons('ana asks: Bash: ls', markup)).toBe(true);
    expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`);
    expect(calls[0]?.json).toMatchObject({ chat_id: CHAT, text: 'ana asks: Bash: ls', reply_markup: markup });
    answers = [reply({ ok: true, result: true })];
    expect(await relay.telegramCall('answerCallbackQuery', { callback_query_id: 'q1', text: 'Sent GO' })).toBe(true);
    expect(calls.at(-1)?.url).toMatch(/\/answerCallbackQuery$/);
    answers = [reply({ ok: false }, 400)];
    expect(await relay.telegramCall('editMessageReplyMarkup', { message_id: 7 })).toBe(false);
    expect(JSON.stringify(logs)).not.toContain(TELEGRAM_TOKEN);
  });

  it('does nothing without a Telegram target', async () => {
    const relay = make();
    await relay.load();
    expect(await relay.sendButtons('x', {})).toBe(false);
    expect(await relay.telegramCall('answerCallbackQuery', {})).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
