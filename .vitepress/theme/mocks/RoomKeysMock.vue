<script setup lang="ts">
// ROOM KEYS in docs/features/room-keys.md: keys every agent gets, values hidden, a Clean Room switch for each.
import '../landing/landing.css';
</script>

<template>
  <div class="module lp-visual rk" role="img" aria-label="Room keys: CLAUDE_CODE_USE_BEDROCK set, AWS_REGION set, AWS_BEARER_TOKEN_BEDROCK set and also in a Clean Room. Values are never shown.">
    <span class="label">ROOM KEYS</span>
    <div v-for="k in [['CLAUDE_CODE_USE_BEDROCK', false], ['AWS_REGION', false], ['AWS_BEARER_TOKEN_BEDROCK', true]]" :key="String(k[0])" class="lp-row"><span class="legend">{{ k[0] }}</span><span class="chip" data-tone="lit">set</span><span class="chip" data-tone="quiet">{{ k[1] ? 'also in a Clean Room' : 'not in a Clean Room' }}</span></div>
    <span class="hint">Write-only: a value is never shown again. An agent's own key of the same name wins.</span>
  </div>
</template>

<style scoped>
.rk { display: grid; gap: 8px; }
</style>
