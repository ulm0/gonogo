<script setup lang="ts">
// The picker at the top of docs/features/registry.md: choose an entry and see what "Add from the list" puts into the Payload box, and what it needs.
// The entries are the real ones (src/shared/registry.ts); nothing here runs or installs anything, and the boxes are read-only.
import { computed, ref } from 'vue';
import { REGISTRY } from '../../../src/shared/registry.ts';
import '../landing/landing.css';

const id = ref('filesystem');
const entry = computed(() => REGISTRY.find((e) => e.id === id.value) ?? REGISTRY[0]);
const text = computed(() => {
  const e = entry.value;
  return e?.kind === 'mcp' ? JSON.stringify({ [e.id]: e.server }, null, 2) : (e?.install ?? '');
});
</script>

<template>
  <div class="module lp-visual rg">
    <div class="field">
      <label for="rg-pick">Add from the list</label>
      <select id="rg-pick" v-model="id" class="input">
        <optgroup label="MCP servers"><option v-for="e in REGISTRY.filter((x) => x.kind === 'mcp')" :key="e.id" :value="e.id">{{ e.name }}</option></optgroup>
        <optgroup label="Skills"><option v-for="e in REGISTRY.filter((x) => x.kind === 'skill')" :key="e.id" :value="e.id">{{ e.name }}</option></optgroup>
      </select>
    </div>
    <p v-if="entry" class="hint">{{ entry.summary }} {{ entry.licence }} · checked {{ entry.checked }}</p>
    <div class="field">
      <label for="rg-text">{{ entry?.kind === 'mcp' ? 'What goes into the MCP servers box' : 'The line you run yourself, in a terminal' }}</label>
      <textarea id="rg-text" class="textarea" rows="6" readonly :value="text"></textarea>
    </div>
    <p v-if="entry?.kind === 'mcp' && entry.needs.length > 0" class="hint">Needs: {{ entry.needs.join(', ') }}. Set them in Clearance or the room's keys; the box holds only the names.</p>
    <p v-if="entry?.kind === 'mcp' && entry.edit" class="hint">{{ entry.edit }}</p>
    <p v-if="entry?.note" class="hint">{{ entry.note }}</p>
  </div>
</template>

<style scoped>
.rg { display: grid; gap: 8px; }
</style>
