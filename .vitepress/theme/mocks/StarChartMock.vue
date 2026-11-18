<script setup lang="ts">
// The Star Chart at the top of docs/features/star-chart.md: six entries of a made-up log, put through the server's own chart
// (src/server/logchart.ts) and the page's own layout (src/client/chart.ts). Choosing a tag or an author lights what it is joined to.
import { computed, ref } from 'vue';
import { buildChart } from '../../../src/server/logchart';
import { CHART_HEIGHT, CHART_WIDTH, chartText, layout, neighbours } from '../../../src/client/chart';
import type { LogEntry } from '../../../src/shared/protocol';

const at = (n: number): Pick<LogEntry, 'createdAt' | 'updatedAt' | 'body'> => ({ createdAt: n, updatedAt: n, body: '' });
const ENTRIES: LogEntry[] = [
  { ...at(1), id: 'l1', title: 'Cache key', author: 'ana', tags: ['build', 'cache'], body: 'The key has the node version.' },
  { ...at(2), id: 'l2', title: 'Cache misses on CI', author: 'ben', tags: ['build', 'cache', 'ci'], body: 'Follows l1. See also l3.' },
  { ...at(3), id: 'l3', title: 'Release steps', author: 'user', tags: ['release', 'ci'], body: 'Needs the checks of l2.' },
  { ...at(4), id: 'l4', title: 'Test database', author: 'ana', tags: ['tests'], body: 'A fresh home per run.' },
  { ...at(5), id: 'l5', title: 'Flaky end-to-end test', author: 'ben', tags: ['tests', 'ci'], body: 'Slow on a cold cache, see l1 and l4.' },
  { ...at(6), id: 'l6', title: 'Naming', author: 'user', tags: ['style'], body: 'Call signs are lowercase.' },
];
const chart = buildChart(ENTRIES);
const spots = layout(chart);
const picked = ref<string | null>(null);
const near = computed(() => (picked.value === null ? null : neighbours(chart, picked.value)));
const flip = (x: number): boolean => x > CHART_WIDTH - 120;
const pick = (id: string, kind: string): void => {
  if (kind !== 'entry') picked.value = picked.value === id ? null : id;
};
</script>

<template>
  <div class="module mk">
    <svg :viewBox="`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`" role="group" :aria-label="`Star chart of a small log. ${chartText(chart)} Entries are circles, tags diamonds and authors squares; an arrow is an entry that names another.`">
      <defs>
        <marker id="mk-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 z" class="mk-arrow" /></marker>
      </defs>
      <template v-for="e in chart.edges" :key="`${e.kind}:${e.from}:${e.to}`">
        <line
          v-if="spots.get(e.from) && spots.get(e.to)"
          class="mk-edge"
          :data-kind="e.kind"
          :data-dim="picked !== null && e.from !== picked && e.to !== picked ? '' : undefined"
          :x1="spots.get(e.from)!.x"
          :y1="spots.get(e.from)!.y"
          :x2="spots.get(e.to)!.x"
          :y2="spots.get(e.to)!.y"
          :marker-end="e.kind === 'mention' ? 'url(#mk-arrow)' : undefined"
        />
      </template>
      <g v-for="n in chart.nodes" :key="n.id" class="mk-node" :data-kind="n.kind" :data-dim="near !== null && !near.has(n.id) ? '' : undefined" :transform="`translate(${spots.get(n.id)!.x} ${spots.get(n.id)!.y})`" :role="n.kind === 'entry' ? undefined : 'button'" :tabindex="n.kind === 'entry' ? undefined : 0" :aria-pressed="n.kind === 'entry' ? undefined : picked === n.id" :aria-label="n.kind === 'entry' ? undefined : `${n.kind === 'tag' ? 'Tag' : 'Author'} ${n.label}`" @click="pick(n.id, n.kind)" @keydown.enter.space.prevent="pick(n.id, n.kind)">
        <circle class="mk-hit" r="15" />
        <circle v-if="n.kind === 'entry'" class="mk-shape" :r="5 + Math.min(n.weight - 1, 4)" />
        <rect v-else-if="n.kind === 'tag'" class="mk-shape" x="-6.5" y="-6.5" width="13" height="13" transform="rotate(45)" />
        <rect v-else class="mk-shape" x="-8" y="-8" width="16" height="16" rx="3" />
        <text class="mk-label" :text-anchor="flip(spots.get(n.id)!.x) ? 'end' : 'start'" :x="(n.kind === 'entry' ? 11 : 12) * (flip(spots.get(n.id)!.x) ? -1 : 1)" y="4">{{ n.kind === 'entry' ? n.ref : n.kind === 'author' ? n.label.toUpperCase() : n.label }}</text>
      </g>
    </svg>
    <p class="hint">{{ chartText(chart) }} Click a tag or an author to light what it is joined to.</p>
  </div>
</template>

<style scoped>
.mk {
  display: grid;
  gap: 8px;
  padding: 10px;
}

svg {
  display: block;
  width: 100%;
  height: auto;
  border: 1px solid var(--edge);
  border-radius: var(--radius-key);
  background: var(--key);
}

.mk .hint {
  margin: 0;
}

.mk-edge {
  stroke: var(--muted);
  stroke-width: 1;
  stroke-opacity: 0.55;
}

.mk-edge[data-kind='mention'] {
  stroke: var(--work);
  stroke-width: 1.75;
  stroke-opacity: 0.9;
}

.mk-edge[data-kind='cooccur'] {
  stroke-dasharray: 4 3;
}

.mk-edge[data-dim],
.mk-node[data-dim] {
  opacity: 0.3;
}

.mk-arrow {
  fill: var(--work);
}

.mk-node[data-kind='tag'],
.mk-node[data-kind='author'] {
  cursor: pointer;
}

.mk-node:focus {
  outline: none;
}

.mk-node:focus-visible .mk-hit,
.mk-node[aria-pressed='true'] .mk-hit {
  stroke: var(--text);
  stroke-width: 2;
}

.mk-shape {
  stroke: var(--text-2);
  stroke-width: 1.5;
}

.mk-node[data-kind='entry'] .mk-shape {
  fill: var(--work);
}

.mk-node[data-kind='tag'] .mk-shape {
  fill: var(--go-tint);
}

.mk-node[data-kind='author'] .mk-shape {
  fill: var(--you-tint);
}

.mk-hit {
  fill: transparent;
}

.mk-label {
  fill: var(--text);
  font-family: var(--font-mono);
  font-size: 11px;
  paint-order: stroke;
  stroke: var(--key);
  stroke-width: 3px;
  stroke-linejoin: round;
  pointer-events: none;
}
</style>
