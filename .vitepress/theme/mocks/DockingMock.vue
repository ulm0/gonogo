<script setup lang="ts">
// Two docked stations at the top of docs/features/docking.md, after the landing's: this one (alpha) with a message to ana@lab and
// a task handed off, the other (lab) with its AGENTS fold. Words from docs/features/docking.md and src/client/docking.ts.
import '../landing/landing.css';
</script>

<template>
  <div class="lp-visual lp-dock" role="img" aria-label="Two docked stations, alpha and lab. A message to ana@lab was delivered, and task t4 was handed off to lab.">
    <div class="module lp-station">
      <span class="label">Station · alpha</span>
      <span class="lamp" data-link="up"><span class="led" data-on="true"></span>DOCKED · lab</span>
      <span class="mk-row"><span class="legend">ana@lab</span><span class="chip" data-tone="go">delivered</span></span>
      <span class="mk-note">accepted by lab: queued</span>
      <span class="lp-card">
        <span class="mk-row"><span class="tile-num">t4</span><span class="chip" data-tone="quiet">DONE</span><span class="chip" data-tone="quiet">HANDED OFF · lab</span></span>
      </span>
    </div>
    <span class="lp-link" aria-hidden="true"></span>
    <div class="module lp-station">
      <span class="label">Station · lab</span>
      <span class="lamp" data-link="up"><span class="led" data-on="true"></span>DOCKED · alpha</span>
      <span class="label">Agents (2)</span>
      <span class="mk-row"><span class="legend">ana@lab</span><span class="chip" data-tone="go">working</span></span>
      <span class="mk-row"><span class="legend">bob@lab</span><span class="chip" data-tone="quiet">idle</span></span>
    </div>
  </div>
</template>

<style scoped>
.mk-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
}

.mk-row .tile-num {
  margin-left: 0;
}

.mk-note {
  color: var(--text-2);
  font-size: 13.5px;
}
</style>
