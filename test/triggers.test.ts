/**
 * The history of triggers (docs/features/triggers.md): the log, its redaction (what may and may not stay in it), its rotation, the route, and what
 * each source writes into it: an uplink delivery (a webhook, a polled Telegram update), a Launch Window run, a Docking hand-off.
 */
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Logger, SendResult, TriggerEntry, UserMessageRequest } from '../src/shared/protocol.js';
import { HubError } from '../src/server/hub.js';
import { createSchedules } from '../src/server/schedules.js';
import { cleanEntry, createTriggers, excerptOf, redactSecrets, TRIGGERS_FILE, TRIGGERS_KEEP_MS, TRIGGERS_LIMIT_MAX, TRIGGERS_OLD_FILE, TRIGGERS_ROTATE_BYTES } from '../src/server/triggers.js';
import type { TriggerInput, Triggers } from '../src/server/triggers.js';
import { createUplinks } from '../src/server/uplinks.js';
import type { Inbound } from '../src/server/uplinks.js';

const quiet: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined, child: () => quiet };
const T0 = Date.UTC(2026, 10, 20, 9, 0);
const DAY = 86_400_000;
let dir: string;
let clock: number;
const open: Array<{ close(): Promise<void> }> = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gng-trig-'));
  clock = T0;
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((x) => x.close()));
  await rm(dir, { recursive: true, force: true });
});

const make = async (): Promise<Triggers> => {
  const t = createTriggers({ dir, now: () => clock, log: quiet });
  open.push(t);
  await t.load();
  return t;
};
const base: TriggerInput = { kind: 'uplink', source: 'u1', name: 'GitHub', service: 'github', outcome: 'queued', what: 'push to main' };

describe('redaction (what may stay in the log)', () => {
  /** [what is said, the secret in it] */
  const SECRETS: Array<[string, string]> = [
    ['Authorization: Bearer abcdef123456.ghijkl', 'abcdef123456.ghijkl'],
    ['url https://x.example/hook?token=sk_live_ABCDEFGH12345678', 'sk_live_ABCDEFGH12345678'],
    ['see #token=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'],
    ['password: hunter2hunter2', 'hunter2hunter2'],
    ['{"secret":"s3cr3t-value","ok":1}', 's3cr3t-value'],
    ['xoxb-1234567890-abcdefghijkl', 'xoxb-1234567890-abcdefghijkl'],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz', 'github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz'],
    ['sk-ant-api03-abcdefghijklmnopqrstuvwxyz', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz'],
    ['AKIAABCDEFGHIJKLMNOP', 'AKIAABCDEFGHIJKLMNOP'],
    ['123456789:AAFabcdefghijklmnopqrstuvwxyz012345', 'AAFabcdefghijklmnopqrstuvwxyz012345'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnop', 'eyJzdWIiOiIxMjM0In0'],
    ['gnk_abcdefgh12345678', 'gnk_abcdefgh12345678'],
    ['api_key=ABCD1234efgh5678', 'ABCD1234efgh5678'],
    ['signature=deadbeefdeadbeef', 'deadbeefdeadbeef'],
    ['x-hub-signature-256: sha256=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'],
    ['QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5YWJjZGVmZ2hpams=', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5YWJjZGVmZ2hpams'],
  ];

  it('replaces every shape of secret gonogo or its services use', () => {
    for (const [said, value] of SECRETS) {
      const out = redactSecrets(`before ${said} after`);
      expect(out, said).toContain('[redacted]');
      expect(out, said).not.toContain(value);
      expect(out.startsWith('before ') && out.endsWith(' after'), said).toBe(true);
    }
  });

  it('leaves ordinary text alone: names, versions, short words, ids', () => {
    for (const text of ['push to main by ana', 'Update to 0.5.0 failed (exit 1)', 'task t12 handed off to nas', 'issue #345 opened: add CSV export', 'm17: queued']) expect(redactSecrets(text), text).toBe(text);
  });

  it('keeps one line, no control characters, at most 160 characters', () => {
    const out = excerptOf(`a\n\tb\u0000c‮${'x '.repeat(200)}`);
    expect(out).not.toMatch(/[\n\t\u0000‮]/);
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out.endsWith('…')).toBe(true);
  });

  it('is applied to what, name and note of an entry, and nothing else reaches the file', async () => {
    const t = await make();
    t.record({ ...base, name: 'Bearer abcdefghijklmnop', what: SECRETS.map(([said]) => said).join(' | '), note: 'failed: token=ABCDEFGH12345678 refused' });
    await t.close();
    const raw = await readFile(join(dir, TRIGGERS_FILE), 'utf8');
    for (const [, value] of SECRETS) expect(raw, value).not.toContain(value);
    expect(raw).not.toContain('ABCDEFGH12345678');
    expect(raw).not.toContain('abcdefghijklmnop');
  });

  it('an entry with a bad kind or no source is not written, and unknown fields are dropped', async () => {
    const t = await make();
    t.record({ ...base, kind: 'nonsense' as never });
    t.record({ ...base, source: '' });
    t.record({ ...base, outcome: '' });
    t.record({ ...base, secret: 'hunter2', headers: { authorization: 'x' }, body: 'a whole body' } as never);
    expect(await t.list()).toHaveLength(1);
    const raw = await readFile(join(dir, TRIGGERS_FILE), 'utf8');
    expect(raw).not.toMatch(/hunter2|headers|authorization|whole body/);
    expect(cleanEntry({ ...base, at: 5 }, 1)).toMatchObject({ at: 5, kind: 'uplink' });
    expect(cleanEntry('nope', 1)).toBeNull();
  });
});

describe('the log', () => {
  it('is a 0600 file of one JSON line each, newest first on read', async () => {
    const t = await make();
    for (let i = 1; i <= 3; i += 1) {
      clock += 1000;
      t.record({ ...base, what: `n${i}`, message: `m${i}`, agent: 'ana' });
    }
    const list = await t.list();
    expect(list.map((e) => e.what)).toEqual(['n3', 'n2', 'n1']);
    expect(list[0]).toMatchObject({ kind: 'uplink', source: 'u1', name: 'GitHub', service: 'github', outcome: 'queued', message: 'm3', agent: 'ana', at: T0 + 3000 });
    expect((await stat(join(dir, TRIGGERS_FILE))).mode & 0o777).toBe(0o600);
    expect((await readFile(join(dir, TRIGGERS_FILE), 'utf8')).trim().split('\n')).toHaveLength(3);
  });

  it('filters by kind, source and outcome, and limits (default 100, at most 500)', async () => {
    const t = await make();
    t.record({ ...base, source: 'u1', outcome: 'queued' });
    t.record({ ...base, source: 'u2', outcome: 'refused', note: 'rate limit' });
    t.record({ ...base, kind: 'schedule', source: 's1', name: 'Standup', service: undefined, outcome: 'delivered' });
    t.record({ ...base, kind: 'telegram', source: 'telegram', name: 'Telegram', outcome: 'queued' });
    t.record({ ...base, kind: 'docking', source: 'abc', name: 'nas', outcome: 'failed', note: 'unreachable' });
    expect(await t.list({ kind: 'schedule' })).toHaveLength(1);
    expect((await t.list({ source: 'u2' })).map((e) => e.outcome)).toEqual(['refused']);
    expect(await t.list({ outcome: 'queued' })).toHaveLength(2);
    expect(await t.list({ kind: 'uplink', outcome: 'refused' })).toHaveLength(1);
    expect(await t.list({ limit: 2 })).toHaveLength(2);
    for (let i = 0; i < 520; i += 1) t.record({ ...base, what: `bulk ${i}` });
    expect(await t.list({ limit: 9999 })).toHaveLength(TRIGGERS_LIMIT_MAX);
    expect(await t.list()).toHaveLength(100);
  });

  it('skips a torn line and a line that is not an entry, and survives a restart', async () => {
    const t = await make();
    t.record(base);
    await t.close();
    await writeFile(join(dir, TRIGGERS_FILE), `${await readFile(join(dir, TRIGGERS_FILE), 'utf8')}{"kind":"upl\nnot json\n{"kind":"bogus","source":"x","outcome":"y"}\n`);
    const again = await make();
    expect(await again.list()).toHaveLength(1);
    again.record({ ...base, what: 'after the restart' });
    expect((await again.list())[0]?.what).toBe('after the restart');
  });

  it('is rotated to triggers.1.jsonl past 1 MiB, the older rotation is dropped, and a read sees both files', async () => {
    const t = await make();
    const note = 'x'.repeat(190);
    let n = 0;
    while (true) {
      t.record({ ...base, what: `row ${n}`, note: `${note} ${n}` });
      n += 1;
      if (n % 200 === 0) {
        await t.list();
        try {
          if ((await stat(join(dir, TRIGGERS_OLD_FILE))).isFile()) break;
        } catch {
          // not yet
        }
      }
      if (n > 20_000) throw new Error('never rotated');
    }
    await t.close();
    const current = await stat(join(dir, TRIGGERS_FILE));
    expect(current.size).toBeLessThan(TRIGGERS_ROTATE_BYTES);
    expect((await stat(join(dir, TRIGGERS_OLD_FILE))).size).toBeLessThanOrEqual(TRIGGERS_ROTATE_BYTES + 1000);
    const again = await make();
    const all = await again.list({ limit: 500 });
    expect(all[0]?.what).toBe(`row ${n - 1}`);
    // the rows before the rotation are still read
    expect(all.length).toBe(500);
  });

  it('is rotated by age too, and a line older than 90 days is not shown', async () => {
    const t = await make();
    t.record({ ...base, what: 'old' });
    await t.close();
    clock += TRIGGERS_KEEP_MS + DAY;
    const later = await make();
    expect(await later.list()).toEqual([]);
    later.record({ ...base, what: 'new' });
    expect((await later.list()).map((e) => e.what)).toEqual(['new']);
    await later.close();
    expect((await stat(join(dir, TRIGGERS_OLD_FILE))).isFile()).toBe(true);
    expect((await readFile(join(dir, TRIGGERS_FILE), 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  it('a failed write is logged and never throws into the trigger', async () => {
    const t = createTriggers({ dir: join(dir, 'nowhere', 'deeper'), now: () => clock, log: quiet });
    open.push(t);
    expect(() => t.record(base)).not.toThrow();
    await expect(t.close()).resolves.toBeUndefined();
  });
});

describe('what each source writes', () => {
  let sent: UserMessageRequest[];
  let store: Triggers;
  let log: TriggerEntry[];
  /** What reached the file: through the real store, so what is checked is what would be kept. */
  const record = (e: TriggerInput): void => store.record(e);
  const seen = async (): Promise<TriggerEntry[]> => (await store.list()).reverse();
  const inbound: Inbound = { find: () => undefined, seen: () => false, telegramChat: () => '777' };
  let answer: (request: UserMessageRequest) => SendResult;
  beforeEach(async () => {
    store = await make();
    sent = [];
    log = [];
    answer = (request) => ({ ok: true, id: `m${sent.length}`, to: request.to === 'boss' ? 'flight' : request.to, status: 'queued', note: null });
  });
  const uplinks = () => {
    const u = createUplinks({
      dir,
      now: () => clock,
      inbound,
      send: (request) => {
        sent.push(request);
        return answer(request);
      },
      emit: () => undefined,
      trigger: record,
      log: quiet,
    });
    open.push(u);
    return u;
  };

  it('a webhook delivery: the uplink, the agent, the message id, the outcome, and the payload cut and redacted', async () => {
    const u = uplinks();
    await u.load();
    const made = await u.create({ name: 'Deploys', to: 'ana', kind: 'generic' });
    const body = JSON.stringify({ event: 'deploy', token: 'ABCDEFGH12345678abcdefgh', note: 'x'.repeat(500) });
    const sig = createHmac('sha256', made.secret).update(body).digest('hex');
    u.deliver(made.id, Buffer.from(body), { 'x-gonogo-signature': `sha256=${sig}`, authorization: `Bearer ${made.secret}` });
    log = await seen();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ kind: 'uplink', source: made.id, name: 'Deploys', service: 'generic', outcome: 'queued', agent: 'ana' });
    expect(log[0]?.message).toMatch(/^m/);
    expect(log[0]?.what.length).toBeLessThanOrEqual(1000);
    const raw = JSON.stringify(log[0]);
    expect(raw).not.toContain('ABCDEFGH12345678abcdefgh');
    expect(raw).not.toContain(made.secret);
  });

  it('a bad signature is not a trigger (it would let a stranger fill the log), a refused message is', async () => {
    const u = uplinks();
    await u.load();
    const made = await u.create({ name: 'Deploys', to: 'ana', kind: 'generic' });
    expect(() => u.deliver(made.id, Buffer.from('{}'), { 'x-gonogo-signature': 'sha256=00' })).toThrow();
    expect(await seen()).toEqual([]);
    answer = () => {
      throw new HubError('not_found', 'ana is not in the room');
    };
    const body = JSON.stringify({ a: 1 });
    expect(() => u.deliver(made.id, Buffer.from(body), { 'x-gonogo-signature': `sha256=${createHmac('sha256', made.secret).update(body).digest('hex')}` })).toThrow();
    log = await seen();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ outcome: 'refused' });
    expect(log[0]?.note).toContain('ana is not in the room');
  });

  it('a polled Telegram update: kind telegram, source telegram, only from the Director\'s chat', async () => {
    const u = uplinks();
    await u.load();
    u.deliverPolled(Buffer.from(JSON.stringify({ update_id: 1, message: { text: 'status please', chat: { id: 777 }, from: { first_name: 'Ana' } } })), 'k');
    u.deliverPolled(Buffer.from(JSON.stringify({ update_id: 2, message: { text: 'let me in', chat: { id: 1 } } })), 'k');
    log = await seen();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ kind: 'telegram', source: 'telegram', name: 'Telegram', outcome: 'queued', agent: 'flight' });
    expect(log[0]?.what).toContain('status please');
  });

  it('a Launch Window run, by the clock or by Run now: the schedule, the message, the agent and the outcome; a failure says why', async () => {
    const timers: Array<() => void> = [];
    const s = createSchedules({ dir, now: () => clock, setTimer: (fn) => (timers.push(fn), timers.length), clearTimer: () => undefined, send: (request) => (sent.push(request), answer(request)), emit: () => undefined, trigger: record, log: quiet });
    open.push(s);
    await s.load();
    const made = await s.create({ name: 'Standup', to: 'boss', body: 'Post your status. token=ABCDEFGH12345678', rule: '0 9 * * 1-5' });
    await s.run(made.id);
    log = await seen();
    expect(log[0]).toMatchObject({ kind: 'schedule', source: made.id, name: 'Standup', outcome: 'queued', agent: 'flight' });
    expect(log[0]?.what).toContain('Post your status.');
    expect(JSON.stringify(log[0])).not.toContain('ABCDEFGH12345678');
    answer = () => {
      throw new HubError('conflict', 'the room is on hold');
    };
    await s.run(made.id);
    log = await seen();
    expect(log[1]).toMatchObject({ kind: 'schedule', outcome: 'failed' });
    expect(log[1]?.note).toContain('the room is on hold');
  });
});
