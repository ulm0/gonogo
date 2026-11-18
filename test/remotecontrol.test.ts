import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRecord } from '../src/shared/protocol.js';
import { createLauncher } from '../src/server/launcher.js';
import { parseRemoteControl, remoteControlName } from '../src/server/remotecontrol.js';
import { editRequest, hireRequest } from '../src/client/form.js';
import type { Values } from '../src/client/form.js';

const SID = '0b2f5c1e-6d3a-4f7e-9a1b-2c3d4e5f6a7b';

describe('parseRemoteControl', () => {
  it('takes an object with no fields, for Claude Code, and not with a Clean Room', () => {
    expect(parseRemoteControl({}, undefined, false)).toEqual({ ok: true, remoteControl: {} });
    expect(parseRemoteControl({ x: undefined }, 'claude', false)).toEqual({ ok: true, remoteControl: {} });
    for (const bad of [null, [], 'yes', 3]) expect(parseRemoteControl(bad, 'claude', false)).toEqual({ ok: false, error: 'remoteControl must be an object' });
    expect(parseRemoteControl({ name: 'x' }, 'claude', false)).toEqual({ ok: false, error: 'remoteControl has no field "name"' });
    expect(parseRemoteControl({}, 'gemini', false)).toMatchObject({ ok: false, error: expect.stringContaining('Claude Code agents only') });
    expect(parseRemoteControl({}, 'claude', true)).toMatchObject({ ok: false, error: expect.stringContaining('Clean Room') });
    expect(remoteControlName('ana')).toBe('gonogo-ana');
  });
});

describe('the launcher and --remote-control', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gonogo-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });
  const record = (patch: Partial<AgentRecord> = {}): AgentRecord => ({ name: 'ana', role: 'r', dir: home, mode: 'default', sessionId: SID, desk: 1, boss: false, createdAt: 1, ...patch });
  const start = async (agent: AgentRecord) => (await createLauncher({ homeDir: home, hubUrl: () => 'http://127.0.0.1:7777', seed: false, env: { PATH: process.env.PATH ?? '' } }).prepareStart(agent, { generation: 1, flag: null })).spec.args;

  it('adds the flag with a session name of the agent, and only when the setting is on', async () => {
    const on = await start(record({ remoteControl: {} }));
    expect(on.slice(on.indexOf('--remote-control'), on.indexOf('--remote-control') + 2)).toEqual(['--remote-control', 'gonogo-ana']);
    expect(await start(record())).not.toContain('--remote-control');
  });
});

describe('the Remote Control box of the form', () => {
  const EMPTY = { provider: 'claude', position: '', name: 'ana', role: 'does things', dir: '/work', mode: 'default', confirm: false, command: '', servers: '', skills: '', cleanRoom: false, remoteControl: false, rules: '', model: '', keys: [], keysRemoved: [] } as unknown as Values;

  it('is in the hire request as {} for Claude Code, and not with a Clean Room or another engine', () => {
    expect(hireRequest({ ...EMPTY, remoteControl: true })).toMatchObject({ remoteControl: {} });
    expect(hireRequest(EMPTY)).not.toHaveProperty('remoteControl');
    expect(hireRequest({ ...EMPTY, remoteControl: true, cleanRoom: true })).not.toHaveProperty('remoteControl');
    expect(hireRequest({ ...EMPTY, remoteControl: true, provider: 'gemini' })).not.toHaveProperty('remoteControl');
  });

  it('is an edit when it changes', () => {
    const view = { name: 'ana', role: 'does things', dir: '/work', mode: 'default', provider: 'claude', remoteControl: null, keys: {} } as never;
    expect(editRequest({ ...EMPTY, remoteControl: true }, view, false)).toEqual({ remoteControl: {} });
  });
});
