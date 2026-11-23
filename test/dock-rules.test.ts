// Docking 2 per-dock rules and the GO on a handoff FLIGHT asks to send.
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { alwaysText, askText, askTitle, RULE_FIELDS, staleProblem } from '../src/client/dockRules.js';
import { HandoffNeed } from '../src/client/HandoffAsks.js';
import type { HandoffAsk } from '../src/shared/protocol.js';

const ask: HandoffAsk = { id: 'h1', dock: 'dk1', station: 'lab', from: 'flight', task: { title: 'Fix the login', detail: 'The token expires too early.\nSee the log.' }, at: 1 };

describe('the rules', () => {
  it('cover the five settings of the spec, each with a plain line that names the station', () => {
    expect(RULE_FIELDS.map((f) => f.key)).toEqual(['handoff', 'incoming', 'autoAccept', 'reportCost', 'serve']);
    for (const f of RULE_FIELDS) expect(f.help('lab')).toContain('lab');
    expect(RULE_FIELDS.find((f) => f.key === 'handoff')?.options.map((o) => o.value)).toEqual(['ask', 'allow']);
    expect(RULE_FIELDS.find((f) => f.key === 'incoming')?.options.map((o) => o.value)).toEqual(['auto', 'ask', 'off']);
  });
  it('take hours from 0 to a year', () => {
    expect(staleProblem('24')).toBeUndefined();
    expect(staleProblem('0')).toBeUndefined();
    for (const bad of ['', '-1', '1.5', 'x', '8761', '12345']) expect(staleProblem(bad), bad).toBeDefined();
  });
});

describe('the GO on a handoff', () => {
  it('says the words the spec fixes for Always, and shows the whole text that would leave', () => {
    expect(alwaysText('lab')).toBe('Always for lab: FLIGHT can then send tasks, and what it writes in them, to lab without asking you.');
    expect(askText(ask)).toBe('Fix the login\n\nThe token expires too early.\nSee the log.');
    expect(askText({ ...ask, task: { title: 'Fix', detail: '' } })).toBe('Fix');
    expect(askTitle(ask, 'FLIGHT')).toBe('FLIGHT wants to send a task to lab');
  });
  it('is drawn with the full text, the Always box (off), and GO and NO-GO keys that name the station', () => {
    const html = renderToString(createElement(HandoffNeed, { ask, legend: 'FLIGHT' }));
    expect(html).toContain('The token expires too early.');
    expect(html).toContain('Always for lab: FLIGHT can then send tasks, and what it writes in them, to lab without asking you.');
    expect(html).not.toContain('checked');
    expect(html).toContain('GO: send this task to lab');
    expect(html).toContain('NO-GO: do not send this task to lab');
  });
});
