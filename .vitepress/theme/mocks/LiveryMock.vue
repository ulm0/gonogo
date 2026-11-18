<script setup lang="ts">
// The Livery list at the top of docs/features/livery.md, as a local preview: APPLY repaints only this box (the tokens of
// tokens.css work on any element with data-livery), never the site; the round key of the top bar does that. Rows as in
// src/client/Livery.tsx: the swatch of the app's eight tokens (src/client/look.ts), the name, what it is, and the keys.
import { ref } from 'vue';
import { BUILTIN_LIVERIES } from '../../../src/shared/livery';

const SWATCH = ['--body', '--panel', '--text', '--lcd', '--work', '--you', '--go', '--nogo'];
const worn = ref('instrument');
</script>

<template>
  <div class="mk" :data-livery="worn">
    <div v-for="l in BUILTIN_LIVERIES" :key="l.slug" class="module mk-row" :data-current="worn === l.slug || undefined">
      <span class="mk-swatch" aria-hidden="true"><span v-for="t in SWATCH" :key="t" :style="{ background: l.tokens[t] }"></span></span>
      <span class="mk-text">
        <span class="mk-name">{{ l.name }} <span v-if="worn === l.slug" class="chip" data-tone="go">In use</span></span>
        <span class="mk-desc">{{ l.description }}</span>
        <span class="hint">Ships with gonogo</span>
      </span>
      <button
        type="button"
        class="btn"
        :data-kind="worn === l.slug ? undefined : 'primary'"
        :aria-label="`Apply ${l.name} to this preview`"
        :aria-disabled="worn === l.slug || undefined"
        @click="worn = l.slug"
      >
        Apply
      </button>
    </div>
    <span class="lcd mk-lcd" aria-hidden="true">The terminal follows --lcd and --lcd-text</span>
  </div>
</template>

<style scoped>
.mk {
  display: grid;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--edge);
  border-radius: var(--radius-module);
  background: var(--body);
  color: var(--text);
}

.mk-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px 16px;
  padding: 12px 14px;
}

.mk-row[data-current] {
  border-color: var(--go);
  box-shadow: inset 3px 0 0 var(--go);
}

.mk-swatch {
  display: grid;
  grid-template-columns: repeat(4, 18px);
  grid-auto-rows: 18px;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--edge);
  border-radius: var(--radius-key);
  background: var(--key);
}

.mk-swatch span {
  border-radius: 3px;
  box-shadow: inset 0 0 0 1px rgb(0 0 0 / 12%);
}

.mk-text {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.mk-name {
  font-size: 15px;
  font-weight: 600;
}

.mk-desc {
  color: var(--text-2);
  font-size: 13.5px;
  line-height: 1.45;
}

.mk-lcd {
  padding: 8px 10px;
  font-size: 12.5px;
}

@media (max-width: 560px) {
  .mk-row {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .mk-row .btn {
    grid-column: 1 / -1;
    justify-self: start;
  }
}
</style>
