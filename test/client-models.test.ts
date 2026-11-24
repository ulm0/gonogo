import { describe, expect, it } from 'vitest';
import { effectiveModel, MODEL_PROVIDERS, modelNote } from '../src/client/models.js';

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
