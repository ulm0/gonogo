<script setup lang="ts">
// The Flight Plan board at the top of docs/features/flight-plan.md: the landing's five columns, and one card (t3) that moves with
// a key for every other column, leaving a history line as the server writes it (src/server/tasks.ts). Nothing is sent anywhere.
import { computed, nextTick, ref } from 'vue';
import { COLUMNS } from '../../../src/client/plan';
import type { TaskStatus } from '../../../src/shared/protocol';
import '../landing/landing.css';

const OTHERS = [
  { id: 't5', who: 'RETRO', kind: 'idle', title: 'Write the release notes', status: 'todo' },
  { id: 't2', who: 'GUIDO', kind: 'idle', title: 'Phone bar keys', status: 'review' },
  { id: 't4', who: 'EECOM', kind: 'needs', title: 'Needs a Docker host', status: 'blocked' },
  { id: 't1', who: 'FLIGHT', kind: 'idle', title: 'Plan the week', status: 'done' },
];
const stamp = (at: number): string => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const status = ref<TaskStatus>('doing');
// the first line carries the example stamp of src/server/tasks.ts, so the page renders the same on the server and in the browser
const history = ref(['2026-11-17 14:03 UTC Director: created; assigned to ana']);
const board = ref<HTMLElement | null>(null);
const columns = computed(() => COLUMNS.map((c) => ({ ...c, others: OTHERS.filter((t) => t.status === c.status) })));

async function move(to: TaskStatus): Promise<void> {
  status.value = to;
  history.value = [...history.value, `${stamp(Date.now())} Director: status ${to}`];
  await nextTick();
  board.value?.querySelector<HTMLElement>('#fp-mock-t3')?.focus();
}
</script>

<template>
  <div ref="board" class="mk">
    <div v-for="c in columns" :key="c.status" class="module lp-plan-col">
      <span class="label">{{ c.label }}</span>
      <div v-if="status === c.status" id="fp-mock-t3" class="lp-card" tabindex="-1">
        <span class="lp-row"><span class="tile-num">t3</span><span class="led" data-kind="working" data-on="true"></span><span class="legend">ANA</span></span>
        <span>Write the spec</span>
        <details class="mk-fold">
          <summary>Detail and history {{ history.length }}</summary>
          <span class="mk-small">one page</span>
          <span class="mk-small">Made by the Director.</span>
          <span v-for="(h, i) in history" :key="i" class="mk-small mk-line">{{ h }}</span>
        </details>
        <span class="mk-keys" role="group" aria-label="Move t3">
          <button v-for="o in COLUMNS.filter((x) => x.status !== status)" :key="o.status" type="button" class="btn mk-key" :aria-label="`Move t3 to ${o.label.toLowerCase()}`" @click="move(o.status)">{{ o.label }}</button>
        </span>
      </div>
      <div v-for="t in c.others" :key="t.id" class="lp-card">
        <span class="lp-row"><span class="tile-num">{{ t.id }}</span><span class="led" :data-kind="t.kind" data-on="true"></span><span class="legend">{{ t.who }}</span></span>
        <span>{{ t.title }}</span>
      </div>
    </div>
    <span class="lcd mk-lcd" aria-hidden="true">Flight Plan: t3 assigned to you: Write the spec</span>
  </div>
</template>

<style scoped>
.mk {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 10px;
}

@media (max-width: 760px) {
  .mk {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
}

.lp-card:focus-visible {
  outline: 2px solid var(--text);
  outline-offset: 2px;
}

.lp-row .tile-num {
  margin-left: 0;
}

.mk-fold summary {
  color: var(--text-2);
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  cursor: pointer;
}

.mk-small {
  display: block;
  margin-top: 6px;
  color: var(--text-2);
  font-size: 12.5px;
  line-height: 1.4;
}

.mk-line {
  font-family: var(--font-mono);
  font-size: 11px;
  overflow-wrap: anywhere;
}

.mk-keys {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.btn.mk-key {
  min-height: 28px;
  padding: 2px 6px;
  font-size: 10px;
}

.mk-lcd {
  grid-column: 1 / -1;
  padding: 8px 10px;
  font-size: 12.5px;
  overflow-wrap: anywhere;
}
</style>
