/** Agent detail chips: the facts (engine, model and where it comes from, effort), the form's effort field, the chips drawn, the terminal row. */
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detailsLine, detailsOf, effectiveEffort, effectiveModel, modelText } from '../src/shared/details.js';
import { EFFORTS, takesEffort } from '../src/shared/protocol.js';
import type { AgentView, ModelDefaults } from '../src/shared/protocol.js';
import { DetailChips } from '../src/client/DetailChips.js';
import { effortOf, editRequest, hireRequest, initialValues } from '../src/client/form.js';
import type { Values } from '../src/client/form.js';
import { publishModelDefaults, resetModelDefaults } from '../src/client/models.js';
import { nullLogger } from '../src/server/constants.js';
import { createLauncher } from '../src/server/launcher.js';
import { checkEngines, formatDoctor, knowsEffort } from '../src/server/providers.js';
import { render } from '../src/server/tui-render.js';
import { initialUi } from '../src/server/tui-keys.js';
import { applyFrame, initialState } from '../src/server/tui-state.js';

const agent = (patch: Partial<AgentView> = {}): AgentView =>
  ({ name: 'ana', desk: 1, boss: false, state: 'idle', stateSince: 1, needsKind: null, needsReason: null, needSeq: null, transition: null, held: null, queued: 0, position: null, provider: 'claude', model: null, effort: null, dir: '/w', role: 'r', mode: 'default', ...patch }) as AgentView;
const defaults: ModelDefaults = { models: { claude: 'sonnet', gemini: 'flash' }, positions: { fido: 'opus' } };

afterEach(() => resetModelDefaults());

describe('the facts', () => {
  it('shows the console\'s own model first, then its position\'s (Claude Code only), then the room\'s, and says which', () => {
    expect(effectiveModel(agent({ model: 'haiku', position: 'fido' }), defaults)).toEqual({ name: 'haiku', from: 'console' });
    expect(effectiveModel(agent({ position: 'fido' }), defaults)).toEqual({ name: 'opus', from: 'position' });
    expect(effectiveModel(agent({ position: 'guido' }), defaults)).toEqual({ name: 'sonnet', from: 'room' });
    expect(effectiveModel(agent(), defaults)).toEqual({ name: 'sonnet', from: 'room' });
    expect(effectiveModel(agent({ provider: 'gemini', position: 'fido' }), defaults)).toEqual({ name: 'flash', from: 'room' });
  });

  it('shows none when nothing sets one: the CLI\'s own default is not known, and is never guessed', () => {
    expect(effectiveModel(agent(), null)).toBeNull();
    expect(effectiveModel(agent(), { models: {} })).toBeNull();
    expect(effectiveModel(agent({ provider: 'pi' }), defaults)).toBeNull();
    expect(effectiveModel(agent({ provider: 'custom' }), defaults)).toBeNull();
    // an engine that takes no model setting shows the model of nobody, even with a stale record
    expect(effectiveModel(agent({ provider: 'opencode', model: null }), { models: { claude: 'sonnet' } })).toBeNull();
    expect(effectiveModel(agent({ model: '  ' }), null)).toBeNull();
  });

  it('words the engine, the model with its source and the effort, in the page and in the terminal', () => {
    const d = detailsOf(agent({ position: 'fido', effort: 'xhigh' }), defaults);
    expect(d).toEqual({ engine: 'Claude Code', model: { name: 'opus', from: 'position' }, effort: { level: 'xhigh', from: 'console' } });
    expect(modelText({ name: 'opus', from: 'position' })).toBe('opus · position default');
    expect(modelText({ name: 'sonnet', from: 'room' })).toBe('sonnet · room default');
    expect(modelText({ name: 'haiku', from: 'console' })).toBe('haiku');
    expect(detailsLine(d)).toBe('Claude Code · opus · position default · xhigh');
    expect(detailsLine(d, true)).toBe('Claude · opus · xhigh');
    expect(detailsLine(detailsOf(agent({ provider: 'pi' }), defaults), true)).toBe('pi');
  });
});

describe('the effort a console starts with', () => {
  it('is its own, else the room\'s for Claude Code only, else none', () => {
    const room: ModelDefaults = { models: {}, effort: 'high' };
    expect(effectiveEffort(agent({ effort: 'low' }), room)).toEqual({ level: 'low', from: 'console' });
    expect(effectiveEffort(agent(), room)).toEqual({ level: 'high', from: 'room' });
    expect(effectiveEffort(agent({ provider: 'pi' }), room)).toBeNull();
    expect(effectiveEffort(agent(), { models: {} })).toBeNull();
    expect(effectiveEffort(agent(), null)).toBeNull();
    expect(detailsLine(detailsOf(agent(), room))).toBe('Claude Code · high · room default');
  });
});

describe('the effort field', () => {
  it('is for Claude Code only, with the levels of its own --effort', () => {
    expect([...EFFORTS]).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(takesEffort('claude')).toBe(true);
    for (const other of ['gemini', 'antigravity', 'codex', 'opencode', 'pi', 'custom'] as const) expect(takesEffort(other)).toBe(false);
  });

  const values = (patch: Partial<Values> = {}): Values => ({ ...initialValues({ mode: 'hire' }, null, {}, '/work'), name: 'ana', role: 'does things', ...patch });

  it('goes in the hire request for Claude Code, and nowhere for another engine or an empty field', () => {
    expect(hireRequest(values({ effort: 'high' }))).toMatchObject({ effort: 'high' });
    expect(hireRequest(values({ effort: '' }))).not.toHaveProperty('effort');
    expect(hireRequest(values({ effort: 'high', provider: 'gemini' }))).not.toHaveProperty('effort');
    expect(effortOf(values({ effort: 'warp' }))).toBeNull();
  });

  it('starts the edit form from the stored one, sends only a change, and null to clear it', () => {
    const stored = agent({ effort: 'high' });
    const v = initialValues({ mode: 'edit', name: 'ana' }, stored, { ana: stored }, '/work');
    expect(v.effort).toBe('high');
    expect(editRequest(v, stored, true)).toBeNull();
    expect(editRequest({ ...v, effort: 'max' }, stored, true)).toEqual({ effort: 'max' });
    expect(editRequest({ ...v, effort: '' }, stored, true)).toEqual({ effort: null });
    const plain = agent();
    const p = initialValues({ mode: 'edit', name: 'ana' }, plain, { ana: plain }, '/work');
    expect(editRequest({ ...p, effort: 'low' }, plain, true)).toEqual({ effort: 'low' });
    expect(editRequest(p, plain, true)).toBeNull();
  });
});

describe('the chips', () => {
  it('draw the engine, the model with where it comes from, and the effort, as quiet chips', () => {
    publishModelDefaults(defaults);
    const out = renderToString(createElement(DetailChips, { agent: agent({ position: 'fido', effort: 'xhigh' }) })).replace(/<!-- -->/g, '');
    expect(out).toContain('role="group"');
    expect(out).toMatch(/data-tone="quiet" data-detail="engine">Claude Code</);
    expect(out).toMatch(/data-detail="model"[^>]*>opus · position default</);
    expect(out).toMatch(/data-detail="effort">effort xhigh</);
  });

  it('draw no model chip when nothing sets one and no effort chip when none is stored', () => {
    publishModelDefaults({ models: {} });
    const out = renderToString(createElement(DetailChips, { agent: agent() }));
    expect(out).toContain('data-detail="engine"');
    expect(out).not.toContain('data-detail="model"');
    expect(out).not.toContain('data-detail="effort"');
  });

  it('the room\'s effort has its source in the chip, and a console\'s own has none', () => {
    publishModelDefaults({ models: {}, effort: 'high' });
    expect(renderToString(createElement(DetailChips, { agent: agent() })).replace(/<!-- -->/g, '')).toMatch(/data-detail="effort">effort high · room default</);
    expect(renderToString(createElement(DetailChips, { agent: agent({ effort: 'low' }) })).replace(/<!-- -->/g, '')).toMatch(/data-detail="effort">effort low</);
  });

  it('the console\'s own model has no source in its text', () => {
    publishModelDefaults(defaults);
    expect(renderToString(createElement(DetailChips, { agent: agent({ model: 'haiku' }) }))).toMatch(/data-detail="model"[^>]*>haiku</);
  });
});

describe('the terminal room list', () => {
  const frame = (agents: AgentView[]) => ({ t: 'state', state: { agents, activity: [], info: { cwd: '/' }, poll: null, governor: { limit: null, working: 0, holding: 0 }, downlink: { unread: 0, items: [] } } }) as never;
  const lines = (cols: number, models: ModelDefaults | null): string[] => render({ ...applyFrame(initialState(), frame([agent({ name: 'flight', desk: 0, boss: true, effort: 'high' }), agent({ provider: 'pi' })])), link: 'open', models }, initialUi(), { cols, rows: 20 }, { color: false });

  it('shows the engine, the model it starts with and the effort on a row with nothing else to say, from 70 columns', () => {
    const wide = lines(80, defaults).join('\n');
    expect(wide).toMatch(/flight\s+idle\s+.*Claude · sonnet · high/);
    expect(wide).toMatch(/ana\s+idle\s+.*pi\b/);
    expect(lines(60, defaults).join('\n')).not.toContain('sonnet');
  });

  it('shows no model before the defaults are known', () => {
    expect(lines(80, null).join('\n')).toMatch(/Claude · high/);
  });
});

describe('a claude that does not know --effort', () => {
  const fake = async (help: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'gonogo-effort-'));
    const bin = join(dir, 'claude');
    await writeFile(bin, `#!/bin/sh\ncase "$1" in --help) printf '%s\\n' ${JSON.stringify(help)};; *) echo 2.0.0;; esac\n`, { mode: 0o755 });
    return bin;
  };

  it('is read from --help: yes, no, and null when it cannot be asked', async () => {
    expect(await knowsEffort(await fake('Options:\n  --effort <level>  how hard'), { PATH: '/usr/bin:/bin' })).toBe(true);
    expect(await knowsEffort(await fake('Options:\n  --model <m>'), { PATH: '/usr/bin:/bin' })).toBe(false);
    expect(await knowsEffort('/nonexistent/claude', { PATH: '/usr/bin:/bin' })).toBeNull();
  });

  it('shows in gonogo doctor, and stops the start with a message that names the effort', async () => {
    const old = await fake('Options:\n  --model <m>');
    const dir = dirname(old);
    const checks = await checkEngines({ PATH: dir });
    expect(checks.find((c) => c.provider === 'claude')?.effort).toBe(false);
    expect(formatDoctor(checks, null)).toMatch(/does not list --effort/);
    await mkdir(join(dir, 'work'), { recursive: true });
    const l = createLauncher({ homeDir: join(dir, 'home'), hubUrl: () => 'http://127.0.0.1:1', seed: false, claudeBin: old, env: { PATH: dir, HOME: join(dir, 'user') } });
    const rec = (effort?: 'high') => ({ name: 'ana', role: 'r', dir: join(dir, 'work'), mode: 'default' as const, sessionId: '0b2f5c1e-6d3a-4f7e-9a1b-2c3d4e5f6a7b', desk: 1, boss: false, createdAt: 1, ...(effort ? { effort } : {}) });
    await expect(l.prepareStart(rec('high'), { generation: 1, flag: null })).rejects.toThrow(/does not list --effort, so the effort of ana cannot be set/);
    // the room's effort is dropped with a warning, never a refusal: one setting must not stop every console
    const warned: string[] = [];
    const room = createLauncher({ homeDir: join(dir, 'home'), hubUrl: () => 'http://127.0.0.1:1', seed: false, claudeBin: old, env: { PATH: dir, HOME: join(dir, 'user') }, defaultEffort: () => 'high', log: { ...nullLogger, warn: (m: string) => void warned.push(m) } });
    expect((await room.prepareStart(rec(), { generation: 3, flag: null })).spec.args).not.toContain('--effort');
    expect(warned.join('\n')).toMatch(/room's default effort is not passed to ana/);
    expect((await l.prepareStart(rec(), { generation: 2, flag: null })).spec.args).not.toContain('--effort');
  });
});

describe('the models frame', () => {
  it('replaces the defaults of the terminal and of the page', () => {
    const next: ModelDefaults = { models: { claude: 'opus' }, effort: 'low' };
    expect(applyFrame(initialState(), { t: 'models', models: next }).models).toEqual(next);
  });
});
