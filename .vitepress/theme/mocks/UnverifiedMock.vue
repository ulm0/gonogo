<script setup lang="ts">
// The areas of docs/reference/not-verified.md, one chip each, in the order of that page.
import '../landing/landing.css';

const AREAS = [
  'Docker', 'Linux', 'Sign-in in a container', 'A real claude, end to end', 'Positions, T-minus, Max Q, custom agents, the room and the wall',
  'The auto permission mode', 'Engine Bay', 'Payload', 'Clean Room', 'Launch Window', 'Uplink', 'Flight Plan', 'Downlink', 'Mission Log',
  'Relay', 'Livery', 'Docking', 'The proxy recipe', 'Versions of the saved state', 'Release', 'Tests', 'The browser, overall',
];
</script>

<template>
  <div class="module lp-visual uv" aria-hidden="true">
    <div class="lp-row">
      <span class="label">What was not verified</span>
      <span class="lcd uv-lcd"><span class="lcd-num">{{ AREAS.length }}</span></span>
    </div>
    <div class="lp-row-keys">
      <span v-for="a in AREAS" :key="a" class="chip" data-tone="quiet">{{ a }}</span>
    </div>
  </div>
</template>

<style scoped>
.uv-lcd {
  padding: 5px 9px;
  font-size: 20px;
}
.uv .chip {
  white-space: normal;
}
</style>
