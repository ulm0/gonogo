import { describe, expect, it } from 'vitest';
import type { LogEntry } from '../src/shared/protocol.js';
import { buildChart, CHART_ENTRIES_MAX, CHART_TAGS_MAX, mentions } from '../src/server/logchart.js';

const entry = (n: number, patch: Partial<LogEntry> = {}): LogEntry => ({ id: `l${n}`, title: `Entry ${n}`, body: 'text', tags: [], author: 'ana', createdAt: n, updatedAt: n, ...patch });
const ids = (nodes: Array<{ id: string }>): string[] => nodes.map((n) => n.id);

describe('mentions', () => {
  it('finds ids as words and never the entry itself', () => {
    expect(mentions('See l3, (l12) and l7.', 'l1')).toEqual(['l3', 'l12', 'l7']);
    expect(mentions('l5 and l5 again', 'l1')).toEqual(['l5']);
    expect(mentions('this is l2', 'l2')).toEqual([]);
  });

  it('does not take a part of a longer word, a number with a zero or a hyphenated name', () => {
    expect(mentions('cl12 l12x l12_b x-l12 l12-b l0 l012 al3 l3l 1l3 él4', 'l1')).toEqual([]);
    expect(mentions('l1234567', 'l9')).toEqual([]);
  });
});

describe('buildChart', () => {
  it('is empty for an empty log', () => {
    expect(buildChart([])).toEqual({ total: 0, shown: 0, nodes: [], edges: [] });
  });

  it('draws an entry, its tags and its author, and counts the uses', () => {
    const chart = buildChart([entry(1, { tags: ['build', 'ci'], author: 'ana' }), entry(2, { tags: ['build'], author: 'user' })]);
    expect(ids(chart.nodes)).toEqual(['entry:l2', 'entry:l1', 'tag:build', 'tag:ci', 'author:ana', 'author:user']);
    expect(chart.nodes.find((n) => n.id === 'tag:build')).toMatchObject({ kind: 'tag', ref: 'build', label: 'build', weight: 2 });
    expect(chart.nodes.find((n) => n.id === 'entry:l1')).toMatchObject({ kind: 'entry', ref: 'l1', label: 'Entry 1', weight: 1 });
    const kinds = (kind: string): string[] => chart.edges.filter((e) => e.kind === kind).map((e) => `${e.from}>${e.to}`);
    expect(kinds('tag')).toEqual(['entry:l2>tag:build', 'entry:l1>tag:build', 'entry:l1>tag:ci']);
    expect(kinds('author')).toEqual(['entry:l2>author:user', 'entry:l1>author:ana']);
    expect(chart).toMatchObject({ total: 2, shown: 2 });
  });

  it('joins two tags only when two entries hold both, with the count as weight', () => {
    const chart = buildChart([entry(1, { tags: ['b', 'a'] }), entry(2, { tags: ['a', 'b', 'c'] }), entry(3, { tags: ['c', 'd'] })]);
    expect(chart.edges.filter((e) => e.kind === 'cooccur')).toEqual([{ from: 'tag:a', to: 'tag:b', kind: 'cooccur', weight: 2 }]);
  });

  it('follows an id in a title or a body to an entry that is drawn, once, and weighs the one it names', () => {
    const chart = buildChart([
      entry(1, { body: 'Fixes l2 and l2 again, and l99 that is not there' }),
      entry(2, { title: 'Needs l3' }),
      entry(3, { body: 'mentions l1' }),
    ]);
    expect(chart.edges.filter((e) => e.kind === 'mention').map((e) => `${e.from}>${e.to}`).sort()).toEqual(['entry:l1>entry:l2', 'entry:l2>entry:l3', 'entry:l3>entry:l1']);
    expect(chart.nodes.find((n) => n.id === 'entry:l2')?.weight).toBe(2);
  });

  it('draws the newest entries and the tags they use most, and keeps every edge between nodes that exist', () => {
    const many = Array.from({ length: CHART_ENTRIES_MAX + 20 }, (_, i) => entry(i + 1, { tags: [`t${i % 60}`], body: i === 0 ? 'l2 and l200' : 'x' }));
    const chart = buildChart(many);
    expect(chart).toMatchObject({ total: CHART_ENTRIES_MAX + 20, shown: CHART_ENTRIES_MAX });
    expect(chart.nodes.filter((n) => n.kind === 'entry')).toHaveLength(CHART_ENTRIES_MAX);
    expect(chart.nodes.filter((n) => n.kind === 'tag')).toHaveLength(CHART_TAGS_MAX);
    // the oldest 20 are not drawn, so l1's mention of l2 (also not drawn) is no edge
    expect(ids(chart.nodes)).not.toContain('entry:l1');
    const known = new Set(ids(chart.nodes));
    for (const edge of chart.edges) expect([known.has(edge.from), known.has(edge.to)], `${edge.from} ${edge.to}`).toEqual([true, true]);
  });

  it('gives the same answer for the same entries in any order', () => {
    const list = [entry(1, { tags: ['a', 'b'], updatedAt: 5 }), entry(2, { tags: ['a'], updatedAt: 5 }), entry(3, { tags: ['b', 'a'], body: 'l1', updatedAt: 9 })];
    expect(buildChart([...list].reverse())).toEqual(buildChart(list));
  });
});
