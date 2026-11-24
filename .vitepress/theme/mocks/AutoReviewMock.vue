<script setup lang="ts">
// The block at the top of docs/features/auto-review.md: the setting and what the poller does with three open pull requests. Read-only; the names are the page's own.
import { computed, ref } from 'vue';
import '../landing/landing.css';

const on = ref(true);
const prs = [
  { n: 41, title: 'Fix the strip key', note: 'a branch of this repo, by you', ok: true },
  { n: 42, title: 'Add a thing', note: 'from a fork', ok: false },
  { n: 43, title: 'Big refactor', note: 'too large (62 files)', ok: false },
];
const shown = computed(() => (on.value ? prs : []));
</script>

<template>
  <div class="module lp-visual ar">
    <label class="staff-check"><input v-model="on" type="checkbox" class="switch" role="switch" /> Review pull requests of the linked repos (ulm0/gonogo)</label>
    <ul class="ar-list" aria-label="What the poller found">
      <li v-for="p in shown" :key="p.n"><b>#{{ p.n }}</b> {{ p.title }} <span class="chip" :data-tone="p.ok ? 'quiet' : undefined">{{ p.ok ? 'review queued' : 'skipped: ' + p.note }}</span></li>
      <li v-if="!on" class="hint">Off: nothing is read from GitHub.</li>
    </ul>
    <span class="hint">Every 3 minutes, one job per head commit. Nothing is posted without your click.</span>
  </div>
</template>

<style scoped>
.ar { display: grid; gap: 8px; }
.ar-list { margin: 0; padding-left: 1.1em; display: grid; gap: 4px; }
</style>
