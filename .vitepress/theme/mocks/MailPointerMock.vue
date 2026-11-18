<script setup lang="ts">
// What happens to mail by the state of the agent (docs/guide/the-room.md, Agents and messages, rule 3). Every line is from that page.
import { computed, ref } from 'vue';
import '../landing/landing.css';

const STATES = [
  { kind: 'idle', key: 'Idle', lines: ['gonogo: 2 new messages from ana, user.', 'Call read_messages.'], chip: ['go', 'typed'], note: 'The pointer is typed only into an idle agent that shows its input box, no dialog and no text you typed.' },
  { kind: 'working', key: 'Working', lines: ['Edit src/room.ts', 'running pnpm test'], chip: ['amber', 'waits'], note: 'A working agent gets it when its turn ends.' },
  { kind: 'needs', key: 'Needs you', lines: ['startup dialog: answer it', 'in the terminal'], chip: ['amber', 'waits'], note: 'An agent that needs you waits.' },
  { kind: 'stopped', key: 'Stopped', lines: ['stopped', ''], chip: ['nogo', 'undelivered'], note: 'A message to a stopped agent is not queued: it comes back to you as undelivered.' },
] as const;
const at = ref(0);
const s = computed(() => STATES[at.value]!);
</script>

<template>
  <div class="module lp-visual mp">
    <div class="lp-row">
      <span class="label">Mail for FIDO · from ana</span>
      <span class="chip" :data-tone="s.chip[0]">{{ s.chip[1] }}</span>
    </div>
    <div class="tile room-tile lp-static" :data-kind="s.kind === 'idle' ? undefined : s.kind">
      <span class="tile-head">
        <span class="led" :data-kind="s.kind" :data-on="s.kind !== 'stopped'"></span>
        <span class="tile-legend">FIDO</span>
        <span class="tile-num">03</span>
      </span>
      <span class="tile-lcd"><span class="tile-sub">{{ s.lines[0] }}</span><span class="tile-sub">{{ s.lines[1] }}</span></span>
      <span class="tile-foot"><span class="tile-state">{{ s.key }}</span></span>
    </div>
    <div class="lp-note" aria-live="polite">{{ s.note }}</div>
    <div class="lp-row-keys" role="group" aria-label="State of FIDO">
      <button v-for="(x, i) in STATES" :key="x.kind" type="button" class="btn" :aria-pressed="at === i" @click="at = i">{{ x.key }}</button>
    </div>
  </div>
</template>

<style scoped>
/* A pressed key, as on the landing (landing.css .lp .btn[aria-pressed]): panel on text. */
.btn[aria-pressed='true'] {
  border-color: var(--text);
  background: var(--text);
  color: var(--panel);
}
.mp .tile-sub {
  white-space: normal;
}
</style>
