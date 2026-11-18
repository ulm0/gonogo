<script setup lang="ts">
// COMMS at the top of docs/features/comms.md: the tab bar and the hint under it, with the tab names, hints and unread count of the app
// (src/client/Comms.tsx). The rows under each tab are the pages of the Downlink, the Loop and Party Line. Nothing leaves the page.
import { ref } from 'vue';

const TABS = [
  { id: 'inbox', label: 'INBOX', hint: 'Messages to you and what the server noticed.', rows: ['ana: Write the spec', 'GO: all go (T-minus)'] },
  { id: 'traffic', label: 'TRAFFIC', hint: 'Everything the agents send each other and you.', rows: ['ana to ben: Review the diff', 'ben to ana: Re: Review the diff'] },
  { id: 'threads', label: 'THREADS', hint: 'The same messages as conversations.', rows: ['Review the diff (2 messages)', 'Write the spec (1 message)'] },
];
const tab = ref('inbox');
const current = () => TABS.find((t) => t.id === tab.value) ?? TABS[0];
</script>

<template>
  <div class="module cm">
    <div class="cm-bar">
      <span class="cm-tabs" role="tablist" aria-label="Comms">
        <button v-for="t in TABS" :key="t.id" type="button" role="tab" class="btn cm-tab" :data-kind="tab === t.id ? 'primary' : 'quiet'" :aria-selected="tab === t.id" @click="tab = t.id">
          {{ t.label }}<span v-if="t.id === 'inbox'" class="chip" data-tone="amber" aria-hidden="true">2</span>
        </button>
      </span>
      <span class="hint">{{ current().hint }}</span>
    </div>
    <ul class="cm-rows" role="tabpanel">
      <li v-for="r in current().rows" :key="r">{{ r }}</li>
    </ul>
  </div>
</template>

<style scoped>
.cm { display: grid; gap: 10px; padding: 12px; }
.cm-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 16px; }
.cm-tabs { display: flex; gap: 6px; }
.cm-tab { min-height: 44px; }
.cm-rows { margin: 0; padding: 0; list-style: none; display: grid; gap: 6px; }
</style>
