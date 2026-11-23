<script setup lang="ts">
// The switch at the top of docs/features/egress.md: what a Clean Room container holds with the Anthropic key kept out or not. Read-only; the values are the page's own.
import { ref } from 'vue';
import '../landing/landing.css';

const on = ref(true);
</script>

<template>
  <div class="module lp-visual eg">
    <label class="staff-check">
      <input v-model="on" type="checkbox" class="switch" role="switch" />
      Keep the Anthropic API key out of Clean Room containers
    </label>
    <div class="eg-env" role="img" aria-label="The environment of the container: with the switch on, a placeholder key and a base URL of gonogo; with it off, the real key.">
      <span class="label">THE CONTAINER'S ENVIRONMENT</span>
      <template v-if="on">
        <code>GONOGO_API_KEY=gnp_3f9c0a…</code>
        <code>ANTHROPIC_BASE_URL=http://host.docker.internal:7777/egress/&lt;token&gt;/anthropic</code>
        <span class="hint">gonogo adds the real key to the request, for api.anthropic.com only. The token stops working when the agent stops.</span>
      </template>
      <template v-else>
        <code>GONOGO_API_KEY=sk-ant-api03-…</code>
        <span class="hint">The key is in the container, as before.</span>
      </template>
    </div>
  </div>
</template>

<style scoped>
.eg { display: grid; gap: 10px; }
.eg-env { display: grid; gap: 4px; }
.eg-env code { font-family: var(--font-mono); font-size: 12px; overflow-wrap: anywhere; }
</style>
