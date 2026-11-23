// Docking 2 per-dock rules and the GO on a handoff FLIGHT asks to send.
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { alwaysText, askRows, askText, askTitle, patchOf, RULE_FIELDS, staleProblem, valueOf } from '../src/client/dockRules.js';
import { HandoffNeed } from '../src/client/HandoffAsks.js';
import type { HandoffAsk } from '../src/shared/protocol.js';

const ask: HandoffAsk = { id: 'ha1', dock: 'dk1', dockName: 'lab', task: 't4', assignee: null, title: 'Fix the login', detail: 'The token expires too early.\nSee the log.', due: null, priority: 'normal', onward: false, budget: null, at: 1 };

describe('the rules', () => {
  it('cover the six settings of the server, each with a plain line that names the station', () => {
    expect(RULE_FIELDS.map((f) => f.key)).toEqual(['handoff', 'incoming', 'autoAccept', 'reportCost', 'ask', 'serve']);
    for (const f of RULE_FIELDS) expect(f.help('lab')).toContain('lab');
    expect(RULE_FIELDS.find((f) => f.key === 'incoming')?.options.map((o) => o.value)).toEqual(['auto', 'off']);
  });
  it('show a boolean as a choice and patch it back as a boolean', () => {
    expect(valueOf({ handoff: 'ask', incoming: 'auto', autoAccept: true, staleHours: 24, serve: false, reportCost: false, ask: false }, 'autoAccept')).toBe('true');
    expect(patchOf('autoAccept', 'false')).toEqual({ autoAccept: false });
    expect(patchOf('handoff', 'allow')).toEqual({ handoff: 'allow' });
    expect(patchOf('serve', 'true')).toEqual({ serve: true });
    expect(patchOf('ask', 'true')).toEqual({ ask: true });
    expect(patchOf('reportCost', 'false')).toEqual({ reportCost: false });
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

describe('the terms of an offer', () => {
  it('say nothing for a box left empty, and what was typed otherwise', async () => {
    const { handoffRequest, missionOffer, NO_TERMS, offerProblems } = await import('../src/client/docking.js');
    const task = { id: 't4' } as Parameters<typeof handoffRequest>[0];
    expect(handoffRequest(task, '')).toEqual({ task: 't4', assignee: null });
    expect(handoffRequest(task, 'cara', { due: '2026-12-01', priority: 'high', onward: true, budget: '5.50' })).toEqual({ task: 't4', assignee: 'cara', due: '2026-12-01', priority: 'high', onward: true, budget: 5.5 });
    expect(missionOffer('ms1', { due: '2026-12-01', priority: 'low', onward: true, budget: '9' })).toEqual({ mission: 'ms1', due: '2026-12-01', priority: 'low' });
    expect(offerProblems(NO_TERMS)).toEqual({});
  });
  it('tell a wrong date and a wrong sum before the call', async () => {
    const { NO_TERMS, offerProblems } = await import('../src/client/docking.js');
    for (const due of ['tomorrow', '2026-13-01', '2026-02-30', '01-12-2026']) expect(offerProblems({ ...NO_TERMS, due }).due, due).toBeDefined();
    for (const budget of ['-1', 'x', '1.234', '1000001', '5,5']) expect(offerProblems({ ...NO_TERMS, budget }).budget, budget).toBeDefined();
    expect(offerProblems({ ...NO_TERMS, due: '2024-02-29', budget: '1000000' })).toEqual({});
  });
});

describe('share marks and the knowledge ask', () => {
  it('keep the docks in the order of the page when a box is ticked or cleared', async () => {
    const { docksOf, toggled } = await import('../src/client/ShareMarks.js');
    expect(toggled(['d2'], 'd1', true, ['d1', 'd2', 'd3'])).toEqual(['d1', 'd2']);
    expect(toggled(['d1', 'd2'], 'd1', false, ['d1', 'd2'])).toEqual(['d2']);
    expect(docksOf([{ kind: 'log', key: 'l1', docks: ['d1'] }, { kind: 'claim', key: 'r/c1', docks: ['d2'] }], 'claim', 'r/c1')).toEqual(['d2']);
    expect(docksOf([], 'log', 'l1')).toEqual([]);
  });
  it('draw the ask with its warning that only shared, ruled-in entries answer', async () => {
    const { KnowledgeAsk } = await import('../src/client/KnowledgeAsk.js');
    const html = renderToString(createElement(KnowledgeAsk, { dock: { id: 'd1', name: 'lab' } as never }));
    expect(html.replace(/<!-- -->/g, '')).toContain('Ask lab what it knows');
    expect(html.replace(/<!-- -->/g, '')).toContain('marked as shareable with this station');
    expect(html).not.toContain('role="status"');
  });
});
