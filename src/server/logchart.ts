/**
 * Star Chart: the Mission Log as a graph of entries, tags and authors, worked out from the entries alone (docs/star-chart-spec.md).
 * No model: an entry has its tags and its author, an entry whose text holds the id of another (`l12`) points at it, and two tags that
 * are together in at least two entries are joined. The page lays the nodes out; this only says which nodes and which edges.
 *
 * shortcut: only the newest CHART_ENTRIES_MAX entries and the CHART_TAGS_MAX tags they use most are drawn, so that the layout stays
 * cheap; page by date or by tag if a log ever needs more.
 */
import type { ChartEdge, ChartNode, LogChart, LogEntry } from '../shared/protocol.js';

export const CHART_ENTRIES_MAX = 150;
export const CHART_TAGS_MAX = 40;
/** Two tags are joined by a co-occurrence edge when this many entries hold both. */
export const COOCCUR_MIN = 2;

/** An entry id as a word of its own: `l12`, `(l12)`, `l12.`; not `cl12`, `l12x` or `l12-b`. */
const MENTION = /(?<![\p{L}\p{N}_-])l([1-9]\d{0,5})(?![\p{L}\p{N}_-])/gu;

/** The ids of other entries named in a text, each once, in order of appearance. */
export function mentions(text: string, self: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(MENTION)) if (`l${match[1]}` !== self) found.add(`l${match[1]}`);
  return [...found];
}

export function buildChart(all: readonly LogEntry[]): LogChart {
  const shown = [...all].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id)).slice(0, CHART_ENTRIES_MAX);
  const ids = new Set(shown.map((e) => e.id));

  const uses = new Map<string, number>();
  for (const entry of shown) for (const tag of entry.tags) uses.set(tag, (uses.get(tag) ?? 0) + 1);
  const tags = [...uses].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, CHART_TAGS_MAX);
  const tagged = new Set(tags.map(([tag]) => tag));

  const authors = new Map<string, number>();
  for (const entry of shown) authors.set(entry.author, (authors.get(entry.author) ?? 0) + 1);

  const edges: ChartEdge[] = [];
  const named = new Map<string, number>();
  const together = new Map<string, number>();
  for (const entry of shown) {
    const from = `entry:${entry.id}`;
    for (const tag of entry.tags) if (tagged.has(tag)) edges.push({ from, to: `tag:${tag}`, kind: 'tag', weight: 1 });
    edges.push({ from, to: `author:${entry.author}`, kind: 'author', weight: 1 });
    for (const id of mentions(`${entry.title}\n${entry.body}`, entry.id)) {
      if (!ids.has(id)) continue;
      edges.push({ from, to: `entry:${id}`, kind: 'mention', weight: 1 });
      named.set(id, (named.get(id) ?? 0) + 1);
    }
    const own = entry.tags.filter((t) => tagged.has(t)).sort();
    for (let i = 0; i < own.length; i += 1) for (let j = i + 1; j < own.length; j += 1) together.set(`${own[i]}\n${own[j]}`, (together.get(`${own[i]}\n${own[j]}`) ?? 0) + 1);
  }
  for (const [pair, weight] of [...together].sort((a, b) => a[0].localeCompare(b[0]))) {
    const [a = '', b = ''] = pair.split('\n');
    if (weight >= COOCCUR_MIN) edges.push({ from: `tag:${a}`, to: `tag:${b}`, kind: 'cooccur', weight });
  }

  const nodes: ChartNode[] = [
    ...shown.map((e): ChartNode => ({ id: `entry:${e.id}`, kind: 'entry', ref: e.id, label: e.title, weight: 1 + (named.get(e.id) ?? 0) })),
    ...tags.map(([tag, weight]): ChartNode => ({ id: `tag:${tag}`, kind: 'tag', ref: tag, label: tag, weight })),
    ...[...authors].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, weight]): ChartNode => ({ id: `author:${name}`, kind: 'author', ref: name, label: name, weight })),
  ];
  return { total: all.length, shown: shown.length, nodes, edges };
}
