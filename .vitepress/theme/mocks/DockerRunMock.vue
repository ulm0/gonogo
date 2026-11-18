<script setup lang="ts">
// The container that docs/guide/docker.md runs: every value is from that page.
import '../landing/landing.css';

const ROWS = [
  ['Image', 'gonogo:0.1.0 · Debian bookworm'],
  ['User', 'node · uid 1000'],
  ['Port', '127.0.0.1:7777 → 7777'],
  ['Volumes', 'gonogo-state:/state · gonogo-projects:/projects'],
  ['Command', 'gonogo --host 0.0.0.0 --port 7777'],
];
</script>

<template>
  <div class="module lp-visual dr" role="img" aria-label="The gonogo container: image gonogo:0.1.0 on Debian bookworm, user node with uid 1000, port 127.0.0.1:7777, the state and projects volumes, healthy, and a log line whose URL holds the browser token.">
    <div class="lp-row">
      <span class="label">Container · gonogo</span>
      <span class="chip" data-tone="go"><span class="led" data-kind="idle" data-on="true"></span> healthy</span>
    </div>
    <div class="dr-rows">
      <template v-for="[k, v] in ROWS" :key="k">
        <span class="label">{{ k }}</span><span class="dr-v">{{ v }}</span>
      </template>
    </div>
    <div class="lcd dr-log">
      <span class="dr-dim">$ docker logs gonogo</span>
      <span>gonogo ready: http://127.0.0.1:7777/#token=&lt;64 hex&gt;</span>
    </div>
    <div class="lp-row"><span class="chip" data-tone="amber">the URL holds the browser token</span></div>
  </div>
</template>

<style scoped>
.dr-rows {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 8px 14px;
  align-items: baseline;
}
.dr-v {
  min-width: 0;
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.dr-log {
  display: grid;
  gap: 4px;
  padding: 10px 12px;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.dr-dim {
  color: var(--lcd-dim);
}
.chip .led {
  width: 6px;
  height: 6px;
  margin-right: 4px;
  vertical-align: 1px;
}
</style>
