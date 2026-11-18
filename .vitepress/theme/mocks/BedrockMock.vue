<script setup lang="ts">
// Amazon Bedrock in docs/features/engine-bay.md: the Clearance keys that switch Claude Code to Bedrock (values hidden, write-only).
import '../landing/landing.css';
</script>

<template>
  <div class="module lp-visual bk" role="img" aria-label="Clearance keys of one agent: CLAUDE_CODE_USE_BEDROCK set, AWS_REGION set, AWS_BEARER_TOKEN_BEDROCK set. Values are never shown.">
    <span class="label">Clearance · ana</span>
    <div v-for="k in ['CLAUDE_CODE_USE_BEDROCK', 'AWS_REGION', 'AWS_BEARER_TOKEN_BEDROCK']" :key="k" class="lp-row"><span class="legend">{{ k }}</span><span class="chip" data-tone="lit">set</span></div>
    <span class="hint">Write-only: a value is never shown again. Not run against a real AWS account.</span>
  </div>
</template>

<style scoped>
.bk { display: grid; gap: 8px; }
</style>
