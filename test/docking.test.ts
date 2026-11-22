// Docking (docs/docking-spec.md): the module against a second copy of itself. The two stations talk through a fake fetch that
// hands each call to the other's `handle`, so the signatures, the replay and expiry rules and the pairing run for real while
// nothing needs a socket. The same two stations over real HTTP are scenario 30 of e2e.test.ts.
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DOCK_ROUTES, createDocking, signCall, stationName } from '../src/server/docking.js';
import type { Docking } from '../src/server/docking.js';
import { DOCK_CODE_TTL_MS, DOCK_PULL_MS, DOCK_RATE_MAX, DOCK_RATE_WINDOW_MS, DOCK_SKEW_MS, nullLogger } from '../src/server/constants.js';
import { hubErrorInfo } from '../src/server/hooks.js';
import type { DockedAgent, DockingView, SendResult, StationMessage, Task } from '../src/shared/protocol.js';

const T0 = 1_700_000_000_000;
const STATUS: Record<string, number> = { bad_request: 400, unauthorized: 401, not_found: 404, conflict: 409, too_large: 413, rate_limited: 429, unavailable: 503, internal: 500 };

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

interface Station {
  docking: Docking;
  dir: string;
  origin: string;
  name: string;
  /** What this station's hub was given by the other one. */
  delivered: Array<{ station: string; message: StationMessage }>;
  created: Array<{ actor: unknown; input: Record<string, unknown> }>;
  handedOff: Array<{ id: string; station: string; assignee: string | null }>;
  /** What this station told the history of triggers. */
  triggers: Array<Record<string, unknown>>;
  tasks: Task[];
  views: DockingView[];
  agents: DockedAgent[];
  /** What the hub does with a message from the other station; a HubError of the same shape as the real one when it throws. */
  hub: { deliver: (station: string, message: StationMessage) => SendResult };
  down: boolean;
}

interface World {
  clock: { now: number };
  stations: Map<string, Station>;
  /** Makes a station. `origin` is the address the others reach it at. */
  make(name: string, origin: string, options?: { dir?: string }): Promise<Station>;
}

function hubError(code: string, message: string, field?: string): Error {
  return Object.assign(new Error(message), { name: 'HubError', code, ...(field === undefined ? {} : { field }) });
}

function world(): World {
  const clock = { now: T0 };
  const stations = new Map<string, Station>();
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const target = stations.get(url.origin);
    if (!target || target.down) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const headers: IncomingHttpHeaders = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[key.toLowerCase()] = value;
    try {
      const data = await target.docking.handle(url.pathname.split('/')[2] ?? '', init?.method ?? 'GET', url.pathname + url.search, headers, Buffer.from(String(init?.body ?? '')));
      return Response.json(data);
    } catch (error) {
      const info = hubErrorInfo(error);
      if (!info) throw error;
      return Response.json({ error: info.message, code: info.code, ...(info.field === undefined ? {} : { field: info.field }) }, { status: STATUS[info.code] ?? 500 });
    }
  };
  return {
    clock,
    stations,
    async make(name, origin, options = {}) {
      const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'gonogo-dock-'));
      if (options.dir === undefined) cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
      const station: Station = {
        docking: undefined as unknown as Docking,
        dir,
        origin,
        name,
        delivered: [],
        created: [],
        handedOff: [],
        triggers: [],
        tasks: [],
        views: [],
        agents: [{ name: `${name}-ana`, role: `${'x'.repeat(400)}`, state: 'idle', boss: true }],
        hub: {
          deliver: (from, message) => {
            station.delivered.push({ station: from, message });
            return { ok: true, id: `m${station.delivered.length}`, to: message.to, status: 'queued', note: 'waiting: about to type the pointer' };
          },
        },
        down: false,
      };
      station.docking = createDocking({
        dir,
        name,
        now: () => clock.now,
        fetch: fetcher,
        deliver: (from, message) => station.hub.deliver(from, message),
        trigger: (entry) => void station.triggers.push(entry as unknown as Record<string, unknown>),
        roster: () => station.agents,
        tasks: {
          list: () => station.tasks,
          create: async (actor, input) => {
            station.created.push({ actor, input: input as Record<string, unknown> });
            const title = (input as { title?: unknown }).title;
            if (typeof title !== 'string' || title === '') throw hubError('bad_request', 'title is required', 'title');
            const assignee = (input as { assignee?: unknown }).assignee;
            if (assignee === 'nobody') throw hubError('bad_request', 'assignee must be the name of an agent in the room, or null', 'assignee');
            return { id: 't9', title, detail: String((input as { detail?: unknown }).detail ?? ''), status: 'todo', assignee: null, createdBy: 'user', createdAt: clock.now, updatedAt: clock.now, notes: [] };
          },
          handOff: async (id, to, assignee) => {
            station.handedOff.push({ id, station: to, assignee });
            return { ...station.tasks.find((t) => t.id === id)!, status: 'done', handedOff: to };
          },
        },
        emit: (view) => station.views.push(view),
        log: nullLogger,
      });
      await station.docking.load();
      stations.set(origin, station);
      return station;
    },
  };
}

const pair = async (a: Station, b: Station): Promise<{ aSees: string; bSees: string }> => {
  const { code } = a.docking.createCode({ url: a.origin });
  const dock = await b.docking.pair({ code, url: b.origin });
  // the first pulls run in the background (b pulls a, which makes a pull b)
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { aSees: a.docking.view().docks[0]?.id ?? '', bSees: dock.id };
};

const task = (id: string, over: Partial<Task> = {}): Task => ({ id, title: `Task ${id}`, detail: 'what done means', status: 'todo', assignee: null, createdBy: 'user', createdAt: T0, updatedAt: T0, notes: [], ...over });

describe('station name', () => {
  it('is GONOGO_STATION, else the first label of the host name, cut to a name', () => {
    expect(stationName('Lab 2', 'mac.local')).toBe('lab-2');
    expect(stationName(undefined, 'MacBook-Pro.local')).toBe('macbook-pro');
    expect(stationName('', 'host')).toBe('host');
    expect(stationName('  --x--  ', 'host')).toBe('x');
    expect(stationName('a'.repeat(50), 'host')).toBe('a'.repeat(31));
    expect(stationName('a'.repeat(30) + '-b', 'host')).toBe('a'.repeat(30));
    expect(stationName('???', '.local')).toBe('station');
    expect(stationName(undefined, '')).toBe('station');
  });
});

describe('the signature', () => {
  it('is the HMAC-SHA256 of sender id, method, path, timestamp, nonce and body with the secret as bytes', () => {
    const secret = 'ab'.repeat(32);
    const expected = createHmac('sha256', Buffer.from(secret, 'hex')).update('s1\nPOST\n/dock/message\n1700000000000\nnonce\n{"a":1}').digest('hex');
    expect(signCall(secret, 's1', 'POST', '/dock/message', '1700000000000', 'nonce', '{"a":1}')).toBe(expected);
    expect(signCall(secret, 's1', 'POST', '/dock/message', '1700000000000', 'nonce', Buffer.from('{"a":1}'))).toBe(expected);
    for (const changed of [
      signCall(secret, 's1', 'GET', '/dock/message', '1700000000000', 'nonce', '{"a":1}'),
      signCall(secret, 's1', 'POST', '/dock/roster', '1700000000000', 'nonce', '{"a":1}'),
      signCall(secret, 's1', 'POST', '/dock/message', '1700000000001', 'nonce', '{"a":1}'),
      signCall(secret, 's1', 'POST', '/dock/message', '1700000000000', 'nonce2', '{"a":1}'),
      signCall(secret, 's1', 'POST', '/dock/message', '1700000000000', 'nonce', '{"a":2}'),
      signCall('cd'.repeat(32), 's1', 'POST', '/dock/message', '1700000000000', 'nonce', '{"a":1}'),
      signCall(secret, 's2', 'POST', '/dock/message', '1700000000000', 'nonce', '{"a":1}'),
    ]) {
      expect(changed).not.toBe(expected);
    }
  });

  it('the routes and their methods', () => {
    expect(DOCK_ROUTES).toEqual({ pair: 'POST', roster: 'GET', message: 'POST', task: 'POST', undock: 'POST' });
  });
});

describe('docking code', () => {
  it('holds the address as typed (an origin) and a token, and is refused for an address that is not one', async () => {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const { code, expiresAt } = a.docking.createCode({ url: ' https://gonogo.example.com ' });
    expect(code).toMatch(/^gonogo-dock:[A-Za-z0-9_-]+$/);
    expect(expiresAt).toBe(T0 + DOCK_CODE_TTL_MS);
    const inside = JSON.parse(Buffer.from(code.slice('gonogo-dock:'.length), 'base64url').toString('utf8')) as { u: string; t: string };
    expect(inside.u).toBe('https://gonogo.example.com');
    expect(inside.t).toMatch(/^[0-9a-f]{64}$/);
    for (const url of ['', 'gonogo', 'ftp://x.test', 'http://x.test/path', 'http://u:p@x.test', 'http://x.test/?a=1', 'http://x.test/#a', 42]) {
      expect(() => a.docking.createCode({ url })).toThrow(/web address with no path/);
    }
    expect(() => a.docking.createCode([])).toThrow(/JSON object/);
  });

  it('keeps five at most: the oldest stops working', async () => {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const b = await w.make('beta', 'http://b.test');
    const first = a.docking.createCode({ url: a.origin }).code;
    for (let i = 0; i < 5; i += 1) a.docking.createCode({ url: a.origin });
    await expect(b.docking.pair({ code: first, url: b.origin })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('the code is wrong, used or expired') });
  });
});

describe('a code as people carry it', () => {
  const T = 'ab'.repeat(32);
  const hand = (u: string, token = T): string => 'gonogo-dock:' + Buffer.from(JSON.stringify({ u, t: token })).toString('base64url');

  it('a whole code pairs with or without its first words, with spaces, line breaks, quotes, a trailing dot, zero-width marks and the other base64 alphabet', async () => {
    const w = world();
    const forms: Array<(code: string) => string> = [
      (c) => c,
      (c) => c.slice('gonogo-dock:'.length),
      (c) => c.toUpperCase().slice(0, 12) + c.slice(12),
      (c) => `  ${c.slice(0, 40)}\n${c.slice(40, 80)}\r\n ${c.slice(80)}  `,
      (c) => `"${c}".`,
      (c) => `<${c}>`,
      (c) => c.slice(0, 20) + '\u200b' + c.slice(20) + '\u00a0',
      (c) => c.replace('gonogo-dock:', 'gonogo-dock%3A'),
      (c) => c.replace('gonogo-dock:', 'gonogo-dock-'),
      (c) => c.slice('gonogo-dock:'.length).replace(/-/g, '+').replace(/_/g, '/'),
    ];
    for (const [i, form] of forms.entries()) {
      const a = await w.make(`alpha${i}`, `http://a${i}.test`);
      const b = await w.make(`beta${i}`, `http://b${i}.test`);
      const { code } = a.docking.createCode({ url: a.origin });
      await expect(b.docking.pair({ code: form(code), url: b.origin }), `form ${i}`).resolves.toMatchObject({ name: `alpha${i}` });
    }
  });

  it('says what is wrong with a code that is cut short, empty, not a code or with a wrong token', async () => {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const { code } = a.docking.createCode({ url: a.origin });
    const refused = async (text: unknown): Promise<string> => {
      try {
        await a.docking.pair({ code: text, url: 'http://a2.test' });
      } catch (error) {
        const info = hubErrorInfo(error);
        expect(info?.code).toBe('bad_request');
        expect(info?.field).toBe('code');
        return info?.message ?? '';
      }
      throw new Error('expected a refusal');
    };
    // the token cut in the middle: the very case of the Director's code
    const whole = hand('http://192.168.0.5:7777');
    expect(await refused(whole.slice(0, whole.length - 20))).toMatch(/cut short \(\d+ characters arrived, and it stops in the middle: its token has \d+ of 64 characters\)/);
    expect(await refused(code.slice(0, 40))).toMatch(/cut short \(\d+ characters arrived, and it stops in the middle\)/);
    expect(await refused(hand('http://192.168.0.5:7777', 'ab'.repeat(20)).replace(/.$/, '')) ).toMatch(/cut short/);
    expect(await refused(hand('http://192.168.0.5:7777', 'ab'.repeat(20)))).toMatch(/cut short \(its token has 40 of 64 characters\)/);
    expect(await refused('')).toMatch(/paste the code/);
    expect(await refused(undefined)).toMatch(/paste the code/);
    expect(await refused('gonogo-dock:')).toMatch(/empty after its first words/);
    expect(await refused('hello world, this is not it')).toMatch(/not a docking code/);
    expect(await refused('gonogo-dock:' + Buffer.from('{"u":"x"}').toString('base64url'))).toMatch(/not a docking code/);
    expect(await refused(hand('http://192.168.0.5:7777', 'zz'.repeat(32)))).toMatch(/token is wrong/);
    expect(await refused(hand('ftp://x/'))).toMatch(/web address with no path/);
    for (const message of [await refused(whole.slice(0, 60))]) expect(message).toMatch(/Copy the whole code again/);
  });

  it('a code with an address that works only on one computer: a warning when it is made, the address named when the other side cannot be reached, and a refusal to give another computer a loopback address of its own', async () => {
    const w = world();
    const a = await w.make('alpha', 'http://127.0.0.1:7777');
    const made = a.docking.createCode({ url: a.origin });
    expect(made.warning).toMatch(/works only on this computer/);
    expect(a.docking.createCode({ url: 'http://192.168.0.5:7777' }).warning).toBeUndefined();
    const b = await w.make('beta', 'http://192.168.0.9:7777');
    // the other side is nowhere to be found (it was on another computer): the loopback address is named as the reason
    await expect(b.docking.pair({ code: made.code, url: b.origin })).resolves.toBeDefined(); // the fake network knows 127.0.0.1:7777, like two stations on one computer
    const lonely = await w.make('gamma', 'http://192.168.0.11:7777');
    await expect(lonely.docking.pair({ code: hand('http://127.0.0.1:9999'), url: lonely.origin })).rejects.toMatchObject({ message: expect.stringMatching(/could not reach.*The code carries http:\/\/127\.0\.0\.1:9999, an address that works only on the station that made it/) as string });
    const local = await w.make('delta', 'http://localhost:7778');
    await expect(local.docking.pair({ code: hand('http://192.168.0.5:7777'), url: local.origin })).rejects.toMatchObject({ code: 'bad_request', field: 'url', message: expect.stringMatching(/works only on this computer, so 192\.168\.0\.5:7777 could never reach it/) as string });
  });

  it('a station that does not accept the address it was reached by says what to start it with', async () => {
    const docking = createDocking({
      dir: mkdtempSync(join(tmpdir(), 'gonogo-dock-')),
      name: 'alpha',
      now: () => 1,
      fetch: async () => new Response('forbidden host', { status: 403 }),
      deliver: () => ({ ok: true, id: 'm1', to: 'x', status: 'queued', note: null }),
      roster: () => [],
      tasks: { list: () => [], create: async () => ({}) as Task, handOff: async () => ({}) as Task },
      emit: () => undefined,
      log: nullLogger,
    });
    cleanups.push(() => undefined);
    await docking.load();
    await expect(docking.pair({ code: hand('http://192.168.86.173:7777'), url: 'http://192.168.86.2:7777' })).rejects.toMatchObject({
      message: expect.stringMatching(/does not accept the address 192\.168\.86\.173: on that station start gonogo with --allow-host 192\.168\.86\.173 \(or set GONOGO_ALLOWED_HOSTS=192\.168\.86\.173\)/) as string,
    });
  });

  it('the view carries the network addresses of this computer for the Address box', async () => {
    const docking = createDocking({
      dir: mkdtempSync(join(tmpdir(), 'gonogo-dock-')),
      name: 'alpha',
      now: () => 1,
      fetch: async () => new Response('{}'),
      deliver: () => ({ ok: true, id: 'm1', to: 'x', status: 'queued', note: null }),
      roster: () => [],
      addresses: () => ['192.168.0.5'],
      tasks: { list: () => [], create: async () => ({}) as Task, handOff: async () => ({}) as Task },
      emit: () => undefined,
      log: nullLogger,
    });
    expect(docking.view().addresses).toEqual(['192.168.0.5']);
  });
});

describe('pairing', () => {
  it('stores the same 32-byte secret on both sides, in a file only the owner reads, and shows each the other', async () => {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const b = await w.make('beta', 'http://b.test');
    const { aSees, bSees } = await pair(a, b);
    const fileA = JSON.parse(readFileSync(join(a.dir, 'docking.json'), 'utf8')) as { version: number; docks: Array<{ id: string; name: string; url: string; secret: string }> };
    const fileB = JSON.parse(readFileSync(join(b.dir, 'docking.json'), 'utf8')) as typeof fileA;
    expect(fileA.version).toBe(1);
    expect(fileA.docks).toHaveLength(1);
    expect(fileA.docks[0]).toMatchObject({ name: 'beta', url: 'http://b.test' });
    expect(fileB.docks[0]).toMatchObject({ name: 'alpha', url: 'http://a.test' });
    expect(fileA.docks[0]?.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(fileA.docks[0]?.secret).toBe(fileB.docks[0]?.secret);
    for (const dir of [a.dir, b.dir]) {
      expect(statSync(join(dir, 'docking.json')).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, 'station.json')).mode & 0o777).toBe(0o600);
    }
    const stationA = JSON.parse(readFileSync(join(a.dir, 'station.json'), 'utf8')) as { id: string };
    expect(stationA.id).toMatch(/^[0-9a-f]{32}$/);
    // each side knows the other by the other's station id
    expect(bSees).toBe(stationA.id);
    expect(fileB.docks[0]?.id).toBe(stationA.id);
    expect(aSees).toBe(fileA.docks[0]?.id);
    expect(a.docking.stations()).toEqual(['beta']);
    expect(b.docking.stations()).toEqual(['alpha']);
  });

  it('never sends the token or the secret, and a station that listens learns neither', async () => {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const b = await w.make('beta', 'http://b.test');
    const seen: string[] = [];
    const real = a.docking.handle.bind(a.docking);
    a.docking.handle = async (route, method, url, headers, body) => {
      const answer = await real(route, method, url, headers, body);
      seen.push(body.toString('utf8'), JSON.stringify(answer));
      return answer;
    };
    const { code } = a.docking.createCode({ url: a.origin });
    await b.docking.pair({ code, url: b.origin });
    const token = (JSON.parse(Buffer.from(code.slice('gonogo-dock:'.length), 'base64url').toString('utf8')) as { t: string }).t;
    const secret = (JSON.parse(readFileSync(join(a.dir, 'docking.json'), 'utf8')) as { docks: Array<{ secret: string }> }).docks[0]?.secret ?? '';
    expect(seen.join('')).not.toContain(token);
    expect(seen.join('')).not.toContain(secret);
    expect(seen.join('')).not.toContain(secret.slice(0, 16));
  });

  it('a code works once', async () => {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const b = await w.make('beta', 'http://b.test');
    const c = await w.make('gamma', 'http://c.test');
    const { code } = a.docking.createCode({ url: a.origin });
    await b.docking.pair({ code, url: b.origin });
    await expect(c.docking.pair({ code, url: c.origin })).rejects.toMatchObject({ code: 'conflict', message: 'a.test refused: the code is wrong, used or expired' });
    expect(c.docking.view().docks).toEqual([]);
  });

  it('a code is good for 15 minutes', async () => {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const b = await w.make('beta', 'http://b.test');
    const { code } = a.docking.createCode({ url: a.origin });
    w.clock.now += DOCK_CODE_TTL_MS;
    await expect(b.docking.pair({ code, url: b.origin })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('wrong, used or expired') });
    const fresh = a.docking.createCode({ url: a.origin });
    w.clock.now += DOCK_CODE_TTL_MS - 1;
    await expect(b.docking.pair({ code: fresh.code, url: b.origin })).resolves.toMatchObject({ name: 'alpha' });
  });

  it('a wrong proof does not use the code up', async () => {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const b = await w.make('beta', 'http://b.test');
    const { code } = a.docking.createCode({ url: a.origin });
    await expect(a.docking.handle('pair', 'POST', '/dock/pair', {}, Buffer.from(JSON.stringify({ id: 'a'.repeat(32), name: 'x', url: 'http://x.test', nonce: 'ab'.repeat(8), proof: 'cd'.repeat(32) })))).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(b.docking.pair({ code, url: b.origin })).resolves.toMatchObject({ name: 'alpha' });
  });

  it('refuses a station that does not prove it made the code', async () => {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const b = await w.make('beta', 'http://b.test');
    const impostor = await w.make('mallory', 'http://m.test');
    const { code } = a.docking.createCode({ url: a.origin });
    // the address in the code answers with a station that does not hold the token: its ack cannot be right
    w.stations.set('http://a.test', impostor);
    impostor.docking.handle = async () => ({ id: 'e'.repeat(32), name: 'mallory', nonce: 'ab'.repeat(8), ack: 'cd'.repeat(32) });
    await expect(b.docking.pair({ code, url: b.origin })).rejects.toMatchObject({ code: 'bad_request', field: 'code', message: expect.stringContaining('did not prove it made this code') });
    expect(b.docking.view().docks).toEqual([]);
  });

  it('refuses a text that is not a code, an address that is not an origin, and a station that is not there', async () => {
    const w = world();
    const b = await w.make('beta', 'http://b.test');
    const a = await w.make('alpha', 'http://a.test');
    const { code } = a.docking.createCode({ url: a.origin });
    for (const bad of ['', 'hello', 'gonogo-dock:', 'gonogo-dock:%%%', `gonogo-dock:${Buffer.from('{}').toString('base64url')}`, `gonogo-dock:${Buffer.from('[1]').toString('base64url')}`, 7]) {
      await expect(b.docking.pair({ code: bad, url: b.origin })).rejects.toMatchObject({ code: 'bad_request', field: 'code' });
    }
    await expect(b.docking.pair({ code, url: 'http://b.test/x' })).rejects.toMatchObject({ code: 'bad_request', field: 'url' });
    await expect(b.docking.pair({ code })).rejects.toMatchObject({ code: 'bad_request', field: 'url' });
    w.stations.delete('http://a.test');
    await expect(b.docking.pair({ code, url: b.origin })).rejects.toMatchObject({ code: 'unavailable', message: 'could not reach a.test: ECONNREFUSED' });
  });

  it('refuses to dock with itself, twice with one station, or two stations of one name', async () => {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const b = await w.make('beta', 'http://b.test');
    const twin = await w.make('beta', 'http://twin.test');
    const own = a.docking.createCode({ url: a.origin });
    await expect(a.docking.pair({ code: own.code, url: a.origin })).rejects.toMatchObject({ code: 'conflict', message: 'a.test: a station cannot dock with itself' });
    await pair(a, b);
    await expect(b.docking.pair({ code: a.docking.createCode({ url: a.origin }).code, url: b.origin })).rejects.toMatchObject({ code: 'conflict', message: 'a.test: already docked with beta' });
    await expect(twin.docking.pair({ code: a.docking.createCode({ url: a.origin }).code, url: twin.origin })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('a station called beta is this one or is docked already') });
    // the station of the same name as this one
    await expect(a.docking.pair({ code: twin.docking.createCode({ url: twin.origin }).code, url: a.origin })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('a side that refuses the pairing after the other side accepted it tells that side to undo it', async () => {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const b = await w.make('beta', 'http://b.test');
    const { aSees } = await pair(a, b);
    // alpha undocks while beta cannot hear it: beta still lists alpha
    b.down = true;
    await expect(a.docking.undock(aSees)).resolves.toEqual({ told: false });
    b.down = false;
    await expect(b.docking.pair({ code: a.docking.createCode({ url: a.origin }).code, url: b.origin })).rejects.toMatchObject({ code: 'conflict', message: 'already docked with alpha: undock it here first' });
    // alpha accepted the code, and then was told to drop the dock that beta never made
    expect(a.docking.view().docks).toEqual([]);
    expect(b.docking.view().docks.map((d) => d.name)).toEqual(['alpha']);
  });

  it('the side that made the code pulls the other once it calls in, and again while it is down', async () => {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const b = await w.make('beta', 'http://b.test');
    const { code } = a.docking.createCode({ url: a.origin });
    // beta does not answer a pull at first
    const real = b.docking.handle.bind(b.docking);
    let quiet = true;
    b.docking.handle = async (...args) => {
      if (quiet && args[0] === 'roster') throw hubError('unauthorized', 'the call is not signed by a docked station');
      return real(...args);
    };
    await b.docking.pair({ code, url: b.origin });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(a.docking.view().docks[0]).toMatchObject({ status: 'down' });
    quiet = false;
    // beta's own pull reaches alpha, which pulls beta again
    await b.docking.pull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(a.docking.view().docks[0]).toMatchObject({ status: 'ok', error: null });
  });

  it('at most 8 stations', async () => {
    const w = world();
    const hub = await w.make('hub', 'http://hub.test');
    for (let i = 0; i < 8; i += 1) {
      const other = await w.make(`s${i}`, `http://s${i}.test`);
      await other.docking.pair({ code: hub.docking.createCode({ url: hub.origin }).code, url: other.origin });
    }
    const ninth = await w.make('s9', 'http://s9.test');
    await expect(ninth.docking.pair({ code: hub.docking.createCode({ url: hub.origin }).code, url: ninth.origin })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('at most 8 stations') });
  });

  it('is kept across a restart, with the same station id', async () => {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const b = await w.make('beta', 'http://b.test');
    await pair(a, b);
    const before = JSON.parse(readFileSync(join(a.dir, 'station.json'), 'utf8')) as { id: string };
    const again = await w.make('alpha', 'http://a.test', { dir: a.dir });
    expect(again.docking.view().docks.map((d) => d.name)).toEqual(['beta']);
    expect(JSON.parse(readFileSync(join(a.dir, 'station.json'), 'utf8'))).toEqual(before);
    // and still signs the way the other side accepts
    await again.docking.pull();
    expect(again.docking.view().docks[0]).toMatchObject({ status: 'ok' });
  });

  it('keeps a docking file it cannot read aside, and skips a record that is not a dock', async () => {
    const w = world();
    const dir = mkdtempSync(join(tmpdir(), 'gonogo-dock-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'docking.json'), '{ not json');
    await w.make('alpha', 'http://a.test', { dir });
    expect(readFileSync(join(dir, 'docking.json.bad'), 'utf8')).toBe('{ not json');
    const good = { id: 'a'.repeat(32), name: 'beta', url: 'http://b.test', secret: 'b'.repeat(64), since: 5 };
    writeFileSync(join(dir, 'docking.json'), JSON.stringify({ version: 1, docks: [good, { ...good, id: 'c'.repeat(32), secret: 'short' }, { ...good, id: 'd'.repeat(32), name: 'Bad Name' }, 7, { ...good, id: 'e'.repeat(32) }] }));
    const again = await w.make('alpha', 'http://a2.test', { dir });
    expect(again.docking.view().docks.map((d) => [d.id, d.name])).toEqual([['a'.repeat(32), 'beta']]);
  });
});

describe('calls between docked stations', () => {
  async function docked(): Promise<{ w: World; a: Station; b: Station; secret: string; idA: string; idB: string }> {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const b = await w.make('beta', 'http://b.test');
    await pair(a, b);
    const file = JSON.parse(readFileSync(join(a.dir, 'docking.json'), 'utf8')) as { docks: Array<{ id: string; secret: string }> };
    return {
      w,
      a,
      b,
      secret: file.docks[0]?.secret ?? '',
      idA: (JSON.parse(readFileSync(join(a.dir, 'station.json'), 'utf8')) as { id: string }).id,
      idB: file.docks[0]?.id ?? '',
    };
  }

  /** A call signed by hand, as the other station would make it, to B. */
  const signed = (target: Station, from: { id: string; secret: string }, method: string, route: string, body = '', over: { timestamp?: number; nonce?: string; url?: string; secret?: string } = {}, clock = T0) => {
    const timestamp = String(over.timestamp ?? clock);
    const nonce = over.nonce ?? Math.random().toString(16).slice(2).padEnd(16, '0');
    const url = over.url ?? `/dock/${route}`;
    const headers: IncomingHttpHeaders = {
      'x-gonogo-station': from.id,
      'x-gonogo-timestamp': timestamp,
      'x-gonogo-nonce': nonce,
      'x-gonogo-signature': signCall(over.secret ?? from.secret, from.id, method, url, timestamp, nonce, body),
    };
    return { run: () => target.docking.handle(route, method, url, headers, Buffer.from(body)), headers, nonce };
  };

  it('a signed call is answered, and one whose parts do not match the signature is not', async () => {
    const { a, secret, idA, idB } = await docked();
    const asB = { id: idB, secret };
    await expect(signed(a, asB, 'GET', 'roster').run()).resolves.toMatchObject({ station: { id: idA, name: 'alpha' } });
    const from = { id: idA, secret };
    // each of these is signed for something other than what is sent
    const wrong = [
      signed(a, asB, 'GET', 'roster', '', { secret: 'cd'.repeat(32) }),
      signed(a, from, 'GET', 'roster'),
    ];
    for (const call of wrong) await expect(call.run()).rejects.toMatchObject({ code: 'unauthorized' });
    // a call that alpha signed, sent back to alpha with beta's id in the header: the id is signed, so it is refused
    const reflected = signed(a, from, 'GET', 'roster');
    await expect(a.docking.handle('roster', 'GET', '/dock/roster', { ...reflected.headers, 'x-gonogo-station': idB }, Buffer.alloc(0))).rejects.toMatchObject({ code: 'unauthorized' });
    // signed for another path than the one it is sent to
    const crossed = signed(a, asB, 'POST', 'message', '{}', { url: '/dock/roster' });
    await expect(a.docking.handle('message', 'POST', '/dock/message', crossed.headers, Buffer.from('{}'))).rejects.toMatchObject({ code: 'unauthorized' });
    // the body was changed after it was signed
    const forged = signed(a, asB, 'POST', 'message', '{"to":"x"}');
    await expect(a.docking.handle('message', 'POST', '/dock/message', forged.headers, Buffer.from('{"to":"y"}'))).rejects.toMatchObject({ code: 'unauthorized' });
    // another method on the same path
    const method = signed(a, asB, 'GET', 'roster');
    await expect(a.docking.handle('roster', 'POST', '/dock/roster', method.headers, Buffer.from(''))).rejects.toMatchObject({ code: 'unauthorized' });
    expect(a.delivered).toEqual([]);
  });

  it('refuses a call with a missing or malformed header, or from a station that is not docked', async () => {
    const { a, secret, idB } = await docked();
    const asB = { id: idB, secret };
    const good = signed(a, asB, 'GET', 'roster');
    for (const drop of ['x-gonogo-station', 'x-gonogo-timestamp', 'x-gonogo-nonce', 'x-gonogo-signature']) {
      const headers = { ...good.headers };
      delete headers[drop];
      await expect(a.docking.handle('roster', 'GET', '/dock/roster', headers, Buffer.alloc(0))).rejects.toMatchObject({ code: 'unauthorized', message: 'the call is not signed by a docked station' });
    }
    for (const [name, value] of [['x-gonogo-timestamp', 'yesterday'], ['x-gonogo-nonce', 'zz'], ['x-gonogo-signature', 'abc'], ['x-gonogo-station', 'f'.repeat(32)], ['x-gonogo-station', ['a', 'b']]] as const) {
      await expect(a.docking.handle('roster', 'GET', '/dock/roster', { ...good.headers, [name]: value as string }, Buffer.alloc(0))).rejects.toMatchObject({ code: 'unauthorized' });
    }
    await expect(a.docking.handle('roster', 'GET', '/dock/roster', {}, Buffer.alloc(0))).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('refuses a timestamp more than 5 minutes old, or as far ahead, and accepts one just inside', async () => {
    const { a, w, secret, idB } = await docked();
    const asB = { id: idB, secret };
    w.clock.now = T0 + 10 * 60_000;
    await expect(signed(a, asB, 'GET', 'roster', '', { timestamp: T0 }, w.clock.now).run()).rejects.toMatchObject({ code: 'unauthorized', message: expect.stringContaining('more than 5 minutes') });
    await expect(signed(a, asB, 'GET', 'roster', '', { timestamp: w.clock.now - DOCK_SKEW_MS - 1 }, w.clock.now).run()).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(signed(a, asB, 'GET', 'roster', '', { timestamp: w.clock.now + DOCK_SKEW_MS + 1 }, w.clock.now).run()).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(signed(a, asB, 'GET', 'roster', '', { timestamp: w.clock.now - DOCK_SKEW_MS }, w.clock.now).run()).resolves.toBeDefined();
    await expect(signed(a, asB, 'GET', 'roster', '', { timestamp: w.clock.now + DOCK_SKEW_MS }, w.clock.now).run()).resolves.toBeDefined();
  });

  it('refuses a call it has seen: the same bytes again, and the same nonce with another body', async () => {
    const { a, secret, idB } = await docked();
    const asB = { id: idB, secret };
    const first = signed(a, asB, 'POST', 'message', JSON.stringify({ from: 'ana', to: 'x', subject: '', body: 'hi', hops: 1 }), { nonce: 'ab'.repeat(8) });
    await expect(first.run()).resolves.toMatchObject({ ok: true });
    await expect(first.run()).rejects.toMatchObject({ code: 'unauthorized', message: 'this call was made before' });
    const other = signed(a, asB, 'POST', 'message', JSON.stringify({ from: 'ana', to: 'x', subject: '', body: 'another', hops: 1 }), { nonce: 'ab'.repeat(8) });
    await expect(other.run()).rejects.toMatchObject({ message: 'this call was made before' });
    expect(a.delivered).toHaveLength(1);
  });

  it('forgets a nonce once its timestamp is too old to be accepted anyway', async () => {
    const { a, w, secret, idB } = await docked();
    const asB = { id: idB, secret };
    const call = signed(a, asB, 'GET', 'roster', '', { nonce: 'cd'.repeat(8) });
    await call.run();
    w.clock.now += DOCK_SKEW_MS + 1;
    // the old call is refused for its age now, and the memory of its nonce is gone
    await expect(call.run()).rejects.toMatchObject({ message: expect.stringContaining('more than 5 minutes') });
    const fresh = signed(a, asB, 'GET', 'roster', '', { nonce: 'cd'.repeat(8) }, w.clock.now);
    await expect(fresh.run()).resolves.toBeDefined();
  });

  it('allows 60 calls a minute to a dock, then answers rate_limited until the minute has passed', async () => {
    const { a, w, secret, idB } = await docked();
    const asB = { id: idB, secret };
    // the pull that followed the pairing was a call to this station: let it finish, and let its minute pass
    await new Promise((resolve) => setImmediate(resolve));
    w.clock.now += DOCK_RATE_WINDOW_MS;
    for (let i = 0; i < DOCK_RATE_MAX; i += 1) await signed(a, asB, 'GET', 'roster', '', {}, w.clock.now).run();
    await expect(signed(a, asB, 'GET', 'roster', '', {}, w.clock.now).run()).rejects.toMatchObject({ code: 'rate_limited' });
    w.clock.now += DOCK_RATE_WINDOW_MS;
    await expect(signed(a, asB, 'GET', 'roster', '', {}, w.clock.now).run()).resolves.toBeDefined();
  });

  it('a refused call is not counted against the limit', async () => {
    const { a, w, secret, idB } = await docked();
    const asB = { id: idB, secret };
    for (let i = 0; i < DOCK_RATE_MAX + 5; i += 1) await expect(signed(a, asB, 'GET', 'roster', '', { secret: 'cd'.repeat(32) }, w.clock.now).run()).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(signed(a, asB, 'GET', 'roster', '', {}, w.clock.now).run()).resolves.toBeDefined();
  });

  it('a message goes to the other hub as from this station, and the answer says what the hub did with it', async () => {
    const { a, b } = await docked();
    const message: StationMessage = { from: 'ana', to: 'bob', subject: 'hello', body: 'from alpha', hops: 2 };
    await expect(a.docking.send('beta', message)).resolves.toEqual({ ok: true, note: 'accepted by beta: queued, waiting: about to type the pointer' });
    // the station that received it keeps the fact, not the words
    expect(b.triggers).toEqual([{ kind: 'docking', source: expect.any(String) as string, name: 'alpha', outcome: 'delivered', what: 'from alpha: a message' }]);
    expect(b.delivered).toEqual([{ station: 'alpha', message }]);
    // and back
    await expect(b.docking.send('alpha', { ...message, from: 'bob', to: 'ana', body: 'from beta' })).resolves.toMatchObject({ ok: true });
    expect(a.delivered.map((d) => [d.station, d.message.from, d.message.body])).toEqual([['beta', 'bob', 'from beta']]);
  });

  it('a message the other hub refuses, or marks undelivered, comes back with its reason; an unknown or unreachable station too', async () => {
    const { a, b } = await docked();
    const message: StationMessage = { from: 'ana', to: 'bob', subject: '', body: 'hi', hops: 1 };
    b.hub.deliver = () => {
      throw hubError('not_found', 'unknown recipient "bob". Known: flight, bea, boss, user', 'to');
    };
    await expect(a.docking.send('beta', message)).resolves.toEqual({ ok: false, note: 'beta refused: unknown recipient "bob". Known: flight, bea, boss, user' });
    b.hub.deliver = () => ({ ok: false, id: 'm1', to: 'bob', status: 'undelivered', note: 'bob is stopped; the message went to the user' });
    await expect(a.docking.send('beta', message)).resolves.toEqual({ ok: false, note: 'beta did not deliver it: undelivered, bob is stopped; the message went to the user' });
    await expect(a.docking.send('nowhere', message)).resolves.toEqual({ ok: false, note: 'nowhere is not docked' });
    b.down = true;
    await expect(a.docking.send('beta', message)).resolves.toEqual({ ok: false, note: 'could not reach beta: ECONNREFUSED' });
  });

  it('gives up on a station that does not answer, with the time in the reason, and never follows a redirect', async () => {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const b = await w.make('beta', 'http://b.test');
    await pair(a, b);
    const seen: Array<{ redirect?: string; signal: boolean }> = [];
    // what AbortSignal.timeout() rejects with when its time is up
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const slow = createDocking({
      dir: a.dir,
      name: 'alpha',
      now: () => w.clock.now,
      fetch: (_url, init) => {
        seen.push({ redirect: init?.redirect, signal: init?.signal instanceof AbortSignal });
        return Promise.reject(timeout);
      },
      deliver: () => ({ ok: true, id: 'm1', to: 'x', status: 'queued', note: null }),
      roster: () => [],
      tasks: { list: () => [], create: async () => task('t1'), handOff: async () => task('t1') },
      emit: () => undefined,
      log: nullLogger,
    });
    await slow.load();
    await expect(slow.send('beta', { from: 'ana', to: 'bob', subject: '', body: 'hi', hops: 1 })).resolves.toEqual({ ok: false, note: 'could not reach beta: no answer within 10 s' });
    expect(seen).toEqual([{ redirect: 'error', signal: true }]);
  });

  it('an answer that is not JSON, or a refusal of 401 from the other side, is an error and never a 401 of ours', async () => {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const b = await w.make('beta', 'http://b.test');
    await pair(a, b);
    b.docking.handle = async () => {
      throw hubError('unauthorized', 'the call is not signed by a docked station');
    };
    const result = await a.docking.send('beta', { from: 'ana', to: 'bob', subject: '', body: 'hi', hops: 1 });
    expect(result).toEqual({ ok: false, note: 'beta refused: the call is not signed by a docked station' });
  });
});

describe('the roster', () => {
  it('is pulled after the pairing, on both sides, cut to the role limit, and shown with the time it was seen', async () => {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const b = await w.make('beta', 'http://b.test');
    await pair(a, b);
    // the pulls that follow a pairing run in the background
    await a.docking.pull();
    await b.docking.pull();
    const seenByA = a.docking.view();
    expect(seenByA.station).toBe('alpha');
    expect(seenByA.docks).toMatchObject([{ name: 'beta', url: 'http://b.test', status: 'ok', seenAt: T0, error: null }]);
    expect(seenByA.docks[0]?.agents).toEqual([{ name: 'beta-ana', role: 'x'.repeat(300), state: 'idle', boss: true }]);
    expect(b.docking.view().docks[0]?.agents).toMatchObject([{ name: 'alpha-ana' }]);
    expect(seenByA.docks[0]).not.toHaveProperty('secret');
    expect(JSON.stringify(seenByA)).not.toContain(readFileSync(join(a.dir, 'docking.json'), 'utf8').match(/"secret": "([0-9a-f]+)"/)?.[1] ?? 'no secret');
  });

  it('lists the agents of a station that answers, for list_roster, and none of one that does not', async () => {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const b = await w.make('beta', 'http://b.test');
    await pair(a, b);
    await a.docking.pull();
    expect(a.docking.rosters()).toEqual([{ station: 'beta', agents: [{ name: 'beta-ana', role: 'x'.repeat(300), state: 'idle', boss: true }] }]);
    b.down = true;
    await a.docking.pull();
    expect(a.docking.rosters()).toEqual([]);
    expect(a.docking.view().docks[0]).toMatchObject({ status: 'down', error: 'could not reach beta: ECONNREFUSED' });
    // what was known stays on the page, dimmed, until it answers again
    expect(a.docking.view().docks[0]?.agents).toHaveLength(1);
    b.down = false;
    b.agents = [];
    await a.docking.pull();
    expect(a.docking.view().docks[0]).toMatchObject({ status: 'ok', error: null, agents: [] });
  });

  it('keeps only agents it can read, at most one room of them', async () => {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const b = await w.make('beta', 'http://b.test');
    await pair(a, b);
    b.agents = [
      { name: 'ok', role: 'r', state: 'working', boss: false },
      { name: 'Bad Name', role: 'r', state: 'idle', boss: false },
      { name: 'odd', role: 5 as unknown as string, state: 'nonsense' as never, boss: 'yes' as never },
      7 as never,
      ...Array.from({ length: 40 }, (_unused, i) => ({ name: `a${i}`, role: '', state: 'idle' as const, boss: false })),
    ];
    await a.docking.pull();
    const agents = a.docking.view().docks[0]?.agents ?? [];
    expect(agents).toHaveLength(24);
    expect(agents.slice(0, 2)).toEqual([
      { name: 'ok', role: 'r', state: 'working', boss: false },
      { name: 'odd', role: '', state: 'stopped', boss: false },
    ]);
  });

  it('is refused when the station at the address is not the one that was docked', async () => {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const b = await w.make('beta', 'http://b.test');
    const stranger = await w.make('gamma', 'http://c.test');
    await pair(a, b);
    // the address of beta now answers with another station's roster
    b.docking.handle = async (route, method, url, headers, body) => {
      if (route === 'roster') return { station: { id: 'f'.repeat(32), name: 'gamma' }, agents: [] };
      return stranger.docking.handle(route, method, url, headers, body);
    };
    await a.docking.pull();
    expect(a.docking.view().docks[0]).toMatchObject({ status: 'down', error: 'the station at this address is not the one that was docked' });
  });

  it('follows a station that renames itself, unless the name is taken', async () => {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const b = await w.make('beta', 'http://b.test');
    await pair(a, b);
    const id = a.docking.view().docks[0]?.id ?? '';
    const answer = (name: string) => {
      b.docking.handle = async () => ({ station: { id, name }, agents: [] });
    };
    answer('alpha');
    await a.docking.pull();
    expect(a.docking.stations()).toEqual(['beta']);
    answer('Not A Name');
    await a.docking.pull();
    expect(a.docking.stations()).toEqual(['beta']);
    answer('delta');
    await a.docking.pull();
    expect(a.docking.stations()).toEqual(['delta']);
    await a.docking.close();
    expect(JSON.parse(readFileSync(join(a.dir, 'docking.json'), 'utf8')).docks[0].name).toBe('delta');
  });

  it('is pulled once at the start and every 30 seconds after, until close', async () => {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const b = await w.make('beta', 'http://b.test');
    await pair(a, b);
    let tick: () => void = () => undefined;
    let stopped = false;
    let every = 0;
    const pulls: string[] = [];
    const again = createDocking({
      dir: a.dir,
      name: 'alpha',
      now: () => w.clock.now,
      fetch: async (input, init) => {
        pulls.push(`${init?.method} ${new URL(String(input)).pathname}`);
        return Response.json({ station: { id: 'x', name: 'beta' }, agents: [] });
      },
      deliver: () => ({ ok: true, id: 'm1', to: 'x', status: 'queued', note: null }),
      roster: () => [],
      tasks: { list: () => [], create: async () => task('t1'), handOff: async () => task('t1') },
      emit: () => undefined,
      every: (fn, ms) => {
        every = ms;
        tick = fn;
        return () => {
          stopped = true;
        };
      },
      log: nullLogger,
    });
    await again.load();
    again.start();
    await new Promise((resolve) => setImmediate(resolve));
    expect(every).toBe(DOCK_PULL_MS);
    expect(pulls).toEqual(['GET /dock/roster']);
    tick();
    await new Promise((resolve) => setImmediate(resolve));
    expect(pulls).toHaveLength(2);
    await again.close();
    expect(stopped).toBe(true);
  });

  it('tells the browsers only when something they show has changed', async () => {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const b = await w.make('beta', 'http://b.test');
    await pair(a, b);
    await a.docking.pull();
    const count = a.views.length;
    w.clock.now += 1000;
    // seenAt moved: that is a change the page shows; the same answer again, at the same time, is not
    await a.docking.pull();
    expect(a.views.length).toBe(count + 1);
    await a.docking.pull();
    expect(a.views.length).toBe(count + 1);
    expect(a.views.at(-1)?.docks[0]?.seenAt).toBe(T0 + 1000);
  });
});

describe('undock', () => {
  it('removes the dock on both sides, and what the other side signs afterwards is refused', async () => {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const b = await w.make('beta', 'http://b.test');
    const { aSees } = await pair(a, b);
    const secretBefore = (JSON.parse(readFileSync(join(a.dir, 'docking.json'), 'utf8')) as { docks: Array<{ secret: string }> }).docks[0]?.secret;
    await expect(a.docking.undock(aSees)).resolves.toEqual({ told: true });
    expect(a.docking.view().docks).toEqual([]);
    expect(b.docking.view().docks).toEqual([]);
    expect(JSON.parse(readFileSync(join(a.dir, 'docking.json'), 'utf8')).docks).toEqual([]);
    expect(JSON.parse(readFileSync(join(b.dir, 'docking.json'), 'utf8')).docks).toEqual([]);
    expect(secretBefore).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(a.dir, 'docking.json'), 'utf8')).not.toContain(secretBefore ?? 'x');
    expect(readFileSync(join(b.dir, 'docking.json'), 'utf8')).not.toContain(secretBefore ?? 'x');
    expect(a.views.at(-1)?.docks).toEqual([]);
    expect(b.views.at(-1)?.docks).toEqual([]);
    await expect(a.docking.send('beta', { from: 'ana', to: 'bob', subject: '', body: 'hi', hops: 1 })).resolves.toEqual({ ok: false, note: 'beta is not docked' });
    expect(b.delivered).toEqual([]);
    await expect(a.docking.undock(aSees)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('removes it here when the other side cannot be reached, and says so', async () => {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const b = await w.make('beta', 'http://b.test');
    const { aSees } = await pair(a, b);
    b.down = true;
    await expect(a.docking.undock(aSees)).resolves.toEqual({ told: false });
    expect(a.docking.view().docks).toEqual([]);
    expect(b.docking.view().docks).toHaveLength(1);
    // the station that was not told is refused by the one that undocked
    b.down = false;
    await b.docking.pull();
    expect(b.docking.view().docks[0]).toMatchObject({ status: 'down', error: expect.stringContaining('alpha refused') });
    const result = await b.docking.send('alpha', { from: 'bob', to: 'ana', subject: '', body: 'hi', hops: 1 });
    expect(result.ok).toBe(false);
    expect(a.delivered).toEqual([]);
  });

  it('can dock again after an undock, with a new secret', async () => {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const b = await w.make('beta', 'http://b.test');
    const { aSees } = await pair(a, b);
    const first = (JSON.parse(readFileSync(join(a.dir, 'docking.json'), 'utf8')) as { docks: Array<{ secret: string }> }).docks[0]?.secret;
    await a.docking.undock(aSees);
    await pair(a, b);
    const second = (JSON.parse(readFileSync(join(a.dir, 'docking.json'), 'utf8')) as { docks: Array<{ secret: string }> }).docks[0]?.secret;
    expect(second).toMatch(/^[0-9a-f]{64}$/);
    expect(second).not.toBe(first);
  });
});

describe('handing off a task', () => {
  async function ready(): Promise<{ a: Station; b: Station; dock: string }> {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const b = await w.make('beta', 'http://b.test');
    const { aSees } = await pair(a, b);
    a.tasks = [task('t1', { detail: 'Fix the build.' }), task('t2', { status: 'done' }), task('t3', { handedOff: 'beta' })];
    return { a, b, dock: aSees };
  }

  it('copies it to the other board, assigned there, and marks it handed off here', async () => {
    const { a, b, dock } = await ready();
    const done = await a.docking.handOff(dock, { task: 't1', assignee: 'bob' });
    expect(b.created).toEqual([
      { actor: { kind: 'dock', station: 'alpha' }, input: { title: 'Task t1', detail: 'Handed off from alpha (its task t1).\n\nFix the build.', assignee: 'bob' } },
    ]);
    expect(a.handedOff).toEqual([{ id: 't1', station: 'beta', assignee: 'bob' }]);
    expect(done).toMatchObject({ id: 't1', status: 'done', handedOff: 'beta' });
  });

  it('two hand-offs of one task at once copy it once', async () => {
    const { a, b, dock } = await ready();
    const [first, second] = await Promise.allSettled([a.docking.handOff(dock, { task: 't1' }), a.docking.handOff(dock, { task: 't1' })]);
    expect(first.status).toBe('fulfilled');
    expect(second).toMatchObject({ status: 'rejected', reason: { code: 'conflict', field: 'task' } });
    expect(b.created).toHaveLength(1);
  });

  it('without an agent, the task lands unassigned', async () => {
    const { a, b, dock } = await ready();
    await a.docking.handOff(dock, { task: 't1' });
    expect(b.created[0]?.input).not.toHaveProperty('assignee');
    expect(a.handedOff).toEqual([{ id: 't1', station: 'beta', assignee: null }]);
  });

  it('cuts a detail that would not fit once the line that says where it came from is added', async () => {
    const { a, b, dock } = await ready();
    a.tasks = [task('t1', { detail: 'y'.repeat(4000) })];
    await a.docking.handOff(dock, { task: 't1' });
    expect(String(b.created[0]?.input.detail)).toHaveLength(4000);
    expect(String(b.created[0]?.input.detail).startsWith('Handed off from alpha (its task t1).\n\nyyy')).toBe(true);
  });

  it('a hand-off is in the history of triggers: delivered here, and received there; a refused one says why', async () => {
    const { a, b, dock } = await ready();
    await a.docking.handOff(dock, { task: 't1', assignee: 'bob' });
    expect(a.triggers).toEqual([{ kind: 'docking', source: dock, name: 'beta', outcome: 'delivered', what: 'hand-off of t1: Task t1', agent: 'bob' }]);
    expect(b.triggers).toEqual([{ kind: 'docking', source: expect.any(String) as string, name: 'alpha', outcome: 'delivered', what: 'from alpha: a task handed off to this station' }]);
    a.tasks.push(task('t4'));
    await expect(a.docking.handOff(dock, { task: 't4', assignee: 'nobody' })).rejects.toThrow();
    expect(a.triggers.at(-1)).toMatchObject({ kind: 'docking', name: 'beta', outcome: 'failed', what: 'hand-off of t4: Task t4' });
    expect(String(a.triggers.at(-1)?.note)).not.toBe('');
    // the payload (the detail) is not in the entries
    expect(JSON.stringify([...a.triggers, ...b.triggers])).not.toContain('Fix the build');
  });

  it('refuses a task that is not open here', async () => {
    const { a, b, dock } = await ready();
    await expect(a.docking.handOff(dock, { task: 't7' })).rejects.toMatchObject({ code: 'not_found', field: 'task' });
    await expect(a.docking.handOff(dock, { task: 't2' })).rejects.toMatchObject({ code: 'conflict', field: 'task' });
    await expect(a.docking.handOff(dock, { task: 't3' })).rejects.toMatchObject({ code: 'conflict', field: 'task' });
    await expect(a.docking.handOff('f'.repeat(32), { task: 't1' })).rejects.toMatchObject({ code: 'not_found', message: 'unknown dock' });
    await expect(a.docking.handOff(dock, { task: 't1', assignee: 'Bob' })).rejects.toMatchObject({ code: 'bad_request', field: 'assignee' });
    await expect(a.docking.handOff(dock, { task: 't1', assignee: 5 })).rejects.toMatchObject({ code: 'bad_request', field: 'assignee' });
    await expect(a.docking.handOff(dock, { task: 't1', title: 'x' })).rejects.toMatchObject({ code: 'bad_request', field: 'title', message: 'unknown field "title"' });
    await expect(a.docking.handOff(dock, [] as never)).rejects.toMatchObject({ code: 'bad_request' });
    expect(b.created).toEqual([]);
    expect(a.handedOff).toEqual([]);
  });

  it('a board that refuses it leaves the task as it was, and the reason reaches the Director', async () => {
    const { a, b, dock } = await ready();
    await expect(a.docking.handOff(dock, { task: 't1', assignee: 'nobody' })).rejects.toMatchObject({ code: 'bad_request', field: 'assignee', message: 'beta: assignee must be the name of an agent in the room, or null' });
    expect(a.handedOff).toEqual([]);
    b.down = true;
    await expect(a.docking.handOff(dock, { task: 't1' })).rejects.toMatchObject({ code: 'unavailable', message: 'could not reach beta: ECONNREFUSED' });
    expect(a.handedOff).toEqual([]);
  });

  it('a task that comes in with a title that is not text is refused by the board, which says why', async () => {
    const { a, b, secret } = await (async () => {
      const r = await ready();
      return { ...r, secret: (JSON.parse(readFileSync(join(r.a.dir, 'docking.json'), 'utf8')) as { docks: Array<{ secret: string }> }).docks[0]?.secret ?? '' };
    })();
    const idA = (JSON.parse(readFileSync(join(a.dir, 'station.json'), 'utf8')) as { id: string }).id;
    const idB = (JSON.parse(readFileSync(join(b.dir, 'station.json'), 'utf8')) as { id: string }).id;
    const body = JSON.stringify({ id: 't1', title: 5 });
    const nonce = 'ef'.repeat(8);
    const headers: IncomingHttpHeaders = { 'x-gonogo-station': idA, 'x-gonogo-timestamp': String(T0), 'x-gonogo-nonce': nonce, 'x-gonogo-signature': signCall(secret, idA, 'POST', '/dock/task', String(T0), nonce, body) };
    await expect(b.docking.handle('task', 'POST', '/dock/task', headers, Buffer.from(body))).rejects.toMatchObject({ code: 'bad_request', field: 'title' });
    expect(idB).not.toBe(idA);
  });
});
