/** The words of the Runtime settings row (src/client/runtimeSettingsModel.ts) and its place in Flight Rules. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { RuntimeSettingRow } from '../src/shared/protocol.js';
import { APPLIES_TEXT, canReset, layerValue, refusalText, SETTING_TEXT, SOURCE_TEXT, startScope, summary, valueText } from '../src/client/runtimeSettingsModel.js';

const row = (patch: Partial<RuntimeSettingRow> = {}): RuntimeSettingRow => ({ key: 'maxHops', env: 'GONOGO_MAX_HOPS', scope: 'both', applies: 'live', sensitive: false, value: null, source: 'default', envValue: null, room: null, global: null, ...patch });

describe('what a setting says', () => {
  it('has a name, a help and a way to type it for each of the eight keys, and a plain warning for the two that decide what runs', () => {
    const keys = ['maxHops', 'maxWorking', 'agentCmd', 'cleanRoomImage', 'scrubEnv', 'logLevel', 'station', 'updateCheck'] as const;
    expect(Object.keys(SETTING_TEXT).sort()).toEqual([...keys].sort());
    for (const k of keys) expect(SETTING_TEXT[k].label.length).toBeGreaterThan(2);
    expect(Object.entries(SETTING_TEXT).filter(([, t]) => t.warning !== undefined).map(([k]) => k).sort()).toEqual(['agentCmd', 'scrubEnv']);
    expect(SETTING_TEXT.agentCmd.warning).toMatch(/runs with the agents/);
    expect(SETTING_TEXT.scrubEnv.warning).toMatch(/left out of the scrub reaches every agent/);
  });

  it('says where a value comes from and when a change applies', () => {
    expect(SOURCE_TEXT).toEqual({ room: 'this room', global: 'all rooms', env: 'environment', default: 'built-in default' });
    expect(APPLIES_TEXT.live).toBe('applies at once');
    expect(APPLIES_TEXT['next-start']).toMatch(/next start of an agent/);
    expect(APPLIES_TEXT.restart).toMatch(/restart/);
  });

  it('says an empty Max Q is no limit, and nothing set anywhere is "not set" (the chip says built-in default: the two never say the same words)', () => {
    expect(valueText(row({ key: 'maxWorking', value: '' }))).toBe('no limit');
    expect(valueText(row({ key: 'scrubEnv', value: '' }))).toBe('empty');
    expect(valueText(row({ value: null }))).toBe('not set');
    expect(valueText(row({ value: null }))).not.toBe(SOURCE_TEXT.default);
    expect(valueText(row({ value: '12' }))).toBe('12');
  });
});

describe('the editor', () => {
  it('opens on the layer that has a value, this room first; a setting for all rooms only is always that', () => {
    expect(startScope(row({ room: '5', global: '6' }))).toBe('room');
    expect(startScope(row({ room: null, global: '6' }))).toBe('global');
    expect(startScope(row())).toBe('room');
    expect(startScope(row({ key: 'logLevel', scope: 'global' }))).toBe('global');
  });

  it('starts with what the layer holds, and offers Reset only when the layer holds something', () => {
    expect(layerValue(row({ room: '5', global: '6' }), 'room')).toBe('5');
    expect(layerValue(row({ global: '6' }), 'room')).toBe('');
    expect(canReset(row({ room: '5' }), 'room')).toBe(true);
    expect(canReset(row({ room: '5' }), 'global')).toBe(false);
    expect(canReset(row({ room: '' }), 'room')).toBe(true); // an empty Max Q was set on purpose
  });

  it('says a refusal in words: the parser\'s reason as it is, the owner-only 403, the 409 of a room started by hand', () => {
    expect(refusalText({ message: 'max hops: use a whole number from 1 to 100', status: 400 }, 'room')).toBe('max hops: use a whole number from 1 to 100');
    expect(refusalText({ message: 'agentCmd is changed from the Director\'s own login', status: 403 }, 'room')).toBe('Only the owner’s own signed-in session can change this.');
    expect(refusalText({ message: 'this server has no supervisor', status: 409 }, 'global')).toMatch(/started by hand/);
    expect(refusalText({ message: 'conflict', status: 409 }, 'room')).toBe('conflict');
  });
});

describe('the row of Flight Rules', () => {
  it('counts what is changed here', () => {
    expect(summary([row(), row({ source: 'env' })])).toBe('all as the environment has them');
    expect(summary([row({ source: 'room' }), row({ source: 'global' }), row()])).toBe('2 changed here');
  });

  it('is in System and update, next to Features, with its block', () => {
    const rules = readFileSync('src/client/Rules.tsx', 'utf8');
    expect(rules).toMatch(/<Row name="Runtime settings" now=\{runtime\}><RuntimeSettingsBlock \/><\/Row>/);
    expect(rules.indexOf('Runtime settings')).toBeGreaterThan(rules.indexOf('<Group id="system"'));
  });
});
