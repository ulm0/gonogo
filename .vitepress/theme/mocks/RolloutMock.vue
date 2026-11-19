<script setup lang="ts">
// Rollout at the top of docs/features/rollout.md: the quiet strip under the top bar when a newer gonogo is out, and the two
// lines `gonogo --version` prints. Decorative: the page says the same in words. The version numbers are examples.
import '../landing/landing.css';
</script>

<template>
  <div class="module lp-visual ro" role="img" aria-label="The note under the top bar when a newer gonogo is out: the new version, the command that updates this one, and the keys Copy and Dismiss. Below it, the two lines of gonogo --version.">
    <span class="label">Rollout · a newer gonogo</span>
    <div class="ro-strip">
      <span>gonogo 0.2.0 is out (this is 0.1.1). To update, run:</span>
      <code>pnpm add -g --config.minimum-release-age-exclude=@ulm0/gonogo @ulm0/gonogo@0.2.0</code>
      <span class="lp-row-keys"><span class="btn" data-kind="quiet">Copy</span><span class="btn" data-kind="quiet">Dismiss</span></span>
    </div>
    <pre class="ro-term">$ gonogo --version
gonogo 0.1.1
0.2.0 is out. To update, run: gonogo update</pre>
  </div>
</template>

<style scoped>
.ro-strip {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 12px;
  padding: 2px 8px 2px 14px;
  border: 1px solid var(--edge);
  border-radius: var(--radius-key);
  background: var(--well);
  color: var(--text-2);
  font-size: 12px;
}

.ro-strip code {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 12px;
}

.ro-term {
  margin: 0;
  padding: 10px 14px;
  overflow-x: auto;
  border: 1px solid var(--edge);
  border-radius: var(--radius-key);
  background: var(--well);
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.5;
}

.btn {
  cursor: default;
}
</style>
