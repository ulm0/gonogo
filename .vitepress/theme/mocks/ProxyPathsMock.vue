<script setup lang="ts">
// What a public name forwards (docs/https.md: the table and the Caddy files of "Webhooks and docking" and "The page behind a proxy").
import { computed, ref } from 'vue';
import '../landing/landing.css';

const PATHS = [
  { path: 'POST /uplink/<id>', who: 'Uplink and the inbound side of Relay', page: true, hooks: true },
  { path: '/dock/*', who: 'Another gonogo you docked with', page: true, hooks: true },
  { path: '/, /assets/*, /api/*, /ws', who: 'Your browser', page: true, hooks: false },
  { path: '/hook/*, /mcp', who: 'Your agents', page: false, hooks: false },
];
const NAMES = [
  { name: 'hooks.example.com', note: 'A name for webhooks and docking alone is safer than one name for everything.' },
  { name: 'gonogo.example.com', note: 'The browser token is then the only gate on a name anyone on the internet can try, so guard the name too.' },
];
const at = ref(0);
const rows = computed(() => PATHS.map((p) => ({ ...p, on: at.value === 0 ? p.hooks : p.page })));
</script>

<template>
  <div class="module lp-visual pp">
    <div class="lp-row">
      <span class="label">Public name</span>
      <span class="lp-row-keys" role="group" aria-label="Public name">
        <button v-for="(n, i) in NAMES" :key="n.name" type="button" class="btn" :aria-pressed="at === i" @click="at = i">{{ n.name }}</button>
      </span>
    </div>
    <div class="pp-rows" aria-live="polite">
      <div v-for="r in rows" :key="r.path" class="pp-row">
        <span class="led" :data-kind="r.on ? 'idle' : 'stopped'" :data-on="r.on"></span>
        <span class="pp-path">{{ r.path }}</span>
        <span class="pp-who">{{ r.who }}</span>
        <span class="chip" :data-tone="r.on ? 'go' : 'quiet'">{{ r.on ? 'forwarded' : '404' }}</span>
      </div>
    </div>
    <div class="lp-note">{{ NAMES[at]!.note }}</div>
  </div>
</template>

<style scoped>
/* A pressed key, as on the landing (landing.css .lp .btn[aria-pressed]): panel on text. */
.btn[aria-pressed='true'] {
  border-color: var(--text);
  background: var(--text);
  color: var(--panel);
}
.pp .btn {
  text-transform: none;
}
.pp-rows {
  display: grid;
}
.pp-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 2px 10px;
  padding: 8px 0;
  border-bottom: 1px solid var(--edge);
}
.pp-row:last-child {
  border-bottom: 0;
}
.pp-path {
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.pp-who {
  grid-row: 2;
  grid-column: 2;
  color: var(--muted);
  font-size: 12px;
}
.pp-row .chip {
  grid-row: 1 / 3;
  grid-column: 3;
}
</style>
