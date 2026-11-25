import { describe, expect, it } from 'vitest';
import { defaultView } from '../src/shared/livery.js';
import type { AgentView, PollView } from '../src/shared/protocol.js';
import { commands, commissioningSteps, fuzzyCost, isBriefKey, isPanelKey, matchCommands, readMarks, showCommissioning, stepIndex, VIEW_NAMES } from '../src/client/shell.js';
import type { CommandInput } from '../src/client/shell.js';
import { NO_PROPELLANT } from '../src/client/store.js';

function agent(name: string, extra: Partial<AgentView> = {}): AgentView {
  return { name, boss: false, provider: 'claude', position: null, state: 'idle', transition: null, ...extra } as AgentView;
}

const flight = agent('flight', { boss: true, position: 'flight' });
const ana = agent('ana', { position: 'fido' });
const input = (extra: Partial<CommandInput> = {}): CommandInput => ({ agents: [flight, ana], legends: { flight: 'FLIGHT', ana: 'FIDO' }, poll: null, unread: 0, livery: defaultView(), ...extra });
const ids = (extra: Partial<CommandInput> = {}): string[] => commands(input(extra)).map((c) => c.id);

describe('Patch Panel lines', () => {
  it('has every console by its call sign, every view, and the actions that can run', () => {
    const list = commands(input());
    expect(list.find((c) => c.id === 'console:ana')?.label).toBe('Open FIDO');
    for (const view of Object.keys(VIEW_NAMES).filter((v) => v !== 'comms')) expect(list.map((c) => c.id)).toContain(`view:${view}`);
    expect(list.map((c) => c.id)).toEqual(expect.arrayContaining(['comms:inbox', 'comms:traffic', 'comms:threads']));
    expect(ids()).toEqual(expect.arrayContaining(['hire', 'brief', 'poll', 'livery:night-shift', 'livery:low-ink', 'livery:low-ink-dark', 'livery:high-contrast', 'livery:high-contrast-dark']));
    // the livery in use is not offered, nor reading an empty inbox
    expect(ids()).not.toContain('livery:instrument');
    expect(ids()).not.toContain('read');
    expect(ids({ unread: 2 })).toContain('read');
  });

  it('has a Rooms line only in a room behind the rooms supervisor', () => {
    expect(ids()).not.toContain('rooms');
    expect(commands(input({ inRoom: true })).find((x) => x.id === 'rooms')).toMatchObject({ label: 'Rooms', group: 'Action', act: { kind: 'rooms' } });
  });

  it('has a Docs line that opens the online docs', () => {
    expect(commands(input()).find((x) => x.id === 'docs')).toMatchObject({ label: 'Docs', group: 'Action', act: { kind: 'docs' } });
  });

  it('offers a poll only when one can start and somebody can answer it', () => {
    expect(ids({ agents: [flight] })).not.toContain('poll');
    expect(ids({ agents: [flight, agent('ana', { state: 'stopped' })] })).not.toContain('poll');
    expect(ids({ poll: { status: 'open' } as PollView })).not.toContain('poll');
    expect(ids({ agents: [ana] })).not.toContain('brief');
  });
});

describe('fuzzy match', () => {
  it('needs the letters in order, any case', () => {
    expect(fuzzyCost('fpl', 'Flight Plan')).not.toBeNull();
    expect(fuzzyCost('FLIGHT', 'flight plan')).toBe(0);
    expect(fuzzyCost('lpf', 'Flight Plan')).toBeNull();
    expect(fuzzyCost('', 'anything')).toBe(0);
  });

  it('ranks word starts and runs first, keeps the panel order on a tie, and finds hidden words last', () => {
    const list = commands(input());
    expect(matchCommands(list, 'fp')[0]?.label).toBe('Flight Plan');
    expect(matchCommands(list, 'ml')[0]?.label).toBe('Mission Log');
    expect(matchCommands(list, 'down')[0]?.label).toBe('Comms: inbox');
    expect(matchCommands(list, 'party')[0]?.label).toBe('Comms: threads');
    expect(matchCommands(list, 'loop')[0]?.label).toBe('Comms: traffic');
    expect(matchCommands(list, 'settings')[0]?.label).toBe('Flight Rules');
    expect(matchCommands(list, 'ana')[0]?.label).toBe('Open FIDO');
    expect(matchCommands(list, '').length).toBe(list.length);
    expect(matchCommands(list, 'zzzz')).toEqual([]);
  });
});

describe('Patch Panel keys', () => {
  const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
  it('opens on Cmd+K and Ctrl+K only', () => {
    expect(isPanelKey(key('k', { metaKey: true }))).toBe(true);
    expect(isPanelKey(key('K', { ctrlKey: true }))).toBe(true);
    expect(isPanelKey(key('k', {}))).toBe(false);
    expect(isPanelKey(key('k', { ctrlKey: true, shiftKey: true }))).toBe(false);
  });

  it('knows the brief key: B with Cmd or Ctrl, no Alt or Shift', () => {
    expect(isBriefKey(key('b', { metaKey: true }))).toBe(true);
    expect(isBriefKey(key('B', { ctrlKey: true }))).toBe(true);
    expect(isBriefKey(key('b', {}))).toBe(false);
    expect(isBriefKey(key('b', { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isBriefKey(key('b', { metaKey: true, altKey: true }))).toBe(false);
    expect(isBriefKey(key('k', { ctrlKey: true }))).toBe(false);
  });

  it('moves with the arrows and wraps', () => {
    expect(stepIndex(0, 3, 'ArrowDown')).toBe(1);
    expect(stepIndex(2, 3, 'ArrowDown')).toBe(0);
    expect(stepIndex(0, 3, 'ArrowUp')).toBe(2);
    expect(stepIndex(1, 3, 'End')).toBe(2);
    expect(stepIndex(1, 3, 'Home')).toBe(0);
    expect(stepIndex(0, 0, 'ArrowDown')).toBe(-1);
  });
});

describe('Commissioning', () => {
  it('reads only the marks it knows, and survives bad storage', () => {
    expect([...readMarks('["away","note","bogus"]')]).toEqual(['away', 'note']);
    expect(readMarks('{')).toEqual(new Set());
    expect(readMarks('"away"')).toEqual(new Set());
    expect(readMarks(null)).toEqual(new Set());
  });

  it('shows on a room with FLIGHT alone, until it is put away', () => {
    expect(showCommissioning([flight], new Set())).toBe(true);
    expect(showCommissioning([], new Set())).toBe(true);
    expect(showCommissioning([flight, ana], new Set())).toBe(false);
    expect(showCommissioning([flight], new Set(['away']))).toBe(false);
  });

  it('ticks each step from the state of the room and this browser', () => {
    const done = (s: ReturnType<typeof commissioningSteps>): string[] => s.filter((x) => x.done).map((x) => x.id);
    expect(done(commissioningSteps([agent('flight', { boss: true, state: 'needs_you' })], NO_PROPELLANT, defaultView(), new Set()))).toEqual([]);
    const limited = { ...NO_PROPELLANT, room: { ...NO_PROPELLANT.room, limits: { day: 1_000_000 } } };
    expect(done(commissioningSteps([flight], limited, { ...defaultView(), current: 'night-shift' }, new Set(['note']), true))).toEqual(['flight', 'brief', 'propellant', 'livery', 'note']);
    expect(done(commissioningSteps([flight], limited, { ...defaultView(), current: 'night-shift' }, new Set(['note'])))).toEqual(['flight', 'propellant', 'livery', 'note']);
    // a FLIGHT that is still starting, or that needs you (a startup question, a sign-in that is missing), is not staffed
    expect(done(commissioningSteps([agent('flight', { boss: true, state: 'starting' })], NO_PROPELLANT, defaultView(), new Set()))).toEqual([]);
    expect(done(commissioningSteps([flight], NO_PROPELLANT, defaultView(), new Set(['livery'])))).toEqual(['flight', 'livery']);
  });
});
