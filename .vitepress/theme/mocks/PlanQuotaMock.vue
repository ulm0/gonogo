<script setup lang="ts">
// Plan quota at the top of docs/features/quota.md: the PLAN block of the Propellant module (week window at 82 %, the 5-hour window under
// 80 %) with the label of where the number comes from, and the line shown when there is no source. Static; numbers are the page's examples.
import '../landing/landing.css';
</script>

<template>
  <div class="module lp-visual pq" role="img" aria-label="Propellant module. PLAN block: 5-hour window at 41 percent, resets in 2 hours 10 minutes; week window at 82 percent, saffron, resets in 1 day 4 hours. Labelled from Claude Code: your plan's own number. Below, the line shown with no source: no plan quota reported, the meters are an estimate.">
    <span class="label">Propellant · PLAN</span>
    <div class="pq-row"><span class="legend">5-HOUR</span><span class="pq-bar"><i style="width: 41%"></i></span><span class="lcd-num">41 %, resets in 2 h 10 min</span></div>
    <div class="pq-row" data-hot="true"><span class="legend">WEEK</span><span class="pq-bar"><i style="width: 82%"></i></span><span class="lcd-num">82 %, resets in 28 h 0 min</span><span class="chip" data-tone="amber">80 %</span></div>
    <span class="hint">from Claude Code: your plan's own number.</span>
    <span class="label">With no source</span>
    <span class="hint">No plan quota reported. A subscriber's Claude Code agent reports it after its first reply; an API-key or Bedrock room has none (see COST). The meters below are gonogo's own ledger: an estimate, not your plan's number.</span>
  </div>
</template>

<style scoped>
.pq { display: grid; gap: 8px; }
.pq-row { display: grid; grid-template-columns: 64px 1fr auto auto; gap: 10px; align-items: center; }
.pq-bar { height: 8px; background: var(--key); border-radius: 4px; overflow: hidden; }
.pq-bar i { display: block; height: 100%; background: var(--work); }
.pq-row[data-hot='true'] .pq-bar i { background: var(--you); }
@media (max-width: 480px) { .pq-row { grid-template-columns: 56px 1fr; } .pq-row .lcd-num, .pq-row .chip { grid-column: 1 / -1; } }
</style>
