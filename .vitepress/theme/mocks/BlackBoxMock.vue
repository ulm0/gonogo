<script setup lang="ts">
// The Black Box page at the top of docs/features/black-box.md: the git line, the command that reads the repository and the newest
// events, with the chips and the words of the app (src/client/audit.ts) and the texts the server writes (src/server/audited.ts).
// Nothing is read from anywhere: the times are the example times of the page.
import { ref } from 'vue';
import { gitText, KIND_CHIPS } from '../../../src/client/audit';
import type { AuditKind } from '../../../src/shared/protocol';

const COMMAND = "git -C '/home/you/.gonogo/black-box' log -p";
const EVENTS: Array<{ at: string; kind: AuditKind; text: string }> = [
  { at: '2026-11-18 14:07:41', kind: 'poll', text: 'T-minus poll HOLD: no-go: simsup' },
  { at: '2026-11-18 14:07:12', kind: 'poll', text: 'Director started a T-minus poll' },
  { at: '2026-11-18 14:03:55', kind: 'redline', text: 'guido tripped the Redline: loop' },
  { at: '2026-11-18 14:01:20', kind: 'uplink', text: 'Uplink u1 delivered message m41' },
  { at: '2026-11-18 13:58:09', kind: 'plan', text: 'flight wrote the Plot Board: revision 4, 312 characters' },
  { at: '2026-11-18 13:52:30', kind: 'plan', text: 'ana updated task t3: status doing' },
  { at: '2026-11-18 13:50:02', kind: 'crew', text: 'Director hired guido' },
  { at: '2026-11-18 13:49:58', kind: 'audit', text: 'gonogo 0.1.1 started' },
];
const state = ref<'ok' | 'missing'>('ok');
const copied = ref('');

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(COMMAND);
    copied.value = 'Copied.';
  } catch {
    copied.value = 'The browser would not copy it: select the command and copy it by hand.';
  }
}
</script>

<template>
  <div class="mk">
    <p class="flood mk-git" :data-tone="state === 'ok' ? 'lit' : 'amber'">
      {{ gitText({ git: state, note: 'git was not found on the PATH' }) }}
      <button type="button" class="btn mk-flip" data-kind="quiet" @click="state = state === 'ok' ? 'missing' : 'ok'">{{ state === 'ok' ? 'Without git' : 'With git' }}</button>
    </p>
    <div class="module mk-box">
      <div class="field">
        <label for="bb-mock-cmd">Read it with git</label>
        <input id="bb-mock-cmd" class="lcd mk-cmd" readonly :value="COMMAND" spellcheck="false" @focus="($event.target as HTMLInputElement).select()" />
      </div>
      <button type="button" class="btn" @click="copy">Copy</button>
      <p class="mk-copied" role="status">{{ copied }}</p>
    </div>
    <ol class="module mk-events">
      <li v-for="(e, i) in EVENTS" :key="i" class="mk-event">
        <time class="mk-when">{{ e.at }}</time>
        <span class="chip" :data-tone="KIND_CHIPS[e.kind].tone">{{ KIND_CHIPS[e.kind].text }}</span>
        <span class="mk-text">{{ e.text }}</span>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.mk {
  display: grid;
  gap: 12px;
}

.mk-git {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  margin: 0;
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.45;
}

.mk-box {
  display: grid;
  justify-items: start;
  gap: 10px;
  padding: 14px;
}

.mk-box .field {
  width: 100%;
}

.mk-cmd {
  width: 100%;
  min-width: 0;
  height: 46px;
  padding: 0 14px;
  border: 1px solid var(--edge);
  font-size: 12.5px;
}

.mk-copied {
  min-height: 1.2em;
  margin: 0;
  color: var(--text-2);
  font-size: 12.5px;
}

.mk-events {
  display: grid;
  margin: 0;
  padding: 0 14px;
  list-style: none;
}

.mk-event {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr);
  align-items: baseline;
  gap: 4px 12px;
  padding: 10px 0;
  border-top: 1px solid var(--edge);
}

.mk-event:first-child {
  border-top: 0;
}

.mk-when {
  color: var(--text-2);
  font-family: var(--font-mono);
  font-size: 11.5px;
}

.mk-text {
  font-size: 13.5px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

@media (max-width: 560px) {
  .mk-event {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .mk-text {
    grid-column: 1 / -1;
  }
}
</style>
