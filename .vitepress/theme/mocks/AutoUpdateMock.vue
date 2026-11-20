<script setup lang="ts">
// The AUTO-UPDATE block of Flight Rules, in docs/features/update.md: the switch (off by default), the window, the note while a version waits, and the
// SKIP THIS VERSION key during the lead time. Static; the numbers are the page's examples.
import '../landing/landing.css';
</script>

<template>
  <div class="module lp-visual au" role="img" aria-label="Flight Rules block AUTO-UPDATE: a checkbox, Update gonogo by itself, in the window below, switched on; windows 02:00-05:00; a note that it will update to 0.6.2 at about 03:10 if nothing changes, with a SKIP THIS VERSION key.">
    <span class="label">AUTO-UPDATE</span>
    <span class="au-row"><span class="led" data-on="true" aria-hidden="true" /> Update gonogo by itself, in the window below</span>
    <span class="label">WINDOWS (24 HOURS, LOCAL TIME)</span>
    <span class="input au-input">02:00-05:00</span>
    <span class="au-note">It takes only the next patch of the version that runs, one that has been out for a day, once per version, and only after nothing has been working or waiting for you for 10 minutes, in every room.</span>
    <span>Updates to 0.6.2 at about 03:10 if nothing changes. <span class="btn">SKIP THIS VERSION</span></span>
  </div>
</template>

<style scoped>
.au { display: grid; gap: 8px; }
.au-row { display: flex; gap: 8px; align-items: center; }
.au-input { max-width: 16ch; }
.au-note { font-size: 13px; color: var(--muted, inherit); }
</style>
