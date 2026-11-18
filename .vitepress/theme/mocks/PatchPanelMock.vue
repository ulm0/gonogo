<script setup lang="ts">
// The Patch Panel at the top of docs/features/patch-panel.md, as a local preview: type to filter, arrows choose. Nothing runs.
// The lines and the match are those of src/client/shell.ts for a room with FLIGHT and FIDO (a letter skipped costs more).
import { computed, ref } from 'vue';

const LINES = [
  ['Open FLIGHT', 'Console'],
  ['Open FIDO', 'Console'],
  ['Room', 'View'],
  ['Loop', 'View'],
  ['Downlink', 'View'],
  ['Launch Window', 'View'],
  ['Flight Plan', 'View'],
  ['Mission Log', 'View'],
  ['Livery', 'View'],
  ['Flight Rules', 'View'],
  ['Staff a console', 'Action'],
  ['Brief FLIGHT', 'Action'],
  ['Start a T-minus poll', 'Action'],
  ['Apply livery Night Shift', 'Action'],
] as const;

function cost(query: string, text: string): number | null {
  const t = text.toLowerCase();
  let c = 0;
  let at = -1;
  for (const ch of query.toLowerCase().replace(/\s+/g, '')) {
    const i = t.indexOf(ch, at + 1);
    if (i < 0) return null;
    if (i !== at + 1) c += i === 0 || /[^a-z0-9]/.test(t[i - 1]!) ? 1 : i - at + 1;
    at = i;
  }
  return c;
}

const query = ref('');
const active = ref(0);
const shown = computed(() =>
  LINES.map((l, i) => ({ l, i, c: cost(query.value, l[0]) }))
    .filter((x) => x.c !== null)
    .sort((a, b) => a.c! - b.c! || a.i - b.i)
    .map((x) => x.l),
);
const at = computed(() => Math.min(active.value, shown.value.length - 1));
function key(e: KeyboardEvent): void {
  const n = shown.value.length;
  if (n === 0 || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
  e.preventDefault();
  active.value = (at.value + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
}
</script>

<template>
  <div class="mk">
    <div class="module mk-panel">
      <span class="label">Patch Panel</span>
      <input
        v-model="query"
        class="input"
        type="text"
        role="combobox"
        aria-label="Filter the preview"
        aria-expanded="true"
        aria-controls="mk-patch-list"
        :aria-activedescendant="at >= 0 ? `mk-patch-${at}` : undefined"
        placeholder="Type a console, a view or an action"
        @input="active = 0"
        @keydown="key"
      />
      <ul id="mk-patch-list" class="mk-list" role="listbox" aria-label="Matches">
        <li v-for="(l, i) in shown" :id="`mk-patch-${i}`" :key="l[0]" role="option" :aria-selected="i === at" class="mk-option" @mousemove="active = i">
          <span>{{ l[0] }}</span>
          <span class="mk-group" aria-hidden="true">{{ l[1] }}</span>
        </li>
      </ul>
      <span class="hint">{{ shown.length === 0 ? 'Nothing matches.' : 'Arrows choose, Enter runs, Esc closes.' }}</span>
    </div>
  </div>
</template>

<style scoped>
.mk {
  padding: 12px;
  border: 1px solid var(--edge);
  border-radius: var(--radius-module);
  background: var(--body);
  color: var(--text);
}

.mk-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: 520px;
  margin: 0 auto;
  padding: 14px;
}

.mk-list {
  max-height: 264px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.mk-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 44px;
  margin: 0;
  padding: 0 12px;
  border-radius: var(--radius-key);
}

.mk-option[aria-selected='true'] {
  background: var(--key);
  box-shadow: inset 3px 0 0 var(--work), 0 0 0 1px var(--edge);
}

.mk-group {
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
</style>
