<script setup lang="ts">
// The block at the top of docs/features/global-mcp.md: the user-scope servers, the room's two switches, and what an agent ends up with. Read-only; the names are the page's own.
import { computed, ref } from 'vue';
import '../landing/landing.css';

const host = ref(true);
const cleanRoom = ref(false);
const agent = ref<'host' | 'clean'>('host');
const mine = computed(() => (agent.value === 'clean' ? cleanRoom.value : host.value));
</script>

<template>
  <div class="module lp-visual gm">
    <label class="staff-check"><input v-model="host" type="checkbox" class="switch" role="switch" /> Include them for the agents of this room</label>
    <label class="staff-check"><input v-model="cleanRoom" type="checkbox" class="switch" role="switch" /> Include them for Clean Room agents too</label>
    <div class="field">
      <label for="gm-agent">An agent that is</label>
      <select id="gm-agent" v-model="agent" class="input"><option value="host">on this machine</option><option value="clean">in a Clean Room</option></select>
    </div>
    <ul class="gm-list" aria-label="The MCP servers this agent starts with">
      <li v-if="mine"><b>pulsar</b> <span class="chip" data-tone="quiet">GLOBAL · http · https://gamma.pulsar.codes</span></li>
      <li v-if="mine"><b>files</b> <span class="chip" data-tone="quiet">GLOBAL · stdio · npx</span> <span class="hint">replaced by a room default of the same name</span></li>
      <li><b>files</b> <span class="chip" data-tone="quiet">ROOM · server</span></li>
      <li><b>gonogo</b> <span class="chip" data-tone="quiet">always</span></li>
    </ul>
    <span class="hint">Only the name, the type and the address are shown, never an argument, a header or a value.</span>
  </div>
</template>

<style scoped>
.gm { display: grid; gap: 8px; }
.gm-list { margin: 0; padding-left: 1.1em; display: grid; gap: 4px; }
</style>
