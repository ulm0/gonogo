<script setup lang="ts">
// Live reload at the top of docs/features/live-reload.md: the Reload gonogo key and the two processes it separates.
import '../landing/landing.css';
</script>

<template>
  <div class="module lp-visual lr" role="img" aria-label="Flight Rules key Reload gonogo. The pty host keeps three agent terminals; the server is replaced, 0.2.0 to 0.3.0.">
    <span class="label">Flight Rules · Reload gonogo</span>
    <span class="lp-row-keys"><span class="btn" data-kind="primary">Reload gonogo</span></span>
    <div class="lr-cols">
      <div class="tile lp-static"><span class="legend">SERVER</span><span class="tile-sub">0.2.0 → 0.3.0</span><span class="hint">replaced</span></div>
      <div class="tile lp-static" data-kind="working"><span class="legend">PTY HOST</span><span class="tile-sub">flight, ana, guido</span><span class="hint">keeps running</span></div>
    </div>
  </div>
</template>

<style scoped>
.lr { display: grid; gap: 8px; }
.lr-cols { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 200px), 1fr)); gap: 10px; }
</style>
