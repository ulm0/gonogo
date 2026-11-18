<script setup lang="ts">
// A console that needs you, with the reasons docs/reference/troubleshooting.md explains and what that page says to do.
import { computed, ref } from 'vue';
import '../landing/landing.css';

const REASONS = [
  { key: 'Startup dialog', line: 'startup dialog: answer it in the terminal', fix: 'Read it, answer it, and the agent goes on.' },
  { key: 'Text in input', line: "held: text in ana's input", fix: 'Submit it, or clear it with Ctrl-C (or Esc twice) in that terminal.' },
  { key: 'No hook', line: 'held: no hook has reached gonogo from ana; is its folder trusted?', fix: 'Outside seed mode answer the trust dialog in the agent\'s terminal.' },
  { key: 'Pointer', line: 'held: pointer not confirmed within 2 s', fix: 'Press Enter in that terminal to send it, or Ctrl-C to clear it.' },
];
const at = ref(0);
const r = computed(() => REASONS[at.value]!);
</script>

<template>
  <div class="module lp-visual hd">
    <div class="tile room-tile lp-static" data-kind="needs">
      <span class="tile-head">
        <span class="led" data-kind="needs" data-on="true"></span>
        <span class="tile-legend">ana</span>
      </span>
      <span class="tile-lcd" aria-live="polite"><span class="tile-sub">{{ r.line }}</span></span>
      <span class="tile-foot"><span class="tile-state">needs you</span></span>
    </div>
    <div class="lp-note">{{ r.fix }}</div>
    <div class="lp-row-keys" role="group" aria-label="Reason">
      <button v-for="(x, i) in REASONS" :key="x.key" type="button" class="btn" :aria-pressed="at === i" @click="at = i">{{ x.key }}</button>
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
.hd .tile-sub {
  white-space: normal;
}
</style>
