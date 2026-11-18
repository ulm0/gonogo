<script setup lang="ts">
// Docker self-update at the top of docs/features/update.md: the Update strip with its confirmation (agents working and idle, autostart), then the strip after
// an update with UNDO. Static; the numbers are the page's examples.
import '../landing/landing.css';
</script>

<template>
  <div class="module lp-visual su" role="img" aria-label="Update strip: gonogo 0.4.0 is out. Confirmation: 2 agents are working and 1 is idle, they will all stop; autostart is on, so they start again by themselves. Buttons Update now and Cancel. After the update: Updated 0.3.0 to 0.4.0, with an UNDO key.">
    <span class="label">Update · in a container</span>
    <span>gonogo 0.4.0 is out (this is 0.3.0). <span class="btn">Update to 0.4.0</span></span>
    <div class="su-confirm">
      <span>Update this container to 0.4.0? It pulls the image, stops gonogo, starts the new container and waits for it to be healthy, and puts the old one back if it is not. 2 agents are working and 1 is idle: they will all stop. Autostart is on (all that were running): they start again by themselves in waves.</span>
      <span class="su-keys"><span class="btn" data-kind="primary">Update now</span><span class="btn" data-kind="quiet">Cancel</span></span>
    </div>
    <span class="label">After the restart</span>
    <span>Updated 0.3.0 to 0.4.0. <span class="btn">UNDO</span> <span class="chip" data-tone="quiet">healthy</span></span>
  </div>
</template>

<style scoped>
.su { display: grid; gap: 8px; }
.su-confirm { display: grid; gap: 8px; padding: 8px 10px; border: 1px solid var(--edge); border-radius: 4px; background: var(--well); font-size: 13px; }
.su-keys { display: flex; gap: 8px; flex-wrap: wrap; }
</style>
