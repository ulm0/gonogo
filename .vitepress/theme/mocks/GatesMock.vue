<script setup lang="ts">
// What each door of the server asks for (docs/reference/security.md). Every line is from that page.
import '../landing/landing.css';

const GATES = [
  { door: '/api/*, /ws', who: 'Your browser', key: 'browser token', tone: 'quiet' },
  { door: 'POST /uplink/<id>', who: 'Senders outside', key: 'secret of that uplink', tone: 'quiet' },
  { door: 'hook and tool endpoints', who: 'Your agents', key: 'GONOGO_TOKEN', tone: 'quiet' },
  { door: 'built client files', who: 'They hold no state', key: 'no token', tone: 'quiet' },
  { door: 'Host not allowed', who: 'DNS rebinding, cross-site', key: '403', tone: 'nogo' },
];
</script>

<template>
  <div class="module lp-visual gt" role="img" aria-label="The doors of gonogo on 127.0.0.1: /api and /ws need the browser token, POST /uplink needs the secret of that uplink, the hook and tool endpoints need the agent's GONOGO_TOKEN, the built client files need none, and a Host that is not allowed gets 403.">
    <div class="lp-row">
      <span class="label">127.0.0.1 unless --host · no TLS</span>
    </div>
    <div class="gt-rows">
      <div v-for="g in GATES" :key="g.door" class="gt-row">
        <span class="led" :style="{ '--led': g.tone === 'nogo' ? 'var(--nogo)' : 'var(--go)' }" data-on="true"></span>
        <span class="gt-door">{{ g.door }}</span>
        <span class="gt-who">{{ g.who }}</span>
        <span class="chip" :data-tone="g.tone">{{ g.key }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.gt-rows {
  display: grid;
}
.gt-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 2px 10px;
  padding: 8px 0;
  border-bottom: 1px solid var(--edge);
}
.gt-row:last-child {
  border-bottom: 0;
}
.gt-door {
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.gt-who {
  grid-row: 2;
  grid-column: 2;
  color: var(--muted);
  font-size: 12px;
}
.gt-row .chip {
  grid-row: 1 / 3;
  grid-column: 3;
  text-transform: none;
}
</style>
