import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { effectiveModel, MODEL_PROVIDERS, modelListText, modelNames, modelNote, OPENCODE_KEY_NOTE, opencodeKeyWarning, publishEngineModels, resetEngineModels } from '../src/client/models.js';
import { ModelListStatus } from '../src/client/EngineModelList.js';
import { HireForm } from '../src/client/HireForm.js';
import { emptyState, store } from '../src/client/store.js';
import { PROVIDER_INFO } from '../src/shared/protocol.js';
import type { EngineModels } from '../src/shared/protocol.js';

describe('effectiveModel', () => {
  const room = { models: { claude: 'sonnet' } };
  it('is the console\'s own model, else the room\'s, else nothing', () => {
    expect(effectiveModel('opus', room, 'claude')).toEqual({ model: 'opus', from: 'console' });
    expect(effectiveModel('  ', room, 'claude')).toEqual({ model: 'sonnet', from: 'room' });
    expect(effectiveModel(null, room, 'claude')).toEqual({ model: 'sonnet', from: 'room' });
    expect(effectiveModel(null, room, 'gemini')).toBeNull();
    expect(effectiveModel(undefined, null, 'claude')).toBeNull();
  });
});

describe('modelNote', () => {
  const room = { models: { claude: 'sonnet' } };
  it('says where the model comes from, and that /model in the console is not kept', () => {
    expect(modelNote('opus', room, 'claude', 'Claude Code')).toContain('This console runs opus.');
    expect(modelNote('', room, 'claude', 'Claude Code')).toContain("the room's default sonnet applies");
    expect(modelNote('', null, 'claude', 'Claude Code')).toContain('Claude Code uses its own default');
    // the position's default comes before the room's, as at the start
    expect(modelNote('', { models: { claude: 'sonnet' }, positions: { fido: 'opus' } }, 'claude', 'Claude Code', 'fido')).toContain("the position's default opus applies");
    expect(modelNote('', { models: { claude: 'sonnet' }, positions: { fido: 'opus' } }, 'claude', 'Claude Code', 'flight')).toContain("the room's default sonnet applies");
    for (const note of [modelNote('', room, 'claude', 'x'), modelNote('', null, 'claude', 'x')]) expect(note).toContain('/model');
  });
});

describe('MODEL_PROVIDERS', () => {
  it('lists the engines with a model field and not the others', () => {
    expect([...MODEL_PROVIDERS].sort()).toEqual(['antigravity', 'claude', 'codex', 'cursor', 'gemini', 'kimi', 'opencode', 'pi']);
  });
});

describe('Model lists on the page', () => {
  const list = (over: Partial<EngineModels>): EngineModels => ({ provider: 'pi', source: 'cli', models: ['anthropic/claude-opus-5-5', 'anthropic/claude-sonnet-5-5'], command: 'pi --list-models', version: '1.6.0', at: 1, ...over });
  beforeEach(() => resetEngineModels());

  it('says where the names come from, or why there are none, and never leaves an empty list unexplained', () => {
    expect(modelListText('pi', { state: 'loading' })).toBe('Loading the models of pi…');
    expect(modelListText('pi', { state: 'ready', list: list({}) })).toBe('2 models from pi --list-models (1.6.0). Pick one or type any name it accepts.');
    expect(modelListText('pi', { state: 'ready', list: list({ models: [] }) })).toContain('listed no models: is a provider signed in?');
    expect(modelListText('opencode', { state: 'ready', list: list({ provider: 'opencode', source: 'missing', models: [], command: null, version: null }) })).toBe('opencode is not installed here (opencode is not on the PATH): type a name.');
    expect(modelListText('pi', { state: 'ready', list: list({ source: 'error', models: ['sonnet'], error: 'no answer in 20 s' }) })).toBe('Could not read the list (pi --list-models: no answer in 20 s). Type a name.');
    expect(modelListText('claude', { state: 'ready', list: list({ provider: 'claude', source: 'static', models: ['sonnet', 'opus'], command: null }) })).toContain('names it knows: sonnet, opus');
    expect(modelListText('codex', { state: 'ready', list: list({ provider: 'codex', source: 'static', models: [], command: null }) })).toBe('Codex has no command that lists its models: type a name.');
    expect(modelListText('pi', { state: 'failed', error: 'offline' })).toContain('Could not ask the server for the models of pi: offline');
  });

  it('a model field offers the real list once it came, and the suggested names until then', () => {
    expect(modelNames('pi', { state: 'loading' })).toEqual(PROVIDER_INFO.pi.model);
    publishEngineModels('pi', list({}));
    expect(modelNames('pi', { state: 'ready', list: list({}) })).toEqual(['anthropic/claude-opus-5-5', 'anthropic/claude-sonnet-5-5']);
  });

  it('the hire and edit form list the engine\'s models in the field, with the line that says where they come from and a refresh key', () => {
    publishEngineModels('pi', list({}));
    store.setState({ ...emptyState(), agents: { ana: { name: 'ana', role: 'r', dir: '/w', mode: 'default', desk: 1, boss: false, state: 'idle', provider: 'pi', model: null, effort: null, position: null, command: null, payload: null, payloadOff: null, cleanRoom: null, worktree: null, history: [], keys: {} } as never }, form: { mode: 'edit', name: 'ana' } });
    const html = renderToString(createElement(HireForm));
    expect(html).toContain('<option value="anthropic/claude-opus-5-5">');
    expect(html).toContain('2 models from pi --list-models (1.6.0)');
    expect(html).toContain('aria-label="Refresh the models of pi"');
    expect(html).not.toContain('<option value="haiku">');
  });

  it('the status line of a list that is loading says so and its key waits', () => {
    const html = renderToString(createElement(ModelListStatus, { provider: 'opencode', state: { state: 'loading' } }));
    expect(html).toContain('Loading the models of opencode…');
    expect(html).toContain('aria-disabled="true"');
  });
});

describe('opencode: a model of another provider needs its key for the agent', () => {
  it('warns when the provider\'s key is not among the agent\'s or the room\'s keys, and not for opencode\'s own models', () => {
    expect(opencodeKeyWarning('anthropic/claude-opus-5-5', [], false)).toContain('anthropic/claude-opus-5-5 needs ANTHROPIC_API_KEY for this agent');
    expect(opencodeKeyWarning('anthropic/claude-opus-5-5', [], false)).toContain('stops at its first turn and asks you');
    expect(opencodeKeyWarning('anthropic/claude-opus-5-5', ['ANTHROPIC_API_KEY'], false)).toBeNull();
    // a Clean Room with egress holds the Anthropic key in gonogo's proxy
    expect(opencodeKeyWarning('anthropic/claude-opus-5-5', [], true)).toBeNull();
    expect(opencodeKeyWarning('openai/gpt-x', [], true)).toContain('needs OPENAI_API_KEY');
    expect(opencodeKeyWarning('google/gemini-x', ['GEMINI_API_KEY'], false)).toBeNull();
    expect(opencodeKeyWarning('google/gemini-x', [], false)).toContain('one of GOOGLE_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, GEMINI_API_KEY');
    expect(opencodeKeyWarning('someone/model', [], false)).toContain('the API key of someone');
    for (const model of ['opencode/big-pickle', 'sonnet', '']) expect(opencodeKeyWarning(model, [], false), model).toBeNull();
  });

  it('the opencode list says that its other providers need a key for the agent; pi\'s list does not', () => {
    const oc: EngineModels = { provider: 'opencode', source: 'cli', models: ['anthropic/claude-opus-5-5', 'opencode/big-pickle'], command: 'opencode models --standalone', version: 'opencode v2.4.1', at: 1 };
    expect(modelListText('opencode', { state: 'ready', list: oc })).toContain(OPENCODE_KEY_NOTE);
    expect(modelListText('pi', { state: 'ready', list: { ...oc, provider: 'pi', command: 'pi --list-models' } })).not.toContain(OPENCODE_KEY_NOTE);
  });

  it('the opencode model field says the model goes into its config, not --model', () => {
    resetEngineModels();
    store.setState({ ...emptyState(), agents: { oc: { name: 'oc', role: 'r', dir: '/w', mode: 'default', desk: 1, boss: false, state: 'idle', provider: 'opencode', model: 'anthropic/claude-opus-5-5', effort: null, position: null, command: null, payload: null, payloadOff: null, cleanRoom: null, worktree: null, history: [], keys: {} } as never }, form: { mode: 'edit', name: 'oc' } });
    const html = renderToString(createElement(HireForm));
    expect(html).toContain('Written into its config as its model (provider/model).');
    expect(html).not.toContain('Passed to opencode as --model');
  });
});
