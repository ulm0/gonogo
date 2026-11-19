/** Plan quota (docs/quota-spec.md): the strict reader, newest report wins, staleness, the alerts, the shim and the settings entry. No claude runs here. */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlanBlock } from '../src/client/Propellant.js';
import { planRows } from '../src/client/quota.js';
import { buildGeminiSettings, STATUS_LINE_SHIM } from '../src/server/providers.js';
import { buildSettings, ownStatusLine } from '../src/server/launcher.js';
import { createQuota, parseRateLimits, QUOTA_STALE_MS } from '../src/server/quota.js';
import type { Quota } from '../src/server/quota.js';
import type { DownlinkEventKind, Logger, PlanQuota } from '../src/shared/protocol.js';

const quiet: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => quiet } as unknown as Logger;
const NOW = Date.parse('2026-11-18T12:00:00Z');
const sec = (ms: number): number => Math.floor(ms / 1000);
const HOUR = 3_600_000;
const body = (week?: number, five?: number, weekReset = NOW + 24 * HOUR, fiveReset = NOW + 2 * HOUR): unknown => ({
  cwd: '/secret',
  cost: { total_cost_usd: 1 },
  rate_limits: {
    ...(five === undefined ? {} : { five_hour: { used_percentage: five, resets_at: sec(fiveReset) } }),
    ...(week === undefined ? {} : { seven_day: { used_percentage: week, resets_at: sec(weekReset) } }),
  },
});

let dir: string;
let clock: number;
let events: [DownlinkEventKind, string][];
let made: Quota[];
const make = async () => {
  const q = createQuota({ dir, now: () => clock, notify: (k, t) => events.push([k, t]), log: quiet });
  made.push(q);
  await q.load();
  return q;
};
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gonogo-quota-'));
  clock = NOW;
  events = [];
  made = [];
});
afterEach(async () => {
  await Promise.all(made.map((q) => q.close()));
  await rm(dir, { recursive: true, force: true });
});

describe('the reader', () => {
  it('keeps only valid windows: missing, strings, negative, over 1000 and a bad reset are ignored', () => {
    expect(parseRateLimits(body(27, 41), NOW)).toEqual({ sevenDay: { pct: 27, resetsAt: sec(NOW + 24 * HOUR) * 1000 }, fiveHour: { pct: 41, resetsAt: sec(NOW + 2 * HOUR) * 1000 } });
    expect(parseRateLimits({ rate_limits: { five_hour: { used_percentage: '5', resets_at: 1e9 } } }, NOW)).toEqual({});
    expect(parseRateLimits({ rate_limits: { five_hour: { used_percentage: -1, resets_at: 1e9 } } }, NOW)).toEqual({});
    expect(parseRateLimits({ rate_limits: { five_hour: { used_percentage: 1001, resets_at: 1e9 } } }, NOW)).toEqual({});
    expect(parseRateLimits({ rate_limits: { five_hour: { used_percentage: 5, resets_at: 'x' } } }, NOW)).toEqual({});
    expect(parseRateLimits({ rate_limits: [] }, NOW)).toEqual({});
    expect(parseRateLimits({}, NOW)).toEqual({});
    expect(parseRateLimits(null, NOW)).toEqual({});
  });
});

describe('the quota', () => {
  it('is empty until a report; a report with no window changes nothing', async () => {
    const q = await make();
    expect(q.view()).toBeNull();
    expect(q.report('ana', { rate_limits: {} })).toBe(false);
    expect(q.view()).toBeNull();
  });

  it('shows the newest report from any agent, and keeps an open window a report lacks', async () => {
    const q = await make();
    q.report('ana', body(20, 10));
    clock += 60_000;
    q.report('ben', body(25));
    const v = q.view();
    expect(v).toMatchObject({ sevenDay: { pct: 25 }, fiveHour: { pct: 10 }, source: 'ben', stale: false });
  });

  it('drops a window past its reset and is stale after 15 minutes', async () => {
    const q = await make();
    q.report('ana', body(20, 10, NOW + 24 * HOUR, NOW + HOUR));
    clock = NOW + 2 * HOUR;
    expect(q.view()?.fiveHour).toBeUndefined();
    expect(q.view()?.sevenDay?.pct).toBe(20);
    expect(q.view()?.stale).toBe(true);
    clock = NOW + QUOTA_STALE_MS - 1;
    q.report('ana', body(21));
    expect(q.view()?.stale).toBe(false);
    clock += QUOTA_STALE_MS + 1;
    expect(q.view()?.stale).toBe(true);
  });

  it('keeps no field but the percentages, writes quota.json with mode 0600, and a restart shows it as stale', async () => {
    const q = await make();
    q.report('ana', body(30));
    await q.close();
    const file = join(dir, 'quota.json');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const text = await readFile(file, 'utf8');
    expect(text).not.toContain('secret');
    expect(text).not.toContain('total_cost_usd');
    clock += 20 * 60_000;
    const again = await make();
    expect(again.view()).toMatchObject({ sevenDay: { pct: 30 }, source: 'ana', stale: true });
  });

  it('ignores a damaged file', async () => {
    await writeFile(join(dir, 'quota.json'), '{ nope');
    expect((await make()).view()).toBeNull();
  });
});

describe('the alerts', () => {
  it('tells once at 80 and once at 95, not again while above, and tells again after the window resets', async () => {
    const q = await make();
    q.report('ana', body(79));
    expect(events).toEqual([]);
    q.report('ana', body(82));
    expect(events).toEqual([['redline', 'Plan week is at 82 %, resets in 24 h 0 min']]);
    q.report('ana', body(83));
    expect(events).toHaveLength(1);
    q.report('ana', body(96));
    expect(events).toHaveLength(2);
    q.report('ana', body(97));
    expect(events).toHaveLength(2);
    // a new window: other resets_at, low use, then high again
    clock += 8 * 24 * HOUR;
    const next = clock + 7 * 24 * HOUR;
    q.report('ana', body(5, undefined, next));
    q.report('ana', body(81, undefined, next));
    expect(events).toHaveLength(3);
  });

  it('a percentage that dips under and rises again inside one window is one alert; a bumped resets_at is not a new window', async () => {
    const q = await make();
    q.report('ana', body(82));
    q.report('ana', body(70));
    q.report('ana', body(83));
    q.report('ana', body(85, undefined, NOW + 24 * HOUR + 5_000));
    q.report('ana', body(86, undefined, NOW + 30 * HOUR));
    expect(events).toHaveLength(1);
  });

  it('a forged far-off reset neither silences the real alerts nor re-arms at will', async () => {
    const q = await make();
    expect(q.report('evil', body(undefined, 96, NOW, NOW + 1e11 * 1000))).toBe(false);
    expect(events).toEqual([]);
    q.report('ana', body(undefined, 96));
    expect(events).toHaveLength(1);
    for (let i = 1; i <= 5; i++) q.report('evil', body(undefined, 96, NOW, NOW + 2 * HOUR + i * 10 * 60_000));
    q.report('evil', body(undefined, 96, NOW, NOW + 10 * HOUR));
    expect(events).toHaveLength(1); // a reset bumped inside the window is not a new window: the told one has not passed
  });

  it('tells 95 once when it arrives at once, and nothing after a restart for what was told', async () => {
    const q = await make();
    q.report('ana', body(undefined, 96));
    expect(events).toEqual([['redline', 'Plan 5-hour window is at 96 %, resets in 2 h 0 min']]);
    await q.close();
    const again = await make();
    again.report('ana', body(undefined, 97));
    expect(events).toHaveLength(1);
  });
});

describe('the status line shim', () => {
  const run = (url: string, input: string, next?: string): Promise<{ out: string; code: number | null }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ['-e', STATUS_LINE_SHIM, url, ...(next === undefined ? [] : [next])], { env: { ...process.env, GONOGO_TOKEN: 'tok' } });
      let out = '';
      child.stdout.on('data', (c: Buffer) => (out += c.toString()));
      child.on('close', (code) => resolve({ out, code }));
      child.stdin.end(input);
    });
  const input = JSON.stringify({ session_id: 's', cwd: '/secret', transcript_path: '/t', cost: { total_cost_usd: 2 }, rate_limits: { seven_day: { used_percentage: 41.4, resets_at: 1795518000 } } });

  it('posts only rate_limits, the session id and the session\'s total cost, with the token, and prints one short line', async () => {
    const seen: { auth?: string; url?: string; body: string }[] = [];
    const server = createServer((req, res) => {
      let b = '';
      req.on('data', (c: Buffer) => (b += c.toString())).on('end', () => {
        seen.push({ auth: req.headers.authorization, url: req.url, body: b });
        res.end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook/ana/StatusLine`;
    const { out, code } = await run(url, input);
    server.close();
    expect(code).toBe(0);
    expect(out).toBe('plan 41% wk\n');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.auth).toBe('Bearer tok');
    expect(seen[0]?.url).toBe('/hook/ana/StatusLine');
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({ rate_limits: { seven_day: { used_percentage: 41.4, resets_at: 1795518000 } }, session: 's', total: 2, at: expect.any(Number) });
    // the time the shim posts at is its own, close to ours
    expect(Math.abs(Date.now() - (JSON.parse(seen[0]?.body ?? '{}') as { at: number }).at)).toBeLessThan(10_000);
    // nothing else of the status line leaves the process
    expect(seen[0]?.body).not.toMatch(/secret|transcript|cwd/);
  });

  it('without rate_limits (an API key, not a subscription) it still posts the session and total; without a total it posts nothing; a session id is cut at 80', async () => {
    const bodies: string[] = [];
    const server = createServer((req, res) => {
      let b = '';
      req.on('data', (c: Buffer) => (b += c.toString())).on('end', () => {
        bodies.push(b);
        res.end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/x`;
    await run(url, JSON.stringify({ session_id: 'abc', cwd: '/secret', cost: { total_cost_usd: 0.5 } }));
    await run(url, JSON.stringify({ session_id: 'abc', cwd: '/secret' }));
    await run(url, JSON.stringify({ session_id: 'x'.repeat(200), cost: { total_cost_usd: 1 } }));
    await run(url, JSON.stringify({ session_id: 'abc', cost: { total_cost_usd: 'a lot' } }));
    server.close();
    expect(bodies.map((b) => JSON.parse(b) as Record<string, unknown>)).toEqual([{ session: 'abc', total: 0.5, at: expect.any(Number) }, { session: 'x'.repeat(80), total: 1, at: expect.any(Number) }]);
  });

  it('prints a line and exits 0 when the hub is down or the input is not JSON', async () => {
    expect(await run('http://127.0.0.1:9/hook/ana/StatusLine', input)).toEqual({ out: 'plan 41% wk\n', code: 0 });
    expect(await run('http://127.0.0.1:9/x', 'not json')).toEqual({ out: '\n', code: 0 });
  });

  it('a chained command that leaves a sleeping child does not hold the shim, and the child is killed with its group', async () => {
    const pidFile = join(dir, 'child.pid');
    const started = Date.now();
    const { out } = await run('http://127.0.0.1:9/x', input, `sleep 30 & echo $! > ${pidFile}; echo mine`);
    expect(out).toBe('mine\n');
    expect(Date.now() - started).toBeLessThan(3000);
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('a chained command that never answers is cut at 4 seconds and the plan line shows', async () => {
    const started = Date.now();
    const { out, code } = await run('http://127.0.0.1:9/x', input, 'sleep 30');
    expect(code).toBe(0);
    expect(out).toBe('plan 41% wk\n');
    expect(Date.now() - started).toBeLessThan(6000);
  }, 10_000);

  it("chains the Director's own status line: it gets the same JSON and its output is what shows", async () => {
    const { out } = await run('http://127.0.0.1:9/x', input, "node -e 'process.stdin.on(\"data\",d=>process.stdout.write(\"mine:\"+JSON.parse(d).cwd))'");
    expect(out).toBe('mine:/secret\n');
  });
});

describe('the settings', () => {
  const base = { hubUrl: 'http://127.0.0.1:7777', name: 'ana', mode: 'default' as const, memoryPath: '/m/memory.md', apiKeyHelper: false };

  it('a Claude agent gets the status line with a refresh every 5 minutes, and its url is the StatusLine route', () => {
    const s = buildSettings({ ...base, statusLine: { node: '/usr/bin/node' } }) as { statusLine: { type: string; command: string; refreshInterval: number } };
    expect(s.statusLine).toMatchObject({ type: 'command', refreshInterval: 300 });
    expect(s.statusLine.command).toContain('http://127.0.0.1:7777/hook/ana/StatusLine');
    expect(s.statusLine.command.startsWith("'/usr/bin/node' '-e'")).toBe(true);
  });

  it('without the option there is none, and Gemini settings never have one', () => {
    expect(buildSettings(base)).not.toHaveProperty('statusLine');
    expect(buildGeminiSettings({ hubUrl: 'http://h', name: 'ana', tokenFile: '/t' })).not.toHaveProperty('statusLine');
  });

  it("reads the Director's own status line from his user settings, and never writes the file", async () => {
    expect(await ownStatusLine(dir)).toBeUndefined();
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'settings.json');
    const text = JSON.stringify({ statusLine: { type: 'command', command: '~/bin/line.sh' }, other: 1 });
    await writeFile(file, text);
    expect(await ownStatusLine(dir)).toBe('~/bin/line.sh');
    expect(await readFile(file, 'utf8')).toBe(text);
    await writeFile(file, JSON.stringify({ statusLine: { type: 'static' } }));
    expect(await ownStatusLine(dir)).toBeUndefined();
  });
});

describe('the PLAN block', () => {
  const plan: PlanQuota = { sevenDay: { pct: 82, resetsAt: NOW + 28 * HOUR }, at: NOW, source: 'ana', stale: false };

  it("labels the real number as the plan's own and shows the window with its reset", () => {
    const html = renderToString(createElement(PlanBlock, { plan, now: NOW }));
    expect(html).toContain("your plan&#x27;s own number");
    expect(html).toContain('82 %, resets in 28 h 0 min');
    expect(planRows(plan, NOW).map((r) => [r.label, r.level])).toEqual([['WEEK', 'low']]);
  });

  it('says how old a stale report is', () => {
    expect(renderToString(createElement(PlanBlock, { plan: { ...plan, stale: true }, now: NOW + 30 * 60_000 }))).toContain('last seen 30 min ago (ana)');
  });

  it('with no source says there is none and that the meters are an estimate', () => {
    const html = renderToString(createElement(PlanBlock, { plan: undefined, now: NOW }));
    expect(html).toContain('No plan quota reported');
    expect(html).toContain('estimate, not your plan');
    expect(html).toContain('see COST');
  });
});
