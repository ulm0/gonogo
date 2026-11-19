<script setup lang="ts">
// The phone app at the top of docs/features/mobile.md: a lock-screen push (generic by default) and the PUSH TO THIS DEVICE block of Flight Rules, built from the app's primitives.
import '../landing/landing.css';
</script>

<template>
  <div class="module lp-visual mb" role="img" aria-label="A phone's lock screen shows a gonogo notification: an agent needs you. Below, the Flight Rules block PUSH TO THIS DEVICE: on for this device, a check to show who it is from, and a list with the device My phone, Android Chrome, with Test and Remove.">
    <div class="mb-lock">
      <span class="label">Lock screen</span>
      <div class="flood mb-note" data-tone="lit"><span class="legend">gonogo</span><span>An agent needs you</span></div>
      <span class="hint">Generic by default: the push service only carries this line, encrypted.</span>
    </div>
    <div class="mb-rules">
      <span class="label">PUSH TO THIS DEVICE</span>
      <span class="hint">On for this device. A tap opens gonogo at the ask; nothing is approved from the notification itself.</span>
      <span class="mb-row"><span class="check-demo" aria-hidden="true"></span><span>Show who it is from and the first words on the lock screen</span></span>
      <span class="btn" aria-pressed="true">Turn push off for this device</span>
      <span class="mb-row"><span class="mb-name">Android, Chrome (this device)</span><span class="btn" data-kind="quiet">Test</span><span class="btn" data-kind="danger">Remove</span></span>
    </div>
  </div>
</template>

<style scoped>
.mb { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); align-items: start; }
.mb-lock, .mb-rules { display: grid; gap: 8px; }
.mb-note { display: grid; gap: 4px; padding: 10px; }
.mb-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; font-size: 13px; }
.mb-name { flex: 1 1 10em; }
.check-demo { flex: none; width: 22px; height: 22px; border: 2px solid var(--muted); border-radius: 5px; background: var(--key); }
</style>
