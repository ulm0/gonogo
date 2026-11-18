<script setup lang="ts">
// The hardware the first paragraph of docs/design-system.md describes, built from the specimens further down that page.
import '../landing/landing.css';
</script>

<template>
  <div class="hw" aria-hidden="true">
    <div class="module hw-mod">
      <span class="label">A · Mission</span>
      <span class="lcd hw-lcd"><span class="lcd-num">00:04:12</span></span>
      <span class="hw-sub">Brief FLIGHT to start the clock.</span>
    </div>
    <div class="flood hw-mod" data-tone="amber">
      <span class="lp-row"><span class="led" data-kind="needs" data-on="true"></span><span class="legend">GUIDO</span></span>
      <span class="hw-sub hw-ink">Permission: Bash</span>
      <span class="lp-row-keys"><span class="chip" data-tone="go">Go</span><span class="chip" data-tone="nogo">No-go</span></span>
    </div>
    <div class="module hw-mod">
      <span class="label">Lights</span>
      <span class="lp-row"><span class="led" data-kind="working" data-on="true"></span><span class="led" data-kind="needs" data-on="true"></span><span class="led" data-kind="idle"></span><span class="led" data-kind="stopped"></span></span>
      <span class="lp-row-keys"><span class="btn" data-kind="primary">+ Staff a console</span></span>
    </div>
  </div>
</template>

<style scoped>
.hw {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr));
  gap: 10px;
  padding: 10px;
  border: 1px solid var(--edge);
  border-radius: var(--radius-module);
  background: var(--body);
}
.hw-mod {
  display: grid;
  align-content: start;
  gap: 8px;
  padding: 10px 12px;
}
.hw-lcd {
  justify-self: start;
  padding: 5px 9px;
  font-size: 22px;
}
.hw-sub {
  color: var(--text-2);
  font-size: 13px;
}
.hw-ink {
  color: var(--you-ink);
  font-family: var(--font-mono);
  font-size: 12px;
}
.hw .btn {
  cursor: default;
}
</style>
