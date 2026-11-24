import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRecord } from '../src/shared/protocol.js';
import { createLauncher, buildSettings } from '../src/server/launcher.js';
import { createPermissionDefaults, effectiveRules, parsePermissions } from '../src/server/permissions.js';
import { editRequest, hireRequest, validate } from '../src/client/form.js';
import type { Values } from '../src/client/form.js';
import { parseRulesText, rulesOf, rulesToText, setToolState, toolState } from '../src/client/permissions.js';

const SID = '0b2f5c1e-6d3a-4f7e-9a1b-2c3d4e5f6a7b';
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gonogo-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('parsePermissions', () => {
  it('takes lists of Claude Code rules, trims and deduplicates them, and drops an empty list', () => {
    expect(parsePermissions({ allow: ['Bash', ' Read ', 'Bash', 'Bash(git:*)'], deny: ['WebFetch(domain:example.com)'], ask: [] }, 'claude')).toEqual({
      ok: true,
      permissions: { allow: ['Bash', 'Read', 'Bash(git:*)'], deny: ['WebFetch(domain:example.com)'] },
    });
    expect(parsePermissions({}, undefined)).toEqual({ ok: true, permissions: {} });
    expect(parsePermissions({ allow: ['mcp__files__read', 'Read(//work/**)'] }, 'claude')).toMatchObject({ ok: true });
  });

  it('refuses a value that is not lists, a list it does not know, and a rule that is not a rule', () => {
    for (const bad of [null, [], 'Bash', 3]) expect(parsePermissions(bad, 'claude')).toEqual({ ok: false, error: 'permissions must be an object' });
    expect(parsePermissions({ block: ['Bash'] }, 'claude')).toMatchObject({ ok: false, error: expect.stringContaining('no list "block"') });
    expect(parsePermissions({ allow: 'Bash' }, 'claude')).toMatchObject({ ok: false, error: 'allow must be a list of rules' });
    for (const rule of ['', 'Bash(', 'Bash()', 'rm -rf', '1Bash', 'Bash(a\nb)', 3, '-Bash']) {
      expect(parsePermissions({ allow: [rule] }, 'claude'), String(rule)).toMatchObject({ ok: false, error: expect.stringContaining('is not a rule') });
    }
    expect(parsePermissions({ allow: Array.from({ length: 51 }, (_, i) => `Tool${i}`) }, 'claude')).toMatchObject({ ok: false, error: 'allow: at most 50 rules' });
  });

  it("refuses gonogo's own tools in every list", () => {
    for (const list of ['allow', 'ask', 'deny']) {
      for (const rule of ['mcp__gonogo', 'mcp__gonogo__send_message', 'mcp__gonogo(x)']) {
        expect(parsePermissions({ [list]: [rule] }, 'claude'), `${list} ${rule}`).toMatchObject({ ok: false, error: expect.stringContaining("gonogo's own tools") });
      }
    }
    expect(parsePermissions({ deny: ['mcp__gonogofake__x'] }, 'claude')).toMatchObject({ ok: true });
  });

  it('is for Claude Code, pi and opencode, and says so for another engine', () => {
    for (const provider of ['claude', 'pi', 'opencode'] as const) expect(parsePermissions({ allow: ['Bash'] }, provider), provider).toMatchObject({ ok: true });
    for (const provider of ['gemini', 'codex', 'antigravity', 'crush', 'custom'] as const) {
      expect(parsePermissions({ allow: ['Bash'] }, provider), provider).toMatchObject({ ok: false, error: expect.stringContaining('not supported for') });
    }
  });

  it('the agent\'s allow and ask replace the room\'s, but the room\'s deny always applies', () => {
    expect(effectiveRules({ allow: ['Read'] }, { allow: ['Glob'], ask: ['Write'], deny: ['Bash'] })).toEqual({ allow: ['Read'], deny: ['Bash'] });
    expect(effectiveRules({ allow: ['Read'], deny: ['WebFetch', 'Bash'] }, { deny: ['Bash'] })).toEqual({ allow: ['Read'], deny: ['Bash', 'WebFetch'] });
    expect(effectiveRules({ ask: ['Edit'] }, undefined)).toEqual({ ask: ['Edit'] });
    expect(effectiveRules(undefined, { deny: ['Bash'] })).toEqual({ deny: ['Bash'] });
    expect(effectiveRules(undefined, undefined)).toEqual({});
  });
});

describe('the room\'s rules', () => {
  it('start empty, are saved in a private file, come back after a restart, and clear with {}', async () => {
    const store = createPermissionDefaults({ dir });
    await store.load();
    expect(store.view()).toEqual({ permissions: {} });
    expect(store.get()).toBeUndefined();
    expect(await store.set({ allow: ['Bash', 'Read'], deny: ['WebFetch'] })).toEqual({ permissions: { allow: ['Bash', 'Read'], deny: ['WebFetch'] } });
    expect((await stat(join(dir, 'permissions.json'))).mode & 0o777).toBe(0o600);
    const again = createPermissionDefaults({ dir });
    await again.load();
    expect(again.get()).toEqual({ allow: ['Bash', 'Read'], deny: ['WebFetch'] });
    await again.set({});
    expect(again.get()).toBeUndefined();
    await store.close();
    await again.close();
  });

  it('refuse a bad rule with a 400 and keep what was there', async () => {
    const store = createPermissionDefaults({ dir });
    await store.load();
    await store.set({ allow: ['Bash'] });
    await expect(store.set({ allow: ['not a rule'] })).rejects.toMatchObject({ code: 'bad_request', field: 'permissions' });
    expect(store.get()).toEqual({ allow: ['Bash'] });
  });

  it('keep a file they cannot read aside and start empty', async () => {
    await writeFile(join(dir, 'permissions.json'), '{ nope');
    const store = createPermissionDefaults({ dir });
    await store.load();
    expect(store.get()).toBeUndefined();
    expect((await stat(join(dir, 'permissions.json.bad')).catch(() => null))?.isFile()).toBe(true);
  });
});

describe('settings.json of a Claude Code agent', () => {
  const base = { hubUrl: 'http://127.0.0.1:7777', name: 'ana', mode: 'default' as const, memoryPath: '/h/agents/ana/memory.md', apiKeyHelper: false };

  it('has gonogo\'s own rules alone when there are none', () => {
    expect(buildSettings(base).permissions).toEqual({ deny: ['SendMessage', 'ListAgents'], allow: ["Read(//h/agents/ana/memory.md)", "Edit(//h/agents/ana/memory.md)", "Read(//h/agents/ana/handoff.md)", "Read(//h/agents/ana/inbox-files/**)"] });
  });

  it('adds the rules after gonogo\'s, never in place of them, and writes ask only when there is one', () => {
    const settings = buildSettings({ ...base, rules: { allow: ['Bash', 'Read(//h/agents/ana/memory.md)'], deny: ['WebFetch', 'SendMessage'], ask: ['Write'] } });
    expect(settings.permissions).toEqual({
      deny: ['SendMessage', 'ListAgents', 'WebFetch'],
      allow: ["Read(//h/agents/ana/memory.md)", "Edit(//h/agents/ana/memory.md)", "Read(//h/agents/ana/handoff.md)", "Read(//h/agents/ana/inbox-files/**)", "Bash"],
      ask: ['Write'],
    });
    expect((buildSettings({ ...base, rules: { allow: ['Bash'] } }).permissions as Record<string, unknown>).ask).toBeUndefined();
  });

  it('keeps the memory rules as allows, so a deny or ask of the same tool beats them (said on the page)', () => {
    const settings = buildSettings({ ...base, rules: { deny: ['Edit'], ask: ['Read'] } }).permissions as { allow: string[]; deny: string[]; ask: string[] };
    expect(settings.allow).toContain('Edit(//h/agents/ana/memory.md)');
    expect(settings.deny).toContain('Edit');
    expect(settings.ask).toContain('Read');
  });

  it('does not touch the mode: bypass still skips the startup warning, and the hooks are there', () => {
    const settings = buildSettings({ ...base, mode: 'bypassPermissions', rules: { deny: ['Bash'] } });
    expect(settings.skipDangerousModePermissionPrompt).toBe(true);
    expect(Object.keys(settings.hooks as object).length).toBeGreaterThan(0);
  });
});

describe('the launcher writes the rules of the agent, else the room\'s, into its own settings file', () => {
  const record = (patch: Partial<AgentRecord> = {}): AgentRecord => ({ name: 'ana', role: 'r', dir, mode: 'default', sessionId: SID, desk: 1, boss: false, createdAt: 1, ...patch });
  const settingsOf = async (agent: AgentRecord, room?: { allow?: string[]; deny?: string[] }) => {
    const launcher = createLauncher({ homeDir: dir, hubUrl: () => 'http://127.0.0.1:7777', seed: false, env: { PATH: process.env.PATH ?? '' }, defaultPermissions: room === undefined ? undefined : () => room });
    const { spec } = await launcher.prepareStart(agent, { generation: 1, flag: null });
    const path = spec.args[spec.args.indexOf('--settings') + 1] ?? '';
    // the file is the agent's own, under the home: never the user's ~/.claude nor the repository's .claude
    expect(path).toBe(join(dir, 'agents', 'ana', 'settings.json'));
    return (JSON.parse(await readFile(path, 'utf8')) as { permissions: { allow: string[]; deny: string[]; ask?: string[] } }).permissions;
  };

  it('uses the room\'s rules for an agent without its own; with its own, its allow replaces the room\'s and the room\'s deny stays', async () => {
    expect((await settingsOf(record(), { allow: ['Glob'] })).allow).toContain('Glob');
    const own = await settingsOf(record({ permissions: { allow: ['Bash'], deny: ['WebFetch'] } }), { allow: ['Glob'], deny: ['Write'] });
    expect(own.allow).toContain('Bash');
    expect(own.allow).not.toContain('Glob');
    expect(own.deny).toEqual(['SendMessage', 'ListAgents', 'Write', 'WebFetch']);
  });

  it('has only gonogo\'s rules for an agent and a room without any', async () => {
    const none = await settingsOf(record());
    expect(none.deny).toEqual(['SendMessage', 'ListAgents']);
    expect(none.ask).toBeUndefined();
  });
});

describe('the rules in the forms', () => {
  const EMPTY = { provider: 'claude', position: '', name: 'ana', role: 'does things', dir: '/work', mode: 'default', confirm: false, command: '', servers: '', skills: '', offServers: [], offSkills: [], cleanRoom: false, worktree: false, remoteControl: false, autostart: true, coauthor: true, rules: '', model: '', keys: [], keysRemoved: [] } as unknown as Values;

  it('read and write a rule on each line, in the order allow, ask, deny', () => {
    const text = 'deny WebFetch(domain:example.com)\nallow Bash(git:*)\n\nallow Read\nask Write';
    expect(parseRulesText(text)).toEqual({ rules: { deny: ['WebFetch(domain:example.com)'], allow: ['Bash(git:*)', 'Read'], ask: ['Write'] }, problem: null });
    expect(rulesToText(rulesOf(text))).toBe('allow Bash(git:*)\nallow Read\nask Write\ndeny WebFetch(domain:example.com)');
    expect(rulesOf('')).toBeNull();
    expect(rulesToText(null)).toBe('');
  });

  it('name the line that is wrong', () => {
    expect(parseRulesText('allow Bash\nBash').problem).toMatch(/^Line 2: start with allow, ask or deny/);
    expect(parseRulesText('allow Bash(').problem).toMatch(/^Line 1: "Bash\(" is not a rule/);
    expect(parseRulesText('deny mcp__gonogo__send_message').problem).toMatch(/gonogo's own tools/);
    expect(rulesOf('allow Bash\nnope')).toBeNull();
  });

  it('the checklist of tools reads and sets the lines of a bare tool and leaves the other lines alone', () => {
    const text = 'allow Bash(git:*)\ndeny Write';
    expect(toolState(text, 'Write')).toBe('deny');
    expect(toolState(text, 'Bash')).toBe('');
    expect(setToolState(text, 'Bash', 'ask')).toBe('allow Bash(git:*)\ndeny Write\nask Bash');
    expect(setToolState(text, 'Write', 'allow')).toBe('allow Bash(git:*)\nallow Write');
    expect(setToolState(text, 'Write', '')).toBe('allow Bash(git:*)');
  });

  it('are in the hire request for Claude Code only, a problem when wrong, and an edit when they change', () => {
    expect(hireRequest({ ...EMPTY, rules: 'allow Bash\ndeny WebFetch' })).toMatchObject({ permissions: { allow: ['Bash'], deny: ['WebFetch'] } });
    expect(hireRequest(EMPTY)).not.toHaveProperty('permissions');
    expect(hireRequest({ ...EMPTY, provider: 'gemini', rules: 'allow Bash' })).not.toHaveProperty('permissions');
    expect(validate({ ...EMPTY, rules: 'allow Bash(' }, {}, null, false).permissions).toMatch(/Line 1/);
    expect(validate({ ...EMPTY, provider: 'gemini', rules: 'allow Bash(' }, {}, null, false).permissions).toBeUndefined();
    const view = { name: 'ana', role: 'does things', dir: '/work', mode: 'default', provider: 'claude', permissions: null, keys: {} } as never;
    expect(editRequest({ ...EMPTY, rules: 'allow Bash' }, view, false)).toEqual({ permissions: { allow: ['Bash'] } });
    const own = { ...(view as object), permissions: { allow: ['Bash'] } } as never;
    expect(editRequest({ ...EMPTY, rules: '' }, own, false)).toEqual({ permissions: null });
    expect(editRequest({ ...EMPTY, rules: 'allow Bash' }, own, false)).toBeNull();
  });
});
