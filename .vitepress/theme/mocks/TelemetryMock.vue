<script setup lang="ts">
// Telemetry at the top of docs/features/telemetry.md: the TELEMETRY fold of a console panel, newest call first, with start time,
// tool, duration (a failure says so), a bar scaled to the longest call and the one-line summary (src/client/TelemetryPanel.tsx).
import '../landing/landing.css';

const CALLS = [
  { time: '14:03:27', tool: 'Bash', ms: 'running', bar: 0, detail: 'pnpm exec vitest run' },
  { time: '14:03:19', tool: 'Edit', ms: '42 ms', bar: 2, detail: 'src/server/hub.ts' },
  { time: '14:02:58', tool: 'Bash', ms: '18.4 s · failed', bar: 100, detail: 'pnpm typecheck' },
  { time: '14:02:51', tool: 'Read', ms: '9 ms', bar: 2, detail: 'docs/contract.md' },
  { time: '14:02:40', tool: 'read_messages', ms: '120 ms', bar: 2, detail: '' },
];
</script>

<template>
  <div
    class="module lp-visual"
    role="img"
    aria-label="The Telemetry fold of a console: five tool calls, newest first, each with its start time, tool, duration and what it ran. One Bash call is still running; one failed after 18.4 seconds."
  >
    <span class="label">Telemetry · FIDO</span>
    <ol class="lcd tm-list">
      <li v-for="c in CALLS" :key="c.time" class="tm-row">
        <span class="tm-dim">{{ c.time }}</span>
        <span class="tm-tool">{{ c.tool }}</span>
        <span class="tm-dim" :class="{ 'tm-warm': c.ms.endsWith('failed') }">{{ c.ms }}</span>
        <span class="tm-bar"><span :style="{ width: c.bar + '%' }"></span></span>
        <span v-if="c.detail" class="tm-detail">{{ c.detail }}</span>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.tm-list {
  margin: 0;
  padding: 8px 10px;
  list-style: none;
  font-size: 12px;
}

.tm-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 2px 10px;
  padding: 6px 0;
  border-bottom: 1px solid rgb(255 255 255 / 8%);
}

.tm-row:last-child {
  border-bottom: 0;
}

.tm-dim {
  color: var(--lcd-dim);
  font-variant-numeric: tabular-nums;
}

.tm-warm {
  color: var(--lcd-warm);
}

.tm-tool {
  font-weight: 600;
}

.tm-bar {
  grid-column: 1 / -1;
  height: 3px;
  border-radius: 2px;
  background: rgb(255 255 255 / 6%);
}

.tm-bar > span {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--lcd-dim);
}

.tm-detail {
  grid-column: 1 / -1;
  overflow-wrap: anywhere;
  color: var(--lcd-text);
}
</style>
