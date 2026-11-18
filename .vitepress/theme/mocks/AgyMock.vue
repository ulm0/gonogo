<script setup lang="ts">
// Antigravity CLI in docs/features/engine-bay.md: its row of the table as the hire form shows it: engine, state from output, no model field, modes.
import '../landing/landing.css';
</script>

<template>
  <div class="module lp-visual ag" role="img" aria-label="Hire form, engine Antigravity CLI (agy): state comes from the output, no model field, modes accept-edits and auto.">
    <span class="label">Engine · Antigravity CLI</span>
    <span class="lp-row"><span class="tile-num">agy</span><span class="chip" data-tone="lit">state from output</span><span class="chip">no model field</span></span>
    <span class="lp-row-keys"><span class="btn" data-kind="primary">accept-edits</span><span class="btn" data-kind="quiet">auto</span></span>
    <span class="hint">The brief arrives as the first prompt. Not run against a signed-in agy.</span>
  </div>
</template>

<style scoped>
.ag { display: grid; gap: 8px; }
</style>
