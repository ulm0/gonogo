<script setup lang="ts">
// Rooms at the top of docs/features/rooms.md: the page the supervisor serves at /, built from the primitives of the app: a top bar, one room card
// for each room (the Room view's tile: light, LCD with the counts and the last activity, foot with the id and the tab name) and the keys.
import '../landing/landing.css';
</script>

<template>
  <div class="module lp-visual rm" role="img" aria-label="Rooms page: top bar with the logo and NEW ROOM. Three rooms as cards. Main: needs you, files in rooms/main with a note and UNDO, 3 of 4 agents running, 1 needs you and 2 working, last activity 4 minutes ago, OPEN. Team B: running, 2 of 2 agents running, OPEN, RENAME, REMOVE. Staging: crashed, with its reason, OPEN disabled, RENAME, REMOVE.">
    <div class="rm-bar">
      <span class="label">GN-1 · ROOMS</span>
      <span class="btn" data-kind="primary">NEW ROOM</span>
    </div>
    <div class="rm-sum"><span class="label">Rooms</span><span class="chip">3 rooms</span><span class="chip" data-tone="amber">1 needs you</span></div>
    <div class="rm-list">
      <div class="tile room-tile rm-card lp-static" data-kind="needs">
        <span class="tile-head"><span class="led" data-on="true" data-blink="true"></span><span class="tile-legend">Main</span><span class="tile-state">NEEDS YOU</span></span>
        <span class="tile-lcd"><span class="tile-sub">3 of 4 agents running</span><span class="tile-sub">1 need you · 2 working</span><span class="tile-sub">last activity 4 min ago</span></span>
        <span class="tile-foot"><span>r/main</span><span>tab: Ops</span><span>files: …/rooms/main</span></span>
        <span class="rm-keys"><span class="btn" data-kind="primary">OPEN</span></span>
        <span class="flood rm-note" data-tone="amber"><span>Room main now lives in rooms/main (23 files moved, 2 h ago). The supervisor’s own files stayed at the root. UNDO moves them back at the next start.</span><span class="rm-keys"><span class="btn">UNDO</span><span class="btn">DISMISS</span></span></span>
      </div>
      <div class="tile room-tile rm-card lp-static">
        <span class="tile-head"><span class="led" data-on="true"></span><span class="tile-legend">Team B</span><span class="tile-state">RUNNING</span></span>
        <span class="tile-lcd"><span class="tile-sub">2 of 2 agents running</span><span class="tile-sub">last activity 2 h ago</span></span>
        <span class="tile-foot"><span>r/team</span></span>
        <span class="rm-keys"><span class="btn" data-kind="primary">OPEN</span><span class="btn">RENAME</span><span class="btn" data-kind="danger">REMOVE</span></span>
      </div>
      <div class="tile room-tile rm-card lp-static" data-kind="crashed">
        <span class="tile-head"><span class="led" data-on="true"></span><span class="tile-legend">Staging</span><span class="tile-state">CRASHED</span></span>
        <span class="tile-lcd"><span class="tile-sub">crashed, starting again</span><span class="tile-sub">gonogo: port 7801 is in use</span></span>
        <span class="tile-foot"><span>r/staging</span></span>
        <span class="rm-keys"><span class="btn" aria-disabled="true">OPEN</span><span class="btn">RENAME</span><span class="btn" data-kind="danger">REMOVE</span></span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rm { display: grid; gap: 10px; }
.rm-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.rm-sum { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; }
.rm-list { display: grid; gap: 8px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 220px), 1fr)); }
.rm-card { gap: 8px; padding: 10px; cursor: default; }
.rm-card .tile-state { margin-left: auto; }
.rm-card .tile-lcd { min-height: 0; font-size: 11px; }
.rm-card .tile-foot { font-family: var(--font-mono); font-size: 10px; color: var(--muted); }
.rm-note { display: grid; gap: 6px; padding: 8px; font-size: 11px; }
.rm-keys { display: flex; flex-wrap: wrap; gap: 6px; }
.rm-keys .btn { flex: 1 1 auto; min-height: 36px; padding: 0 10px; }
</style>
