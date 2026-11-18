<script setup lang="ts">
// Hold at the top of docs/features/hold.md: a running console with its Hold key, and the same console on hold, with the reason
// and the held mail as the hub writes them (src/server/hub.ts) and the two keys that end a hold.
import '../landing/landing.css';
</script>

<template>
  <div
    class="module lp-visual"
    role="img"
    aria-label="Two consoles. FIDO works and its panel has a Hold key. GUIDO is on hold: needs you, on hold, its mail held, with the keys Resume and Stop."
  >
    <span class="label">Hold · one console</span>
    <div class="hd-grid">
      <div class="hd-col">
        <div class="tile room-tile lp-static" data-kind="working">
          <span class="tile-head"><span class="led" data-kind="working" data-on="true"></span><span class="tile-legend">FIDO</span></span>
          <span class="tile-lcd">
            <span class="tile-sub">Bash: pnpm test</span>
            <span class="tile-sub">Flight dynamics</span>
          </span>
          <span class="tile-foot"><span class="tile-state">WORKING 2 M</span></span>
        </div>
        <span class="lp-row-keys"><span class="btn" data-kind="quiet">Hold</span><span class="btn" data-kind="quiet">Restart</span><span class="btn" data-kind="quiet">Stop</span></span>
      </div>
      <div class="hd-col">
        <div class="tile room-tile lp-static" data-kind="needs">
          <span class="tile-head"><span class="led" data-kind="needs" data-on="true"></span><span class="tile-legend">GUIDO</span><span class="chip" data-tone="amber">hold</span></span>
          <span class="tile-lcd">
            <span class="tile-sub">on hold</span>
            <span class="tile-sub">held: guido is on hold</span>
          </span>
          <span class="tile-foot"><span class="tile-state">NEEDS YOU 4 M</span><span class="tile-state tile-right">2 HELD</span></span>
        </div>
        <span class="lp-row-keys"><span class="btn">Stop</span><span class="btn" data-kind="primary">Resume</span></span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hd-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 230px), 1fr));
  gap: 12px;
}

.hd-col {
  display: grid;
  gap: 8px;
  align-content: start;
}

.hd-grid .tile-head .chip {
  margin-left: auto;
}

.tile-right {
  margin-left: auto;
}

.btn {
  cursor: default;
}
</style>
