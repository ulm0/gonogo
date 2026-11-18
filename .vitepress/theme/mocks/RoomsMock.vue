<script setup lang="ts">
// Rooms at the top of docs/features/rooms.md: the list the supervisor serves at /, one tile per room, built from the room tile and key primitives.
import '../landing/landing.css';
</script>

<template>
  <div class="module lp-visual rm" role="img" aria-label="Rooms: Main, 3 of 4 agents running, 1 needs you, OPEN. Team B, 2 of 2 agents running, OPEN. Staging, stopped.">
    <span class="label">ROOMS · gonogo.example:7777</span>
    <div class="rm-list">
      <div class="tile lp-static" data-kind="needs">
        <span class="legend">MAIN</span><span class="tile-sub">3 of 4 agents running</span><span class="hint">1 needs you</span>
        <span class="btn" data-kind="primary">OPEN</span>
      </div>
      <div class="tile lp-static" data-kind="working">
        <span class="legend">TEAM B</span><span class="tile-sub">2 of 2 agents running</span>
        <span class="btn" data-kind="primary">OPEN</span>
      </div>
      <div class="tile lp-static">
        <span class="legend">STAGING</span><span class="tile-sub">stopped</span>
        <span class="btn" aria-disabled="true">OPEN</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rm { display: grid; gap: 8px; }
.rm-list { display: grid; gap: 8px; }
.rm-list .tile { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; }
.rm-list .legend { flex: 1 1 8em; }
</style>
