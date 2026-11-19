<script setup lang="ts">
// The login at the top of docs/features/login.md: the sign-in form, and the Flight Rules block with a session and a key.
import '../landing/landing.css';
</script>

<template>
  <div class="module lp-visual lm" role="img" aria-label="The log in form with a name and a password and a LOG IN button, and the Flight Rules block LOGIN with the second factor on, one session from this machine marked this one, and one read key that expires in 90 days.">
    <div class="lm-form">
      <span class="label">LOG IN</span>
      <span class="input lm-field">director</span>
      <span class="input lm-field">••••••••••••••</span>
      <span class="btn" data-kind="primary">LOG IN</span>
    </div>
    <div class="lm-rules">
      <span class="label">LOGIN</span>
      <span class="label">SECOND FACTOR (TOTP)</span>
      <span class="lm-line">On. 10 recovery codes left. <span class="btn" data-kind="danger">TURN OFF</span></span>
      <span class="label">SESSIONS</span>
      <span class="lm-line">127.0.0.1 · Firefox · last used 2026-11-19 09:41 · this one <span class="btn">REVOKE</span></span>
      <span class="label">API KEYS</span>
      <span class="lm-line">ci · read · expires 2027-02-17 · last used never <span class="btn" data-kind="danger">REVOKE</span></span>
    </div>
  </div>
</template>

<style scoped>
.lm { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); }
.lm-form, .lm-rules { display: grid; gap: 8px; align-content: start; }
.lm-field { display: block; }
.lm-line { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px; font-size: 12.5px; }
</style>
