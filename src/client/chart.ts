import type { ChartNode, LogChart } from '../shared/protocol.js';

// What Star Chart draws and says, kept out of StarChart.tsx so that it can be tested without a DOM: where each node goes, what
// is next to it, and the list that says the same as the drawing.

export const CHART_WIDTH = 760;
export const CHART_HEIGHT = 520;
export interface Spot {
  x: number;
  y: number;
}

const MARGIN = 30;
const ITERATIONS = 150;
const GOLDEN_ANGLE = 2.399963229728653;
/** How hard an edge pulls: two tags that often meet pull less than an entry pulls its tag. */
const PULL = { tag: 1, author: 1, mention: 1, cooccur: 0.4 } as const;

/**
 * Where each node goes: a force layout (nodes push each other away, edges pull their ends together) that starts from a spiral in
 * the order of the nodes and runs a fixed number of rounds, so that the same chart always gives the same picture and nothing
 * moves when the page draws it again. The cost is the square of the node count (at most about 250 nodes).
 */
export function layout(chart: LogChart, width = CHART_WIDTH, height = CHART_HEIGHT): Map<string, Spot> {
  const nodes = chart.nodes;
  const n = nodes.length;
  const spots = new Map<string, Spot>();
  if (n === 0) return spots;
  const inner = { w: width - 2 * MARGIN, h: height - 2 * MARGIN };
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const reach = Math.sqrt((i + 0.5) / n);
    x[i] = width / 2 + Math.cos(i * GOLDEN_ANGLE) * reach * inner.w * 0.45;
    y[i] = height / 2 + Math.sin(i * GOLDEN_ANGLE) * reach * inner.h * 0.45;
  }
  const at = new Map(nodes.map((node, i) => [node.id, i]));
  const pulls: Array<[number, number, number]> = [];
  for (const edge of chart.edges) {
    const a = at.get(edge.from);
    const b = at.get(edge.to);
    if (a !== undefined && b !== undefined && a !== b) pulls.push([a, b, PULL[edge.kind]]);
  }
  const k = Math.sqrt((inner.w * inner.h) / n) * 0.8;
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  for (let round = 0; round < ITERATIONS; round += 1) {
    dx.fill(0);
    dy.fill(0);
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        // two nodes on one spot are pushed apart along a fixed direction
        const ex = (x[i] ?? 0) - (x[j] ?? 0) || (i - j) * 0.01;
        const ey = (y[i] ?? 0) - (y[j] ?? 0) || (j - i) * 0.01;
        const d2 = ex * ex + ey * ey + 0.01;
        const push = (k * k) / d2;
        dx[i] = (dx[i] ?? 0) + ex * push;
        dy[i] = (dy[i] ?? 0) + ey * push;
        dx[j] = (dx[j] ?? 0) - ex * push;
        dy[j] = (dy[j] ?? 0) - ey * push;
      }
    }
    for (const [a, b, strength] of pulls) {
      const ex = (x[a] ?? 0) - (x[b] ?? 0);
      const ey = (y[a] ?? 0) - (y[b] ?? 0);
      const d = Math.sqrt(ex * ex + ey * ey + 0.01);
      const pull = (d / k) * strength;
      dx[a] = (dx[a] ?? 0) - ex * pull;
      dy[a] = (dy[a] ?? 0) - ey * pull;
      dx[b] = (dx[b] ?? 0) + ex * pull;
      dy[b] = (dy[b] ?? 0) + ey * pull;
    }
    const heat = (width / 8) * (1 - round / ITERATIONS) + 0.5;
    for (let i = 0; i < n; i += 1) {
      // a little pull to the middle keeps nodes with no edge, and the islands, on the page
      const mx = (dx[i] ?? 0) + (width / 2 - (x[i] ?? 0)) * 0.08;
      const my = (dy[i] ?? 0) + (height / 2 - (y[i] ?? 0)) * 0.08;
      const d = Math.sqrt(mx * mx + my * my) || 1;
      const step = Math.min(d, heat) / d;
      x[i] = Math.min(width - MARGIN, Math.max(MARGIN, (x[i] ?? 0) + mx * step));
      y[i] = Math.min(height - MARGIN, Math.max(MARGIN, (y[i] ?? 0) + my * step));
    }
  }
  nodes.forEach((node, i) => spots.set(node.id, { x: Math.round((x[i] ?? 0) * 10) / 10, y: Math.round((y[i] ?? 0) * 10) / 10 }));
  return spots;
}

/** The ids of the nodes joined to `id` by an edge, and `id` itself. */
export function neighbours(chart: LogChart, id: string): Set<string> {
  const near = new Set([id]);
  for (const edge of chart.edges) {
    if (edge.from === id) near.add(edge.to);
    if (edge.to === id) near.add(edge.from);
  }
  return near;
}

/** "All 12 entries, 5 tags and 2 authors." or "The newest 150 of 400 entries, with 40 tags and 6 authors." */
export function chartText(chart: LogChart): string {
  if (chart.total === 0) return 'The log is empty: there is nothing to draw.';
  const count = (kind: ChartNode['kind'], word: string): string => {
    const n = chart.nodes.filter((node) => node.kind === kind).length;
    return `${n} ${n === 1 ? word : `${word}s`}`;
  };
  const rest = `${count('tag', 'tag')} and ${count('author', 'author')}`;
  return chart.shown < chart.total ? `The newest ${chart.shown} of ${chart.total} entries, with ${rest}.` : `${chart.total === 1 ? '1 entry' : `All ${chart.total} entries`}, ${rest}.`;
}

/** What a node says in a line: "build: 5 entries". An entry says its id and title. */
export function nodeText(node: ChartNode, who: string): string {
  if (node.kind === 'entry') return `${node.ref}: ${node.label}`;
  const entries = `${node.weight} ${node.weight === 1 ? 'entry' : 'entries'}`;
  return `${node.kind === 'author' ? who : node.label}: ${entries}`;
}

export interface EntryLinks {
  node: ChartNode;
  author: string;
  tags: string[];
  /** The ids this entry's text names, and the ids of the entries whose text names this one. */
  mentions: string[];
  mentionedBy: string[];
}
export interface GroupLinks {
  node: ChartNode;
  /** The ids of the entries that have this tag or this author, newest first. */
  entries: string[];
  /** A tag: the tags that share at least two entries with it, with how many. */
  with: Array<{ tag: string; weight: number }>;
}
export interface ChartLinks {
  entries: EntryLinks[];
  tags: GroupLinks[];
  authors: GroupLinks[];
}

/** The chart as lists: the same nodes and edges, each with what it is joined to. This is what a keyboard and a screen reader walk. */
export function links(chart: LogChart): ChartLinks {
  const refOf = (id: string): string => id.slice(id.indexOf(':') + 1);
  const own = new Map(chart.nodes.filter((n) => n.kind === 'entry').map((node): [string, EntryLinks] => [node.ref, { node, author: '', tags: [], mentions: [], mentionedBy: [] }]));
  const groups = new Map<string, GroupLinks>(chart.nodes.filter((n) => n.kind !== 'entry').map((node) => [node.id, { node, entries: [], with: [] }]));
  for (const edge of chart.edges) {
    const from = edge.from.startsWith('entry:') ? own.get(refOf(edge.from)) : undefined;
    if (edge.kind === 'mention') {
      from?.mentions.push(refOf(edge.to));
      own.get(refOf(edge.to))?.mentionedBy.push(refOf(edge.from));
    } else if (edge.kind === 'cooccur') {
      groups.get(edge.from)?.with.push({ tag: refOf(edge.to), weight: edge.weight });
      groups.get(edge.to)?.with.push({ tag: refOf(edge.from), weight: edge.weight });
    } else if (from) {
      if (edge.kind === 'author') from.author = refOf(edge.to);
      else from.tags.push(refOf(edge.to));
      groups.get(edge.to)?.entries.push(refOf(edge.from));
    }
  }
  const list = [...groups.values()];
  return { entries: [...own.values()], tags: list.filter((g) => g.node.kind === 'tag'), authors: list.filter((g) => g.node.kind === 'author') };
}
