<script setup lang="ts">
// Default models in docs/features/engine-bay.md, section Model: the DEFAULT MODELS block of Flight Rules, per engine and per position.
import '../landing/landing.css';
</script>

<template>
  <div class="module lp-visual mm" role="img" aria-label="Flight Rules, default models: Claude Code haiku, Gemini CLI empty; by position FLIGHT opus, SURGEON haiku.">
    <span class="label">Default models</span>
    <div class="mm-grid"><div class="field"><span class="hint">Claude Code</span><span class="input">haiku</span></div><div class="field"><span class="hint">Gemini CLI</span><span class="input">the CLI's own</span></div></div>
    <span class="label">By position</span>
    <div class="mm-grid"><div class="field"><span class="hint">FLIGHT</span><span class="input">opus</span></div><div class="field"><span class="hint">SURGEON</span><span class="input">haiku</span></div></div>
  </div>
</template>

<style scoped>
.mm { display: grid; gap: 8px; }
.mm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
.mm .field { display: grid; gap: 4px; }
</style>
