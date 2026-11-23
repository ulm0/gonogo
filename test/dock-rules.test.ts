// Docking 2 per-dock rules and the GO on a handoff FLIGHT asks to send.
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { alwaysText, askRows, askText, askTitle, fieldsOf, patchOf, RULE_FIELDS, staleProblem, valueOf } from '../src/client/dockRules.js';
import { HandoffNeed } from '../src/client/HandoffAsks.js';
import type { HandoffAsk } from '../src/shared/protocol.js';

const ask: HandoffAsk = { id: 'ha1', dock: 'dk1', dockName: 'lab', task: 't4', assignee: null, title: 'Fix the login', detail: 'The token expires too early.\nSee the log.', due: null, priority: 'normal', onward: false, budget: null, at: 1 };

describe('the rules', () => {
  it('draw the three settings the server has, and the other two only when it sends them', () => {
    const rules = { handoff: 'ask', incoming: 'auto', autoAccept: false, staleHours: 24 } as const;
    expect(fieldsOf({ ...rules }).map((f) => f.key)).toEqual(['handoff', 'incoming', 'autoAccept']);
    expect(fieldsOf({ ...rules, reportCost: 'off', serve: 'off' }).map((f) => f.key)).toEqual(['handoff', 'incoming', 'autoAccept', 'reportCost', 'serve']);
    for (const f of RULE_FIELDS) expect(f.help('lab')).toContain('lab');
    expect(RULE_FIELDS.find((f) => f.key === 'incoming')?.options.map((o) => o.value)).toEqual(['auto', 'off']); // ask is not built
  });
  it('show a boolean as a choice and patch it back as a boolean', () => {
    expect(valueOf({ handoff: 'ask', incoming: 'auto', autoAccept: true, staleHours: 24 }, 'autoAccept')).toBe('true');
    expect(patchOf('autoAccept', 'false')).toEqual({ autoAccept: false });
    expect(patchOf('handoff', 'allow')).toEqual({ handoff: 'allow' });
  });
  it('take hours from 0 to 30 days', () => {
    expect(staleProblem('24')).toBeUndefined();
    expect(staleProblem('720')).toBeUndefined();
    for (const bad of ['', '-1', '1.5', 'x', '721', '12345']) expect(staleProblem(bad), bad).toBeDefined();
  });
});

describe('the GO on a handoff', () => {
  it('says the words the spec fixes for Always, and shows the whole text that would leave', () => {
    expect(alwaysText('lab')).toBe('Always for lab: FLIGHT can then send tasks, and what it writes in them, to lab without asking you.');
    expect(askText(ask)).toBe('Fix the login\n\nThe token expires too early.\nSee the log.');
    expect(askText({ ...ask, title: 'Fix', detail: '' })).toBe('Fix');
    expect(askTitle(ask, 'FLIGHT')).toBe('FLIGHT wants to send a task to lab');
  });
  it('says what else goes with it, and that it may go onward', () => {
    expect(askRows(ask)).toEqual([{ label: 'For', value: 'nobody yet: it lands with the boss there' }]);
    const rows = askRows({ ...ask, assignee: 'cara', due: '2026-12-01', priority: 'high', budget: 5, onward: true });
    expect(rows.map((r) => r.label)).toEqual(['For', 'Due', 'Priority', 'Budget', 'Onward']);
    expect(rows[0]?.value).toBe('cara at lab');
    expect(rows[3]?.value).toBe('$5.00, enforced by lab');
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
