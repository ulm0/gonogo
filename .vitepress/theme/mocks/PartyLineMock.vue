<script setup lang="ts">
// Party Line at the top of docs/features/party-line.md: a handful of messages grouped by the app's own rules
// (src/client/threads.ts). Answering adds a message from the Director to the thread's newest message, as the app does. Nothing leaves the page.
import { computed, ref } from 'vue';
import { chipOf, legendOf } from '../../../src/client/loop';
import { groupThreads, repliers } from '../../../src/client/threads';
import type { ActivityItem } from '../../../src/shared/protocol';

let clock = 0;
function msg(from: string, to: string, subject: string, body: string, inReplyTo: string | null = null, status: ActivityItem['status'] = 'delivered'): ActivityItem {
  clock += 1;
  return { id: `m${clock}`, from, to, subject, body, inReplyTo, hops: 1, at: clock, status, note: null, updatedAt: clock, truncated: false };
}

const first = msg('ana', 'user', 'Build is green', 'All 40 tests pass.', null, 'to_user');
const second = msg('ana', 'ben', 'Review the diff', 'Please review the build branch.');
const third = msg('ben', 'ana', 'Re: Review the diff', 'Two nits in src/api.ts.');
// the list is newest first, as the app keeps it
const items = ref<ActivityItem[]>([third, second, first]);
const threads = computed(() => groupThreads(items.value));
const open = ref<string | null>(null);
const text = ref('');
const none = {};
const who = (name: string): string => legendOf(name, none);

function send(thread: (typeof threads.value)[number]): void {
  const body = text.value.trim();
  const to = repliers(thread)[0];
  if (body === '' || to === undefined) return;
  items.value = [msg('user', to, `Re: ${thread.subject}`, body, thread.last.id), ...items.value];
  text.value = '';
}
</script>

<template>
  <div class="module mk">
    <span class="chip" data-tone="quiet" aria-live="polite">{{ threads.length }} threads</span>
    <div v-for="t in threads" :key="t.id" class="mk-thread">
      <button type="button" class="mk-head" :aria-expanded="open === t.id" @click="open = open === t.id ? null : t.id">
        <span class="legend">{{ t.who.map(who).join(' · ') }}</span>
        <span class="mk-title">{{ t.title }}</span>
        <span class="mk-count">{{ t.items.length }} {{ t.items.length === 1 ? 'message' : 'messages' }}</span>
        <span v-if="chipOf(t.last).tone !== 'quiet'" class="chip" :data-tone="chipOf(t.last).tone">{{ chipOf(t.last).text }}</span>
      </button>
      <div v-if="open === t.id" class="mk-open">
        <p v-for="i in t.items" :key="i.id" class="mk-msg" :data-from-you="i.from === 'user' || undefined">
          <span class="legend">{{ who(i.from) }} › {{ who(i.to) }}</span>
          <span>{{ i.body }}</span>
        </p>
        <form v-if="repliers(t).length > 0" class="mk-reply" @submit.prevent="send(t)">
          <label class="legend" :for="`pl-mock-${t.id}`">Reply to {{ who(repliers(t)[0] ?? '') }}</label>
          <input :id="`pl-mock-${t.id}`" v-model="text" class="input" type="text" autocomplete="off" />
          <button type="submit" class="btn" data-kind="primary" :aria-disabled="text.trim() === '' || undefined">Send</button>
        </form>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mk {
  display: grid;
  justify-items: start;
  gap: 10px;
  padding: 14px;
}

.mk-thread {
  width: 100%;
  border-top: 1px solid var(--edge);
}

.mk-head {
  appearance: none;
  display: grid;
  grid-template-columns: 190px minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 8px 12px;
  width: 100%;
  min-height: 44px;
  padding: 6px 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.mk-title {
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.mk-count {
  color: var(--muted);
  font-size: 12.5px;
}

.mk-open {
  display: grid;
  gap: 10px;
  margin-bottom: 10px;
  padding: 12px 14px;
  border: 1px solid var(--edge);
  border-radius: var(--radius);
  background: var(--key);
}

.mk-msg {
  display: grid;
  gap: 2px;
  margin: 0;
  padding-left: 10px;
  border-left: 3px solid var(--edge);
  font-size: 13.5px;
}

.mk-msg[data-from-you] {
  border-left-color: var(--work);
}

.mk-reply {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.mk-reply .input {
  flex: 1 1 180px;
  width: auto;
  height: 44px;
}

@media (max-width: 640px) {
  .mk-head {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .mk-head .legend,
  .mk-title {
    grid-column: 1 / -1;
  }
}
</style>
