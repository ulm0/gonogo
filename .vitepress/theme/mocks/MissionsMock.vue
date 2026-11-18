<script setup lang="ts">
// Missions at the top of docs/features/missions.md: one mission with its status keys, progress, cost and the tasks that serve it.
import '../landing/landing.css';
</script>

<template>
  <div class="module lp-visual ms" role="img" aria-label="Mission Ship 0.2, active, lead FLIGHT, 3 of 7 tasks done, cost 1.20 dollars of a 10 dollar budget, with three of its tasks.">
    <span class="lp-row"><span class="tile-num">ms3</span><span class="legend">Ship 0.2</span><span class="chip" data-tone="lit">active</span><span class="hint">lead FLIGHT</span><span class="lcd-num ms-right">3 / 7</span></span>
    <span class="lp-row-keys"><span class="btn" data-kind="quiet">Pause</span><span class="btn" data-kind="quiet">Done</span><span class="btn" data-kind="quiet">Abort</span></span>
    <div class="lp-card"><span class="lp-row"><span class="tile-num">t3</span><span class="led" data-kind="working" data-on="true"></span><span class="legend">GUIDO</span><span class="ms-right lcd-num">$0.70</span></span><span>Cut the release</span></div>
    <div class="lp-card"><span class="lp-row"><span class="tile-num">t5</span><span class="led" data-kind="idle" data-on="true"></span><span class="legend">PAO</span><span class="ms-right lcd-num">$0.50</span></span><span>Write the changelog</span></div>
    <div class="flood" data-tone="lit"><span class="label">Cost</span><span class="lcd-num">$1.20 of $10.00</span><span class="hint">API-equivalent estimate. Budget in dollars, in all.</span></div>
  </div>
</template>

<style scoped>
.ms { display: grid; gap: 8px; }
.ms-right { margin-left: auto; }
.flood { display: grid; gap: 4px; padding: 10px; }
</style>
