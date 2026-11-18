import { describe, expect, it } from 'vitest';
import type { LogChart, LogEntry } from '../src/shared/protocol.js';
import { buildChart, CHART_ENTRIES_MAX } from '../src/server/logchart.js';
import { CHART_HEIGHT, CHART_WIDTH, chartText, labelLeft, layout, links, neighbours, nodeText } from '../src/client/chart.js';

const entry = (n: number, patch: Partial<LogEntry> = {}): LogEntry => ({ id: `l${n}`, title: `Entry ${n}`, body: 'text', tags: [], author: 'ana', createdAt: n, updatedAt: n, ...patch });
const SAMPLE = buildChart([
  entry(1, { tags: ['build', 'cache'], author: 'ana', body: 'See l2.' }),
  entry(2, { tags: ['build', 'cache'], author: 'ben', body: 'Follows l1.' }),
  entry(3, { tags: ['release'], author: 'user' }),
]);

describe('layout', () => {
  it('is empty for no nodes and puts a lone node on the page', () => {
    expect(layout({ total: 0, shown: 0, nodes: [], edges: [] }).size).toBe(0);
    const one = layout(buildChart([entry(1)]));
    expect(one.size).toBe(2);
    for (const spot of one.values()) expect(Number.isFinite(spot.x) && Number.isFinite(spot.y)).toBe(true);
  });

  it('gives every node a finite place inside the page, and the same places for the same chart', () => {
    const spots = layout(SAMPLE);
    expect([...spots.keys()]).toEqual(SAMPLE.nodes.map((n) => n.id));
    for (const { x, y } of spots.values()) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(CHART_WIDTH);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(CHART_HEIGHT);
    }
    expect(layout(SAMPLE)).toEqual(spots);
  });

  it('keeps joined nodes nearer than the two ends of the page and never puts two nodes on one spot', () => {
    const spots = layout(SAMPLE);
    const distance = (a: string, b: string): number => Math.hypot((spots.get(a)?.x ?? 0) - (spots.get(b)?.x ?? 0), (spots.get(a)?.y ?? 0) - (spots.get(b)?.y ?? 0));
    expect(distance('entry:l1', 'tag:build')).toBeLessThan(CHART_WIDTH / 2);
    const places = new Set([...spots.values()].map((s) => `${Math.round(s.x)},${Math.round(s.y)}`));
    expect(places.size).toBe(spots.size);
  });

  it('takes a chart of the largest size in well under a second, with edges that name nodes that are not there', () => {
    const entries = Array.from({ length: CHART_ENTRIES_MAX }, (_, i) => entry(i + 1, { tags: [`t${i % 40}`, `u${i % 7}`], author: `a${i % 12}`, body: `see l${((i * 7) % CHART_ENTRIES_MAX) + 1}` }));
    const chart = buildChart(entries);
    const odd: LogChart = { ...chart, edges: [...chart.edges, { from: 'entry:l1', to: 'entry:nowhere', kind: 'mention', weight: 1 }, { from: 'entry:l1', to: 'entry:l1', kind: 'mention', weight: 1 }] };
    const started = performance.now();
    const spots = layout(odd);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(spots.size).toBe(chart.nodes.length);
    for (const { x, y } of spots.values()) expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
  });
});

describe('layout of a dense log', () => {
  it('fills the frame along at least one axis and stays inside the margins', () => {
    const entries = Array.from({ length: CHART_ENTRIES_MAX }, (_, i) => entry(i + 1, { tags: [`t${i % 8}`, `t${(i * 3) % 8}`], body: `see l${Math.max(1, i)}` }));
    const spots = [...layout(buildChart(entries)).values()];
    const xs = spots.map((s) => s.x);
    const ys = spots.map((s) => s.y);
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    expect(Math.max(spanX / (CHART_WIDTH - 60), spanY / (CHART_HEIGHT - 60))).toBeGreaterThan(0.95);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(30 - 0.1);
    expect(Math.max(...xs)).toBeLessThanOrEqual(CHART_WIDTH - 30 + 0.1);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(30 - 0.1);
    expect(Math.max(...ys)).toBeLessThanOrEqual(CHART_HEIGHT - 30 + 0.1);
  });
});

describe('labelLeft', () => {
  it('writes a name to the left of its node only when it would run past the right edge, whatever its length', () => {
    expect(labelLeft(100, 'l12')).toBe(false);
    expect(labelLeft(740, 'l12')).toBe(true);
    // a 30-character tag at x 587 ends at about 800: it goes left, where there is room
    expect(labelLeft(587, 'a'.repeat(30))).toBe(true);
    expect(labelLeft(587, 'build')).toBe(false);
    // at every x one side has room for the longest name
    for (let x = 30; x <= CHART_WIDTH - 30; x += 10) {
      const left = labelLeft(x, 'a'.repeat(30));
      expect(left ? x - 12 - 30 * 6.6 : x + 12 + 30 * 6.6, String(x)).toSatisfy((edge: number) => (left ? edge >= 0 : edge <= CHART_WIDTH));
    }
  });
});

describe('neighbours', () => {
  it('are the node, and what an edge joins it to, either way round', () => {
    expect([...neighbours(SAMPLE, 'tag:release')].sort()).toEqual(['entry:l3', 'tag:release']);
    expect([...neighbours(SAMPLE, 'entry:l1')].sort()).toEqual(['author:ana', 'entry:l1', 'entry:l2', 'tag:build', 'tag:cache']);
    expect([...neighbours(SAMPLE, 'nothing')]).toEqual(['nothing']);
  });
});

describe('the words', () => {
  it('count what is drawn', () => {
    expect(chartText(SAMPLE)).toBe('All 3 entries, 3 tags and 3 authors.');
    expect(chartText(buildChart([entry(1)]))).toBe('1 entry, 0 tags and 1 author.');
    expect(chartText({ total: 0, shown: 0, nodes: [], edges: [] })).toBe('The log is empty: there is nothing to draw.');
    expect(chartText({ ...SAMPLE, total: 400, shown: 150 })).toBe('The newest 150 of 400 entries, with 3 tags and 3 authors.');
  });

  it('say a node in a line', () => {
    const node = (id: string) => SAMPLE.nodes.find((n) => n.id === id)!;
    expect(nodeText(node('entry:l1'), '')).toBe('l1: Entry 1');
    expect(nodeText(node('tag:build'), '')).toBe('build: 2 entries');
    expect(nodeText(node('tag:release'), '')).toBe('release: 1 entry');
    expect(nodeText(node('author:user'), 'DIRECTOR')).toBe('DIRECTOR: 1 entry');
  });
});

describe('links, the list that says what the drawing says', () => {
  const found = links(SAMPLE);

  it('has a row for each entry with its author, tags and mentions both ways', () => {
    expect(found.entries.map((e) => e.node.ref)).toEqual(['l3', 'l2', 'l1']);
    expect(found.entries.find((e) => e.node.ref === 'l1')).toMatchObject({ author: 'ana', tags: ['build', 'cache'], mentions: ['l2'], mentionedBy: ['l2'] });
    expect(found.entries.find((e) => e.node.ref === 'l3')).toMatchObject({ author: 'user', tags: ['release'], mentions: [], mentionedBy: [] });
  });

  it('has a row for each tag and author with its entries and the tags it meets', () => {
    expect(found.tags.map((t) => t.node.ref)).toEqual(['build', 'cache', 'release']);
    expect(found.tags.find((t) => t.node.ref === 'build')).toMatchObject({ entries: ['l2', 'l1'], with: [{ tag: 'cache', weight: 2 }] });
    expect(found.tags.find((t) => t.node.ref === 'cache')?.with).toEqual([{ tag: 'build', weight: 2 }]);
    expect(found.authors.map((a) => [a.node.ref, a.entries])).toEqual([
      ['ana', ['l1']],
      ['ben', ['l2']],
      ['user', ['l3']],
    ]);
  });

  it('is empty for an empty chart and ignores an edge that names no node', () => {
    expect(links({ total: 0, shown: 0, nodes: [], edges: [] })).toEqual({ entries: [], tags: [], authors: [] });
    expect(() => links({ ...SAMPLE, edges: [...SAMPLE.edges, { from: 'entry:l9', to: 'tag:zz', kind: 'tag', weight: 1 }, { from: 'entry:l1', to: 'entry:l9', kind: 'mention', weight: 1 }] })).not.toThrow();
  });
});
