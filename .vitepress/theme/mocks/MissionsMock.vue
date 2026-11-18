<script setup lang="ts">
// Missions at the top of docs/features/missions.md: one mission with its status keys, progress, cost and the tasks that serve it.
import '../landing/landing.css';
</script>

<template>
  <div class="module lp-visual ms" role="img" aria-label="Mission Ship 0.2, active, lead FLIGHT, 3 of 7 tasks done, cost 1.20 dollars of a 10 dollar budget, with three of its tasks.">
    <span class="lp-row"><span class="tile-num">ms3</span><span class="legend">Ship 0.2</span><span class="chip" data-tone="go">ACTIVE</span><span class="hint">lead FLIGHT</span><span class="lcd-num ms-right">3 / 7</span></span>
    <span class="lp-row-keys"><span class="btn" data-kind="quiet">PAUSE</span><span class="btn" data-kind="quiet">DONE</span><span class="btn" data-kind="quiet">ABORT</span></span>
    <div class="lp-card"><span class="lp-row"><span class="tile-num">t3</span><span class="led" data-kind="working" data-on="true"></span><span class="legend">GUIDO</span><span class="ms-right lcd-num">$0.70</span></span><span>Cut the release</span></div>
    <div class="lp-card"><span class="lp-row"><span class="tile-num">t5</span><span class="led" data-kind="idle" data-on="true"></span><span class="legend">PAO</span><span class="ms-right lcd-num">$0.50</span></span><span>Write the changelog</span></div>
    <div class="ms-cost"><span class="label">COST</span><span>$1.20 of $10.00</span><span class="hint">Budget in dollars. Replies are counted to the mission while an agent has one of its tasks on doing.</span></div>
  </div>
</template>

<style scoped>
.ms-cost { display: grid; gap: 4px; }
.ms { display: grid; gap: 8px; }
.ms-right { margin-left: auto; }
.flood { display: grid; gap: 4px; padding: 10px; }
</style>
