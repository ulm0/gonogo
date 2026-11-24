import { describe, expect, it } from 'vitest';
import type { ActivityItem, AgentView, EngineCheck } from '../src/shared/protocol.js';
import { SUBJECT_MAX_CHARS } from '../src/shared/protocol.js';
import { POSITIONS, positionById } from '../src/shared/positions.js';
import {
  callOf,
  chooseCustom,
  chooseEngine,
  withRoomDefaults,
  choosePosition,
  CUSTOM_ROLE,
  editRequest,
  engineHint,
  engineNote,
  engineOptions,
  hireRequest,
  initialValues,
  needsBypassConfirm,
  cleanRoomOf,
  payloadOf,
  payloadOffOf,
  payloadRows,
  positionShort,
  positionTag,
  submitLabel,
  validate,
} from '../src/client/form.js';
import type { Values } from '../src/client/form.js';
import { chipOf, FILTERS, filterCounts, filterItems, legendOf, noteOf, replyRequest, routeText, subjectOf, trafficOf } from '../src/client/loop.js';
import { briefSentText } from '../src/client/wording.js';

function agent(name: string, desk: number, extra: Partial<AgentView> = {}): AgentView {
  return {
    name,
    role: 'a role',
    dir: '/work',
    mode: 'default',
    desk,
    boss: desk === 0,
    state: 'idle',
    stateSince: 1,
    needsKind: null,
    needsReason: null,
    transition: null,
    draft: false,
    held: null,
    queued: 0,
    dirty: false,
    generation: 1,
    exit: null,
    position: null,
    provider: 'claude',
    command: null,
    ...extra,
  } as AgentView;
}

function item(id: string, from: string, to: string, extra: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id,
    from,
    to,
    subject: 'subject',
    body: 'body',
    inReplyTo: null,
    hops: 1,
    at: 1,
    status: 'queued',
    note: null,
    updatedAt: 1,
    truncated: false,
    ...extra,
  };
}

const EMPTY: Values = { provider: 'claude', position: '', name: '', role: '', dir: '/work', mode: 'default', confirm: false, command: '', servers: '', skills: '', offServers: [], offSkills: [], cleanRoom: false, sandbox: '', egress: '', worktree: false, remoteControl: false, autostart: true, coauthor: true, protectedAgent: false, rules: '', model: '', effort: '', keys: [], keysRemoved: [] };

describe('staffing a seat, no position or a custom command', () => {
  it('picking a position after a custom command makes the agent a Claude one and replaces the placeholder role', () => {
    const custom = chooseCustom(EMPTY, {});
    expect(custom).toMatchObject({ provider: 'custom', position: '', role: CUSTOM_ROLE });
    const seat = choosePosition({ ...custom, name: 'logs' }, 'fido', {}, true);
    expect(seat).toMatchObject({ provider: 'claude', position: 'fido', name: 'logs', role: positionById('fido')?.role });
  });

  it('NO POSITION drops what the position filled in and keeps what was typed', () => {
    const fido = choosePosition(EMPTY, 'fido', {}, true);
    expect(choosePosition(fido, '', {}, true)).toMatchObject({ position: '', name: '', role: '' });
    const typed = { ...fido, name: 'zed', role: 'mine' };
    expect(choosePosition(typed, '', {}, true)).toMatchObject({ name: 'zed', role: 'mine' });
  });

  it('a custom command keeps a typed name and drops a suggested one', () => {
    const fido = choosePosition(EMPTY, 'fido', {}, true);
    expect(chooseCustom(fido, {}).name).toBe('');
    expect(chooseCustom({ ...fido, name: 'zed' }, {}).name).toBe('zed');
  });

  it('opens preselected from the seat or the custom flag, and ignores the seat of the boss', () => {
    const open = (target: Parameters<typeof initialValues>[0]) => initialValues(target, null, {}, '/work');
    expect(open({ mode: 'hire', position: 'guido' })).toMatchObject({ position: 'guido', name: 'guido', dir: '/work' });
    expect(open({ mode: 'hire', custom: true })).toMatchObject({ provider: 'custom', role: CUSTOM_ROLE });
    expect(open({ mode: 'hire', position: 'flight' })).toMatchObject({ position: '', name: '' });
    expect(open({ mode: 'hire' })).toMatchObject({ provider: 'claude', position: '' });
  });

  it('opens with the room\'s default mode (an engine without modes keeps ask; bypass is chosen but not confirmed), and leaves a form that was touched alone', () => {
    expect(withRoomDefaults(EMPTY, { mode: 'acceptEdits' })).toMatchObject({ mode: 'acceptEdits', confirm: false });
    expect(withRoomDefaults(EMPTY, { mode: 'bypassPermissions' })).toMatchObject({ mode: 'bypassPermissions', confirm: false });
    expect(withRoomDefaults(EMPTY, { engine: 'copilot', mode: 'auto' })).toMatchObject({ provider: 'copilot', mode: 'default' });
    expect(withRoomDefaults(EMPTY, { engine: 'opencode', mode: 'auto' })).toMatchObject({ provider: 'opencode', mode: 'auto' });
    expect(withRoomDefaults(EMPTY, {})).toEqual(EMPTY);
    const touched = { ...EMPTY, name: 'ana' };
    expect(withRoomDefaults(touched, { mode: 'auto' })).toBe(touched);
  });

  it('opens an edit with the values of the agent', () => {
    const ana = agent('ana', 1, { role: 'does it', dir: '/x', mode: 'acceptEdits', position: 'fido' });
    expect(initialValues({ mode: 'edit', name: 'ana' }, ana, { ana }, '/work')).toMatchObject({
      name: 'ana',
      role: 'does it',
      dir: '/x',
      mode: 'acceptEdits',
      position: 'fido',
    });
  });

  it('hires a custom command with the placeholder role', () => {
    const values: Values = { ...chooseCustom(EMPTY, {}), name: 'logs', command: 'tail -f x' };
    expect(validate(values, {}, null, false)).toEqual({});
    expect(hireRequest(values)).toMatchObject({ provider: 'custom', role: CUSTOM_ROLE, command: 'tail -f x' });
  });
});

describe('the engine (Engine Bay)', () => {
  it('lists every engine but the custom command, installed ones first, saying what is missing or unknown', () => {
    const options = engineOptions(['gemini', 'claude', 'custom']);
    expect(options.map((o) => o.provider)).toEqual(['claude', 'gemini', 'antigravity', 'codex', 'opencode', 'qwen', 'grok', 'kimi', 'crush', 'pi', 'copilot', 'cursor']);
    expect(options[0]?.text).toBe('Claude Code');
    expect(options[1]?.text).toBe('Gemini CLI');
    expect(options.find((o) => o.provider === 'codex')?.text).toBe('Codex · not installed · unverified');
    expect(options.find((o) => o.provider === 'pi')?.text).toBe('pi · not installed');
    expect(options.find((o) => o.provider === 'crush')?.text).toBe('Crush · not installed · unverified · no mail');
  });

  it('a position keeps the engine; an engine without permission modes runs in default and drops the bypass tick', () => {
    const gemini = chooseEngine({ ...EMPTY, mode: 'bypassPermissions', confirm: true }, 'gemini');
    expect(gemini).toMatchObject({ provider: 'gemini', mode: 'bypassPermissions', confirm: false });
    expect(needsBypassConfirm(gemini, null)).toBe(true);
    expect(choosePosition(gemini, 'fido', {}, true).provider).toBe('gemini');
    const crush = chooseEngine(gemini, 'crush');
    expect(crush.mode).toBe('default');
    expect(needsBypassConfirm({ ...crush, mode: 'bypassPermissions' }, null)).toBe(false);
    // pi and opencode take the modes through gonogo's tool gate: the mode stays, and bypass needs its tick again
    for (const engine of ['pi', 'opencode'] as const) expect(chooseEngine(gemini, engine)).toMatchObject({ mode: 'bypassPermissions', confirm: false });
  });

  it('sends the engine with the hire, and no mode an engine cannot use', () => {
    const values: Values = { ...EMPTY, name: 'gem', role: 'r', provider: 'gemini', mode: 'acceptEdits' };
    expect(hireRequest(values)).toEqual({ name: 'gem', role: 'r', dir: '/work', mode: 'acceptEdits', provider: 'gemini' });
    expect(hireRequest({ ...values, provider: 'crush', mode: 'bypassPermissions', confirm: true })).toEqual({ name: 'gem', role: 'r', dir: '/work', mode: 'default', provider: 'crush' });
    expect(hireRequest({ ...values, provider: 'pi', mode: 'acceptEdits' })).toEqual({ name: 'gem', role: 'r', dir: '/work', mode: 'acceptEdits', provider: 'pi' });
    const cr = agent('cr', 1, { provider: 'crush' });
    expect(editRequest({ ...EMPTY, name: 'cr', role: 'a role', provider: 'crush', mode: 'acceptEdits' }, cr, false)).toBeNull();
  });

  it('the hint says where the state comes from, whether mail arrives and how far it was checked', () => {
    expect(engineHint('claude')).toBe('Its hooks report working, idle and needs you. Gets mail through the gonogo tools.');
    expect(engineHint('gemini')).toContain('Checked against the installed program, not run with a model.');
    expect(engineHint('qwen')).toBe('Lit while it prints; no Max Q slot. No mail and no votes. Written from its docs, not tried here.');
  });
});

describe('position tiles', () => {
  it('shortens every summary to the words before the first colon or comma', () => {
    expect(POSITIONS.map((p) => positionShort(p.summary))).toEqual([
      'The boss',
      'Planner',
      'Architect',
      'Backend and core logic',
      'Frontend',
      'Data',
      'Integrations',
      'Infrastructure',
      'Build and release',
      'Tests and debugging',
      'Adversarial tester',
      'Code reviewer',
      'Keeps the repository and the workspace clean',
      'Security reviewer',
      'Docs',
      'Reporter',
    ]);
  });

  it('tags the boss seat, the picked one, a staffed one and an open one', () => {
    const [flight, fao] = [positionById('flight'), positionById('fao')];
    if (flight === null || fao === null) throw new Error('missing position');
    expect(positionTag(flight, false, true)).toBe('THE BOSS HOLDS IT');
    expect(positionTag(fao, true, true)).toBe('PICKED');
    expect(positionTag(fao, false, true)).toBe('STAFFED · ADD ANOTHER');
    expect(positionTag(fao, false, false)).toBe('OPEN');
  });
});

describe('the big button', () => {
  it('names the call sign of the position, else the typed name, else a console', () => {
    expect(callOf({ ...EMPTY, position: 'fido', name: 'fido-2' })).toBe('FIDO');
    expect(callOf({ ...EMPTY, name: 'logs' })).toBe('LOGS');
    expect(callOf(EMPTY)).toBe('A CONSOLE');
  });

  it('says what to fix first, in the order of the fields, while the form is invalid', () => {
    const custom: Values = { ...chooseCustom(EMPTY, {}), name: 'logs', command: '["tail","-f"' };
    expect(submitLabel(validate(custom, {}, null, false), 'LOGS', false)).toBe('FIX THE COMMAND TO STAFF LOGS');
    expect(submitLabel(validate(EMPTY, {}, null, false), 'A CONSOLE', false)).toBe('FIX THE NAME TO STAFF A CONSOLE');
    expect(submitLabel({ dir: 'x' }, 'FIDO', false)).toBe('FIX THE DIRECTORY TO STAFF FIDO');
  });

  it('asks for the tick of a bypass, then says UNGUARDED', () => {
    const bypass: Values = { ...EMPTY, name: 'ana', role: 'r', mode: 'bypassPermissions' };
    expect(submitLabel(validate(bypass, {}, null, false), 'ANA', true)).toBe('TICK THE BOX TO STAFF ANA');
    expect(submitLabel(validate({ ...bypass, confirm: true }, {}, null, false), 'ANA', true)).toBe('STAFF ANA UNGUARDED');
    expect(submitLabel({}, 'ANA', false)).toBe('STAFF ANA');
  });
});

describe('the bypass confirmation', () => {
  const bypassing = agent('ana', 1, { mode: 'bypassPermissions' });
  const same: Values = { ...EMPTY, name: 'ana', role: 'a role', mode: 'bypassPermissions' };

  it('is needed when bypass is chosen, not for a custom command or an agent that already bypasses', () => {
    expect(needsBypassConfirm(same, null)).toBe(true);
    expect(needsBypassConfirm(same, agent('ana', 1))).toBe(true);
    expect(needsBypassConfirm(same, bypassing)).toBe(false);
    expect(needsBypassConfirm({ ...same, provider: 'custom' }, null)).toBe(false);
  });

  it('lets an agent that already bypasses be edited without a tick, and sends no confirmBypass for it', () => {
    expect(validate(same, { ana: bypassing }, bypassing, true)).toEqual({});
    expect(editRequest({ ...same, role: 'new' }, bypassing, true)).toEqual({ role: 'new' });
  });

  it('protects an agent the boss hired by rule from fire_agent, and only that one', () => {
    const hired = { ...bypassing, hiredBy: 'boss' as const };
    const form = { ...same, name: 'ana' };
    expect(editRequest({ ...form, protectedAgent: true }, hired, true)).toEqual({ protected: true });
    expect(editRequest({ ...form, protectedAgent: false }, { ...hired, protected: true }, true)).toEqual({ protected: false });
    expect(editRequest({ ...form, protectedAgent: true }, bypassing, true)).toBeNull();
  });

  it('is not needed for auto, which sends no confirmBypass either', () => {
    const auto: Values = { ...same, mode: 'auto' };
    expect(needsBypassConfirm(auto, null)).toBe(false);
    expect(validate(auto, {}, null, false)).toEqual({});
    expect(editRequest(auto, agent('ana', 1), true)).toEqual({ mode: 'auto' });
  });

  it('sends confirmBypass when an agent is switched to bypass and ticked', () => {
    const ana = agent('ana', 1);
    expect(validate(same, { ana }, ana, true).confirmBypass).toBeDefined();
    expect(editRequest({ ...same, confirm: true }, ana, true)).toEqual({ mode: 'bypassPermissions', confirmBypass: true });
  });
});

describe('the payload fold', () => {
  const files = { command: 'npx', args: ['-y', 'x'] };
  const filled: Values = { ...EMPTY, name: 'ana', role: 'a role', servers: JSON.stringify({ files }), skills: ' /skills/review \n\n/skills/triage' };

  it('reads the servers text and the skill lines into a payload, and none when both are empty', () => {
    expect(payloadOf(filled)).toEqual({ mcpServers: { files }, skills: ['/skills/review', '/skills/triage'] });
    expect(payloadOf({ ...filled, skills: '' })).toEqual({ mcpServers: { files } });
    expect(payloadOf({ ...filled, servers: '  ' })).toEqual({ skills: ['/skills/review', '/skills/triage'] });
    expect(payloadOf({ ...filled, servers: '{}', skills: '' })).toBeNull();
    expect(payloadOf(EMPTY)).toBeNull();
  });

  it('keeps only what the engine takes: servers for gemini, both for pi, nothing for a custom command or codex', () => {
    expect(payloadOf({ ...filled, provider: 'gemini' })).toEqual({ mcpServers: { files } });
    expect(payloadOf({ ...filled, provider: 'pi' })).toEqual({ mcpServers: { files }, skills: ['/skills/review', '/skills/triage'] });
    expect(payloadOf({ ...filled, provider: 'codex' })).toBeNull();
    expect(payloadOf({ ...filled, provider: 'custom', command: 'htop' })).toBeNull();
  });

  it('flags text that is not a JSON object and skill lines that are not absolute, and nothing for an engine without a payload', () => {
    expect(validate(filled, {}, null, false)).toEqual({});
    expect(validate({ ...filled, servers: '{' }, {}, null, false)['payload.mcpServers']).toBe('Not a JSON object of servers.');
    expect(validate({ ...filled, servers: '[]' }, {}, null, false)['payload.mcpServers']).toBe('Not a JSON object of servers.');
    expect(validate({ ...filled, skills: 'skills/review' }, {}, null, false)['payload.skills']).toBe('Use absolute paths: each starts with /.');
    expect(validate({ ...filled, provider: 'codex', servers: '{' }, {}, null, false)).toEqual({});
    expect(submitLabel({ 'payload.mcpServers': 'x' }, 'ANA', false)).toBe('FIX THE PAYLOAD TO STAFF ANA');
  });

  it('puts the payload in the hire request only when there is one', () => {
    expect(hireRequest(filled)).toMatchObject({ payload: { mcpServers: { files }, skills: ['/skills/review', '/skills/triage'] } });
    expect(hireRequest(EMPTY)).not.toHaveProperty('payload');
  });

  it('starts the edit form from the stored payload, and sends only a changed payload, null to take it away', () => {
    const stored = agent('ana', 1, { payload: { mcpServers: { files }, skills: ['/skills/review'] } });
    const values = initialValues({ mode: 'edit', name: 'ana' }, stored, { ana: stored }, '/cwd');
    expect(JSON.parse(values.servers)).toEqual({ files });
    expect(values.skills).toBe('/skills/review');
    expect(editRequest(values, stored, true)).toBeNull();
    expect(editRequest({ ...values, skills: '/skills/review\n/skills/triage' }, stored, true)).toEqual({
      payload: { mcpServers: { files }, skills: ['/skills/review', '/skills/triage'] },
    });
    expect(editRequest({ ...values, servers: '', skills: '' }, stored, true)).toEqual({ payload: null });
    const plain = agent('ben', 2);
    expect(editRequest(initialValues({ mode: 'edit', name: 'ben' }, plain, { ben: plain }, '/cwd'), plain, true)).toBeNull();
  });
});

describe('the Clean Room box', () => {
  const base: Values = { ...EMPTY, name: 'ana', role: 'does things' };
  const on: Values = { ...base, cleanRoom: true };

  it('is in the hire request as {} when ticked for Claude Code, and nowhere when not', () => {
    expect(hireRequest(on)).toMatchObject({ cleanRoom: {} });
    expect(hireRequest(base)).not.toHaveProperty('cleanRoom');
    expect(cleanRoomOf(on, null)).toEqual({});
    expect(cleanRoomOf(base, null)).toBeNull();
  });

  it('carries the sandbox flavor: empty is the room\'s default (no field), a flavor replaces the saved one and keeps the image', () => {
    expect(cleanRoomOf({ ...on, sandbox: 'gvisor' }, null)).toEqual({ flavor: 'gvisor' });
    expect(hireRequest({ ...on, sandbox: 'microvm' })).toMatchObject({ cleanRoom: { flavor: 'microvm' } });
    const saved = { cleanRoom: { image: 'mine', flavor: 'gvisor' as const } } as AgentView;
    expect(cleanRoomOf({ ...on, sandbox: '' }, saved)).toEqual({ image: 'mine' });
    expect(cleanRoomOf({ ...on, sandbox: 'docker' }, saved)).toEqual({ image: 'mine', flavor: 'docker' });
    expect(initialValues({ mode: 'edit', name: 'ana' }, { ...saved, name: 'ana' } as AgentView, { ana: saved }, '/work').sandbox).toBe('gvisor');
  });

  it('the API key box: follow the room (nothing sent), keep it out, or leave it in; the stored image stays', () => {
    expect(cleanRoomOf({ ...on, egress: 'on' }, null)).toEqual({ egress: true });
    expect(cleanRoomOf({ ...on, egress: 'off' }, null)).toEqual({ egress: false });
    expect(hireRequest({ ...on, egress: 'on' })).toMatchObject({ cleanRoom: { egress: true } });
    const stored = agent('ana', 1, { cleanRoom: { image: 'my/image', egress: true } });
    const values = initialValues({ mode: 'edit', name: 'ana' }, stored, { ana: stored }, '/cwd');
    expect(values.egress).toBe('on');
    expect(editRequest(values, stored, true)).toBeNull();
    expect(cleanRoomOf({ ...values, egress: '' }, stored)).toEqual({ image: 'my/image' });
    expect(editRequest({ ...values, egress: 'off' }, stored, true)).toEqual({ cleanRoom: { image: 'my/image', egress: false } });
    expect(editRequest({ ...values, egress: '' }, stored, true)).toEqual({ cleanRoom: { image: 'my/image' } });
    // for an agent that has none of it, the box starts on "follow the room"
    expect(initialValues({ mode: 'edit', name: 'bo' }, agent('bo', 1, { cleanRoom: {} }), {}, '/cwd').egress).toBe('');
  });

  it('is never sent for another engine, and turning to one clears it', () => {
    expect(hireRequest({ ...on, provider: 'gemini' })).not.toHaveProperty('cleanRoom');
    expect(cleanRoomOf({ ...on, provider: 'custom' }, null)).toBeNull();
    expect(chooseEngine(on, 'gemini').cleanRoom).toBe(false);
    expect(chooseEngine(on, 'claude').cleanRoom).toBe(true);
    expect(chooseCustom(on, {}).cleanRoom).toBe(false);
  });

  it('starts the edit form from the stored setting, sends only a change, and null to turn it off', () => {
    const stored = agent('ana', 1, { cleanRoom: { image: 'my/image' } });
    const values = initialValues({ mode: 'edit', name: 'ana' }, stored, { ana: stored }, '/cwd');
    expect(values.cleanRoom).toBe(true);
    expect(editRequest(values, stored, true)).toBeNull();
    // a setting that came through the API (an image) is kept while the box stays ticked
    expect(cleanRoomOf(values, stored)).toEqual({ image: 'my/image' });
    expect(editRequest({ ...values, cleanRoom: false }, stored, true)).toEqual({ cleanRoom: null });
    const plain = agent('ben', 2, { cleanRoom: null });
    const plainValues = initialValues({ mode: 'edit', name: 'ben' }, plain, { ben: plain }, '/cwd');
    expect(plainValues.cleanRoom).toBe(false);
    expect(editRequest(plainValues, plain, true)).toBeNull();
    expect(editRequest({ ...plainValues, cleanRoom: true }, plain, true)).toEqual({ cleanRoom: {} });
  });
});

describe('the model field (Engine Bay)', () => {
  const base: Values = { ...EMPTY, name: 'ana', role: 'does things' };

  it('is in the hire request trimmed, for an engine that takes one, and nowhere when empty', () => {
    expect(hireRequest({ ...base, model: ' sonnet ' })).toMatchObject({ model: 'sonnet' });
    expect(hireRequest({ ...base, model: '  ' })).not.toHaveProperty('model');
    expect(hireRequest(base)).not.toHaveProperty('model');
    expect(hireRequest({ ...base, provider: 'gemini', model: 'flash' })).toMatchObject({ model: 'flash' });
  });

  it('is never sent for an engine without a model setting, a custom command included', () => {
    expect(hireRequest({ ...base, provider: 'copilot', model: 'x' })).not.toHaveProperty('model');
    expect(hireRequest({ ...chooseCustom(base, {}), name: 'logs', command: 'htop', model: 'x' })).not.toHaveProperty('model');
    expect(validate({ ...base, provider: 'copilot', model: '--bad' }, {}, null, false)).toEqual({});
  });

  it('turning to another engine empties it, because the engines name their models differently', () => {
    expect(chooseEngine({ ...base, model: 'sonnet' }, 'gemini').model).toBe('');
    expect(chooseCustom({ ...base, model: 'sonnet' }, {}).model).toBe('');
  });

  it.each(['-x', '--model', 'a b', 'a;b', '$(id)', 'x'.repeat(101)])('refuses %j', (model) => {
    expect(validate({ ...base, model }, {}, null, false).model).toMatch(/Use letters/);
    expect(submitLabel({ model: 'x' }, 'ANA', false)).toBe('FIX THE MODEL TO STAFF ANA');
  });

  it.each(['sonnet', 'claude-sonnet-4', 'openai/gpt-4o', 'sonnet:high', 'o3.mini', 'a@b+c'])('accepts %j', (model) => {
    expect(validate({ ...base, model }, {}, null, false)).toEqual({});
  });

  it('starts the edit form from the stored model, sends only a change, and null to go back to the default', () => {
    const stored = agent('ana', 1, { model: 'opus' });
    const values = initialValues({ mode: 'edit', name: 'ana' }, stored, { ana: stored }, '/cwd');
    expect(values.model).toBe('opus');
    expect(editRequest(values, stored, true)).toBeNull();
    expect(editRequest({ ...values, model: 'haiku' }, stored, true)).toEqual({ model: 'haiku' });
    expect(editRequest({ ...values, model: ' ' }, stored, true)).toEqual({ model: null });
    const plain = agent('ben', 2, { model: null });
    expect(editRequest(initialValues({ mode: 'edit', name: 'ben' }, plain, { ben: plain }, '/cwd'), plain, true)).toBeNull();
  });
});

describe('the keys of Clearance', () => {
  const SECRET = 'sk-test-0123456789';
  const base: Values = { ...EMPTY, name: 'ana', role: 'does things' };
  const withRow = (name: string, value: string): Values => ({ ...base, keys: [{ name, value }] });

  it('go in the hire request by name, trimmed, and an empty row is nothing', () => {
    expect(hireRequest(withRow(' OPENAI_API_KEY ', ` ${SECRET} `))).toMatchObject({ keys: { OPENAI_API_KEY: SECRET } });
    expect(hireRequest({ ...base, keys: [{ name: '', value: '' }] })).not.toHaveProperty('keys');
    expect(hireRequest(base)).not.toHaveProperty('keys');
    expect(validate({ ...base, keys: [{ name: '', value: '' }] }, {}, null, false)).toEqual({});
  });

  it('go in the request of a custom command and of every engine', () => {
    expect(hireRequest({ ...withRow('OPENAI_API_KEY', SECRET), provider: 'gemini' })).toMatchObject({ keys: { OPENAI_API_KEY: SECRET } });
    expect(hireRequest({ ...chooseCustom(withRow('OPENAI_API_KEY', SECRET), {}), name: 'logs', command: 'htop' })).toMatchObject({ keys: { OPENAI_API_KEY: SECRET } });
  });

  it.each([
    ['a lower case name', withRowOf('openai', SECRET)],
    ['a name with a dash', withRowOf('A-B', SECRET)],
    ['no name', withRowOf('', SECRET)],
    ['no value', withRowOf('OPENAI_API_KEY', '')],
    ['a value with a space inside', withRowOf('OPENAI_API_KEY', 'a b')],
    ['a value over 4096 characters', withRowOf('OPENAI_API_KEY', 'x'.repeat(4097))],
  ])('refuses %s, and says nothing of the value', (_what, values) => {
    const problem = validate(values, {}, null, false).keys ?? '';
    expect(problem).toMatch(/^Key 1:/);
    expect(problem).not.toContain(SECRET);
    expect(submitLabel({ keys: problem }, 'ANA', false)).toBe('FIX THE KEYS TO STAFF ANA');
  });

  it('refuses a name used twice and more than 16 keys, counting those already set', () => {
    expect(validate({ ...base, keys: [{ name: 'A_KEY', value: 'x' }, { name: 'A_KEY', value: 'y' }] }, {}, null, false).keys).toBe('Key 2: the name is used twice.');
    const stored = agent('ana', 1, { keys: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`K${i}`, 1])) });
    const values = initialValues({ mode: 'edit', name: 'ana' }, stored, { ana: stored }, '/cwd');
    expect(validate({ ...values, keys: [{ name: 'ONE_MORE', value: 'x' }] }, { ana: stored }, stored, true).keys).toBe('At most 16 keys.');
    // replacing one, or removing one to make room, is fine
    expect(validate({ ...values, keys: [{ name: 'K1', value: 'x' }] }, { ana: stored }, stored, true).keys).toBeUndefined();
    expect(validate({ ...values, keys: [{ name: 'ONE_MORE', value: 'x' }], keysRemoved: ['K0'] }, { ana: stored }, stored, true).keys).toBeUndefined();
  });

  it('an edit sends only what was typed or marked for removal, and a stored key is never in the form', () => {
    const stored = agent('ana', 1, { keys: { OPENAI_API_KEY: 5, GEMINI_API_KEY: 6 } });
    const values = initialValues({ mode: 'edit', name: 'ana' }, stored, { ana: stored }, '/cwd');
    expect(values.keys).toEqual([]);
    expect(editRequest(values, stored, true)).toBeNull();
    expect(editRequest({ ...values, keysRemoved: ['GEMINI_API_KEY'] }, stored, true)).toEqual({ keys: { GEMINI_API_KEY: null } });
    expect(editRequest({ ...values, keys: [{ name: 'OPENAI_API_KEY', value: SECRET }], keysRemoved: ['GEMINI_API_KEY'] }, stored, true)).toEqual({ keys: { OPENAI_API_KEY: SECRET, GEMINI_API_KEY: null } });
    // a name marked for removal that is not set (a stale click) is not sent
    expect(editRequest({ ...values, keysRemoved: ['GONE_KEY'] }, stored, true)).toBeNull();
    // typed again for a key marked for removal: the value wins
    expect(editRequest({ ...values, keys: [{ name: 'GEMINI_API_KEY', value: 'g' }], keysRemoved: ['GEMINI_API_KEY'] }, stored, true)).toEqual({ keys: { GEMINI_API_KEY: 'g' } });
    const custom = agent('tail', 2, { provider: 'custom', command: 'htop', keys: {} });
    expect(editRequest({ ...initialValues({ mode: 'edit', name: 'tail' }, custom, { tail: custom }, '/cwd'), keys: [{ name: 'A_KEY', value: 'v' }] }, custom, true)).toEqual({ keys: { A_KEY: 'v' } });
  });

  function withRowOf(name: string, value: string): Values {
    return { ...base, keys: [{ name, value }] };
  }
});

describe('the engine note (Pad Check)', () => {
  const check = (over: Partial<EngineCheck> = {}): EngineCheck => ({ provider: 'codex', label: 'Codex', bin: 'codex', path: null, version: null, install: 'npm install -g @openai/codex', docs: 'https://github.com/openai/codex', ...over });

  it('a missing program: where to find it, the vendor\'s command to copy, the page', () => {
    expect(engineNote('codex', ['claude', 'custom'], undefined)).toEqual({
      found: false,
      text: 'codex is not on the PATH of the machine gonogo runs on.',
      install: 'npm install -g @openai/codex',
      docs: 'https://github.com/openai/codex',
    });
    expect(engineNote('codex', [], check()).install).toBe('npm install -g @openai/codex');
  });

  it('a program with no install command that was checked says so by giving none', () => {
    expect(engineNote('kimi', [], undefined)).toMatchObject({ found: false, install: null, docs: 'https://moonshotai.github.io/kimi-cli/' });
  });

  it('a program that is there: its path and version when Pad Check has answered, no command', () => {
    expect(engineNote('codex', ['codex'], undefined)).toEqual({ found: true, text: 'Codex found.', install: null, docs: 'https://github.com/openai/codex' });
    expect(engineNote('codex', ['codex'], check({ path: '/bin/codex', version: 'codex 0.1.2' })).text).toBe('Codex found at /bin/codex, codex 0.1.2.');
    expect(engineNote('codex', ['codex'], check({ path: '/bin/codex' })).text).toBe('Codex found at /bin/codex.');
  });

  it('a program installed after the server started shows as found once Pad Check sees it', () => {
    expect(engineNote('codex', ['claude'], check({ path: '/bin/codex', version: '1' }))).toMatchObject({ found: true, install: null });
  });
});

describe('comm loop filters and counts', () => {
  const items = [
    item('m1', 'flight', 'user', { status: 'to_user' }),
    item('m2', 'guido', 'surgeon', { status: 'held' }),
    item('m3', 'control', 'pao', { status: 'undelivered' }),
    item('m4', 'user', 'flight', { status: 'read' }),
  ];

  it('counts each filter over every item', () => {
    expect(filterCounts(items)).toEqual({ all: 4, you: 1, held: 1, lost: 1 });
    expect(filterCounts([])).toEqual({ all: 0, you: 0, held: 0, lost: 0 });
  });

  it('keeps what a filter selects, in order', () => {
    expect(FILTERS.map((f) => f.label)).toEqual(['ALL', 'TO YOU', 'HELD', 'UNDELIVERED']);
    expect(filterItems(items, 'all')).toHaveLength(4);
    expect(filterItems(items, 'you').map((i) => i.id)).toEqual(['m1']);
    expect(filterItems(items, 'held').map((i) => i.id)).toEqual(['m2']);
    expect(filterItems(items, 'lost').map((i) => i.id)).toEqual(['m3']);
  });
});

describe('comm loop rows', () => {
  it('lights the chip of mail for the Director, ambers a hold, oranges a loss and quiets the rest', () => {
    const chip = (status: ActivityItem['status']) => chipOf(item('m', 'a', 'b', { status }));
    expect(chip('to_user')).toEqual({ text: 'TO YOU', tone: 'lit' });
    expect(chip('held')).toEqual({ text: 'HELD', tone: 'amber' });
    expect(chip('undelivered')).toEqual({ text: 'UNDELIVERED', tone: 'nogo' });
    expect(chip('queued')).toEqual({ text: 'QUEUED', tone: 'quiet' });
    expect(chip('delivered')).toEqual({ text: 'DELIVERED', tone: 'quiet' });
    expect(chip('read')).toEqual({ text: 'READ', tone: 'quiet' });
  });

  const agents = {
    flight: agent('flight', 0),
    ana: agent('ana', 1, { position: 'fido' }),
    ben: agent('ben', 2),
  };

  it('names the Director, FLIGHT, a call sign and a plain name in capitals', () => {
    expect(legendOf('user', agents)).toBe('DIRECTOR');
    expect(legendOf('flight', agents)).toBe('FLIGHT');
    expect(legendOf('ana', agents)).toBe('FIDO');
    expect(legendOf('ben', agents)).toBe('BEN');
    expect(legendOf('gone', agents)).toBe('GONE');
    expect(legendOf('constructor', agents)).toBe('CONSTRUCTOR');
  });

  it('writes the route as FROM › TO', () => {
    expect(routeText(item('m', 'ana', 'user'), agents)).toBe('FIDO › DIRECTOR');
    expect(routeText(item('m', 'user', 'flight'), agents)).toBe('DIRECTOR › FLIGHT');
  });

  it('shows the subject, else the first line of the body, and the note in the room words', () => {
    expect(subjectOf(item('m', 'a', 'b', { subject: 'Hello' }))).toBe('Hello');
    expect(subjectOf(item('m', 'a', 'b', { subject: ' ', body: '\nFirst\nSecond' }))).toBe('First');
    expect(noteOf(item('m', 'a', 'b'))).toBe('');
    expect(noteOf(item('m', 'a', 'b', { note: 'waiting: load limit (2 of 3 agents working)' }))).toBe(
      'waiting for Max Q: 2 of 3 agents working',
    );
  });

  it('answers the sender in the same thread, and cuts a long subject', () => {
    expect(replyRequest(item('m7', 'flight', 'user', { subject: 'Done' }), 'Go')).toEqual({
      to: 'flight',
      subject: 'Re: Done',
      body: 'Go',
      inReplyTo: 'm7',
    });
    expect(replyRequest(item('m8', 'ana', 'user', { subject: '' }), 'ok').subject).toBe('');
    expect(replyRequest(item('m9', 'ana', 'user', { subject: 'x'.repeat(500) }), 'ok').subject).toHaveLength(SUBJECT_MAX_CHARS);
  });

  it('takes the last three messages to or from one agent', () => {
    const list = [
      item('m5', 'ana', 'user'),
      item('m4', 'ben', 'flight'),
      item('m3', 'flight', 'ana'),
      item('m2', 'ana', 'ben'),
      item('m1', 'flight', 'ana'),
    ];
    expect(trafficOf(list, 'ana').map((i) => i.id)).toEqual(['m5', 'm3', 'm2']);
    expect(trafficOf(list, 'ana', 5)).toHaveLength(4);
    expect(trafficOf(list, 'nobody')).toEqual([]);
  });
});

describe('the confirmation under the brief box', () => {
  it('names the agent as the room does while matching the note of the server', () => {
    expect(briefSentText('waiting: flight is working', 'flight', 'FLIGHT')).toBe('Sent. FLIGHT is working and will see it when its turn ends.');
    expect(briefSentText('waiting: flight is working', 'flight')).toBe('Sent. flight is working and will see it when its turn ends.');
    expect(briefSentText(null, 'flight', 'FLIGHT')).toBe('Sent.');
    expect(briefSentText('something new', 'flight', 'FLIGHT')).toBe('Sent. FLIGHT will see it as soon as it can.');
  });
});

describe('the worktree box', () => {
  const base: Values = { ...EMPTY, name: 'ana', role: 'does things' };

  it('is in the hire request as {} when ticked, for any engine, and nowhere when not', () => {
    expect(hireRequest({ ...base, worktree: true })).toMatchObject({ worktree: {} });
    expect(hireRequest({ ...base, provider: 'gemini', worktree: true })).toMatchObject({ worktree: {} });
    expect(hireRequest(base)).not.toHaveProperty('worktree');
  });

  it('is off while Clean Room is ticked, which has a worktree of its own', () => {
    expect(hireRequest({ ...base, cleanRoom: true, worktree: true })).not.toHaveProperty('worktree');
    expect(chooseEngine({ ...base, cleanRoom: true, worktree: true }, 'claude').worktree).toBe(false);
  });

  it('is an edit when it changes, and null turns it off', () => {
    const off = agent('ana', 1, { role: 'does things', dir: '/work', worktree: null });
    const values: Values = { ...EMPTY, name: 'ana', role: 'does things', dir: '/work', mode: off.mode };
    expect(editRequest({ ...values, worktree: true }, off, false)).toEqual({ worktree: {} });
    const on = agent('ana', 1, { role: 'does things', dir: '/work', worktree: {} });
    expect(editRequest({ ...values, worktree: false }, on, false)).toEqual({ worktree: null });
    expect(editRequest({ ...values, worktree: true }, on, false)).toBeNull();
  });
});

describe('Payload fold: what a console starts with and where each item comes from', () => {
  const room = {
    mcpServers: [
      { name: 'files', type: 'stdio' as const, target: 'npx', args: 2, names: [] },
      { name: 'web', type: 'http' as const, target: 'https://x.test', args: 0, names: ['Authorization'] },
    ],
    skills: [{ name: 'review', path: '/s/review' }],
  };
  const rowsOf = (extra: Partial<Values>, defaults: typeof room | null = room): string[] =>
    payloadRows(defaults, { ...EMPTY, ...extra }).map((r) => `${r.from}:${r.kind}:${r.name}:${r.on ? 'on' : 'off'}${r.canSwitch || r.from === 'agent' ? '' : ':fixed'}${r.note === '' ? '' : `:${r.note}`}`);

  it('lists the room items on, then the console\'s own; the console wins by name', () => {
    expect(rowsOf({})).toEqual(['room:server:files:on', 'room:server:web:on', 'room:skill:review:on']);
    expect(rowsOf({ servers: '{"files":{"command":"mine"},"extra":{"command":"x"}}', skills: '/mine/review/' })).toEqual([
      "room:server:files:off:fixed:replaced by this agent's own",
      'room:server:web:on',
      "room:skill:review:off:fixed:replaced by this agent's own",
      'agent:server:files:on',
      'agent:server:extra:on',
      'agent:skill:review:on',
    ]);
  });
  describe('the global servers (claude mcp add --scope user)', () => {
    const view = (over: { host?: boolean; cleanRoom?: boolean } = {}) => ({
      host: over.host ?? true,
      cleanRoom: over.cleanRoom ?? false,
      source: 'global (claude mcp --scope user)',
      servers: [
        { name: 'pulsar', type: 'http' as const, target: 'https://gamma.pulsar.codes', overriddenBy: null },
        { name: 'web', type: 'http' as const, target: 'https://x.test', overriddenBy: 'room' as const },
        { name: 'mine', type: 'stdio' as const, target: 'npx', overriddenBy: null },
      ],
    });
    const globalRows = (extra: Partial<Values>, g = view()): string[] =>
      payloadRows(room, { ...EMPTY, ...extra }, g).map((r) => `${r.from}:${r.kind}:${r.name}:${r.on ? 'on' : 'off'}${r.canSwitch || r.from === 'agent' ? '' : ':fixed'}${r.note === '' ? '' : `:${r.note}`}`);

    it('come first, a room default or the console\'s own of the same name replaces one, and a switched-off one can be switched back', () => {
      expect(globalRows({})).toEqual([
        'global:server:pulsar:on',
        'global:server:web:off:fixed:replaced by a room default',
        'global:server:mine:on',
        'room:server:files:on',
        'room:server:web:on',
        'room:skill:review:on',
      ]);
      expect(globalRows({ servers: '{"mine":{"command":"x"}}' }).filter((r) => r.startsWith('global:server:mine'))).toEqual(["global:server:mine:off:fixed:replaced by this agent's own"]);
      expect(globalRows({ offServers: ['pulsar'] })[0]).toBe('global:server:pulsar:off:switched off for this agent');
    });

    it('follow the room\'s two switches: a Clean Room console has them only when the room says so, a host console unless it says no, and an engine that takes no servers never', () => {
      expect(globalRows({ cleanRoom: true }, view())).toEqual([]);
      expect(globalRows({ cleanRoom: true }, view({ cleanRoom: true }))).toHaveLength(3);
      expect(globalRows({}, view({ host: false }))).toEqual(['room:server:files:on', 'room:server:web:on', 'room:skill:review:on']);
      // every engine that takes servers gets them, as Claude Code does
      for (const provider of ['gemini', 'pi', 'opencode'] as const) expect(globalRows({ provider }).some((r) => r.startsWith('global')), provider).toBe(true);
      expect(globalRows({ provider: 'codex' }).some((r) => r.startsWith('global'))).toBe(false);
      expect(payloadRows(room, { ...EMPTY }, null).some((r) => r.from === 'global')).toBe(false);
    });
  });

  it('a switched-off item says so and can be switched back', () => {
    expect(rowsOf({ offServers: ['web'], offSkills: ['review'] })).toEqual(['room:server:files:on', 'room:server:web:off:switched off for this agent', 'room:skill:review:off:switched off for this agent']);
  });
  it('a Clean Room console gets none of the room\'s, an engine with servers only no skills, one with no payload nothing', () => {
    expect(rowsOf({ cleanRoom: true, servers: '{"a":{"command":"x"}}' })).toEqual(['agent:server:a:on']);
    expect(rowsOf({ provider: 'gemini' })).toEqual(['room:server:files:on', 'room:server:web:on']);
    expect(rowsOf({ provider: 'codex' })).toEqual([]);
    expect(rowsOf({}, null)).toEqual([]);
  });
  it('the switches are their own field, never part of the payload, and only for what the engine takes', () => {
    expect(payloadOf({ ...EMPTY, offServers: ['web'], offSkills: ['review'] })).toBeNull();
    expect(payloadOffOf({ ...EMPTY, offServers: ['web'], offSkills: ['review'] })).toEqual({ mcpServers: ['web'], skills: ['review'] });
    expect(payloadOffOf({ ...EMPTY, provider: 'gemini', offServers: ['web'], offSkills: ['review'] })).toEqual({ mcpServers: ['web'] });
    expect(payloadOffOf({ ...EMPTY, provider: 'codex', offServers: ['web'] })).toBeNull();
    expect(payloadOffOf(EMPTY)).toBeNull();
    expect(hireRequest({ ...EMPTY, name: 'ana', role: 'r', offServers: ['web'] })).toMatchObject({ payloadOff: { mcpServers: ['web'] } });
  });
  it('a name switched off that the room no longer has is still listed, so it can be switched back', () => {
    expect(rowsOf({ offServers: ['old'], offSkills: ['older'] })).toEqual(['room:server:files:on', 'room:server:web:on', 'room:skill:review:on', "room:server:old:off:switched off, but the room's defaults no longer have it", "room:skill:older:off:switched off, but the room's defaults no longer have it"]);
  });
});
