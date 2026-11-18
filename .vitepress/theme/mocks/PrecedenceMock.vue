<script setup lang="ts">
// "A flag beats its environment variable, which beats the default" (docs/reference/configuration.md), for --port / GONOGO_PORT.
import { computed, ref } from 'vue';
import '../landing/landing.css';

const flag = ref(true);
const env = ref(true);
const rows = computed(() => [
  { k: 'Flag', v: '--port 7780', n: '7780', set: flag.value },
  { k: 'Environment variable', v: 'GONOGO_PORT=7778', n: '7778', set: env.value },
  { k: 'Default', v: '7777', n: '7777', set: true },
]);
const win = computed(() => rows.value.find((r) => r.set)!);
</script>

<template>
  <div class="module lp-visual pr">
    <div class="lp-row">
      <span class="label">Listen port</span>
      <span class="lcd pr-lcd" aria-live="polite"><span class="lcd-num">{{ win.n }}</span></span>
    </div>
    <div class="pr-rows">
      <div v-for="r in rows" :key="r.k" class="pr-row" :data-win="r === win">
        <span class="led" :data-kind="r === win ? 'idle' : 'stopped'" :data-on="r === win"></span>
        <span class="label">{{ r.k }}</span>
        <span class="pr-v" :data-set="r.set">{{ r.set ? r.v : 'not set' }}</span>
      </div>
    </div>
    <div class="lp-row-keys">
      <button type="button" class="btn" :aria-pressed="flag" @click="flag = !flag">--port 7780</button>
      <button type="button" class="btn" :aria-pressed="env" @click="env = !env">GONOGO_PORT=7778</button>
    </div>
  </div>
</template>

<style scoped>
/* A pressed key, as on the landing (landing.css .lp .btn[aria-pressed]): panel on text. */
.btn[aria-pressed='true'] {
  border-color: var(--text);
  background: var(--text);
  color: var(--panel);
}
.pr .btn {
  text-transform: none;
}
.pr-lcd {
  padding: 6px 10px;
  font-size: 26px;
}
.pr-rows {
  display: grid;
  gap: 8px;
}
.pr-row {
  display: grid;
  grid-template-columns: auto 11em minmax(0, 1fr);
  align-items: center;
  gap: 10px;
}
.pr-v {
  min-width: 0;
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.pr-v[data-set='false'] {
  color: var(--muted);
}
@media (max-width: 480px) {
  .pr-row {
    grid-template-columns: auto minmax(0, 1fr);
  }
  .pr-v {
    grid-column: 2;
  }
}
</style>
