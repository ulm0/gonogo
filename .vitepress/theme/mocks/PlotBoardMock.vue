<script setup lang="ts">
// The Plot Board page at the top of docs/features/plot-board.md: the box, the line under it and the two keys, driven by the app's own
// rules (src/client/board.ts). "FLIGHT writes" stands for the boss's board_write: type in the box first and the board "moves on under
// you", and the page says so and offers the latest. Nothing is sent anywhere.
import { computed, ref } from 'vue';
import { boardMode, conflictText, countText } from '../../../src/client/board';
import type { BoardView } from '../../../src/shared/protocol';
import type { AgentView } from '../../../src/shared/protocol';

const PLAN = '# This week\n\n1. Ship the audit log\n2. Then the Plot Board\n\nGUIDO: the routes. CONTROL: the page.';
const AGENTS = { flight: { name: 'flight', boss: true, position: 'flight' } } as unknown as Record<string, AgentView>;
const server = ref<BoardView>({ text: PLAN, revision: 4, author: 'flight', updatedAt: 1 });
const text = ref(PLAN);
const base = ref(4);
const notice = ref('');

const mode = computed(() => boardMode(text.value, base.value, server.value));
const line = computed(() => `Written by ${server.value.author === 'user' ? 'DIRECTOR' : 'FLIGHT'}, revision ${server.value.revision}. ${countText(text.value)}.`);

function flightWrites(): void {
  server.value = { text: `${server.value.text}\n3. Docs for both`, revision: server.value.revision + 1, author: 'flight', updatedAt: 1 };
  if (mode.value === 'clean') {
    text.value = server.value.text;
    base.value = server.value.revision;
  }
  notice.value = '';
}
function save(): void {
  if (mode.value !== 'edited') return;
  server.value = { text: text.value, revision: server.value.revision + 1, author: 'user', updatedAt: 1 };
  base.value = server.value.revision;
  notice.value = 'Saved.';
}
function load(): void {
  if (mode.value === 'clean') return;
  text.value = server.value.text;
  base.value = server.value.revision;
  notice.value = mode.value === 'stale' ? 'Loaded the latest.' : 'Typing discarded.';
}
</script>

<template>
  <form class="module mk" @submit.prevent="save">
    <div class="field">
      <label for="pb-mock-text">Plan</label>
      <textarea id="pb-mock-text" v-model="text" class="textarea" rows="7" spellcheck="false" aria-describedby="pb-mock-line" @input="notice = ''"></textarea>
    </div>
    <p id="pb-mock-line" class="hint">{{ line }}</p>
    <p v-if="mode === 'stale'" class="flood mk-stale" data-tone="amber" role="status">{{ conflictText(server, AGENTS) }}</p>
    <div class="mk-keys">
      <button type="submit" class="btn" data-kind="primary" :aria-disabled="mode !== 'edited' || undefined">Save</button>
      <button type="button" class="btn" data-kind="quiet" :aria-disabled="mode === 'clean' || undefined" @click="load">{{ mode === 'stale' ? 'Load the latest' : 'Discard typing' }}</button>
      <button type="button" class="btn" @click="flightWrites">FLIGHT writes</button>
    </div>
    <p class="mk-notice" role="status">{{ notice }}</p>
  </form>
</template>

<style scoped>
.mk {
  display: grid;
  gap: 12px;
  padding: 14px;
}

.mk-keys {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.mk-stale {
  margin: 0;
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.45;
}

.mk-notice {
  min-height: 1.2em;
  margin: 0;
  color: var(--text-2);
  font-size: 12.5px;
}
</style>
