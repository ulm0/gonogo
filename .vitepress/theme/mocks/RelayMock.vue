<script setup lang="ts">
// The RELAY module at the top of docs/features/relay.md: the four services coming in, each with the header it proves itself by,
// and what goes out to the targets. The labels are the app's own (src/client/relay.ts); the values are the examples of the page.
import { RELAY_FORWARD_KINDS } from '../../../src/shared/protocol';
import { FORWARD_LABELS, SERVICES } from '../../../src/client/relay';

const HEADERS: Record<string, string> = {
  github: 'X-Hub-Signature-256',
  linear: 'Linear-Signature',
  slack: 'X-Slack-Signature',
  telegram: 'X-Telegram-Bot-Api-Secret-Token',
};
</script>

<template>
  <div class="mk" aria-hidden="true">
    <div class="module mk-side">
      <span class="label">In · uplinks</span>
      <div v-for="s in SERVICES" :key="s.kind" class="mk-row">
        <span class="legend">{{ s.label }}</span>
        <code>{{ HEADERS[s.kind] }}</code>
      </div>
      <span class="lcd mk-lcd">Uplink: &lt;name&gt;</span>
      <span class="lcd mk-lcd">Telegram without an uplink: getUpdates, no public address</span>
    </div>
    <div class="module mk-side">
      <span class="label">Out · forwarded to the targets</span>
      <div v-for="k in RELAY_FORWARD_KINDS" :key="k" class="mk-row">
        <span class="led" data-kind="working" data-on="true"></span>
        <span class="mk-text">{{ FORWARD_LABELS[k] }}</span>
      </div>
      <div class="mk-row mk-target">
        <span class="legend">Slack</span><span class="chip" data-tone="quiet">Channel id</span><code>C0123456789</code>
      </div>
      <div class="mk-row mk-target">
        <span class="legend">Telegram</span><span class="mk-text mk-muted">No target yet: nothing is sent to Telegram.</span>
      </div>
      <span class="lcd mk-lcd">Message from ana: &lt;subject&gt;</span>
    </div>
  </div>
</template>

<style scoped>
.mk {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr));
  gap: 10px;
}

.mk-side {
  display: grid;
  align-content: start;
  gap: 10px;
  min-width: 0;
  padding: 14px;
}

.mk-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  min-width: 0;
}

.mk-row .legend {
  min-width: 6.5em;
}

.mk-row code {
  font-size: 12px;
  overflow-wrap: anywhere;
}

.mk-text {
  font-size: 14px;
}

.mk-muted {
  color: var(--text-2);
}

.mk-target {
  padding-top: 10px;
  border-top: 1px solid var(--edge);
}

.mk-target + .mk-target {
  padding-top: 0;
  border-top: 0;
}

.mk-lcd {
  padding: 8px 10px;
  font-size: 12.5px;
  overflow-wrap: anywhere;
}
</style>
