import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CostDays, FuelMeter } from '../src/client/Propellant.js';
import { commands } from '../src/client/shell.js';
import type { CostView } from '../src/shared/protocol.js';

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
