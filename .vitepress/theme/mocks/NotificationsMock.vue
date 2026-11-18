<script setup lang="ts">
// Notifications at the top of docs/features/notifications.md: the browser's notification for a message, and the tab title with its count.
import '../landing/landing.css';
</script>

<template>
  <div class="module lp-visual nt" role="img" aria-label="A browser tab titled (3) gonogo, and a notification: ana: Done, Tests pass on all three engines.">
    <span class="label">Tab, away from the room</span>
    <span class="lcd">(3) gonogo</span>
    <span class="label">Notification</span>
    <div class="flood nt-note" data-tone="lit"><span class="legend">ana: Done</span><span>Tests pass on all three engines. Ready for review.</span></div>
    <span class="hint">Only a snippet leaves the page: 80 characters.</span>
  </div>
</template>

<style scoped>
.nt { display: grid; gap: 8px; }
.nt-note { display: grid; gap: 4px; padding: 10px; }
</style>
