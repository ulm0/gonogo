<script setup lang="ts">
// Feature toggles at the top of docs/features/features.md: the FEATURES block of Flight Rules, with a plan open under one row.
import '../landing/landing.css';
const ROWS = [
  ['Max Q', 'on', ''],
  ['T-minus poll', 'off', 'used by Static fire'],
  ['Static fire', 'off', 'needs T-minus poll'],
  ['Relief', 'on', ''],
];
</script>

<template>
  <div class="module lp-visual fm" role="img" aria-label="FEATURES block: Max Q on, T-minus poll off, Static fire off because it needs T-minus poll, Relief on; Black Box locked as core; a plan open for turning on Static fire: it also turns on T-minus poll.">
    <span class="label">FEATURES</span>
    <div v-for="r in ROWS" :key="r[0]" class="fm-row">
      <input type="checkbox" role="switch" class="switch" :checked="r[1] === 'on'" :aria-label="r[0]" disabled />
      <strong>{{ r[0] }}</strong>
      <span class="chip" data-tone="quiet" v-if="r[2]">{{ r[2] }}</span>
    </div>
    <div class="fm-row"><span class="icon" data-icon="lock" aria-hidden="true" /><strong>Black Box</strong><span class="hint">Core: an audit trail that can be switched off is not one.</span></div>
    <div class="flood fm-plan">
      <span class="hint">Turning on Static fire also turns on T-minus poll, which it needs.</span>
      <span class="btn">CANCEL</span><span class="btn" data-kind="primary">TURN ON</span>
    </div>
  </div>
</template>

<style scoped>
.fm { display: grid; gap: 8px; }
.fm-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; }
.fm-plan { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 8px; }
</style>
