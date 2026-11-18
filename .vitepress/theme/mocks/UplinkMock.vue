<script setup lang="ts">
// An Uplink row at the top of docs/features/uplink.md: the address, the last deliveries with their status chips, the keys, and
// the saffron panel that shows a secret once. Every value is the page's own (its address example, its message ids).
import '../landing/landing.css';

const DELIVERIES = [
  { status: 'queued', tone: 'go', note: 'm12' },
  { status: 'held', tone: 'amber', note: 'm13' },
  { status: 'undelivered', tone: 'nogo', note: 'm14' },
];
</script>

<template>
  <div class="module lp-visual ul" aria-hidden="true">
    <div class="lp-row">
      <span class="label">Uplink</span>
      <span class="legend">GitHub</span>
      <span class="ul-to">to FLIGHT</span>
      <span class="chip" data-tone="quiet">generic</span>
    </div>
    <div class="ul-url">
      <span class="lcd ul-addr">https://hooks.example.com/uplink/u1</span>
      <span class="btn">Copy</span>
    </div>
    <div class="ul-log">
      <span class="label">Deliveries</span>
      <span v-for="d in DELIVERIES" :key="d.note" class="lp-row"><span class="chip" :data-tone="d.tone">{{ d.status }}</span><span class="ul-note">{{ d.note }}</span></span>
    </div>
    <div class="lp-row-keys">
      <span class="btn"><span class="led" data-on="true"></span>Enabled</span>
      <span class="btn">Test</span>
      <span class="btn">Rotate secret</span>
      <span class="btn" data-kind="quiet">Edit</span>
      <span class="btn" data-kind="danger">Delete</span>
    </div>
    <div class="flood ul-secret" data-tone="amber">
      <span class="label ul-ink">Secret · shown once</span>
      <span class="lcd ul-addr">&lt;64 hex characters&gt;</span>
    </div>
  </div>
</template>

<style scoped>
.ul {
  --led: var(--go);
}

.ul .btn {
  min-height: 36px;
  padding: 0 12px;
  cursor: default;
}

.ul-to,
.ul-note {
  color: var(--text-2);
  font-family: var(--font-mono);
  font-size: 12px;
}

.ul-url {
  display: flex;
  gap: 8px;
  align-items: center;
}

.ul-addr {
  flex: 1;
  min-width: 0;
  padding: 8px 12px;
  font-size: 13px;
  overflow-wrap: anywhere;
}

.ul-log {
  display: grid;
  gap: 6px;
}

.ul-secret {
  display: grid;
  gap: 8px;
  padding: 12px;
}

/* muted is not checked on the saffron tint: its ink carries the label there */
.ul-ink {
  color: var(--you-ink);
}
</style>
