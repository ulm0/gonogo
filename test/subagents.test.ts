import { copyFile, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRecord, Logger } from '../src/shared/protocol.js';
import { createLauncher, withNoSubagents } from '../src/server/launcher.js';
import { createPropellant } from '../src/server/propellant.js';
import { createSubagentStore } from '../src/server/subagents.js';
import { subagentChip, subagentTypes } from '../src/client/room.js';

const quiet: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => quiet } as unknown as Logger;
const FIX = join(import.meta.dirname, 'fixtures', 'subagent-run');
const SID = '0b2f5c1e-6d3a-4f7e-9a1b-2c3d4e5f6a7b';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gonogo-sub-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('Propellant counts the subagents of a session (a real run, test/fixtures/subagent-run)', () => {
  const setup = async () => {
    const projects = join(root, 'claude', 'projects');
    const dir = join(projects, '-work-ana');
    await mkdir(join(dir, 'session', 'subagents'), { recursive: true });
    await mkdir(join(root, 'home'));
    await copyFile(join(FIX, 'main.jsonl'), join(dir, 'session.jsonl'));
    await copyFile(join(FIX, 'agent.jsonl'), join(dir, 'session', 'subagents', 'agent-a11de4cdf0716c4ae.jsonl'));
    const p = createPropellant({ dir: join(root, 'home'), projectsRoot: projects, now: () => Date.parse('2026-11-18T18:10:00Z'), log: quiet });
    await p.load();
    return { p, dir, transcript: join(dir, 'session.jsonl') };
  };

  it('adds the helper\'s replies to the parent\'s, once each, and never again after a restart', async () => {
    const { p, transcript } = await setup();
    const main = (await createPropellantCount(transcript, false)) ?? 0;
    expect(main).toBeGreaterThan(0);
    const both = await p.record('ana', transcript);
    // the helper file's two replies are in the total: input + cache creation + output of each, none of the cache reads
    expect(both).toBeGreaterThan(main);
    expect(await p.record('ana', transcript)).toBe(0);
    expect(p.view().agents.ana?.used.day).toBeGreaterThan(0);
    await p.close();
    const again = createPropellant({ dir: join(root, 'home'), projectsRoot: join(root, 'claude', 'projects'), now: () => Date.parse('2026-11-18T18:10:00Z'), log: quiet });
    await again.load();
    expect(await again.record('ana', transcript)).toBe(0);
    await again.close();
  });

  it('counts a subagent file that appears later, and ignores files that are not agent-<id>.jsonl', async () => {
    const { p, dir, transcript } = await setup();
    await p.record('ana', transcript);
    await copyFile(join(FIX, 'agent.jsonl'), join(dir, 'session', 'subagents', 'agent-b2.jsonl'));
    await writeFile(join(dir, 'session', 'subagents', 'notes.jsonl'), '{"message":{"id":"x","usage":{"output_tokens":99999}}}\n');
    await writeFile(join(dir, 'session', 'subagents', 'agent-b2.meta.json'), '{}');
    const more = await p.record('ana', transcript);
    // agent-b2 has the same message ids as agent-a1…: ids are per file, so its two replies count again
    expect(more).toBeGreaterThan(0);
    expect(more).toBeLessThan(99999);
    await p.close();
  });

  it('refuses a subagent file that is a link to a place outside the projects folder', async () => {
    const { p, dir, transcript } = await setup();
    await p.record('ana', transcript);
    const outside = join(root, 'outside.jsonl');
    await copyFile(join(FIX, 'agent.jsonl'), outside);
    await symlink(outside, join(dir, 'session', 'subagents', 'agent-evil.jsonl'));
    expect(await p.record('ana', transcript)).toBe(0);
    await p.close();
  });

  it('is the same as before for a session with no subagents folder', async () => {
    const { p, dir } = await setup();
    await mkdir(join(dir, 'other'), { recursive: true });
    await copyFile(join(FIX, 'main.jsonl'), join(dir, 'other.jsonl'));
    expect(await p.record('bea', join(dir, 'other.jsonl'))).toBeGreaterThan(0);
    await p.close();
  });
});

/** The tokens of the main file alone: a Propellant of its own over a copy that has no subagents folder. */
async function createPropellantCount(transcript: string, _withSub: boolean): Promise<number> {
  const only = join(root, 'only');
  await mkdir(join(only, 'projects', '-w'), { recursive: true });
  await mkdir(join(only, 'home'));
  await copyFile(transcript, join(only, 'projects', '-w', 's.jsonl'));
  const p = createPropellant({ dir: join(only, 'home'), projectsRoot: join(only, 'projects'), now: () => Date.parse('2026-11-18T18:10:00Z'), log: quiet });
  await p.load();
  const n = await p.record('x', join(only, 'projects', '-w', 's.jsonl'));
  await p.close();
  return n;
}

describe('the Subagents setting', () => {
  it('allows them at first, saves a change in a private file, and keeps the limit when the mode changes', async () => {
    const store = createSubagentStore({ dir: root });
    await store.load();
    expect(store.view()).toEqual({ mode: 'allow', limit: 4 });
    expect(await store.set({ mode: 'limit', limit: 2 })).toEqual({ mode: 'limit', limit: 2 });
    expect(await store.set({ mode: 'none' })).toEqual({ mode: 'none', limit: 2 });
    expect((await stat(join(root, 'subagents.json'))).mode & 0o777).toBe(0o600);
    const again = createSubagentStore({ dir: root });
    await again.load();
    expect(again.view()).toEqual({ mode: 'none', limit: 2 });
    await store.close();
  });

  it('refuses a mode, a limit and a field it does not know', async () => {
    const store = createSubagentStore({ dir: root });
    await store.load();
    await expect(store.set({ mode: 'some' })).rejects.toMatchObject({ field: 'mode' });
    for (const limit of [0, 21, 1.5, '3']) await expect(store.set({ limit })).rejects.toMatchObject({ field: 'limit' });
    await expect(store.set({ extra: 1 })).rejects.toMatchObject({ field: 'extra' });
    await expect(store.set([])).rejects.toMatchObject({ code: 'bad_request' });
    expect(store.view()).toEqual({ mode: 'allow', limit: 4 });
  });

  it('moves a file with wrong content aside, and leaves one it cannot read where it is', async () => {
    await writeFile(join(root, 'subagents.json'), JSON.stringify({ version: 1, mode: 'lots' }));
    const store = createSubagentStore({ dir: root });
    await store.load();
    expect(store.view().mode).toBe('allow');
    expect((await stat(join(root, 'subagents.json.bad'))).isFile()).toBe(true);
    const other = await mkdtemp(join(tmpdir(), 'gonogo-sub-'));
    await mkdir(join(other, 'subagents.json'));
    const unreadable = createSubagentStore({ dir: other });
    await unreadable.load();
    expect(unreadable.view().mode).toBe('allow');
    expect(await stat(join(other, 'subagents.json.bad')).catch(() => null)).toBeNull();
    await rm(other, { recursive: true, force: true });
  });
});

describe('the launcher applies the setting', () => {
  const agent = (patch: Partial<AgentRecord> = {}): AgentRecord => ({ name: 'ana', role: 'r', dir: root, mode: 'default', sessionId: SID, desk: 1, boss: false, createdAt: 1, ...patch });
  const start = async (setting: { mode: 'allow' | 'limit' | 'none'; limit: number }, patch: Partial<AgentRecord> = {}) => {
    const home = await mkdtemp(join(tmpdir(), 'gonogo-sub-'));
    try {
      const launcher = createLauncher({ homeDir: home, hubUrl: () => 'http://127.0.0.1:7777', seed: false, env: { PATH: process.env.PATH ?? '' }, subagents: () => setting });
      const { spec } = await launcher.prepareStart(agent(patch), { generation: 1, flag: null });
      const settings = JSON.parse(await (await import('node:fs/promises')).readFile(join(home, 'agents', 'ana', 'settings.json'), 'utf8')) as { permissions: { deny: string[] } };
      return { env: spec.env, deny: settings.permissions.deny };
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  };

  it('allow: nothing is added', async () => {
    const { env, deny } = await start({ mode: 'allow', limit: 3 });
    expect(env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).toBeUndefined();
    expect(deny).not.toContain('Agent');
  });

  it('limit N: the variable of Claude Code is in the environment, and the deny list is not touched', async () => {
    const { env, deny } = await start({ mode: 'limit', limit: 3 });
    expect(env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).toBe('3');
    expect(deny).not.toContain('Agent');
  });

  it('none: Agent and Task are denied next to the Director\'s own rules and gonogo\'s', async () => {
    const { env, deny } = await start({ mode: 'none', limit: 3 }, { permissions: { deny: ['WebFetch'] } });
    expect(deny).toEqual(['SendMessage', 'ListAgents', 'WebFetch', 'Agent', 'Task']);
    expect(env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).toBeUndefined();
    expect(withNoSubagents({}, { mode: 'none', limit: 1 })).toEqual({ deny: ['Agent', 'Task'] });
    expect(withNoSubagents({ deny: ['Agent'] }, { mode: 'none', limit: 1 })).toEqual({ deny: ['Agent', 'Task'] });
  });
});

describe('the chip', () => {
  const view = (types: Record<string, number>) => ({ subagents: { running: Object.values(types).reduce((a, b) => a + b, 0), started: 5, types } });
  it('says how many helpers run, and of what kind, and nothing when none', () => {
    expect(subagentChip(view({}))).toBe('');
    // an older server sends no subagents at all
    expect(subagentChip({} as never)).toBe('');
    expect(subagentTypes({} as never)).toBe('');
    expect(subagentChip(view({ Explore: 1 }))).toBe('1 SUBAGENT');
    expect(subagentChip(view({ Explore: 2, 'general-purpose': 1 }))).toBe('3 SUBAGENTS');
    expect(subagentTypes(view({ Explore: 2, 'general-purpose': 1 }))).toBe('2 Explore, 1 general-purpose');
  });
});
