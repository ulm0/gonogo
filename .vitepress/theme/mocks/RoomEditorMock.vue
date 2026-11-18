<script setup lang="ts">
// The Room editor at the top of docs/features/room-editor.md: the 12-column grid with the six blocks as cards, and the keys SAVE, CANCEL, RESET.
import '../landing/landing.css';
const BLOCKS = [['MISSION', '1 / 5', '1'], ['SEQUENCE', '5 / 9', '1'], ['T-MINUS', '9 / 13', '1'], ['MAX Q', '1 / 5', '2'], ['PROPELLANT', '5 / 9', '2'], ['OPERATIONS', '1 / 13', '3']];
</script>

<template>
  <div class="module lp-visual re" role="img" aria-label="Room editor: six cards on a 12 column grid, MISSION, SEQUENCE, T-MINUS, MAX Q, PROPELLANT and OPERATIONS, with Save, Cancel and Reset to default.">
    <span class="label">Edit room · 12 columns</span>
    <div class="re-grid"><div v-for="b in BLOCKS" :key="b[0]" class="module re-card" :style="{ gridColumn: b[1], gridRow: b[2] }"><span class="re-title">{{ b[0] }}</span><span class="re-grip" aria-hidden="true"></span></div></div>
    <span class="lp-row-keys"><span class="btn" data-kind="primary">Save</span><span class="btn" data-kind="quiet">Cancel</span><span class="btn" data-kind="quiet">Reset to default</span></span>
  </div>
</template>

<style scoped>
.re { display: grid; gap: 8px; }
.re-grid { display: grid; grid-template-columns: repeat(12, 1fr); gap: 6px; }
.re-card { position: relative; padding: 8px 10px 14px; min-height: 44px; }
.re-title { font-family: var(--font-mono); font-weight: 700; letter-spacing: 0.06em; }
.re-grip { position: absolute; right: 2px; bottom: 2px; width: 22px; height: 22px; border-right: 3px solid var(--text-2); border-bottom: 3px solid var(--text-2); border-radius: 0 0 4px 0; }
</style>
