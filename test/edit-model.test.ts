/** The edit form opens with the model and effort the agent was configured with, shows what applies when it has none, and a save that touched neither changes neither. */
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { chooseEngine, chooseEngineAgain, editRequest, initialValues, needsBypassConfirm } from '../src/client/form.js';
import { HireForm } from '../src/client/HireForm.js';
import { publishModelDefaults, resetModelDefaults } from '../src/client/models.js';
import { emptyState, store } from '../src/client/store.js';
import type { AgentView } from '../src/shared/protocol.js';

const agent = (extra: Partial<AgentView> = {}): AgentView =>
  ({ name: 'ana', role: 'r', dir: '/w', mode: 'default', desk: 1, boss: false, state: 'idle', provider: 'claude', model: null, effort: null, position: null, command: null, payload: null, payloadOff: null, cleanRoom: null, worktree: null, history: [], keys: {}, ...extra }) as unknown as AgentView;
const open = (a: AgentView): string => {
  store.setState({ ...emptyState(), agents: { ana: a }, form: { mode: 'edit', name: 'ana' } });
  return renderToString(createElement(HireForm));
};

beforeEach(() => {
  resetModelDefaults();
  publishModelDefaults({ models: { claude: 'sonnet' }, positions: { fido: 'opus' }, effort: 'high' });
});

describe('the edit form', () => {
  it("opens with the agent's own model typed in and its own effort selected", () => {
    const html = open(agent({ model: 'us.anthropic.claude-opus-4-1-20250805-v1:0', effort: 'xhigh' }));
    expect(html).toContain('value="us.anthropic.claude-opus-4-1-20250805-v1:0"');
    expect(html).toMatch(/<option value="xhigh" selected="">xhigh<\/option>/);
    expect(html).toContain('This console runs us.anthropic.claude-opus-4-1-20250805-v1:0.');
  });

  it('with none of its own, says what applies: the room default, and the position default first', () => {
    const none = open(agent());
    expect(none).toContain("Empty: the room&#x27;s default sonnet applies.");
    expect(none).toContain('placeholder="sonnet"');
    expect(none).toContain("Empty: the room&#x27;s default high applies.");
    expect(none).toContain('room default (high)');
    // nothing is selected for the effort: it is the agent's, and it has none
    expect(none).not.toMatch(/<option value="high" selected/);
    expect(open(agent({ position: 'fido' }))).toContain("Empty: the position&#x27;s default opus applies.");
  });

  it('keeps an effort level this page does not know selected, instead of blank', () => {
    expect(open(agent({ effort: 'ultra' as never }))).toMatch(/<option value="ultra" selected="">ultra<\/option>/);
  });

  it('a save that touched neither changes neither, with a value of its own, with none, and with an unknown level', () => {
    for (const own of [agent({ model: 'opus', effort: 'low' }), agent(), agent({ model: 'my-bedrock-id', effort: 'ultra' as never })]) {
      const values = initialValues({ mode: 'edit', name: 'ana' }, own, { ana: own }, '/w');
      expect(values).toMatchObject({ model: own.model ?? '', effort: own.effort ?? '' });
      expect(editRequest(values, own, true)).toBeNull();
    }
  });

  it('changing or clearing one is an edit of that one only', () => {
    const own = agent({ model: 'opus', effort: 'low' });
    const values = initialValues({ mode: 'edit', name: 'ana' }, own, { ana: own }, '/w');
    expect(editRequest({ ...values, model: '' }, own, true)).toEqual({ model: null });
    expect(editRequest({ ...values, effort: '' }, own, true)).toEqual({ effort: null });
    expect(editRequest({ ...values, effort: 'max' }, own, true)).toEqual({ effort: 'max' });
  });
});

describe('the edit form switches engine', () => {
  it('a new engine is sent as provider, with the model and the settings it does not take cleared', () => {
    const own = agent({ model: 'opus', effort: 'high', mode: 'acceptEdits' });
    const values = initialValues({ mode: 'edit', name: 'ana' }, own, { ana: own }, '/w');
    expect(editRequest(chooseEngine(values, 'pi'), own, true)).toEqual({ provider: 'pi', model: null, effort: null });
    expect(editRequest(chooseEngine(values, 'opencode'), own, true)).toEqual({ provider: 'opencode', model: null, effort: null });
  });

  it('flight switches like any console, to any engine and any model', () => {
    const flight = agent({ name: 'flight', boss: true, model: 'opus' } as Partial<AgentView>);
    const values = initialValues({ mode: 'edit', name: 'flight' }, flight, { flight }, '/w');
    expect(editRequest({ ...chooseEngine(values, 'pi'), model: 'my-provider/some-model' }, flight, true)).toEqual({ provider: 'pi', model: 'my-provider/some-model' });
  });

  it('a bypass carried to another engine with modes must be confirmed again', () => {
    const own = agent({ mode: 'bypassPermissions' });
    const values = initialValues({ mode: 'edit', name: 'ana' }, own, { ana: own }, '/w');
    const gemini = chooseEngine(values, 'gemini');
    expect(needsBypassConfirm(gemini, own)).toBe(true);
    expect(editRequest({ ...gemini, confirm: true }, own, true)).toEqual({ provider: 'gemini', confirmBypass: true });
  });

  it('picking the engine it runs on again brings back what the form opened with: nothing to save', () => {
    const own = agent({ model: 'opus', effort: 'low' });
    const opened = initialValues({ mode: 'edit', name: 'ana' }, own, { ana: own }, '/w');
    const back = chooseEngineAgain(chooseEngineAgain(opened, 'pi', opened), 'claude', opened);
    expect(back).toMatchObject({ provider: 'claude', model: 'opus', effort: 'low' });
    expect(editRequest(back, own, true)).toBeNull();
  });

  it('the edit form shows the engine select, and a pending switch with its two buttons', () => {
    const html = open(agent({ state: 'working', pendingEngine: 'pi' } as Partial<AgentView>));
    expect(html).toContain('Engine');
    expect(html).toContain('Switches to pi when its turn ends; its mail waits until then.');
    expect(html).toContain('SWITCH NOW');
    expect(html).toContain('CANCEL SWITCH');
  });
});
