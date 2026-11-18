<script setup lang="ts">
// The checks of CONTRIBUTING.md ("All three must pass"), lit one after the other. Under prefers-reduced-motion it stays on the
// first frame, which already shows each state.
import { onBeforeUnmount, onMounted, ref } from 'vue';
import '../landing/landing.css';

const CHECKS = [
  { cmd: 'pnpm typecheck', note: 'server, client and tests' },
  { cmd: 'pnpm exec vitest run', note: 'the whole suite, about 2 minutes' },
  { cmd: 'pnpm build', note: 'client (vite) and server (tsc) into dist/' },
];
const at = ref(1); // the check running now; the ones before it passed
let tick: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  tick = setInterval(() => void (at.value = (at.value + 1) % (CHECKS.length + 2)), 2500);
});
onBeforeUnmount(() => clearInterval(tick));
const kind = (i: number): string => (i < at.value ? 'go' : i === at.value ? 'working' : 'idle');
</script>

<template>
  <div class="module lp-visual ck" aria-hidden="true">
    <div class="lp-row"><span class="label">Run the checks</span><span class="chip" data-tone="quiet">All three must pass</span></div>
    <div v-for="(c, i) in CHECKS" :key="c.cmd" class="ck-row">
      <span class="led" :data-kind="kind(i) === 'go' ? 'idle' : kind(i) === 'working' ? 'working' : 'stopped'" :data-on="kind(i) !== 'idle'"></span>
      <span class="ck-cmd">{{ c.cmd }}</span>
      <span class="ck-note">{{ c.note }}</span>
      <span class="chip" :data-tone="kind(i) === 'go' ? 'go' : kind(i) === 'working' ? 'lit' : 'quiet'">{{ kind(i) === 'go' ? 'pass' : kind(i) === 'working' ? 'running' : 'waiting' }}</span>
    </div>
  </div>
</template>

<style scoped>
.ck-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 2px 10px;
}
.ck-cmd {
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 12px;
}
.ck-note {
  grid-row: 2;
  grid-column: 2;
  color: var(--muted);
  font-size: 12px;
}
.ck-row .chip {
  grid-row: 1 / 3;
  grid-column: 3;
}
.ck .led {
  transition: background-color 0.6s ease;
}
@media (prefers-reduced-motion: reduce) {
  .ck .led {
    transition: none;
  }
}
</style>
