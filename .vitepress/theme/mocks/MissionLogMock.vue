<script setup lang="ts">
// The Mission Log search at the top of docs/features/mission-log.md: the landing's entries, ranked by the server's own BM25 and
// snippet (src/server/logsearch.ts), counted by the app's own words (src/client/log.ts).
import { computed, ref } from 'vue';
import { createIndex, snippet } from '../../../src/server/logsearch';
import { countText } from '../../../src/client/log';

const ENTRIES = [
  { id: 'l4', at: 4, author: 'You', title: 'Release checklist', tags: ['release', 'ci'], body: 'Tag, build the image, run the smoke test, then publish the package.' },
  { id: 'l3', at: 3, author: 'FIDO', title: 'Why the build is slow', tags: ['build'], body: 'The client build runs twice when the cache is cold; warm it in CI first.' },
  { id: 'l2', at: 2, author: 'GUIDO', title: 'Test database', tags: ['tests'], body: 'Tests use a fresh home per run, so the build never sees old state.' },
  { id: 'l1', at: 1, author: 'You', title: 'Naming', tags: ['style'], body: 'Call signs are lowercase letters, digits and hyphens.' },
];
const index = createIndex();
for (const e of ENTRIES) index.add(e);

const query = ref('build');
const hits = computed(() => {
  const q = query.value.trim();
  const found = q === '' ? ENTRIES : index.search(q, 20).map((h) => ENTRIES.find((e) => e.id === h.id)!);
  return found.map((e) => ({ ...e, snippet: snippet(e.body, q) }));
});
const count = computed(() => countText(query.value, { total: ENTRIES.length, hits: hits.value } as never));
</script>

<template>
  <div class="module mk" role="search">
    <div class="field">
      <label for="ml-mock-q">Search the log</label>
      <input id="ml-mock-q" v-model="query" class="input" type="search" autocomplete="off" autocapitalize="none" aria-describedby="ml-mock-count" />
      <span id="ml-mock-count" class="hint" aria-live="polite">{{ count }}</span>
    </div>
    <div class="mk-hits">
      <div v-for="e in hits" :key="e.id" class="mk-hit">
        <span class="mk-top"><span class="tile-num">{{ e.id }}</span><span class="legend">{{ e.author }}</span></span>
        <strong>{{ e.title }}</strong>
        <span class="mk-snip">{{ e.snippet }}</span>
        <span class="mk-tags"><span v-for="t in e.tags" :key="t" class="chip" data-tone="quiet">{{ t }}</span></span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mk {
  display: grid;
  gap: 12px;
  padding: 14px;
}

.mk-hit {
  display: grid;
  justify-items: start;
  gap: 4px;
  padding: 12px 0;
  border-top: 1px solid var(--edge);
}

.mk-top,
.mk-tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.mk-top .tile-num {
  margin-left: 0;
}

.mk-snip {
  color: var(--text-2);
  font-size: 14px;
  line-height: 1.5;
}
</style>
