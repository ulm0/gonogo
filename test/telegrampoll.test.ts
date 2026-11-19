/**
 * Telegram inbound by long polling (docs/features/relay.md): the loop against a stand-in Telegram API (a fake fetch with scripted answers), and the
 * hand-on of an update through the same read as a webhook delivery. No real Telegram is reached.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Logger, SendResult, UserMessageRequest } from '../src/shared/protocol.js';
import { createTelegramPoll, TELEGRAM_POLL_FILE } from '../src/server/telegrampoll.js';
import type { TelegramPoll } from '../src/server/telegrampoll.js';
import { createUplinks } from '../src/server/uplinks.js';
import type { Inbound } from '../src/server/uplinks.js';

const TOKEN = '123456:SECRET-token_abcdefghijklmnopqrstuvwxyz0123';
const CHAT = '777';
let dir: string;
let logs: string[];
const polls: TelegramPoll[] = [];

const quiet: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (message, ...extra) => void logs.push([message, ...extra.map(String)].join(' ')),
  error: (message, ...extra) => void logs.push([message, ...extra.map(String)].join(' ')),
  child: () => quiet,
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gng-tgpoll-'));
  logs = [];
});
afterEach(async () => {
  await Promise.all(polls.splice(0).map((p) => p.stop()));
  await rm(dir, { recursive: true, force: true });
});

interface Call {
  url: string;
  body: { offset: number; timeout: number; allowed_updates: string[] };
}
type Reply = { status?: number; json?: unknown; throws?: Error };

/** A Telegram that answers the scripted replies in order, then waits (a long poll) until the request is aborted. */
function stand(script: Reply[]): { fetch: typeof fetch; calls: Call[]; waiting(): boolean } {
  const calls: Call[] = [];
  let waiting = false;
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) as Call['body'] });
    const next = script.shift();
    if (next === undefined) {
      waiting = true;
      await new Promise<never>((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      });
    }
    const reply = next as Reply;
    if (reply.throws !== undefined) throw reply.throws;
    return new Response(JSON.stringify(reply.json ?? { ok: true, result: [] }), { status: reply.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetch: fn, calls, waiting: () => waiting };
}

const until = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 500 && !check(); i += 1) await new Promise((r) => setTimeout(r, 4));
  if (!check()) throw new Error('timed out');
};

function make(fetchFn: typeof fetch, over: Partial<Parameters<typeof createTelegramPoll>[0]> = {}) {
  const delivered: Array<{ update: Record<string, unknown>; secret: string }> = [];
  const waits: number[] = [];
  const poll = createTelegramPoll({
    dir,
    target: () => ({ token: TOKEN, to: CHAT }),
    hasUplink: () => false,
    deliver: (update, secret) => void delivered.push({ update: JSON.parse(update.toString('utf8')) as Record<string, unknown>, secret }),
    fetch: fetchFn,
    // waits are recorded and short, and end early when the signal aborts
    sleep: (ms, signal) =>
      new Promise<void>((done) => {
        waits.push(ms);
        const timer = setTimeout(done, 1);
        signal.addEventListener('abort', () => (clearTimeout(timer), done()), { once: true });
      }),
    now: () => 0,
    log: quiet,
    ...over,
  });
  polls.push(poll);
  return { poll, delivered, waits };
}

describe('the loop', () => {
  // these start with a known offset and bot, as after a first start; the first-start tests below do not
  beforeEach(async () => {
    await writeFile(join(dir, TELEGRAM_POLL_FILE), JSON.stringify({ version: 1, offset: 0, bot: '123456', secret: 'b'.repeat(64) }));
  });

  it('asks for message and callback_query only, with a 50 s timeout and the offset after the last update', async () => {
    const t = stand([{ json: { ok: true, result: [{ update_id: 10, message: { text: 'a' } }, { update_id: 11, message: { text: 'b' } }] } }, { json: { ok: true, result: [{ update_id: 12, message: { text: 'c' } }] } }]);
    const { poll, delivered } = make(t.fetch);
    await poll.load();
    poll.start();
    await until(() => t.calls.length >= 3);
    expect(t.calls.map((c) => c.body.offset)).toEqual([0, 12, 13]);
    expect(t.calls[0]?.body).toMatchObject({ timeout: 50, allowed_updates: ['message', 'callback_query'] });
    expect(delivered.map((d) => d.update.update_id)).toEqual([10, 11, 12]);
    expect(t.calls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/getUpdates`);
    expect(poll.state().mode).toBe('polling');
  });

  it('keeps the offset in a 0600 file, so a restart does not replay', async () => {
    const first = stand([{ json: { ok: true, result: [{ update_id: 40, message: { text: 'a' } }] } }]);
    const one = make(first.fetch);
    await one.poll.load();
    one.poll.start();
    await until(() => first.waiting());
    await one.poll.stop();
    expect((await stat(join(dir, TELEGRAM_POLL_FILE))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(dir, TELEGRAM_POLL_FILE), 'utf8'))).toMatchObject({ version: 1, offset: 41 });
    const second = stand([]);
    const two = make(second.fetch);
    await two.poll.load();
    two.poll.start();
    await until(() => second.calls.length === 1);
    expect(second.calls[0]?.body.offset).toBe(41);
    expect(two.poll.secret()).toBe(one.poll.secret());
  });

  it('a damaged file starts like a first start: the newest update is looked at and nothing is handed on', async () => {
    await writeFile(join(dir, TELEGRAM_POLL_FILE), '{ nope');
    const t = stand([]);
    const { poll } = make(t.fetch);
    await poll.load();
    poll.start();
    await until(() => t.calls.length === 1);
    expect(t.calls[0]?.body).toMatchObject({ offset: -1, timeout: 0 });
  });

  it('a 409 "terminated by other getUpdates request" is another program polling this bot: said so, and backed off like an error, not a minute', async () => {
    const other = { status: 409, json: { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running' } };
    const t = stand([other, other, other]);
    const { poll, waits } = make(t.fetch);
    await poll.load();
    poll.start();
    await until(() => t.calls.length >= 4);
    expect(poll.state().mode).toBe('error');
    expect(poll.state().note).toMatch(/Another program polls this bot/);
    expect(waits.slice(0, 3)).toEqual([1000, 2000, 4000]);
    expect(waits).not.toContain(60_000);
  });

  it('a 409 means a webhook is set: it says so, never calls deleteWebhook, and looks again after a minute', async () => {
    const t = stand([{ status: 409, json: { ok: false, error_code: 409, description: 'Conflict: can not use getUpdates while webhook is active' } }]);
    const { poll, waits } = make(t.fetch);
    await poll.load();
    poll.start();
    await until(() => t.calls.length >= 2);
    expect(poll.state().mode).toBe('webhook');
    expect(poll.state().note).toMatch(/webhook is set.*inbound uses it/);
    expect(waits).toContain(60_000);
    for (const call of t.calls) expect(call.url).not.toMatch(/deleteWebhook|setWebhook/);
  });

  it('a bad token is said (not shown), and waits five minutes', async () => {
    const t = stand([{ status: 401, json: { ok: false } }]);
    const { poll, waits } = make(t.fetch);
    await poll.load();
    poll.start();
    await until(() => waits.length > 0);
    expect(poll.state()).toMatchObject({ mode: 'error' });
    expect(poll.state().note).not.toContain(TOKEN);
    expect(waits).toContain(300_000);
  });

  it('backs off after errors, doubling to a cap of a minute, and starts again after a good answer', async () => {
    const boom = { throws: new Error(`fetch failed: https://api.telegram.org/bot${TOKEN}/getUpdates`) };
    const t = stand([boom, boom, boom, boom, { status: 502 }, { json: { ok: true, result: [] } }, boom]);
    const { poll, waits } = make(t.fetch);
    await poll.load();
    poll.start();
    await until(() => t.calls.length >= 8);
    expect(waits.slice(0, 5)).toEqual([1000, 2000, 4000, 8000, 16000]);
    // the good answer reset it
    expect(waits[5]).toBe(1000);
    expect(waits.every((w) => w <= 60_000)).toBe(true);
  });

  it('honours Telegram\'s retry_after on 429', async () => {
    const t = stand([{ status: 429, json: { ok: false, parameters: { retry_after: 7 } } }]);
    const { poll, waits } = make(t.fetch);
    await poll.load();
    poll.start();
    await until(() => waits.length > 0);
    expect(waits[0]).toBe(7000);
  });

  it('never puts the token in a log line, in the state or in the file', async () => {
    const t = stand([{ throws: Object.assign(new Error(`getaddrinfo ENOTFOUND api.telegram.org/bot${TOKEN}`), { cause: { code: 'ENOTFOUND' } }) }, { status: 401 }, { status: 409 }]);
    const { poll } = make(t.fetch);
    await poll.load();
    poll.start();
    await until(() => t.calls.length >= 4);
    await poll.stop();
    expect(logs.join('\n')).toContain('ENOTFOUND');
    expect(logs.join('\n')).not.toContain(TOKEN);
    expect(logs.join('\n')).not.toContain('SECRET-token');
    expect(JSON.stringify(poll.state())).not.toContain('SECRET-token');
    expect(await readFile(join(dir, TELEGRAM_POLL_FILE), 'utf8')).not.toContain('SECRET-token');
  });

  it('stops on shutdown, ending the request in flight', async () => {
    const t = stand([]);
    const { poll } = make(t.fetch);
    await poll.load();
    poll.start();
    await until(() => t.waiting());
    const done = Date.now();
    await poll.stop();
    expect(Date.now() - done).toBeLessThan(1000);
    const count = t.calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(t.calls.length).toBe(count);
  });

  it('a changed token ends the request in flight and the next one uses the new token; none set, or a Telegram uplink, asks nothing', async () => {
    let token: string | null = TOKEN;
    let uplink = false;
    const t = stand([]);
    const { poll } = make(t.fetch, { target: () => (token === null ? null : { token, to: CHAT }), hasUplink: () => uplink });
    await poll.load();
    poll.start();
    await until(() => t.calls.length === 1);
    token = '999999:NEW-token_abcdefghijklmnopqrstuvwxyz01234';
    await until(() => t.calls.length >= 2);
    expect(t.calls.at(-1)?.url).toContain('NEW-token');
    token = null;
    await until(() => poll.state().mode === 'off');
    const count = t.calls.length;
    token = TOKEN;
    uplink = true;
    await until(() => poll.state().mode === 'uplink');
    expect(poll.state().note).toMatch(/uplink.*webhook.*polling is off/);
    await new Promise((r) => setTimeout(r, 30));
    expect(t.calls.length).toBe(count);
  });
});

describe('the first start (no replay of what Telegram still holds)', () => {
  it('asks for the newest update only, hands nothing on, and goes on after it', async () => {
    const old = [{ update_id: 88, message: { text: 'yesterday' } }, { update_id: 90, message: { text: 'an hour ago' } }];
    const t = stand([{ json: { ok: true, result: old } }, { json: { ok: true, result: [{ update_id: 91, message: { text: 'now' } }] } }]);
    const { poll, delivered } = make(t.fetch);
    await poll.load();
    poll.start();
    await until(() => t.calls.length >= 3);
    expect(t.calls[0]?.body).toMatchObject({ offset: -1, timeout: 0, allowed_updates: ['message', 'callback_query'] });
    expect(t.calls[1]?.body).toMatchObject({ offset: 91, timeout: 50 });
    expect(delivered.map((d) => d.update.update_id)).toEqual([91]);
    await poll.stop(); // the offset is written after the hand-on: stop waits for it
    expect(JSON.parse(await readFile(join(dir, TELEGRAM_POLL_FILE), 'utf8'))).toMatchObject({ offset: 92, bot: '123456' });
  });

  it('with nothing waiting it starts at 0, and a restart keeps what it saved (no second priming)', async () => {
    const t = stand([{ json: { ok: true, result: [] } }]);
    const one = make(t.fetch);
    await one.poll.load();
    one.poll.start();
    await until(() => t.calls.length >= 2);
    expect(t.calls[1]?.body.offset).toBe(0);
    await one.poll.stop();
    const again = stand([]);
    const two = make(again.fetch);
    await two.poll.load();
    two.poll.start();
    await until(() => again.calls.length === 1);
    expect(again.calls[0]?.body).toMatchObject({ offset: 0, timeout: 50 });
  });

  it('another bot has other update ids: the offset of the first is dropped and the new one is primed; a rotated token of the same bot keeps its offset', async () => {
    await writeFile(join(dir, TELEGRAM_POLL_FILE), JSON.stringify({ version: 1, offset: 5000, bot: '111111', secret: 'c'.repeat(64) }));
    let token = TOKEN;
    const t = stand([{ json: { ok: true, result: [{ update_id: 7, message: { text: 'old' } }] } }]);
    const { poll, delivered } = make(t.fetch, { target: () => ({ token, to: CHAT }) });
    await poll.load();
    poll.start();
    await until(() => t.calls.length >= 2);
    expect(t.calls[0]?.body.offset).toBe(-1);
    expect(t.calls[1]?.body.offset).toBe(8);
    expect(delivered).toEqual([]);
    token = '123456:ROTATED-token_abcdefghijklmnopqrstuvwxyz0123';
    await until(() => t.calls.length >= 3);
    expect(t.calls[2]?.body.offset).toBe(8);
    expect(t.calls[2]?.url).toContain('ROTATED');
  });

  it('shows "starting" while a set target waits for the first look, and a changed target is seen within the check interval', async () => {
    let target: { token: string; to: string } | null = null;
    const t = stand([{ json: { ok: true, result: [] } }]);
    const { poll } = make(t.fetch, { target: () => target });
    await poll.load();
    expect(poll.state().mode).toBe('off');
    poll.start();
    await new Promise((r) => setTimeout(r, 20));
    target = { token: TOKEN, to: CHAT };
    expect(poll.state().note).toMatch(/starting/);
    await until(() => t.calls.length >= 1);
  });
});

describe('an update goes through the same read as a webhook delivery', () => {
  let sent: UserMessageRequest[];
  let pressed: Array<[string, unknown]>;
  const threads = new Map<string, { id: string; agent: string; subject: string }>();
  const seen = new Set<string>();
  const inbound: Inbound = { find: (key) => threads.get(key), seen: (key) => (seen.has(key) ? true : (seen.add(key), false)), telegramChat: () => CHAT };
  const open = () =>
    createUplinks({
      dir,
      now: () => Date.UTC(2026, 10, 19, 9, 0),
      inbound,
      send: (request): SendResult => {
        sent.push(request);
        return { ok: true, id: `m${sent.length}`, to: 'flight', status: 'queued', note: null };
      },
      emit: () => undefined,
      press: (secret, press) => void pressed.push([secret, press]),
      log: quiet,
    });
  beforeEach(() => {
    sent = [];
    pressed = [];
    threads.clear();
    seen.clear();
  });

  const update = (body: unknown): Buffer => Buffer.from(JSON.stringify(body));

  it('a message from the Director\'s chat goes to the boss; one from another chat is dropped', () => {
    const u = open();
    u.deliverPolled(update({ update_id: 1, message: { text: ' hello gonogo ', chat: { id: 777 }, from: { first_name: 'Ana', username: 'ana' } } }), 'k');
    u.deliverPolled(update({ update_id: 2, message: { text: 'let me in', chat: { id: 999 }, from: { first_name: 'Eve' } } }), 'k');
    u.deliverPolled(update({ update_id: 3, message: { chat: { id: 777 } } }), 'k');
    u.deliverPolled(update({ update_id: 4, edited_message: { text: 'x', chat: { id: 777 } } }), 'k');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'boss', subject: 'Telegram' });
    expect(sent[0]?.body).toContain('hello gonogo');
    expect(sent[0]?.body).toContain('Ana @ana');
    expect(sent[0]?.body).not.toContain('let me in');
  });

  it('a reply to something gonogo posted goes to the agent that wrote it, in its thread', () => {
    threads.set('telegram:777:55', { id: 'm9', agent: 'fido', subject: 'Review' });
    const u = open();
    u.deliverPolled(update({ update_id: 5, message: { text: 'looks good', chat: { id: 777 }, reply_to_message: { message_id: 55 } } }), 'k');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'fido', inReplyTo: 'm9', subject: 'Re: Review', body: 'looks good' });
  });

  it('a button from the Director\'s chat goes to phone approvals with the polling secret, and one from another chat is dropped', () => {
    const u = open();
    u.deliverPolled(update({ update_id: 6, callback_query: { id: 'q1', data: 'a:perm:p1:go:abcd1234', message: { message_id: 3, chat: { id: 777 } } } }), 'poll-secret');
    u.deliverPolled(update({ update_id: 7, callback_query: { id: 'q2', data: 'a:perm:p1:go:abcd1234', message: { message_id: 3, chat: { id: 1 } } } }), 'poll-secret');
    expect(pressed).toEqual([['poll-secret', { queryId: 'q1', data: 'a:perm:p1:go:abcd1234', chat: '777', messageId: '3' }]]);
    expect(sent).toEqual([]);
  });

  it('a damaged update is dropped with no throw, and the rate limit of an uplink applies', () => {
    const u = open();
    expect(() => u.deliverPolled(Buffer.from('not json'), 'k')).not.toThrow();
    for (let i = 0; i < 40; i += 1) u.deliverPolled(update({ update_id: 100 + i, message: { text: `m${i}`, chat: { id: 777 } } }), 'k');
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThan(40);
    expect(logs.join('\n')).toMatch(/dropped/);
  });

  it('is not an uplink: nothing is listed or saved for it', async () => {
    const u = open();
    u.deliverPolled(update({ update_id: 8, message: { text: 'hi', chat: { id: 777 } } }), 'k');
    await u.close();
    expect(u.list()).toEqual([]);
    await expect(readFile(join(dir, 'uplinks.json'), 'utf8')).rejects.toThrow();
  });
});
