<script setup lang="ts">
// Default models in docs/features/engine-bay.md, section Model: the DEFAULT MODELS block of Flight Rules, per engine and per position.
import '../landing/landing.css';
</script>

<template>
  <div class="module lp-visual mm" role="img" aria-label="Flight Rules, defaults: default engine Claude Code, Claude Code effort high, model by engine Claude Code haiku and Gemini CLI empty, by position FLIGHT opus and SURGEON haiku. A console shows its engine, the model it starts with and where that comes from, and its effort as chips.">
    <span class="label">Defaults: engine and effort</span>
    <div class="mm-grid"><div class="field"><span class="hint">Default engine</span><span class="input">Claude Code</span></div><div class="field"><span class="hint">Claude Code effort</span><span class="input">high</span></div></div>
    <span class="label">Model by engine</span>
    <div class="mm-grid"><div class="field"><span class="hint">Claude Code</span><span class="input">haiku</span></div><div class="field"><span class="hint">Gemini CLI</span><span class="input">the CLI's own</span></div></div>
    <span class="label">By position</span>
    <div class="mm-grid"><div class="field"><span class="hint">FLIGHT</span><span class="input">opus</span></div><div class="field"><span class="hint">SURGEON</span><span class="input">haiku</span></div></div>
    <span class="label">A console's chips</span>
    <span class="mm-chips"><span class="chip" data-tone="quiet">Claude Code</span><span class="chip" data-tone="quiet">opus · position default</span><span class="chip" data-tone="quiet">effort high · room default</span></span>
  </div>
</template>

<style scoped>
.mm { display: grid; gap: 8px; }
.mm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
.mm .field { display: grid; gap: 4px; }
.mm-chips { display: flex; flex-wrap: wrap; gap: 4px 6px; }
</style>
