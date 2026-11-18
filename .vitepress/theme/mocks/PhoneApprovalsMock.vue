<script setup lang="ts">
// Phone approvals at the top of docs/features/phone-approvals.md: the verdict on Remote Control, the setting, and a Telegram message with its buttons.
import '../landing/landing.css';
</script>

<template>
  <div class="module lp-visual pa" role="img" aria-label="Phone approvals setting: Off, Telegram buttons, Claude app, both. A Telegram message: ana asks: Bash: pnpm vitest run, with buttons GO and NO-GO.">
    <span class="label">Phone approvals</span>
    <span class="lp-row-keys"><span class="btn" data-kind="quiet">Off</span><span class="btn" data-kind="primary">Telegram buttons</span><span class="btn" data-kind="quiet">Claude app</span><span class="btn" data-kind="quiet">Both</span></span>
    <div class="flood pa-msg" data-tone="lit"><span>ana asks: Bash: pnpm vitest run</span><span class="lp-row-keys"><span class="btn" data-kind="primary">GO</span><span class="btn">NO-GO</span></span></div>
    <span class="hint">After a press: "Sent GO", and the buttons go away. A late press answers "Too late".</span>
  </div>
</template>

<style scoped>
.pa { display: grid; gap: 8px; }
.pa-msg { display: grid; gap: 8px; padding: 10px; max-width: 320px; }
</style>
