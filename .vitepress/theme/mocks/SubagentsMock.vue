<script setup lang="ts">
// Subagents at the top of docs/features/subagents.md: the tile chip, the console line and the Flight Rules block.
import '../landing/landing.css';
</script>

<template>
  <div class="module lp-visual sm" role="img" aria-label="A console tile with the chip 3 SUBAGENTS, its panel line '2 Explore, 1 general-purpose. 5 started since it began.', and the Flight Rules block SUBAGENTS set to At most N at once with 4.">
    <div class="sm-tile"><span class="label">ANA</span><span class="hint">working</span><span class="chip" data-tone="amber">3 SUBAGENTS</span></div>
    <p class="hint"><span class="chip" data-tone="amber">3 SUBAGENTS</span> 2 Explore, 1 general-purpose. 5 started since it began.</p>
    <div class="sm-rule"><span class="label">SUBAGENTS</span><span class="input">At most N at once</span><span class="input">4</span></div>
  </div>
</template>

<style scoped>
.sm { display: grid; gap: 10px; }
.sm-tile, .sm-rule { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; }
</style>
