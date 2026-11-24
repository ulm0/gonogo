import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BreakdownTable, CostByKind, CostDays, CostKindsTable, FuelMeter } from '../src/client/Propellant.js';
import { commands } from '../src/client/shell.js';
import type { CostReport, CostView, FuelBreakdownRow } from '../src/shared/protocol.js';

const W = { '5h': 0, day: 0, week: 0, month: 0 };
const cost: CostView = {
  room: { usd: { ...W, day: 8 }, unpriced: { ...W, day: 1200 }, budget: { day: 10 } },
  agents: {},
  days: [
    { date: '2026-11-16', usd: 0, unpriced: 0, byAgent: {} },
    { date: '2026-11-17', usd: 8, unpriced: 1200, byAgent: { ana: 5, ben: 3 } },
  ],
  pricedSince: 1,
};

const scope = (usd: number, input: number, output: number, cw: number, cr: number) => ({ usd, usdSplit: { input, output, cacheWrite: cw, cacheRead: cr }, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, unpriced: 0 });
const report: CostReport = {
  currency: 'USD',
  estimate: true,
  dayBoundary: 'local',
  from: '2026-11-04',
  to: '2026-11-17',
  room: { ...scope(8, 1, 5, 1, 1), reported: 9.5, reportedAgents: { have: 1, of: 2 } },
  agents: {
    ana: { ...scope(5, 1, 3, 0.5, 0.5), reported: 6.25, basis: 'reported', sessions: 2 },
    ben: { ...scope(3, 0, 2, 0.5, 0.5), reported: null, basis: 'estimated', sessions: 0 },
    idle: { ...scope(0, 0, 0, 0, 0), reported: null, basis: 'none', sessions: 0 },
  },
  days: [],
  unpricedModels: ['claude-mystery-9'],
  partial: false,
  sessions: 2,
  pricedSince: 1,
  priceAsOf: '2026-11-18',
};

describe('cost by kind of token', () => {
  it('shows the estimates by kind, the reported figure beside them as "at least", and says plainly that they are estimates', () => {
    const html = renderToString(createElement(CostKindsTable, { report }));
    expect(html).toContain('Estimated dollars, 2026-11-04 to 2026-11-17');
    expect(html).toContain('<th scope="row">ana</th>');
    expect(html).toContain('at least $6.25');
    expect(html).toContain('at least $9.50 (1 of 2 agents)');
    // an agent with nothing is not listed; one with an estimate only shows a dash for the reported figure
    expect(html).not.toContain('>idle<');
    expect(html).toMatch(/<th scope="row">ben<\/th>[^]*?<td data-basis="estimated">—<\/td>/);
    expect(html).toContain('estimates');
    expect(html).toContain('not a bill');
    expect(html).toContain('never added to them');
    expect(html).toContain('equivalent, not a charge');
    expect(html).toContain('No price for: claude-mystery-9');
    expect(html).toMatch(/Prices as of (<!-- -->)?2026-11-18/);
  });

  it('asks the server when it opens: until then it says it is reading', () => {
    expect(renderToString(createElement(CostByKind, { spent: 0 }))).toContain('Reading the ledger');
  });
});

describe('the cost screens', () => {
  it('draws the chart with a table of the same numbers and the estimate note', () => {
    const html = renderToString(createElement(CostDays, { cost }));
    expect(html).toContain('Dollars per day');
    expect(html).toContain('<th scope="row">2026-11-17</th>');
    expect(html).toContain('ana $5.00, ben $3.00');
    expect(html).not.toContain('2026-11-16</th>');
    expect(html).toContain('not a bill');
  });

  it('starts the meter on tokens with a switch to dollars', () => {
    const html = renderToString(createElement(FuelMeter, { gauge: { used: { ...W }, limits: {} }, cost: cost.room, who: 'the room', save: async () => {}, saveBudget: async () => {} }));
    expect(html).toContain('TOKENS');
    expect(html).toContain('DOLLARS');
    expect(html).toContain('NO LIMIT');
  });

  it('puts two Propellant lines in the Patch Panel', () => {
    const lines = commands({ agents: [], legends: {}, poll: null, unread: 0, livery: { current: '', liveries: [] } as never });
    expect(lines.filter((c) => c.label.startsWith('Propellant:')).map((c) => c.label)).toEqual(['Propellant: prices', 'Propellant: budget']);
  });
});

describe('use by engine, provider and model', () => {
  const row = (over: Partial<FuelBreakdownRow>): FuelBreakdownRow => ({ engine: 'claude', provider: 'anthropic', model: 'claude-opus-5-5', tokens: 2000, cacheRead: 0, usd: 3, unpriced: 0, free: false, claudePlan: false, agents: { ana: { tokens: 2000, usd: 3, unpriced: 0 } }, ...over });
  const html = renderToString(
    createElement(BreakdownTable, {
      caption: 'c',
      rows: [
        row({}),
        row({ engine: 'pi', claudePlan: false }),
        row({ engine: 'opencode', provider: 'opencode', model: 'big-pickle', usd: 0, free: true, tokens: 5000 }),
        row({ engine: 'unknown', provider: 'unknown', model: 'mystery', usd: 0, unpriced: 40, tokens: 40 }),
        row({ engine: 'claude', model: 'claude-sonnet-5-5', claudePlan: true, usd: 1, tokens: 100 }),
      ],
    }),
  );
  it('says free for a free model and no price for an unpriced one, and sums the room', () => {
    expect(html).toContain('big-pickle');
    expect(html).toMatch(/data-free="true"[^>]*>free</);
    expect(html).toMatch(/no price \(40\)/);
    expect(html).toContain('$7.00'); // 3 + 3 + 0 + 0 + 1
  });
  it('tells the plan use from the API use', () => {
    expect(html).toContain('Claude plan');
    expect(html).toContain('API or other');
  });
  it('says so when there is no use', () => {
    expect(renderToString(createElement(BreakdownTable, { caption: 'c', rows: [] }))).toContain('No use in this window');
  });
});
