<script setup lang="ts">
// Tool permissions at the top of docs/features/permissions.md: the fold of the hire form, a select per common tool and the rule lines.
import '../landing/landing.css';
const TOOLS = [['Bash', 'Ask'], ['Read', 'Allow'], ['Write', 'Default'], ['Edit', 'Allow'], ['WebFetch', 'Deny']];
</script>

<template>
  <div class="module lp-visual pm" role="img" aria-label="Tool permissions fold: Bash ask, Read allow, Write default, Edit allow, WebFetch deny; rules text allow Bash(git:*) and deny Read(./.env); the room's deny shown read only.">
    <span class="label">Tool permissions</span>
    <div class="pm-grid"><div v-for="t in TOOLS" :key="t[0]" class="field"><span class="hint">{{ t[0] }}</span><span class="input">{{ t[1] }}</span></div></div>
    <span class="textarea pm-rules">allow Bash(git:*)
deny Read(./.env)</span>
    <span class="hint">Inherited from the room, read only: deny WebFetch(domain:example.com)</span>
  </div>
</template>

<style scoped>
.pm { display: grid; gap: 10px; }
.pm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; }
.pm .field { display: grid; gap: 4px; }
.pm-rules { white-space: pre; font-family: var(--font-mono); font-size: 12px; }
</style>
