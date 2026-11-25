// Docking (docs/docking-spec.md): the module against a second copy of itself. The two stations talk through a fake fetch that
// hands each call to the other's `handle`, so the signatures, the replay and expiry rules and the pairing run for real while
// nothing needs a socket. The same two stations over real HTTP are scenario 30 of e2e.test.ts.
import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DOCK_ROUTES, createDocking, lanAddresses, publicUrl, signCall, stationName } from '../src/server/docking.js';
import { readDeliverable, readDeliverables, readOffer } from '../src/server/links.js';
import type { Docking } from '../src/server/docking.js';
import { DOCK_CODE_TTL_MS, DOCK_PULL_MS, DOCK_RATE_MAX, DOCK_RATE_WINDOW_MS, DOCK_SKEW_MS, nullLogger } from '../src/server/constants.js';
import { hubErrorInfo } from '../src/server/hooks.js';
import { HubError } from '../src/server/hub.js';
import type { ApiErrorCode } from '../src/shared/protocol.js';
import type { DockedAgent, DockingView, SendResult, StationMessage, Task } from '../src/shared/protocol.js';

const T0 = 1_700_000_000_000;
const STATUS: Record<string, number> = { bad_request: 400, unauthorized: 401, not_found: 404, conflict: 409, too_large: 413, rate_limited: 429, unavailable: 503, internal: 500 };

/** Every docking this file made: stopped, and its background writes (outbox, trail, rules) awaited, before the folders go (a write that lands after the rm is ENOTEMPTY). */
const running: Docking[] = [];
const cleanups: Array<() => void> = [];
afterEach(async () => {
  for (const docking of running.splice(0)) await docking.close().catch(() => undefined);
  // writes that a close started a moment ago
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
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
  attached: Array<{ id: string; link?: string; outgoing?: string; note: string }>;
  /** What the links did to the tasks of this station, and what the Director and the boss were told. */
  systemed: Array<{ id: string; status?: string; note: string; returned?: boolean }>;
  told: string[];
  bossTold: Array<{ station: string; subject: string; body: string }>;
  /** What the station's Propellant was told: link caps, what a task has spent, and the room budget. */
  /** The Mission Log and the claims this station would answer from (S5). */
  logEntries: Array<{ id: string; title: string; snippet: string; date: string }>;
  claimList: Array<{ key: string; statement: string; date: string }>;
  missionList: Array<{ id: string; name: string; goal: string; status: string }>;
  linkBudgets: Record<string, number | null>;
  spent: Record<string, number>;
  roomCap?: number;
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
  return new HubError(code as ApiErrorCode, message, field);
}

function world(): World {
  const clock = { now: T0 };
  const stations = new Map<string, Station>();
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    // a station may live in a room of its machine: its address is origin + /r/<room>, and the room sees the path without it (the front port strips it)
    const room = /^(\/r\/[a-z][a-z0-9-]*)(\/dock\/.*)$/.exec(url.pathname);
    if (room !== null) url.pathname = room[2] ?? '';
    const target = stations.get(room === null ? url.origin : url.origin + room[1]);
    if (!target || target.down) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const headers: IncomingHttpHeaders = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[key.toLowerCase()] = value;
    // what the proxy writes for a call: the address it was reached at
    headers['x-gonogo-reached'] = url.host + (room === null ? '' : room[1]);
    try {
      const data = await target.docking.handle(url.pathname.split('/').slice(2).join('/'), init?.method ?? 'GET', url.pathname + url.search, headers, Buffer.from(String(init?.body ?? '')));
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
        attached: [],
        systemed: [],
        told: [],
        bossTold: [],
        logEntries: [],
        claimList: [],
        missionList: [],
        linkBudgets: {},
        spent: {},
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
            const made: Task = { id: `t${8 + station.created.length}`, title, detail: String((input as { detail?: unknown }).detail ?? ''), status: 'todo', assignee: null, createdBy: 'user', createdAt: clock.now, updatedAt: clock.now, notes: [] };
            station.tasks.push(made);
            return made;
          },
          system: async (id, change) => {
            station.systemed.push({ id, ...change });
            const found = station.tasks.find((t) => t.id === id)!;
            const next = { ...found, ...(change.status === undefined ? {} : { status: change.status as Task['status'] }), ...(change.returned === true ? { returned: true } : {}), notes: [...found.notes, `docking: ${change.note}`] };
            station.tasks[station.tasks.indexOf(found)] = next;
            return next;
          },
          attach: async (id, binding) => {
            station.attached.push({ id, ...binding });
            const found = station.tasks.find((t) => t.id === id)!;
            const next = { ...found, ...(binding.link === undefined ? {} : { link: binding.link }), ...(binding.outgoing === undefined ? {} : { links: [...(found.links ?? []), binding.outgoing] }) };
            station.tasks[station.tasks.indexOf(found)] = next;
            return next;
          },
          handOff: async (id, to, assignee) => {
            station.handedOff.push({ id, station: to, assignee });
            return { ...station.tasks.find((t) => t.id === id)!, status: 'done', handedOff: to };
          },
        },
        emit: (view) => station.views.push(view),
        notify: (text) => void station.told.push(text),
        tellBoss: (st, subject, body) => void station.bossTold.push({ station: st, subject, body }),
        knowledge: { entries: (query) => station.logEntries.filter((e) => `${e.title} ${e.snippet}`.toLowerCase().includes(query.toLowerCase().split(' ')[0] ?? '')), claims: async () => station.claimList },
        missions: {
          list: () => station.missionList as never,
          create: async (_actor, input) => {
            const made = { id: `ms${station.missionList.length + 1}`, name: String((input as { name: string }).name), goal: String((input as { goal: string }).goal), status: 'planned' };
            station.missionList.push(made);
            return made as never;
          },
        },
        setLinkBudget: (linkId, usd) => void (station.linkBudgets[linkId] = usd),
        spentOnTask: (taskId) => station.spent[taskId],
        roomBudgetCap: () => station.roomCap,
        log: nullLogger,
      });
      await station.docking.load();
      stations.set(origin, station);
      running.push(station.docking);
      return station;
    },
  };
}

/** A write that docking.ts makes in the background (a fire-and-forget save) lands when the disk says so, not after a fixed number of ticks: the check is tried again until it holds (3 s at most). */
const eventually = async (check: () => void, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  for (;;) {
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() > end) throw error;
      await new Promise((r) => setTimeout(r, 10));
    }
  }
};

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
    expect(DOCK_ROUTES).toEqual({ pair: 'POST', roster: 'GET', message: 'POST', task: 'POST', link: 'POST', knowledge: 'POST', undock: 'POST' });
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
      expect(() => a.docking.createCode({ url })).toThrow(/web address such as/);
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
    expect(await refused(hand('ftp://x/'))).toMatch(/web address such as/);
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
      tasks: { list: () => [], create: async () => ({}) as Task, handOff: async () => ({}) as Task, attach: async () => ({}) as Task, system: async () => ({}) as Task },
      emit: () => undefined,
      log: nullLogger,
    });
    cleanups.push(() => undefined);
    await docking.load();
    await expect(docking.pair({ code: hand('http://192.168.86.173:7777'), url: 'http://192.168.86.2:7777' })).rejects.toMatchObject({
      message: expect.stringMatching(/does not accept the address 192\.168\.86\.173: on that station start gonogo with --allow-host 192\.168\.86\.173 \(or set GONOGO_ALLOWED_HOSTS=192\.168\.86\.173\)/) as string,
    });
  });

  it('the hints carry the network addresses of this computer for the Address box, and the view never does', async () => {
    const docking = createDocking({
      dir: mkdtempSync(join(tmpdir(), 'gonogo-dock-')),
      name: 'alpha',
      now: () => 1,
      fetch: async () => new Response('{}'),
      deliver: () => ({ ok: true, id: 'm1', to: 'x', status: 'queued', note: null }),
      roster: () => [],
      addresses: () => ['192.168.0.5'],
      tasks: { list: () => [], create: async () => ({}) as Task, handOff: async () => ({}) as Task, attach: async () => ({}) as Task, system: async () => ({}) as Task },
      emit: () => undefined,
      log: nullLogger,
    });
    expect(docking.hints()).toEqual({ addresses: ['192.168.0.5'], container: false });
    expect(JSON.stringify(docking.view())).not.toContain('192.168.0.5');
  });

  it('lanAddresses: no bridge, virtual or link-local interface, 192.168 before 10 before the rest and 172.16/12 last, and none at all in a container', () => {
    const net = (address: string, internal = false, family: string | number = 'IPv4') => ({ family, address, internal });
    const nets = {
      lo: [net('127.0.0.1', true)],
      eth0: [net('172.22.0.2'), net('fe80::1', false, 'IPv6')],
      docker0: [net('172.17.0.1')],
      'br-1a2b3c': [net('172.18.0.1')],
      veth9: [net('10.9.9.9')],
      virbr0: [net('192.168.122.1')],
      wlan0: [net('192.168.1.20'), net('169.254.3.4')],
      enp3: [net('10.0.0.7'), net('203.0.113.9'), net('192.168.1.20')],
    };
    expect(lanAddresses(nets, false)).toEqual(['192.168.1.20', '10.0.0.7', '203.0.113.9', '172.22.0.2']);
    expect(lanAddresses(nets, true)).toEqual([]);
    expect(lanAddresses({ docker0: [net('172.17.0.1')], lo: [net('127.0.0.1', true)] }, false)).toEqual([]);
    expect(lanAddresses({ eth0: [net('192.168.0.5', false, 4)] }, false)).toEqual(['192.168.0.5']);
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
      tasks: { list: () => [], create: async () => task('t1'), handOff: async () => task('t1'), attach: async () => task('t1'), system: async () => task('t1') },
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
    expect(result).toEqual({ ok: false, note: 'beta does not know this station at this address: the dock may be in another room there (/r/<room>) or was removed; change the address or pair again' });
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
      tasks: { list: () => [], create: async () => task('t1'), handOff: async () => task('t1'), attach: async () => task('t1'), system: async () => task('t1') },
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

describe('a dock in another room of a station, and its address', () => {
  it('an address is an origin, or an origin with /r/<room>; nothing else in the path', () => {
    expect(publicUrl('https://g.example.com', 'url')).toBe('https://g.example.com');
    expect(publicUrl(' http://192.168.86.173:7777/ ', 'url')).toBe('http://192.168.86.173:7777');
    expect(publicUrl('http://192.168.86.173:7777/r/umbral', 'url')).toBe('http://192.168.86.173:7777/r/umbral');
    expect(publicUrl('http://h:7777/r/umbral/', 'url')).toBe('http://h:7777/r/umbral');
    for (const bad of ['http://h/r/Umbral', 'http://h/r/', 'http://h/r', 'http://h/x', 'http://h/r/a/b', 'http://h/r/a/dock', 'http://h/r/1a', 'http://h/r/a?x=1', 'http://h/r/a#f', 'http://u:p@h/r/a', 'ftp://h/r/a', 'http://h/r/a%2fb', 'nope']) expect(() => publicUrl(bad, 'url'), bad).toThrow(/web address/);
  });

  it('two stations pair, call and answer through /r/<room> addresses: the calls are signed over /dock/<route> and the room is reached', async () => {
    const w = world();
    const a = await w.make('alpha', 'http://a.test/r/umbral');
    const b = await w.make('beta', 'http://b.test/r/main');
    await pair(a, b);
    expect(a.docking.view().docks[0]).toMatchObject({ name: 'beta', url: 'http://b.test/r/main', status: 'ok' });
    expect(b.docking.view().docks[0]).toMatchObject({ name: 'alpha', url: 'http://a.test/r/umbral', status: 'ok' });
    await expect(a.docking.send('beta', { from: 'ana', to: 'bob', subject: '', body: 'hi', hops: 1 })).resolves.toMatchObject({ ok: true });
    expect(b.delivered).toHaveLength(1);
  });

  it('change address: the dock stays (id, name, secret), the next call goes to the new address, and a wrong one says what to do', async () => {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    // beta lives in the room "umbral" of its machine, and a main room of that machine knows nothing of alpha
    const b = await w.make('beta', 'http://b.test/r/umbral');
    await w.make('beta-main', 'http://b.test', {});
    const { aSees } = await pair(a, b);
    const before = JSON.parse(readFileSync(join(a.dir, 'docking.json'), 'utf8')) as { docks: Array<{ id: string; name: string; secret: string; url: string }> };
    // docked at the machine's origin by mistake: the room at that address does not know this station
    const dockA = a.docking.view().docks[0]!;
    expect(dockA.url).toBe('http://b.test/r/umbral');
    const moved = await a.docking.setAddress(aSees, { url: 'http://b.test' });
    expect(moved).toMatchObject({ id: aSees, name: 'beta', url: 'http://b.test', status: 'down' });
    expect(moved.error).toContain('does not know this station at this address: the dock may be in another room there (/r/<room>) or was removed; change the address or pair again');
    const fixed = await a.docking.setAddress(aSees, { url: 'http://b.test/r/umbral/' });
    expect(fixed).toMatchObject({ id: aSees, name: 'beta', url: 'http://b.test/r/umbral', status: 'ok', error: null });
    const after = JSON.parse(readFileSync(join(a.dir, 'docking.json'), 'utf8')) as typeof before;
    expect(after.docks[0]).toMatchObject({ id: before.docks[0]?.id, name: 'beta', secret: before.docks[0]?.secret, url: 'http://b.test/r/umbral' });
    expect(a.views.at(-1)?.docks[0]?.url).toBe('http://b.test/r/umbral');
    await expect(a.docking.send('beta', { from: 'ana', to: 'bob', subject: '', body: 'hi', hops: 1 })).resolves.toMatchObject({ ok: true });
  });

  it('a changed address is not believed until the station there proves it holds the secret: a real peer does at once, nothing is cleared before', async () => {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const b = await w.make('beta', 'http://b.test/r/umbral');
    const { aSees } = await pair(a, b);
    expect(a.docking.view().docks[0]?.unverified).toBeUndefined();
    const same = await a.docking.setAddress(aSees, { url: 'http://b.test/r/umbral' });
    expect(same.unverified).toBeUndefined();
    // the same station at another address (beta also answers at the machine's root alias): its roster answer carries the proof
    w.stations.set('http://b.test', b);
    const moved = await a.docking.setAddress(aSees, { url: 'http://b.test' });
    expect(moved, JSON.stringify(moved)).toMatchObject({ url: 'http://b.test', status: 'ok', error: null });
    expect(moved.unverified).toBeUndefined();
    const file = JSON.parse(readFileSync(join(a.dir, 'docking.json'), 'utf8')) as { docks: Array<Record<string, unknown>> };
    expect(file.docks[0]?.unverified).toBeUndefined();
  });

  it('a host that answers 200 but cannot prove the secret gets the roster call and nothing else: no message, no task, no link event, no undock; it stays unverified after a restart', async () => {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const b = await w.make('beta', 'http://b.test');
    const { aSees, bSees } = await pair(a, b);
    // a typo'd or hostile host: it says it is beta, and cannot sign the nonce
    const imp = await w.make('imp', 'http://imp.test');
    const seen: string[] = [];
    imp.docking.handle = async (route) => {
      seen.push(route);
      if (route === 'roster') return { station: { id: aSees === '' ? 'x' : bSees === '' ? 'y' : a.docking.view().docks[0]!.id, name: 'beta' }, agents: [{ name: 'fake', role: 'x', state: 'idle', boss: false }], proof: 'f'.repeat(64) };
      return { ok: true, acked: {} };
    };
    const moved = await a.docking.setAddress(aSees, { url: 'http://imp.test' });
    expect(moved.unverified).toBe(true);
    expect(moved.status).toBe('down');
    expect(moved.error).toContain('did not prove that it holds this dock');
    // the roster the host made up is not taken
    expect(moved.agents.map((x) => x.name)).not.toContain('fake');
    await a.docking.pull();
    // what would have left goes nowhere
    expect(await a.docking.send('beta', { from: 'ana', to: 'bob', subject: '', body: 'secret text', hops: 1 })).toMatchObject({ ok: false });
    await expect(a.docking.undock(aSees)).resolves.toEqual({ told: false });
    expect(seen.every((route) => route === 'roster')).toBe(true);
    expect(seen).not.toContain('message');
  });

  it('survives a restart as unverified, and the right address then clears it and lets the outbox go', async () => {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const b = await w.make('beta', 'http://b.test');
    const { aSees } = await pair(a, b);
    const imp = await w.make('imp', 'http://imp.test');
    imp.docking.handle = async () => ({ station: { id: aSees, name: 'beta' }, agents: [] });
    expect((await a.docking.setAddress(aSees, { url: 'http://imp.test' })).unverified).toBe(true);
    expect((JSON.parse(readFileSync(join(a.dir, 'docking.json'), 'utf8')) as { docks: Array<{ unverified?: boolean }> }).docks[0]?.unverified).toBe(true);
    const again = await w.make('alpha2', 'http://a2.test', { dir: a.dir });
    expect(again.docking.view().docks[0]?.unverified).toBe(true);
    // the address is put right: the real beta proves itself, the flag goes, and a message passes
    const fixed = await a.docking.setAddress(aSees, { url: 'http://b.test' });
    expect(fixed.unverified).toBeUndefined();
    expect(fixed.status).toBe('ok');
    await expect(a.docking.send('beta', { from: 'ana', to: 'bob', subject: '', body: 'now', hops: 1 })).resolves.toMatchObject({ ok: true });
    expect(b.delivered).toHaveLength(1);
  });

  it('a relay: a host that forwards our signed roster call to the real peer cannot pass on its proof, because the proof names the address the peer was reached at', async () => {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const b = await w.make('beta', 'http://b.test');
    const { aSees } = await pair(a, b);
    const relay = await w.make('relay', 'http://relay.test');
    const forwarded: string[] = [];
    // it forwards every call unchanged to the real beta, which must be reached at its own host (its allow-host), and returns what beta answered
    relay.docking.handle = async (route, method, url, headers, body) => {
      forwarded.push(route);
      return b.docking.handle(route, method, url, { ...headers, 'x-gonogo-reached': 'b.test' }, body);
    };
    const moved = await a.docking.setAddress(aSees, { url: 'http://relay.test' });
    expect(moved.unverified).toBe(true);
    expect(moved.error).toContain('did not prove that it holds this dock');
    expect(forwarded).toEqual(['roster']);
    // asked again, and after a message, it is still held: the relay learns nothing but roster calls
    await a.docking.pull();
    await a.docking.send('beta', { from: 'ana', to: 'bob', subject: '', body: 'secret text', hops: 1 });
    expect(new Set(forwarded)).toEqual(new Set(['roster']));
    // the real address proves itself
    expect((await a.docking.setAddress(aSees, { url: 'http://b.test' })).unverified).toBeUndefined();
  });

  it('the proof binds the room too: the same station reached at its root alias is not /r/<room>', async () => {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const b = await w.make('beta', 'http://b.test/r/umbral');
    const { aSees } = await pair(a, b);
    w.stations.set('http://b.test', b);
    // a calls the root alias but types it with a room that is not there: beta is reached at 'b.test', the caller expects 'b.test/r/umbral'
    const real = b.docking.handle.bind(b.docking);
    b.docking.handle = async (route, method, url, headers, body) => real(route, method, url, { ...headers, 'x-gonogo-reached': 'b.test' }, body);
    expect((await a.docking.setAddress(aSees, { url: 'http://b.test' })).unverified).toBeUndefined();
    const moved = await a.docking.setAddress(aSees, { url: 'http://b.test/r/umbral' });
    expect(moved.unverified).toBe(true);
  });

  it('a peer that is an older gonogo (no proof in its roster) stays unverified with a message that says why', async () => {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const b = await w.make('beta', 'http://b.test');
    const { aSees } = await pair(a, b);
    const real = b.docking.handle.bind(b.docking);
    b.docking.handle = async (route, method, url, headers, body) => {
      const answer = await real(route, method, url, headers, body);
      if (route === 'roster') delete (answer as Record<string, unknown>).proof;
      return answer;
    };
    w.stations.set('http://b2.test', b);
    const moved = await a.docking.setAddress(aSees, { url: 'http://b2.test' });
    expect(moved.unverified).toBe(true);
    expect(moved.error).toContain('an older gonogo cannot');
  });

  it('refuses a bad address, an unknown field and an unknown dock, and changes nothing', async () => {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const b = await w.make('beta', 'http://b.test');
    const { aSees } = await pair(a, b);
    await expect(a.docking.setAddress(aSees, { url: 'http://b.test/x' })).rejects.toMatchObject({ code: 'bad_request', field: 'url' });
    await expect(a.docking.setAddress(aSees, {})).rejects.toMatchObject({ code: 'bad_request', field: 'url' });
    await expect(a.docking.setAddress(aSees, { url: 'http://b.test', secret: 'x' })).rejects.toMatchObject({ code: 'bad_request', field: 'secret' });
    await expect(a.docking.setAddress(aSees, 'http://b.test')).rejects.toMatchObject({ code: 'bad_request' });
    await expect(a.docking.setAddress('0'.repeat(32), { url: 'http://b.test' })).rejects.toMatchObject({ code: 'not_found' });
    expect(a.docking.view().docks[0]).toMatchObject({ url: 'http://b.test', status: 'ok' });
  });

  it('the same address changes nothing and calls nobody', async () => {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const b = await w.make('beta', 'http://b.test');
    const { aSees } = await pair(a, b);
    const seen = a.views.length;
    expect(await a.docking.setAddress(aSees, { url: 'http://b.test/' })).toMatchObject({ url: 'http://b.test', status: 'ok' });
    expect(a.views.length).toBe(seen);
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
    expect(b.docking.view().docks[0]).toMatchObject({ status: 'down', error: expect.stringContaining('alpha does not know this station') });
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

  it('copies it to the other board, assigned there, and binds it to a link here: it stays open', async () => {
    const { a, b, dock } = await ready();
    const done = await a.docking.handOff(dock, { task: 't1', assignee: 'bob' });
    expect(b.created).toEqual([
      { actor: { kind: 'dock', station: 'alpha' }, input: { title: 'Task t1', detail: 'Handed off from alpha (its task t1).\n\nFix the build.', assignee: 'bob' } },
    ]);
    expect(a.attached).toHaveLength(1);
    expect(a.attached[0]).toMatchObject({ id: 't1', note: expect.stringMatching(/^handed off to bob@beta on link dl_[0-9a-f]{16}$/) as string });
    expect(done).toMatchObject({ id: 't1', status: 'todo', links: [expect.stringMatching(/^dl_[0-9a-f]{16}$/) as string] });
    expect(done.handedOff).toBeUndefined();
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
    expect(a.attached[0]?.note).toMatch(/^handed off to beta on link dl_/);
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
    const handoffs = (list: Array<Record<string, unknown>>) => list.filter((e) => !String(e.what).startsWith('link event'));
    expect(handoffs(a.triggers)).toEqual([{ kind: 'docking', source: dock, name: 'beta', outcome: 'delivered', what: 'hand-off of t1: Task t1', agent: 'bob' }]);
    expect(handoffs(b.triggers)).toEqual([{ kind: 'docking', source: expect.any(String) as string, name: 'alpha', outcome: 'delivered', what: 'from alpha: a task handed off to this station' }]);
    a.tasks.push(task('t4'));
    b.down = true;
    await expect(a.docking.handOff(dock, { task: 't4' })).rejects.toThrow();
    b.down = false;
    expect(a.triggers.filter((e) => !String(e.what).startsWith('link event')).at(-1)).toMatchObject({ kind: 'docking', name: 'beta', outcome: 'failed', what: 'hand-off of t4: Task t4' });
    expect(String(a.triggers.filter((e) => !String(e.what).startsWith('link event')).at(-1)?.note)).not.toBe('');
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
    expect(a.attached).toEqual([]);
  });

  it('a station that is down leaves the task as it was, and the reason reaches the Director; a name that is no agent there is only a hint', async () => {
    const { a, b, dock } = await ready();
    b.down = true;
    await expect(a.docking.handOff(dock, { task: 't1' })).rejects.toMatchObject({ code: 'unavailable', message: 'could not reach beta: ECONNREFUSED' });
    expect(a.attached).toEqual([]);
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

/* ------------------------------------------------------------------ Docking 2: the link, its events, the outbox (S1) */

describe('links: the core', () => {
  const stationId = (s: Station): string => (JSON.parse(readFileSync(join(s.dir, 'station.json'), 'utf8')) as { id: string }).id;
  const secretOf = (s: Station): string => (JSON.parse(readFileSync(join(s.dir, 'docking.json'), 'utf8')) as { docks: Array<{ secret: string }> }).docks[0]?.secret ?? '';
  let nonceN = 0;
  /** A signed call made by `from` to `to`'s route, as the other gonogo would: for what a docking.handOff cannot say (a forged or a repeated event). */
  const raw = async (from: Station, to: Station, route: string, payload: unknown, w: World): Promise<unknown> => {
    const body = JSON.stringify(payload);
    const timestamp = String(w.clock.now);
    nonceN += 1;
    const nonce = nonceN.toString(16).padStart(32, '0');
    const urlPath = `/dock/${route}`;
    return to.docking.handle(route, 'POST', urlPath, { 'x-gonogo-station': stationId(from), 'x-gonogo-timestamp': timestamp, 'x-gonogo-nonce': nonce, 'x-gonogo-signature': signCall(secretOf(from), stationId(from), 'POST', urlPath, timestamp, nonce, body) }, Buffer.from(body));
  };
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0));
  };
  async function linked(): Promise<{ w: World; a: Station; b: Station; dock: string; link: string; at: string }> {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const b = await w.make('beta', 'http://b.test');
    const { aSees } = await pair(a, b);
    a.tasks = [task('t1', { detail: 'Fix the build.' })];
    const handed = await a.docking.handOff(aSees, { task: 't1', assignee: 'bob', due: '2026-12-01', priority: 'high' });
    await settle();
    return { w, a, b, dock: aSees, link: handed.links?.[0] ?? '', at: stationId(b) };
  }
  const agentActor = { kind: 'agent', name: 'bob', generation: 1 } as const;

  it('a hand-off makes one link on each side, bound to a task on each, with the same trail: offer (theirs), accept (ours)', async () => {
    const { a, b, link } = await linked();
    expect(link).toMatch(/^dl_[0-9a-f]{16}$/);
    const sender = a.docking.linkViews();
    const receiver = b.docking.linkViews();
    expect(sender).toEqual([expect.objectContaining({ id: link, role: 'sender', peerName: 'beta', mine: 't1', theirs: 't9', state: 'accepted', due: '2026-12-01', priority: 'high', onward: false, budget: null, title: 'Task t1' })]);
    expect(receiver).toEqual([expect.objectContaining({ id: link, role: 'receiver', peerName: 'alpha', mine: 't9', state: 'accepted', due: '2026-12-01', priority: 'high' })]);
    const trailA = a.docking.linkTrail(link)!;
    const trailB = b.docking.linkTrail(link)!;
    expect(trailA.map((e) => [e.from, e.seq, e.kind, e.by])).toEqual([['us', 1, 'offer', 'director@alpha'], ['them', 1, 'accept', 'station@beta']]);
    expect(trailB.map((e) => [e.from, e.seq, e.kind, e.by])).toEqual([['them', 1, 'offer', 'director@alpha'], ['us', 1, 'accept', 'station@beta']]);
    expect(b.attached[0]).toMatchObject({ id: 't9', link });
    await settle();
    await eventually(() => expect(JSON.parse(readFileSync(join(a.dir, 'links.json'), 'utf8'))).toMatchObject({ version: 1, links: [{ id: link }] }));
    expect(statSync(join(a.dir, 'links.json')).mode & 0o777).toBe(0o600);
  });

  it('the offer is idempotent: the same link offered again is the same task, not a second one', async () => {
    const { w, a, b, link } = await linked();
    const again = (await raw(a, b, 'task', { id: 't1', title: 'Task t1', detail: 'Fix the build.', link }, w)) as { ok: boolean; id: string; accept?: { kind: string } };
    expect(again).toMatchObject({ ok: true, id: 't9', accept: { kind: 'accept' } });
    expect(b.created).toHaveLength(1);
    // another dock cannot claim the link, and one that is not a link id is an old-style copy
    const c = await w.make('gamma', 'http://c.test');
    await pair(c, b);
    await expect(raw(c, b, 'task', { id: 't1', title: 'x', link }, w)).rejects.toMatchObject({ code: 'conflict', field: 'link' });
  });

  it('a status or a note of a task that is bound to a link becomes an event on its own, with the author as agent@station; notes are cleaned and cut', async () => {
    const { a, b, link } = await linked();
    const before = b.tasks.find((t) => t.id === 't9')!;
    b.docking.taskChanged(before, { ...before, status: 'doing' }, agentActor, 'on it‮​ now');
    b.docking.taskChanged({ ...before, status: 'doing' }, { ...before, status: 'doing' }, agentActor, 'a note only');
    await settle();
    const trail = a.docking.linkTrail(link)!;
    expect(trail.at(-2)).toMatchObject({ from: 'them', kind: 'status', status: 'doing', by: 'bob@beta', text: 'on it now' });
    expect(trail.at(-1)).toMatchObject({ kind: 'note', text: 'a note only' });
    expect(a.docking.linkViews()[0]).toMatchObject({ peerStatus: 'doing', waiting: 0 });
    expect(b.docking.linkViews()[0]).toMatchObject({ peerStatus: 'doing', waiting: 0 });
    // acked: nothing waits, and what left is on record exactly
    expect(b.docking.outbound(stationId(a)).map((e) => [e.kind, e.text, e.ackedAt !== null])).toEqual([['status', 'on it now', true], ['note', 'a note only', true]]);
  });

  it('local notes: the status leaves without its text, and a note alone does not leave at all', async () => {
    const { a, b, link } = await linked();
    const before = { ...b.tasks.find((t) => t.id === 't9')!, localNotes: true };
    b.docking.taskChanged(before, { ...before, status: 'blocked' }, agentActor, 'the password is hunter2');
    b.docking.taskChanged({ ...before, status: 'blocked' }, { ...before, status: 'blocked' }, agentActor, 'also private');
    await settle();
    const trail = a.docking.linkTrail(link)!;
    expect(trail.at(-1)).toMatchObject({ kind: 'status', status: 'blocked', text: '' });
    expect(JSON.stringify(trail)).not.toContain('hunter2');
    expect(JSON.stringify(b.docking.outbound(stationId(a)))).not.toContain('hunter2');
    expect(trail.filter((e) => e.kind === 'note')).toEqual([]);
  });

  it('integrity: an event applied twice is a no-op; a known seq with other content is refused and logged; the peer cannot author as us, send a kind its side may not, or touch a link of another dock', async () => {
    const { w, a, b, link, at } = await linked();
    const ev = (over: Record<string, unknown>) => ({ link, author: at, seq: 2, at: w.clock.now, kind: 'status', by: 'bob@beta', text: 'one', status: 'doing', ...over });
    expect(await raw(b, a, 'link', { events: [ev({})] }, w)).toEqual({ acked: { [link]: 2 } });
    expect(await raw(b, a, 'link', { events: [ev({})] }, w)).toEqual({ acked: { [link]: 2 } }); // twice: nothing changes
    expect(a.docking.linkTrail(link)!.filter((e) => e.kind === 'status')).toHaveLength(1);
    // the same seq with other text: refused, the first stays
    await raw(b, a, 'link', { events: [ev({ text: 'rewritten' })] }, w);
    expect(a.docking.linkTrail(link)!.at(-1)).toMatchObject({ seq: 2, text: 'one' });
    // an event that says it is authored here (our station id) is not taken
    await raw(b, a, 'link', { events: [ev({ seq: 3, author: stationId(a) })] }, w);
    // a kind the receiver may not send is not taken as an offer
    await raw(b, a, 'link', { events: [ev({ seq: 3, kind: 'offer' }), ev({ seq: 3, kind: 'recall' })] }, w);
    expect(a.docking.linkTrail(link)!.map((e) => e.kind)).toEqual(['offer', 'accept', 'status']);
    // a station cannot appear as another name than agent@its own name
    await raw(b, a, 'link', { events: [ev({ seq: 3, by: 'user@beta', text: 'two' })] }, w);
    await raw(b, a, 'link', { events: [ev({ seq: 4, by: 'Not A Name@gamma', text: 'three' })] }, w);
    const by = a.docking.linkTrail(link)!.slice(-2).map((e) => e.by);
    expect(by).toEqual(['user@beta', 'station@beta']);
    // the sender cannot send a status either: our link on b is a receiver link, so b cannot be told a status by a
    const c = await w.make('gamma', 'http://c.test');
    await pair(c, a);
    expect(await raw(c, a, 'link', { events: [{ link, author: stationId(c), seq: 1, at: w.clock.now, kind: 'status', by: 'x@gamma', text: 'x', status: 'done' }] }, w)).toEqual({ acked: {} }); // a link of another dock: untouched
    expect(a.docking.linkViews()[0]).toMatchObject({ state: 'accepted', peerStatus: 'doing' });
  });

  it('a gap is held and filled in order; the ack says how far it got', async () => {
    const { w, a, b, link, at } = await linked();
    const ev = (seq: number) => ({ link, author: at, seq, at: w.clock.now, kind: 'note', by: 'bob@beta', text: `n${seq}` });
    expect(await raw(b, a, 'link', { events: [ev(4), ev(3)] }, w)).toEqual({ acked: { [link]: 1 } });
    expect(a.docking.linkTrail(link)!.filter((e) => e.kind === 'note')).toEqual([]);
    expect(await raw(b, a, 'link', { events: [ev(2)] }, w)).toEqual({ acked: { [link]: 4 } });
    expect(a.docking.linkTrail(link)!.filter((e) => e.kind === 'note').map((e) => e.text)).toEqual(['n2', 'n3', 'n4']);
  });

  it('the outbox keeps events while the station is down, shows them as waiting, survives a restart and goes when it is back', async () => {
    const { w, a, b, dock, link } = await linked();
    a.down = true;
    const before = b.tasks.find((t) => t.id === 't9')!;
    b.docking.taskChanged(before, { ...before, status: 'doing' }, agentActor, 'working');
    await settle();
    expect(b.docking.linkViews()[0]).toMatchObject({ waiting: 1 });
    expect(b.docking.view().docks[0]).toMatchObject({ waiting: 1 });
    expect(JSON.parse(readFileSync(join(b.dir, 'dock-outbox.json'), 'utf8'))).toMatchObject({ version: 1 });
    expect(statSync(join(b.dir, 'dock-outbox.json')).mode & 0o777).toBe(0o600);
    // a restart of b: the file is read again
    await b.docking.close();
    w.stations.delete('http://b.test');
    const b2 = await w.make('beta', 'http://b.test', { dir: b.dir });
    expect(b2.docking.linkViews()[0]).toMatchObject({ id: link, waiting: 1 });
    // not before the retry time; then it goes, and the ack empties the outbox
    a.down = false;
    await b2.docking.pull();
    w.clock.now += 31_000;
    await b2.docking.pull();
    await settle();
    expect(b2.docking.linkViews()[0]).toMatchObject({ waiting: 0 });
    expect(a.docking.linkTrail(link)!.at(-1)).toMatchObject({ kind: 'status', status: 'doing', text: 'working' });
    void dock;
  });

  it('the caps: 20 open tasks from a station, 30 an hour, and the sender is told why, in its trail; 10 an hour outgoing; a task with 10 links', async () => {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const b = await w.make('beta', 'http://b.test');
    const { aSees } = await pair(a, b);
    a.tasks = Array.from({ length: 40 }, (_, i) => task(`t${i + 1}`));
    for (let i = 1; i <= 10; i += 1) await a.docking.handOff(aSees, { task: `t${i}` });
    await expect(a.docking.handOff(aSees, { task: 't11' })).rejects.toMatchObject({ code: 'rate_limited', message: 'at most 10 tasks an hour to one station' });
    w.clock.now += 3600_001;
    for (let i = 11; i <= 20; i += 1) await a.docking.handOff(aSees, { task: `t${i}` });
    w.clock.now += 3600_001;
    // the receiver already holds 20: the 21st is refused with its reason, in the trail of the link
    await expect(a.docking.handOff(aSees, { task: 't21' })).rejects.toMatchObject({ code: 'conflict', message: 'beta did not take it: this station already holds 20 open tasks from alpha' });
    const refused = a.docking.linkViews().find((l) => l.mine === 't21');
    expect(refused).toMatchObject({ state: 'refused' });
    expect(a.docking.linkTrail(refused?.id ?? '')!.at(-1)).toMatchObject({ kind: 'refuse', from: 'them', text: 'this station already holds 20 open tasks from alpha' });
    // one task cannot have more than 10 links
    const c = await w.make('gamma', 'http://c.test');
    await pair(a, c);
    const gammaDock = a.docking.view().docks.find((d) => d.name === 'gamma')!.id;
    a.tasks = [task('t1', { links: Array.from({ length: 10 }, (_, i) => `dl_${String(i).padStart(16, '0')}`) })];
    await expect(a.docking.handOff(gammaDock, { task: 't1' })).rejects.toMatchObject({ code: 'conflict', message: 'a task has at most 10 links to other stations' });
  });

  it('the offer fields are validated: due is a real date, priority one of three, onward true or false, budget a number of dollars', async () => {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const b = await w.make('beta', 'http://b.test');
    const { aSees } = await pair(a, b);
    a.tasks = [task('t1')];
    for (const [field, value] of [['due', '2026-13-01'], ['due', '2026-02-30'], ['due', 'tomorrow'], ['priority', 'urgent'], ['onward', 'yes'], ['budget', -1], ['budget', '5'], ['budget', 2_000_000]] as const) {
      await expect(a.docking.handOff(aSees, { task: 't1', [field]: value }), `${field} ${String(value)}`).rejects.toMatchObject({ code: 'bad_request', field });
    }
    await a.docking.handOff(aSees, { task: 't1', due: '2026-12-31', priority: 'low', onward: true, budget: 12.345 });
    expect(a.docking.linkViews()[0]).toMatchObject({ due: '2026-12-31', priority: 'low', onward: true, budget: 12.35 });
    expect(b.created[0]?.input.detail).toContain('Due 2026-12-31. Priority low.');
  });

  it('what left is on record exactly, only for the Director, and a hostile links file gives fewer links, never a crash', async () => {
    const { w, a, b, link } = await linked();
    const before = b.tasks.find((t) => t.id === 't9')!;
    b.docking.taskChanged(before, { ...before, status: 'review' }, agentActor, 'ready for a look');
    await settle();
    const left = b.docking.outbound(stationId(a));
    expect(left).toEqual([expect.objectContaining({ link, seq: 2, kind: 'status', by: 'bob@beta', text: 'ready for a look', ackedAt: expect.any(Number) as number })]);
    expect(JSON.stringify(a.docking.linkViews())).not.toContain('ready for a look'); // the list carries cleaned titles and states, never event text
    await a.docking.close();
    writeFileSync(join(a.dir, 'links.json'), JSON.stringify({ version: 1, links: [{ id: 'nope' }, { id: link, role: 'sender', peer: 'x', mine: 't1' }, 5, null, { id: link, role: 'x' }] }));
    w.stations.delete('http://a.test');
    const a2 = await w.make('alpha', 'http://a.test', { dir: a.dir });
    expect(a2.docking.linkViews()).toEqual([]);
    writeFileSync(join(a.dir, 'links.json'), 'not json');
    w.stations.delete('http://a.test');
    const a3 = await w.make('alpha', 'http://a.test', { dir: a.dir });
    expect(a3.docking.linkViews()).toEqual([]);
    expect(existsSync(join(a.dir, 'links.json.bad'))).toBe(true);
  });

  it('undock detaches the links, keeps their trail and drops the outbox', async () => {
    const { a, b, dock, link } = await linked();
    await a.docking.undock(dock);
    expect(a.docking.linkViews()[0]).toMatchObject({ id: link, state: 'detached', waiting: 0 });
    expect(a.docking.linkTrail(link)!.length).toBe(2);
    expect(b.docking.linkViews()[0]).toMatchObject({ state: 'detached' });
  });
});

/* ------------------------------------------------------------------ Docking 2: the flow (S2) */

describe('links: the flow', () => {
  const stationId = (s: Station): string => (JSON.parse(readFileSync(join(s.dir, 'station.json'), 'utf8')) as { id: string }).id;
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 30; i += 1) await new Promise((r) => setTimeout(r, 0));
  };
  async function linked(assignee?: string): Promise<{ w: World; a: Station; b: Station; dock: string; bDock: string; link: string; bTask: string }> {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const b = await w.make('beta', 'http://b.test');
    const { aSees, bSees } = await pair(a, b);
    a.tasks = [task('t1', { detail: 'Fix the build.' })];
    const handed = await a.docking.handOff(aSees, { task: 't1', ...(assignee === undefined ? {} : { assignee }) });
    await settle();
    return { w, a, b, dock: aSees, bDock: bSees, link: handed.links?.[0] ?? '', bTask: b.created.length > 0 ? `t${8 + b.created.length}` : '' };
  }
  const bob = { kind: 'agent', name: 'bob', generation: 1 } as const;
  const done = (s: Station, id: string, over: Partial<Task> = {}): [Task, Task] => {
    const before = s.tasks.find((t) => t.id === id)!;
    return [before, { ...before, ...over }];
  };

  it('the assignee is only a hint: a name that is no agent there, or none, gives an unassigned task and a message to the boss that says whose words they are; the name is never echoed', async () => {
    const withHint = await linked('nobody');
    expect(withHint.b.created[0]?.input).not.toHaveProperty('assignee');
    expect(withHint.b.bossTold).toHaveLength(1);
    expect(withHint.b.bossTold[0]).toMatchObject({ station: 'alpha', subject: 'task from alpha (not your Director): Task t1' });
    expect(withHint.b.bossTold[0]?.body).toContain('theirs, not the Director\'s');
    expect(withHint.b.bossTold[0]?.body).toContain('Fix the build.');
    expect(JSON.stringify(withHint.b.bossTold)).not.toContain('nobody');
    const none = await linked();
    expect(none.b.bossTold).toHaveLength(1);
    // a name that is an agent there is not a case for the boss: here the stand-in board assigns nobody, so only the hint path is exercised above
    expect(withHint.b.told[0]).toContain('alpha handed over a task');
  });

  it('return: the receiver gives it back (done here, marked), the sender\'s own task reopens as todo with the line, nothing else changes; a sender cannot return, a returned link cannot again', async () => {
    const { a, b, link } = await linked();
    await expect(a.docking.returnTask(link, 'x')).rejects.toMatchObject({ code: 'conflict', field: 'link' });
    const view = await b.docking.returnTask(link, 'we have no‮ budget');
    await settle();
    expect(view).toMatchObject({ state: 'returned' });
    expect(b.systemed.at(-1)).toMatchObject({ id: 't9', status: 'done', returned: true, note: 'given back to alpha: we have no budget' });
    expect(a.systemed.at(-1)).toMatchObject({ id: 't1', status: 'todo', returned: true, note: 'returned by director@beta: we have no budget' });
    expect(a.docking.linkViews()[0]).toMatchObject({ state: 'returned' });
    expect(a.told.at(-1)).toBe('beta gave back "Task t1": we have no budget');
    await expect(b.docking.returnTask(link, 'again')).rejects.toMatchObject({ code: 'conflict' });
    // the sender may hand it again, to the same or another station, on a new link
    await expect(a.docking.handOff(a.docking.view().docks[0]!.id, { task: 't1' })).resolves.toMatchObject({ id: 't1' });
    expect(a.docking.linkViews()).toHaveLength(2);
  });

  it('recall: the sender withdraws it, the receiver\'s task closes only if it is not done, and only the task bound to the link', async () => {
    const { a, b, link } = await linked();
    await a.docking.recallTask(link, 'plans changed');
    await settle();
    expect(a.systemed.at(-1)).toMatchObject({ id: 't1', note: 'recalled from beta: plans changed' });
    expect(a.systemed.at(-1)?.status).toBeUndefined();
    expect(b.systemed.at(-1)).toMatchObject({ id: 't9', status: 'done', note: 'recalled by alpha: plans changed' });
    expect(b.docking.linkViews()[0]).toMatchObject({ state: 'recalled' });
    expect(b.told.at(-1)).toBe('alpha recalled "Task t1"');
    // a task that is done there is left alone
    const second = await linked();
    second.b.tasks = second.b.tasks.map((t) => (t.id === 't9' ? { ...t, status: 'done' as const } : t));
    await second.a.docking.recallTask(second.link, '');
    await settle();
    expect(second.b.systemed).toEqual([]);
    await expect(second.a.docking.recallTask(second.link, '')).rejects.toMatchObject({ code: 'conflict' });
  });

  it('delivery and acceptance: done there makes the link delivered and the sender\'s task review; the sender accepts and it is done; a link that is not delivered cannot be accepted', async () => {
    const { a, b, link } = await linked();
    await expect(a.docking.acceptDelivery(link)).rejects.toMatchObject({ code: 'conflict' });
    const [before, after] = done(b, 't9', { status: 'done' });
    b.docking.taskChanged(before, after, bob, 'all merged');
    await settle();
    expect(a.docking.linkViews()[0]).toMatchObject({ state: 'delivered', peerStatus: 'done' });
    expect(a.systemed.at(-1)).toMatchObject({ id: 't1', status: 'review', note: 'delivered by beta' });
    expect(a.told.at(-1)).toBe('beta delivered "Task t1"');
    await a.docking.acceptDelivery(link);
    await settle();
    expect(a.systemed.at(-1)).toMatchObject({ id: 't1', status: 'done', note: 'accepted from beta' });
    expect(a.docking.linkTrail(link)!.at(-1)).toMatchObject({ kind: 'accept', from: 'us', text: 'accepted' });
    expect(b.docking.linkViews()[0]).toMatchObject({ state: 'done' });
  });

  it('autoAccept: a delivery closes the sender\'s task at once and the trail says so', async () => {
    const { a, b, dock, link } = await linked();
    a.docking.setRules(dock, { autoAccept: true });
    const [before, after] = done(b, 't9', { status: 'done' });
    b.docking.taskChanged(before, after, bob, '');
    await settle();
    expect(a.systemed.map((s) => [s.status, s.note])).toContainEqual(['done', 'auto-accepted from beta']);
    expect(a.docking.linkTrail(link)!.at(-1)).toMatchObject({ kind: 'accept', text: 'auto-accepted' });
    expect(a.docking.linkViews()[0]).toMatchObject({ state: 'done' });
  });

  it('deliverables: up to 5, well formed for their kind, links only; a URL is https with no userinfo; they reach the other trail with the status', async () => {
    const { a, b, link } = await linked();
    const [before, after] = done(b, 't9', { status: 'review' });
    b.docking.taskChanged(before, after, bob, 'ready', [
      { kind: 'pr', ref: 'https://github.com/x/y/pull/3', label: 'the PR' },
      { kind: 'commit', ref: 'abc1234', label: '' },
      { kind: 'branch', ref: 'feat/docking', label: 'branch' },
      { kind: 'file', ref: 'docs/spec.md', label: '' },
      { kind: 'url', ref: 'https://example.com/report', label: 'report‮' },
    ]);
    await settle();
    expect(a.docking.linkTrail(link)!.at(-1)?.attachments).toEqual([
      { kind: 'pr', ref: 'https://github.com/x/y/pull/3', label: 'the PR' },
      { kind: 'commit', ref: 'abc1234', label: '' },
      { kind: 'branch', ref: 'feat/docking', label: 'branch' },
      { kind: 'file', ref: 'docs/spec.md', label: '' },
      { kind: 'url', ref: 'https://example.com/report', label: 'report' },
    ]);
    // what is not well formed for its kind never gets in
    for (const bad of [{ kind: 'url', ref: 'http://example.com' }, { kind: 'url', ref: 'https://u:p@example.com/' }, { kind: 'pr', ref: 'javascript:alert(1)' }, { kind: 'commit', ref: 'not hex' }, { kind: 'branch', ref: '../x' }, { kind: 'file', ref: '/etc/passwd' }, { kind: 'file', ref: '../../secret' }, { kind: 'exe', ref: 'x' }, { kind: 'url', ref: 'https://x/' + 'a'.repeat(300) }]) {
      expect(readDeliverable({ ...bad, label: '' }), JSON.stringify(bad)).toBeNull();
    }
    expect(readDeliverables(Array.from({ length: 9 }, () => ({ kind: 'commit', ref: 'abc1234' })))).toHaveLength(5);
  });

  it('the rules: defaults, changed field by field and checked, kept in docking.json, and shown in the dock', async () => {
    const { a, dock } = await linked();
    expect(a.docking.view().docks[0]?.rules).toEqual({ handoff: 'ask', incoming: 'auto', autoAccept: false, staleHours: 24, reportCost: false, serve: false, ask: false });
    expect(a.docking.setRules(dock, { staleHours: 6, handoff: 'allow' })).toEqual({ handoff: 'allow', incoming: 'auto', autoAccept: false, staleHours: 6, reportCost: false, serve: false, ask: false });
    for (const bad of [{ handoff: 'sometimes' }, { incoming: 'ask' }, { autoAccept: 'yes' }, { staleHours: -1 }, { staleHours: 1.5 }, { staleHours: 721 }, { nope: 1 }]) expect(() => a.docking.setRules(dock, bad), JSON.stringify(bad)).toThrow();
    await eventually(() => expect(JSON.parse(readFileSync(join(a.dir, 'docking.json'), 'utf8')).docks[0].rules).toMatchObject({ handoff: 'allow', staleHours: 6 }));
  });

  it('with `ask` FLIGHT\'s hand-off waits for the Director with the whole text; no sends nothing; go sends; always sets allow; with `allow` it goes at once', async () => {
    const { w, a, b, dock } = await linked();
    a.tasks.push(task('t2', { title: 'Write the docs', detail: 'All of it.' }));
    const waiting = await a.docking.requestHandoff({ station: 'beta', task: 't2', assignee: 'bob', due: '2026-12-05', priority: 'high' });
    expect(waiting).toMatchObject({ state: 'waiting', ask: expect.stringMatching(/^ha\d+$/) as string });
    expect(a.docking.asks()).toEqual([expect.objectContaining({ id: waiting.ask, dockName: 'beta', task: 't2', title: 'Write the docs', detail: 'All of it.', assignee: 'bob', due: '2026-12-05', priority: 'high' })]);
    expect(b.created).toHaveLength(1); // nothing left
    expect(a.told.at(-1)).toContain('FLIGHT wants to send "Write the docs" to beta');
    expect(await a.docking.answerAsk(waiting.ask ?? '', false, false)).toEqual({ state: 'refused' });
    expect(b.created).toHaveLength(1);
    expect(a.docking.asks()).toEqual([]);
    const again = await a.docking.requestHandoff({ station: 'beta', task: 't2' });
    const sent = await a.docking.answerAsk(again.ask ?? '', true, true);
    expect(sent).toMatchObject({ state: 'sent', link: expect.stringMatching(/^dl_/) as string });
    expect(b.created).toHaveLength(2);
    expect(a.docking.view().docks[0]?.rules?.handoff).toBe('allow'); // "always" set the rule
    a.tasks.push(task('t3'));
    expect(await a.docking.requestHandoff({ station: 'beta', task: 't3' })).toMatchObject({ state: 'sent' });
    expect(b.created).toHaveLength(3);
    await expect(a.docking.requestHandoff({ station: 'nowhere', task: 't3' })).rejects.toMatchObject({ code: 'not_found', field: 'station' });
    await expect(a.docking.requestHandoff({ station: 'beta', task: 't2' })).resolves.toMatchObject({ state: 'sent' }); // allow now
    void w; void dock;
  });

  it('incoming: off refuses every task from that station with the reason, in the sender\'s trail', async () => {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const b = await w.make('beta', 'http://b.test');
    const { aSees, bSees } = await pair(a, b);
    b.docking.setRules(bSees, { incoming: 'off' });
    a.tasks = [task('t1')];
    await expect(a.docking.handOff(aSees, { task: 't1' })).rejects.toMatchObject({ message: 'beta did not take it: beta does not take tasks from alpha' });
    expect(b.created).toEqual([]);
    expect(a.docking.linkViews()[0]).toMatchObject({ state: 'refused' });
  });

  it('the Director hears each incoming task, and more than 3 from one station in 10 minutes make one digest line', async () => {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const b = await w.make('beta', 'http://b.test');
    const { aSees } = await pair(a, b);
    a.tasks = Array.from({ length: 6 }, (_, i) => task(`t${i + 1}`));
    for (let i = 1; i <= 6; i += 1) await a.docking.handOff(aSees, { task: `t${i}` });
    expect(b.told.filter((t) => t.includes('handed over a task'))).toHaveLength(3);
    expect(b.told.filter((t) => t.includes('is handing over several tasks'))).toHaveLength(1);
    expect(b.told.length).toBe(4);
  });

  it('a quiet accepted link tells this station\'s own boss once per period, and nothing crosses the dock', async () => {
    const { w, a, b, dock } = await linked();
    a.docking.setRules(dock, { staleHours: 2 });
    const eventsBefore = a.docking.linkTrail(a.docking.linkViews()[0]!.id)!.length;
    w.clock.now += 3 * 3600_000;
    await a.docking.pull();
    expect(a.bossTold).toHaveLength(1);
    expect(a.bossTold[0]?.body).toContain('has had no news for 3 hours');
    expect(a.bossTold[0]?.body).toContain('This is a note from gonogo');
    expect(a.told.at(-1)).toContain('has had no news for 3 hours');
    await a.docking.pull();
    expect(a.bossTold).toHaveLength(1); // not again in the same period
    w.clock.now += 2 * 3600_001;
    await a.docking.pull();
    expect(a.bossTold).toHaveLength(2);
    expect(a.docking.linkTrail(a.docking.linkViews()[0]!.id)!.length).toBe(eventsBefore);
    expect(b.bossTold).toEqual([expect.objectContaining({ station: 'alpha' })]); // beta has its own rule (the default 24 h): only the incoming-task note from before
    void stationId;
  });
});

/* ------------------------------------------------------------------ Docking 2: reach (S3) */

describe('links: reach', () => {
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 30; i += 1) await new Promise((r) => setTimeout(r, 0));
  };
  const bob = { kind: 'agent', name: 'bob', generation: 1 } as const;
  const note = (s: Station, id: string, text: string): void => {
    const before = s.tasks.find((t) => t.id === id)!;
    s.docking.taskChanged(before, before, bob, text);
  };
  async function linked(onward = false): Promise<{ w: World; a: Station; b: Station; dock: string; link: string }> {
    const w = world();
    const a = await w.make('alpha', 'http://a.test');
    const b = await w.make('beta', 'http://b.test');
    const { aSees } = await pair(a, b);
    a.tasks = [task('t1', { detail: 'Fix the build.' })];
    const handed = await a.docking.handOff(aSees, { task: 't1', onward });
    await settle();
    return { w, a, b, dock: aSees, link: handed.links?.[0] ?? '' };
  }
  const trailKinds = (s: Station, link: string): string[] => (s.docking.linkTrail(link) ?? []).map((e) => e.kind);

  it('threads: a subject tagged with a link of that dock is a question or a reply on the link, in both trails; the tag of a link of another dock is refused, going and coming', async () => {
    const { w, a, b, link } = await linked();
    const sent = await a.docking.send('beta', { from: 'ana', to: 'bob', subject: `[${link}] is the build red?`, body: 'details', hops: 0 });
    expect(sent.ok).toBe(true);
    await a.docking.send('beta', { from: 'ana', to: 'bob', subject: `[${link}] Re: thanks`, body: '', hops: 0 });
    await settle();
    expect(b.delivered.map((d) => d.message.subject)).toEqual([`[${link}] is the build red?`, `[${link}] Re: thanks`]);
    expect(trailKinds(b, link).slice(-2)).toEqual(['ask', 'reply']);
    expect(trailKinds(a, link).slice(-2)).toEqual(['ask', 'reply']);
    expect((b.docking.linkTrail(link) ?? []).at(-2)).toMatchObject({ from: 'them', by: 'ana@alpha', text: 'is the build red?' });
    // a link that is not with that dock: refused on the way out and on the way in
    const c = await w.make('gamma', 'http://c.test');
    const { aSees: bToC } = await pair(b, c).then((p) => ({ aSees: p.aSees }));
    void bToC;
    const other = 'dl_0000000000000000';
    expect((await a.docking.send('beta', { from: 'ana', to: 'bob', subject: `[${other}] x`, body: '', hops: 0 })).note).toBe(`the thread ${other} is not a link with beta`);
    expect(b.delivered).toHaveLength(2);
    await expect(a.docking.handle('message', 'POST', '/dock/message', {}, Buffer.from('{}'))).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('lost: events that waited 7 days are replaced by one `lost` event that both sides see, and the numbering goes on without a hole', async () => {
    const { w, a, b, link } = await linked();
    a.down = true;
    note(b, 't9', 'one');
    note(b, 't9', 'two');
    note(b, 't9', 'three');
    await settle();
    expect(b.docking.view().docks[0]).toMatchObject({ waiting: 3 });
    w.clock.now += 8 * 24 * 3600_000;
    note(b, 't9', 'four');
    a.down = false;
    await b.docking.pull();
    w.clock.now += 11 * 60_000;
    await b.docking.pull();
    await settle();
    const lost = (b.docking.linkTrail(link) ?? []).find((e) => e.kind === 'lost');
    expect(lost).toMatchObject({ from: 'us', text: '3 events were not delivered' });
    expect((a.docking.linkTrail(link) ?? []).filter((e) => e.kind === 'lost' || e.kind === 'note').map((e) => [e.kind, e.text])).toEqual([['lost', '3 events were not delivered'], ['note', 'four']]);
    expect(b.docking.view().docks[0]).toMatchObject({ waiting: 0 });
  });

  it('undock detaches the links and keeps the trail; docking the same station again gives them the state they had', async () => {
    const { a, b, dock, link } = await linked();
    await a.docking.undock(dock);
    await settle();
    expect(a.docking.linkViews()[0]).toMatchObject({ state: 'detached' });
    expect(b.docking.linkViews()[0]).toMatchObject({ state: 'detached' });
    expect((a.docking.linkTrail(link) ?? []).length).toBeGreaterThan(0);
    await pair(a, b);
    await settle();
    expect(a.docking.linkViews()[0]).toMatchObject({ state: 'accepted' });
    expect(b.docking.linkViews()[0]).toMatchObject({ state: 'accepted' });
    note(b, 't9', 'back again');
    await settle();
    expect(trailKinds(a, link).at(-1)).toBe('note');
  });

  it('a task worked on while the dock is undocked keeps its events: the redock delivers them, and the sender hears the delivery', async () => {
    const { a, b, dock, link } = await linked();
    await b.docking.undock(b.docking.view().docks[0]!.id);
    await settle();
    expect(a.docking.linkViews()[0]).toMatchObject({ state: 'detached' });
    const before = b.tasks.find((t) => t.id === 't9')!;
    b.docking.taskChanged(before, { ...before, status: 'done' }, bob, 'finished while apart');
    await settle();
    expect(trailKinds(b, link).at(-1)).toBe('status');
    expect(b.docking.linkViews()[0]).toMatchObject({ state: 'detached', waiting: 1 });
    await pair(a, b);
    await settle();
    await b.docking.pull();
    await settle();
    expect(a.docking.linkViews()[0]).toMatchObject({ state: 'delivered', peerStatus: 'done' });
    expect(b.docking.linkViews()[0]).toMatchObject({ state: 'delivered', waiting: 0 });
    expect((a.docking.linkTrail(link) ?? []).at(-1)).toMatchObject({ kind: 'status', status: 'done', text: 'finished while apart' });
    void dock;
  });

  it('repair: a station that lost its outbox is asked what the other holds and sends what is lacking', async () => {
    const { w, a, b, link } = await linked();
    a.down = true;
    note(b, 't9', 'while you were away');
    note(b, 't9', 'second');
    await settle();
    // b restarts without its outbox file; a is back
    await b.docking.close();
    w.stations.delete('http://b.test');
    rmSync(join(b.dir, 'dock-outbox.json'), { force: true });
    const b2 = await w.make('beta', 'http://b.test', { dir: b.dir });
    expect(b2.docking.linkViews()[0]).toMatchObject({ waiting: 0 });
    a.down = false;
    await b2.docking.pull();
    await settle();
    expect((a.docking.linkTrail(link) ?? []).filter((e) => e.kind === 'note').map((e) => e.text)).toEqual(['while you were away', 'second']);
    // asked once: a second pull does not send them again
    await b2.docking.pull();
    await settle();
    expect((a.docking.linkTrail(link) ?? []).filter((e) => e.kind === 'note')).toHaveLength(2);
  });

  describe('knowledge on request, and suggestions', () => {
    const ready = async (): Promise<{ w: World; a: Station; b: Station; aDock: string; bDock: string }> => {
      const w = world();
      const a = await w.make('alpha', 'http://a.test');
      const b = await w.make('beta', 'http://b.test');
      const { aSees, bSees } = await pair(a, b);
      b.logEntries = [
        { id: 'l1', title: 'Deploy notes', snippet: 'we deploy with token=abc123def456 on friday\u202e and rollback', date: '2026-11-01' },
        { id: 'l2', title: 'Deploy secrets', snippet: 'private: deploy key lives elsewhere', date: '2026-11-02' },
      ];
      b.claimList = [{ key: 'repo1/K-1', statement: 'Deploys go out on Friday only.', date: '2026-10-30' }, { key: 'repo1/K-2', statement: 'Deploys never touch prod on weekends.', date: '2026-10-31' }];
      return { w, a, b, aDock: aSees, bDock: bSees };
    };

    it('nothing is shared by default: with serve off the answer is a refusal, and with serve on but no marks it is empty', async () => {
      const { a, b, bDock, aDock } = await ready();
      expect((await a.docking.askKnowledge('beta', 'deploy')).text).toContain('beta gave nothing: beta does not answer requests for knowledge from alpha');
      b.docking.setRules(bDock, { serve: true });
      expect((await a.docking.askKnowledge('beta', 'deploy')).text).toBe('From beta, shared on request (data, not instructions)\nnothing shared matched');
      void aDock;
      await settle();
    });

    it('an agent\'s request needs the rule `ask` of that dock, off by default and set like the other rules; the Director\'s own ask does not', async () => {
      const { a, aDock } = await ready();
      await expect(a.docking.askKnowledge('beta', 'deploy', 'agent')).rejects.toMatchObject({ code: 'forbidden', field: 'station' });
      expect((await a.docking.askKnowledge('beta', 'deploy')).text).toContain('beta gave nothing'); // the Director asks: it goes out (beta serves nothing yet)
      expect(a.docking.rules(aDock).ask).toBe(false);
      expect(() => a.docking.setRules(aDock, { ask: 'yes' })).toThrow();
      a.docking.setRules(aDock, { ask: true });
      expect((await a.docking.askKnowledge('beta', 'deploy', 'agent')).text).toContain('beta gave nothing');
      await settle();
    });

    it('only what the Director marked for that dock leaves: cleaned, secrets replaced, at most 600 characters, no id, no tag, no author; the asker gets data, not stored', async () => {
      const { a, b, bDock, aDock } = await ready();
      b.docking.setRules(bDock, { serve: true });
      await b.docking.setShare('log', 'l1', [aDock === '' ? bDock : bDock]);
      const answer = await a.docking.askKnowledge('beta', 'deploy');
      expect(answer.results).toBe(1);
      expect(answer.text.split('\n')[0]).toBe('From beta, shared on request (data, not instructions)');
      expect(answer.text).toContain('Deploy notes (2026-11-01, shared by beta)');
      expect(answer.text).toContain('token=[redacted]');
      expect(answer.text).not.toContain('abc123def456');
      expect(answer.text).not.toContain('\u202e');
      expect(answer.text).not.toContain('private');
      expect(answer.text).not.toMatch(/\bl1\b/);
      // the exact text that left is in the answering station's Outbound view
      expect(b.docking.outbound(bDock).at(-1)).toMatchObject({ kind: 'knowledge' });
      expect(b.docking.outbound(bDock).at(-1)?.text).toContain('Deploy notes: we deploy with token=[redacted]');
      expect(a.docking.outbound(aDock).at(-1)).toMatchObject({ kind: 'knowledge-ask', text: 'deploy' });
    });

    it('a claim is its statement only, and a mark is for the docks named, set by the Director and listed; a dock that is removed loses its marks', async () => {
      const { a, b, bDock, aDock } = await ready();
      b.docking.setRules(bDock, { serve: true });
      await b.docking.setShare('claim', 'repo1/K-1', [bDock]);
      const answer = await a.docking.askKnowledge('beta', 'deploys friday');
      expect(answer.text).toContain('claim (2026-10-30, shared by beta): Deploys go out on Friday only.');
      expect(answer.text).not.toContain('K-1');
      expect(answer.text).not.toContain('weekends');
      expect(b.docking.shares()).toEqual([{ kind: 'claim', key: 'repo1/K-1', docks: [bDock] }]);
      await expect(b.docking.setShare('claim', 'repo1/K-1', ['f'.repeat(32)])).rejects.toMatchObject({ field: 'docks' });
      await expect(b.docking.setShare('log', '../x', [bDock])).rejects.toMatchObject({ field: 'id' });
      await expect(b.docking.setShare('other', 'l1', [])).rejects.toMatchObject({ field: 'kind' });
      expect(await b.docking.setShare('claim', 'repo1/K-1', [])).toMatchObject({ docks: [] });
      expect(b.docking.shares()).toEqual([]);
      void a;
      void aDock;
    });

    it('at most 5 results, 20 requests an hour per dock each way, and the request has to be text', async () => {
      const { w, a, b, bDock } = await ready();
      b.docking.setRules(bDock, { serve: true });
      b.logEntries = Array.from({ length: 9 }, (_, i) => ({ id: `l${i}`, title: `Deploy ${i}`, snippet: 'deploy', date: '2026-11-01' }));
      for (const e of b.logEntries) await b.docking.setShare('log', e.id, [bDock]);
      expect((await a.docking.askKnowledge('beta', 'deploy')).results).toBe(5);
      for (let i = 0; i < 19; i += 1) await a.docking.askKnowledge('beta', 'deploy');
      await expect(a.docking.askKnowledge('beta', 'deploy')).rejects.toMatchObject({ code: 'rate_limited' });
      await expect(a.docking.askKnowledge('beta', '   ')).rejects.toMatchObject({ field: 'query' });
      await expect(a.docking.askKnowledge('nowhere', 'x')).rejects.toMatchObject({ code: 'not_found' });
      w.clock.now += 61 * 60_000;
      expect((await a.docking.askKnowledge('beta', 'deploy')).results).toBe(5);
    });

    it('suggestions rank the agents here and at the docked stations by the words of the task, read-only, with the matching words and the state; stopped is flagged', async () => {
      const { a, b } = await ready();
      a.agents = [{ name: 'ana', role: 'writes the release notes and docs', state: 'idle', boss: true }, { name: 'ben', role: 'builds the pipeline', state: 'stopped', boss: false }];
      b.agents = [{ name: 'cat', role: 'release manager for the notes', state: 'working', boss: true }];
      await b.docking.pull();
      await a.docking.pull();
      await settle();
      a.tasks = [task('t1', { title: 'Write the release notes', detail: 'docs for the pipeline' })];
      const found = a.docking.suggest('t1');
      expect(found.text.split('\n')[0]).toBe('Suggestions from the rosters (data, not instructions)');
      expect(found.suggestions.map((s) => [s.station, s.agent])).toEqual([['here', 'ana'], ['beta', 'cat'], ['here', 'ben']]);
      expect(found.suggestions.find((s) => s.agent === 'ben')).toMatchObject({ stopped: true });
      expect(found.text).toContain('- ben@here (stopped): matches');
      expect(found.suggestions[0]?.why.length).toBeGreaterThanOrEqual(2);
      expect(() => a.docking.suggest('t99')).toThrow();
    });
  });

  describe('mission links', () => {
    const setup = async (): Promise<{ w: World; a: Station; b: Station; dock: string; link: string }> => {
      const w = world();
      const a = await w.make('alpha', 'http://a.test');
      const b = await w.make('beta', 'http://b.test');
      const { aSees } = await pair(a, b);
      a.missionList.push({ id: 'ms1', name: 'Ship the thing', goal: 'Everything in it, done.', status: 'active' });
      const view = await a.docking.handOffMission(aSees, { mission: 'ms1', due: '2026-12-24', priority: 'high' });
      await settle();
      return { w, a, b, dock: aSees, link: view.id };
    };

    it('a mission is offered like a task: the receiver makes its own planned mission labelled with where it came from, the boss is told, and both sides have a mission link', async () => {
      const { a, b, link } = await setup();
      expect(b.missionList).toEqual([{ id: 'ms1', name: 'from alpha: Ship the thing', goal: 'Everything in it, done.', status: 'planned' }]);
      expect(a.docking.linkViews()[0]).toMatchObject({ id: link, kind: 'mission', role: 'sender', mine: 'ms1', state: 'accepted', due: '2026-12-24', priority: 'high', onward: false });
      expect(b.docking.linkViews()[0]).toMatchObject({ id: link, kind: 'mission', role: 'receiver', mine: 'ms1', theirs: 'ms1' });
      expect(b.bossTold[0]?.subject).toBe('mission from alpha (not your Director): Ship the thing');
      expect(b.told.at(-1)).toContain('alpha handed over a mission');
      expect(a.systemed).toEqual([]); // no task was touched
    });

    it('the receiver reports counts only, when they change: "3 of 5" with no titles, and tasks handed over inside the mission land inside it', async () => {
      const { a, b, dock } = await setup();
      b.tasks = [task('t20', { missionId: 'ms1' as never, status: 'done' }), task('t21', { missionId: 'ms1' as never, status: 'doing' }), task('t22', { missionId: 'ms1' as never, status: 'blocked' }), task('t23', { missionId: 'ms1' as never, status: 'review' }), task('t24')];
      await b.docking.pull();
      await settle();
      expect(a.docking.linkViews()[0]?.progress).toEqual({ done: 1, total: 4, blocked: 1, review: 1, doing: 1 });
      const events = (a.docking.linkTrail(a.docking.linkViews()[0]!.id) ?? []).filter((e) => e.kind === 'progress');
      expect(events.map((e) => e.text)).toEqual(['1/4 1 1 1']);
      expect(JSON.stringify(events)).not.toMatch(/Task t2/);
      // a task going from todo to doing is a change too
      b.tasks = b.tasks.map((t) => (t.id === 't24' ? { ...t, missionId: 'ms1' as never, status: 'doing' as const } : t));
      await b.docking.pull();
      await settle();
      expect(a.docking.linkViews()[0]?.progress).toEqual({ done: 1, total: 5, blocked: 1, review: 1, doing: 2 });
      await b.docking.pull(); // nothing changed: nothing sent
      await settle();
      expect((a.docking.linkTrail(a.docking.linkViews()[0]!.id) ?? []).filter((e) => e.kind === 'progress')).toHaveLength(2);
      // a task of the mission, handed over, lands inside the other station's mission
      a.tasks = [task('t5', { missionId: 'ms1' as never })];
      await a.docking.handOff(dock, { task: 't5' });
      await settle();
      expect(b.created.at(-1)?.input).toMatchObject({ missionId: 'ms1' });
    });

    it('the receiver\'s mission being done is a delivery of the link and closes nothing on the sender\'s side; at most 5 open missions per dock', async () => {
      const { w, a, b, dock } = await setup();
      b.missionList[0]!.status = 'done';
      await b.docking.pull();
      await settle();
      expect(a.docking.linkViews()[0]).toMatchObject({ state: 'delivered' });
      expect(a.missionList[0]?.status).toBe('active');
      expect(a.systemed).toEqual([]);
      for (let i = 2; i <= 6; i += 1) {
        a.missionList.push({ id: `ms${i}`, name: `m${i}`, goal: '', status: 'planned' });
        await a.docking.handOffMission(dock, { mission: `ms${i}` });
      }
      a.missionList.push({ id: 'ms7', name: 'm7', goal: '', status: 'planned' });
      await expect(a.docking.handOffMission(dock, { mission: 'ms7' })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('already holds 5 open missions') as string });
      void w;
    });
  });

  describe('cost and the cap of a link', () => {
    const offered = async (budget: number | null, roomCap?: number): Promise<{ w: World; a: Station; b: Station; dock: string; bDock: string; link: string }> => {
      const w = world();
      const a = await w.make('alpha', 'http://a.test');
      const b = await w.make('beta', 'http://b.test');
      if (roomCap !== undefined) b.roomCap = roomCap;
      const { aSees, bSees } = await pair(a, b);
      a.tasks = [task('t1')];
      const handed = await a.docking.handOff(aSees, { task: 't1', ...(budget === null ? {} : { budget }) });
      await settle();
      return { w, a, b, dock: aSees, bDock: bSees, link: handed.links?.[0] ?? '' };
    };

    it('the cap a peer offers is clamped: a $0.01 offer is raised to $0.50, a big one is cut to the room\'s own budget, a sensible one stays; both cards show the value applied', async () => {
      const small = await offered(0.01);
      expect(small.b.linkBudgets[small.link]).toBe(0.5);
      expect(small.b.docking.linkViews()[0]?.budget).toBe(0.5);
      expect(small.a.docking.linkViews()[0]?.budget).toBe(0.5);
      const big = await offered(500, 20);
      expect(big.b.linkBudgets[big.link]).toBe(20);
      expect(big.a.docking.linkViews()[0]?.budget).toBe(20);
      const fine = await offered(5, 20);
      expect(fine.b.linkBudgets[fine.link]).toBe(5);
      const none = await offered(null);
      expect(none.b.linkBudgets).toEqual({});
    });

    it('cost leaves only when reportCost is on: off says nothing; on, one report an hour and one at delivery, dollars to the cent and an estimate flag, nothing else', async () => {
      const { w, a, b, bDock, link } = await offered(5);
      b.spent = { t9: 3.1049 };
      await b.docking.pull();
      await settle();
      expect(a.docking.linkViews()[0]?.cost).toBeNull(); // not reported
      expect(trailKinds(a, link)).not.toContain('cost');
      b.docking.setRules(bDock, { reportCost: true });
      await b.docking.pull();
      await settle();
      expect(a.docking.linkViews()[0]?.cost).toEqual({ usd: 3.1, estimate: true, cap: 5 });
      expect((a.docking.linkTrail(link) ?? []).filter((e) => e.kind === 'cost').map((e) => e.text)).toEqual(['3.10']);
      // the same figure again, or a new one within the hour: nothing
      b.spent = { t9: 3.5 };
      await b.docking.pull();
      await settle();
      expect((a.docking.linkTrail(link) ?? []).filter((e) => e.kind === 'cost')).toHaveLength(1);
      w.clock.now += 61 * 60_000;
      await b.docking.pull();
      await settle();
      expect(a.docking.linkViews()[0]?.cost).toMatchObject({ usd: 3.5 });
      // at delivery, at once
      b.spent = { t9: 4.2 };
      const before = b.tasks.find((t) => t.id === 't9')!;
      b.docking.taskChanged(before, { ...before, status: 'done' }, bob, 'finished');
      await settle();
      expect(a.docking.linkViews()[0]).toMatchObject({ state: 'delivered', cost: { usd: 4.2, estimate: true } });
      // what the cost event carries: the figure and nothing else
      const sent = (b.docking.linkTrail(link) ?? []).filter((e) => e.kind === 'cost').at(-1);
      expect(Object.keys(sent ?? {}).sort()).toEqual(['at', 'by', 'from', 'kind', 'link', 'seq', 'text']);
      expect(JSON.stringify(sent)).not.toMatch(/token|model|price|agent/i);
    });

    it('reportCost is a yes or a no, and is off by default', async () => {
      const { b, bDock } = await offered(5);
      expect(b.docking.rules(bDock).reportCost).toBe(false);
      expect(() => b.docking.setRules(bDock, { reportCost: 'yes' })).toThrow();
    });
  });

  describe('chains and splits', () => {
    async function three(): Promise<{ w: World; a: Station; b: Station; c: Station; link: string; bTask: string; toC: string }> {
      const { w, a, b, link } = await linked(true);
      const c = await w.make('gamma', 'http://c.test');
      await pair(b, c);
      await settle();
      const toC = b.docking.view().docks.find((d) => d.name === 'gamma')?.id ?? '';
      return { w, a, b, c, link, bTask: 't9', toC };
    }

    it('a task goes on only if its offer said onward; the next station gets the chain, and each hop is its own link', async () => {
      const closed = await linked(false);
      await expect(closed.b.docking.handOff(closed.b.docking.view().docks[0]!.id, { task: 't9' })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('did not allow this task to be handed on') as string });
      const { a, b, c, link, bTask, toC } = await three();
      const handed = await b.docking.handOff(toC, { task: bTask });
      await settle();
      const onward = handed.links?.at(-1) ?? '';
      expect(b.docking.linkViews().find((l) => l.id === onward)).toMatchObject({ role: 'sender', peerName: 'gamma', chain: [{ station: 'alpha', task: 't1' }] });
      expect(c.docking.linkViews()[0]).toMatchObject({ role: 'receiver', chain: [{ station: 'alpha', task: 't1' }, { station: 'beta', task: 't9' }] });
      expect(a.docking.linkViews().find((l) => l.id === link)).toMatchObject({ role: 'sender', peerName: 'beta' });
    });

    it('status flows back hop by hop: gamma\'s status reaches alpha as "gamma: doing" on its link with beta, text only', async () => {
      const { a, b, c, link, bTask, toC } = await three();
      await b.docking.handOff(toC, { task: bTask });
      await settle();
      const before = c.tasks.find((t) => t.status === 'todo')!;
      c.docking.taskChanged(before, { ...before, status: 'doing' }, bob, 'on it');
      await settle();
      expect(b.docking.linkViews().find((l) => l.peerName === 'gamma')).toMatchObject({ peerStatus: 'doing' });
      expect(a.docking.linkViews().find((l) => l.id === link)).toMatchObject({ via: 'gamma: doing', peerStatus: null });
      const last = (a.docking.linkTrail(link) ?? []).at(-1);
      expect(last).toMatchObject({ kind: 'status', via: 'gamma', text: 'doing', from: 'them' });
      expect(last?.status).toBeUndefined();
    });

    it('3 hops at most and no loops: a fourth station and a station already in the chain are refused, before anything leaves', async () => {
      const { w, a, b, c, toC } = await three();
      const handed = await b.docking.handOff(toC, { task: 't9', onward: true });
      await settle();
      // back to alpha: a loop
      await expect(b.docking.handOff(b.docking.view().docks.find((d) => d.name === 'alpha')!.id, { task: 't9' })).rejects.toMatchObject({ code: 'conflict' });
      // gamma may not hand on (3 stations already: alpha, beta, gamma), even where the offer said onward
      const d = await w.make('delta', 'http://d.test');
      await pair(c, d);
      await settle();
      const cTask = c.tasks.at(-1)!.id;
      await expect(c.docking.handOff(c.docking.view().docks.find((x) => x.name === 'delta')!.id, { task: cTask })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('3 stations at most') as string });
      void a;
      void handed;
    });

    it('the chain of an offer is shape-checked: station names and task ids only, at most 2 hops; a hop that is anything else is a 400 with the field', () => {
      expect(readOffer({ chain: [{ station: 'alpha', task: 't1' }] }).chain).toEqual([{ station: 'alpha', task: 't1' }]);
      expect(readOffer({}).chain).toEqual([]);
      for (const chain of [[{ station: 'a', task: 't1' }, { station: 'b', task: 't2' }, { station: 'c', task: 't3' }], [{ station: 'A B', task: 't1' }], [{ station: 'alpha', task: 'x' }], [{ station: 'alpha' }], 'alpha', [null]]) {
        expect(() => readOffer({ chain }), JSON.stringify(chain)).toThrow();
      }
    });
  });
});
