<script setup lang="ts">
// The Mass Budget line at the top of docs/features/mass-budget.md: a console's memory file, the soft-limit warning, and REFLECT,
// worded by the app's own rules (src/client/mass.ts). Nothing is sent: the key only plays the three states of the line.
import { computed, ref } from 'vue';
import { askedText, overText, resultText, sizeLine } from '../../../src/client/mass';
import type { MemoryView, ReflectResult } from '../../../src/shared/protocol';

const NOW = Date.UTC(2026, 10, 18, 14, 30);
const BIG: MemoryView = { exists: true, bytes: 19043, lines: 233, softLines: 200, softBytes: 16384, over: true, changedAt: NOW - 3_600_000, backup: null };
const view = ref<MemoryView>(BIG);
const notice = ref('');
const send: ReflectResult['send'] = { ok: true, id: 'm1', to: 'guido', status: 'queued', note: null };

const asked = computed(() => askedText(view.value, NOW));
const over = computed(() => overText(view.value));
const state = computed(() => (view.value.backup === null ? 'over the limit' : view.value.changedAt !== null && view.value.changedAt > view.value.backup.at ? 'after the rewrite' : 'asked'));

function reflect(): void {
  view.value = { ...BIG, backup: { bytes: BIG.bytes, at: NOW - 60_000 } };
  notice.value = resultText('guido', { send, memory: view.value });
}
function rewrite(): void {
  if (view.value.backup === null) return;
  view.value = { ...view.value, bytes: 2150, lines: 41, over: false, changedAt: NOW };
}
function reset(): void {
  view.value = BIG;
  notice.value = '';
}
</script>

<template>
  <div class="module mk" role="group" aria-label="Memory file of the console GUIDO, as the page shows it">
    <div class="mk-row">
      <span class="label">MASS BUDGET</span>
      <span class="mk-size"><code>memory.md</code> {{ sizeLine(view) }}</span>
      <button type="button" class="btn" data-kind="quiet" @click="reflect">Reflect</button>
    </div>
    <p v-if="over" class="mk-over">{{ over }}. Reflect asks guido to condense it.</p>
    <p v-if="asked" class="hint">{{ asked }}</p>
    <p v-if="notice" class="hint" role="status">{{ notice }}</p>
    <div class="mk-row mk-play">
      <span class="chip" data-tone="quiet">{{ state }}</span>
      <button type="button" class="btn" data-kind="quiet" :aria-disabled="view.backup === null || undefined" @click="rewrite">The agent rewrites the file</button>
      <button type="button" class="btn" data-kind="quiet" @click="reset">Start again</button>
    </div>
  </div>
</template>

<style scoped>
.mk {
  display: grid;
  gap: 8px;
  padding: 14px;
}

.mk-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
}

.mk-size {
  flex: 1 1 auto;
  color: var(--text-2);
  font-size: 13px;
}

.mk-size code {
  font-family: var(--font-mono);
  font-size: 12px;
}

.mk-over {
  margin: 0;
  padding: 6px 10px;
  border-radius: var(--radius-key);
  background: var(--you-tint);
  color: var(--you-ink);
  font-size: 13px;
  line-height: 1.4;
}

.mk .hint {
  margin: 0;
}

.mk-play {
  padding-top: 6px;
  border-top: 1px solid var(--edge);
}
</style>
