<script setup lang="ts">
// The Room editor at the top of docs/features/room-editor.md: the 12-column grid with the six blocks as cards, and the keys SAVE, CANCEL, RESET.
import '../landing/landing.css';
const BLOCKS = [['MISSION', '1 / 5', '1'], ['SEQUENCE', '5 / 9', '1'], ['T-MINUS', '9 / 13', '1'], ['MAX Q', '1 / 5', '2'], ['PROPELLANT', '5 / 9', '2'], ['OPERATIONS', '1 / 13', '3']];
</script>

<template>
  <div class="module lp-visual re" role="img" aria-label="Room editor: six cards on a 12 column grid, MISSION, SEQUENCE, T-MINUS, MAX Q, PROPELLANT and OPERATIONS, with Save, Cancel and Reset to default.">
    <span class="label">Edit room · 12 columns</span>
    <div class="re-grid"><div v-for="b in BLOCKS" :key="b[0]" class="tile re-card" :style="{ gridColumn: b[1], gridRow: b[2] }"><span class="legend">{{ b[0] }}</span></div></div>
    <span class="lp-row-keys"><span class="btn" data-kind="primary">Save</span><span class="btn" data-kind="quiet">Cancel</span><span class="btn" data-kind="quiet">Reset to default</span></span>
  </div>
</template>

<style scoped>
.re { display: grid; gap: 8px; }
.re-grid { display: grid; grid-template-columns: repeat(12, 1fr); gap: 6px; }
.re-card { padding: 8px; min-height: 44px; }
</style>
