<script setup lang="ts">
// The Downlink at the top of docs/features/downlink.md: the filters, MARK ALL READ, and a key pair on each row, run by the app's
// own rules (src/client/inbox.ts). The events are worded as the server words them; nothing leaves the page.
import { computed, ref } from 'vue';
import { EVENT_CHIPS, FILTERS, filterCounts, filterItems, unreadText } from '../../../src/client/inbox';
import type { FilterId } from '../../../src/client/inbox';
import type { DownlinkItem } from '../../../src/shared/protocol';

const base = { at: 0, read: false, archived: false };
const items = ref<DownlinkItem[]>([
  { ...base, type: 'message', id: 'm12', from: 'ana', subject: 'Write the spec', body: '', truncated: false, inReplyTo: null },
  { ...base, type: 'event', id: 'e3', kind: 'flight-plan', text: 'ana moved t3 to review: Write the spec' },
  { ...base, type: 'event', id: 'e2', kind: 'tminus', text: 'GO: all go', read: true },
  { ...base, type: 'event', id: 'e1', kind: 'redline', text: 'fido: loop', read: true },
]);
const filter = ref<FilterId>('all');
// read while the page is up: such a row keeps its place, as in the app
const stay = ref(new Set<string>());
const rows = computed(() => filterItems(items.value, filter.value, stay.value));
const counts = computed(() => filterCounts(items.value));
const unread = computed(() => items.value.filter((i) => !i.read && !i.archived).length);
const titleOf = (i: DownlinkItem): string => (i.type === 'message' ? i.subject : i.text);

function mark(ids: string[], archive: boolean): void {
  for (const id of ids) if (!items.value.find((i) => i.id === id)?.read) stay.value.add(id);
  items.value = items.value.map((i) => (ids.includes(i.id) ? { ...i, read: true, archived: i.archived || archive } : i));
}
</script>

<template>
  <div class="module mk">
    <div class="mk-head">
      <span class="chip" :data-tone="unread > 0 ? 'amber' : 'quiet'" aria-live="polite">{{ unreadText(unread) }}</span>
      <span class="mk-keys" role="group" aria-label="Filter">
        <button v-for="f in FILTERS" :key="f.id" type="button" class="btn" :data-kind="filter === f.id ? 'primary' : 'quiet'" :aria-pressed="filter === f.id" @click="filter = f.id">
          {{ f.label }} {{ counts[f.id] }}
        </button>
      </span>
      <button type="button" class="btn" :aria-disabled="unread === 0 || undefined" @click="mark(items.map((i) => i.id), false)">Mark all read</button>
    </div>
    <div class="mk-list">
      <div v-for="i in rows" :key="i.id" class="mk-item" :data-unread="!i.read || undefined">
        <span class="led" :data-on="!i.read" aria-hidden="true"></span>
        <span v-if="i.type === 'message'" class="legend mk-who">{{ i.from }}</span>
        <span v-else class="chip mk-who" :data-tone="EVENT_CHIPS[i.kind].tone">{{ EVENT_CHIPS[i.kind].text }}</span>
        <span class="mk-text">{{ titleOf(i) }}</span>
        <span class="mk-keys">
          <button v-if="!i.read" type="button" class="btn" :aria-label="`Mark read: ${titleOf(i)}`" @click="mark([i.id], false)">Mark read</button>
          <button v-if="!i.archived" type="button" class="btn" :aria-label="`Archive: ${titleOf(i)}`" @click="mark([i.id], true)">Archive</button>
        </span>
      </div>
      <span v-if="rows.length === 0" class="mk-text mk-empty">Nothing in this filter.</span>
    </div>
  </div>
</template>

<style scoped>
.mk {
  display: grid;
  gap: 12px;
  padding: 14px;
}

.mk-head,
.mk-keys {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.mk-head .btn,
.mk-keys .btn {
  min-height: 32px;
  padding: 0 10px;
  font-size: 10.5px;
}

.mk-item {
  display: grid;
  grid-template-columns: 8px 110px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px 12px;
  padding: 10px 14px;
  margin: 0 -14px;
  border-top: 1px solid var(--edge);
}

.mk-item[data-unread] {
  background: var(--key);
  box-shadow: inset 3px 0 0 var(--work);
}

.mk-item[data-unread] .led {
  --led: var(--work);
}

.mk-who {
  justify-self: start;
}

.mk-text {
  min-width: 0;
  font-size: 14px;
  overflow-wrap: anywhere;
}

.mk-item[data-unread] .mk-text {
  font-weight: 600;
}

.mk-empty {
  color: var(--text-2);
}

@media (max-width: 640px) {
  .mk-item {
    grid-template-columns: 8px minmax(0, 1fr);
  }

  .mk-item > :nth-child(n + 3) {
    grid-column: 2;
  }
}
</style>
