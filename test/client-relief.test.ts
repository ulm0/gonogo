import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentView, ReliefRequest, ServerInfo, StateSnapshot } from '../src/shared/protocol.js';
import { applyServerFrame, emptyState } from '../src/client/store.js';
import { expiresText, reliefAnnouncement, reliefFailure, reliefRows, reliefTitle, roleLabel } from '../src/client/relief.js';
import { ANNOUNCE_GAP_MS, createAnnouncer } from '../src/client/room.js';
import { missionOf } from '../src/client/wall.js';

const request = (over: Partial<ReliefRequest> = {}): ReliefRequest => ({
  id: 'h1',
  by: 'flight',
  at: 1_000,
  expiresAt: 1_000 + 30 * 60_000,
  name: 'guido-1',
  position: 'guido',
  role: 'Writes the backend.',
  dir: '/work/app',
  provider: 'claude',
  mode: 'acceptEdits',
  cleanRoom: null,
  ...over,
});

const INFO: ServerInfo = { protocol: 1, version: '0.1.0', cwd: '/work', home: '/h', host: '127.0.0.1', port: 7777, seed: false, agentCmd: null, maxHops: 8, startedAt: 1, installed: ['claude'], timeZone: 'UTC' };
const snapshot = (over: Partial<StateSnapshot> = {}): StateSnapshot => ({
  agents: [],
  activity: [],
  info: INFO,
  poll: null,
  governor: { limit: null, working: 0, holding: 0 },
  propellant: { room: { used: { '5h': 0, day: 0, week: 0, month: 0 }, limits: {} }, agents: {}, cost: { room: { usd: { '5h': 0, day: 0, week: 0, month: 0 }, unpriced: { '5h': 0, day: 0, week: 0, month: 0 }, budget: {} }, agents: {}, days: [], pricedSince: null } },
  schedules: [],
  uplinks: [],
  tasks: [],
  downlink: { unread: 0, items: [] },
  ...over,
});

describe('what the Director reads', () => {
  it('shows every parameter of the request, in the order he reads them', () => {
    expect(reliefRows(request(), 1_000)).toEqual([
      { label: 'Name', value: 'guido-1' },
      { label: 'Position', value: 'GUIDO · Guidance officer' },
      { label: 'Engine', value: 'Claude Code' },
      { label: 'Mode', value: 'ACCEPT EDITS: edits files without asking' },
      { label: 'Folder', value: '/work/app' },
      { label: 'Waits', value: '30 minutes left' },
    ]);
  });

  it('says so when there is no position, another engine, a default mode or a Clean Room', () => {
    const rows = reliefRows(request({ position: null, provider: 'gemini', mode: 'default', cleanRoom: { image: 'img:1' } }), 1_000);
    expect(rows.map((r) => r.value)).toEqual(['guido-1', 'none: a role of its own', 'Gemini CLI', 'ASK: asks you for a go before a tool runs', '/work/app', 'yes: its own container and branch, image img:1', '30 minutes left']);
    // an engine without permission modes is not shown as asking before each tool
    expect(reliefRows(request({ provider: 'opencode', mode: 'default' }), 1_000).find((r) => r.label === 'Mode')?.value).toMatch(/^none: this engine has no permission modes/);
    expect(reliefRows(request({ cleanRoom: {} }), 1_000).find((r) => r.label === 'Clean Room')?.value).toBe('yes: its own container and branch');
    expect(reliefRows(request({ cleanRoom: {}, flavor: 'gvisor' }), 1_000).find((r) => r.label === 'Clean Room')?.value).toBe('yes: its own container and branch, sandbox gVisor (runsc)');
    expect(reliefRows(request({ cleanRoom: {}, flavor: 'docker', flavorBelowRoom: true }), 1_000).find((r) => r.label === 'Clean Room')?.value).toBe("yes: its own container and branch, sandbox Docker (runc) (below the room's default)");
  });

  it('shows the worktree row only when the boss asked for one', () => {
    expect(reliefRows(request(), 1_000).some((r) => r.label === 'Worktree')).toBe(false);
    expect(reliefRows(request({ worktree: null }), 1_000).some((r) => r.label === 'Worktree')).toBe(false);
    const rows = reliefRows(request({ worktree: {} }), 1_000);
    expect(rows.map((r) => r.label)).toEqual(['Name', 'Position', 'Engine', 'Mode', 'Folder', 'Worktree', 'Waits']);
    expect(rows.find((r) => r.label === 'Worktree')?.value).toBe('yes: its own git worktree and branch of the repository of the folder');
  });

  it('tells a failed answer in words, the message of the server in them', () => {
    expect(reliefFailure('guido-1', true, new Error('directory does not exist: /work/x'))).toBe('GO on guido-1 failed: directory does not exist: /work/x');
    expect(reliefFailure('guido-1', false, 'offline')).toBe('NO-GO on guido-1 failed: offline');
  });

  it('says how long the role text is, so that a box that scrolls is not taken for the whole of it', () => {
    expect(roleLabel(request({ role: 'x'.repeat(4000) }))).toBe('Role text (4000 characters)');
    expect(roleLabel(request({ role: 'x' }))).toBe('Role text (1 character)');
  });

  it('does not run text of the request as markup: the rows are plain strings', () => {
    const rows = reliefRows(request({ name: '<img src=x onerror=alert(1)>', dir: '/a/<b>' }), 1_000);
    expect(rows[0]?.value).toBe('<img src=x onerror=alert(1)>');
    expect(rows.find((r) => r.label === 'Folder')?.value).toBe('/a/<b>');
  });

  it('titles it with the call sign of the boss', () => {
    expect(reliefTitle(request(), 'FLIGHT')).toBe('FLIGHT ASKS TO HIRE guido-1');
  });

  it('counts the time left down, rounded up, to the end', () => {
    const r = request({ expiresAt: 100_000 });
    expect(expiresText(r, 100_000 - 90 * 60_000)).toBe('90 minutes left');
    expect(expiresText(r, 100_000 - 61_000)).toBe('2 minutes left');
    expect(expiresText(r, 100_000 - 60_000)).toBe('1 minute left');
    expect(expiresText(r, 100_000 - 59_999)).toBe('under a minute left');
    expect(expiresText(r, 100_000)).toBe('expiring now');
    expect(expiresText(r, 200_000)).toBe('expiring now');
  });

  it('announces how many wait', () => {
    expect(reliefAnnouncement(1)).toBe('1 hire request waits for your go');
    expect(reliefAnnouncement(3)).toBe('3 hire requests wait for your go');
  });
});

describe('the wall', () => {
  const said = (id: string, at: number, subject: string, body = ''): never => ({ id, at, from: 'user', to: 'flight', subject, body, status: 'read', note: null, inReplyTo: null, truncated: false }) as never;

  it('keeps the mission when FLIGHT is told how a request ended: only a brief changes it', () => {
    const brief = said('m1', 1, 'Brief', 'Ship the docs.');
    const answer = said('m2', 2, 'Relief: guido-1 is staffed', 'The Director said go.');
    expect(missionOf([answer, brief], 'flight')).toEqual({ text: 'Ship the docs.', at: 1 });
    expect(missionOf([answer], 'flight')).toBeNull();
  });
});

describe('the store', () => {
  it('starts with none, takes those of the state, and replaces them with each relief frame', () => {
    expect(emptyState().relief).toEqual([]);
    const first = applyServerFrame(emptyState(), { t: 'state', state: snapshot({ relief: { requests: [request()] } }) }, 1);
    expect(first.relief).toEqual([request()]);
    const two = applyServerFrame(first, { t: 'relief', relief: { requests: [request(), request({ id: 'h2', name: 'ana' })] } }, 2);
    expect(two.relief.map((r) => r.id)).toEqual(['h1', 'h2']);
    expect(applyServerFrame(two, { t: 'relief', relief: { requests: [] } }, 3).relief).toEqual([]);
  });

  it('shows none when an older server sends none, and when a reconnect finds them gone', () => {
    const had = applyServerFrame(emptyState(), { t: 'relief', relief: { requests: [request()] } }, 1);
    expect(applyServerFrame(had, { t: 'state', state: snapshot() }, 2).relief).toEqual([]);
    expect(applyServerFrame(had, { t: 'state', state: snapshot({ relief: { requests: [] } }) }, 2).relief).toEqual([]);
  });

  it('leaves the agents alone', () => {
    const agents = {} as Record<string, AgentView>;
    const s = { ...emptyState(), agents };
    expect(applyServerFrame(s, { t: 'relief', relief: { requests: [request()] } }, 1).agents).toBe(agents);
  });
});

describe('the live region', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const agent = (name: string): AgentView =>
    ({ name, state: 'idle', needsKind: null, needsReason: null, queued: 0, desk: 0, boss: false, held: null, transition: null }) as unknown as AgentView;
  const facts = (relief?: number) => ({ agents: [agent('flight')], unread: 0, poll: null, limit: null, ...(relief === undefined ? {} : { relief }) });

  it('says a request waits when the count goes up, and nothing when it goes down or stays', () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const announcer = createAnnouncer((t) => writes.push(t));
    announcer.update(facts(1), {});
    announcer.update(facts(1), {});
    vi.advanceTimersByTime(5_000);
    expect(writes).toEqual([]);
    announcer.update(facts(2), {});
    vi.advanceTimersByTime(ANNOUNCE_GAP_MS);
    expect(writes).toEqual(['2 hire requests wait for your go']);
    announcer.update(facts(0), {});
    announcer.update(facts(), {});
    vi.advanceTimersByTime(5_000);
    expect(writes).toHaveLength(1);
    announcer.update(facts(1), {});
    vi.advanceTimersByTime(ANNOUNCE_GAP_MS);
    expect(writes.at(-1)).toBe('1 hire request waits for your go');
  });
});
