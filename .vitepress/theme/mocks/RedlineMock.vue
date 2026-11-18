<script setup lang="ts">
// Redline at the top of docs/features/redline.md: one console tripped by each rule, with the reason and the held mail as the hub
// writes them (src/server/hub.ts, src/server/propellant.ts), and the two keys that end a trip.
import '../landing/landing.css';

const TRIPS = [
  { name: 'fido', rule: 'loop', reason: 'redline: loop: Bash: pnpm test 5 times in a row' },
  { name: 'guido', rule: 'error storm', reason: 'redline: error storm: 8 failed tool calls in 2 min' },
  { name: 'eecom', rule: 'ping-pong', reason: 'redline: ping-pong: 16 messages to fido in 10 min' },
  { name: 'retro', rule: 'propellant', reason: 'redline: out of propellant: 2M of 2M tokens in day' },
];
</script>

<template>
  <div
    class="module lp-visual"
    role="img"
    aria-label="Four consoles stopped by Redline, one for each rule: a loop, an error storm, a ping-pong and a Propellant limit. Each shows needs you, its redline reason and its held mail, with the keys Resume and Stop."
  >
    <span class="label">Redline · circuit breaker</span>
    <div class="rl-grid">
      <div v-for="t in TRIPS" :key="t.name" class="tile room-tile lp-static" data-kind="needs">
        <span class="tile-head"><span class="led" data-kind="needs" data-on="true"></span><span class="tile-legend">{{ t.name }}</span><span class="chip" data-tone="amber">{{ t.rule }}</span></span>
        <span class="tile-lcd">
          <span class="tile-sub">{{ t.reason }}</span>
          <span class="tile-sub">held: redline on {{ t.name }}</span>
        </span>
        <span class="tile-foot"><span class="tile-state">needs you</span></span>
      </div>
    </div>
    <span class="lp-row-keys"><span class="btn" data-kind="primary">Resume</span><span class="btn">Stop</span></span>
  </div>
</template>

<style scoped>
.rl-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 230px), 1fr));
  gap: 8px;
}

.rl-grid .tile-head .chip {
  margin-left: auto;
}

/* the whole reason, on as many lines as it needs */
.rl-grid .tile-sub {
  white-space: normal;
  overflow-wrap: anywhere;
}

.btn {
  cursor: default;
}
</style>
