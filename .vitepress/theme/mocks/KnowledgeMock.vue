<script setup lang="ts">
// KNOWLEDGE in docs/features/knowledge.md: a repository with a claim, what the check found on each checkout, and a proposal that waits for the Director.
import '../landing/landing.css';
</script>

<template>
  <div class="module lp-visual kn" role="img" aria-label="Knowledge of the repository shop. Claim K-1, Money is an integer number of cents, confirmed on main. Claim K-2, No eval in src, not confirmed on feature, likely real. One proposal from flight, unreviewed, with Trial run, Accept and Reject.">
    <span class="label">KNOWLEDGE · shop <span class="chip" data-tone="quiet">abcdef01</span></span>
    <div class="lp-row"><span class="legend">K-1</span><span class="chip" data-tone="quiet">store</span><span class="chip" data-tone="go">confirmed</span><span class="hint">main@abc1234</span></div>
    <div class="lp-row"><span class="legend">K-2</span><span class="chip" data-tone="quiet">store</span><span class="chip" data-tone="amber">not confirmed</span><span class="hint">feature@def5678 · likely real</span></div>
    <div class="lp-row"><span class="legend">p1</span><span class="chip" data-tone="amber">unreviewed</span><span class="hint">proposed by flight</span><span class="btn" data-kind="quiet">Trial run</span><span class="btn" data-kind="primary">Accept</span><span class="btn" data-kind="danger">Reject</span></div>
    <span class="hint">Not confirmed is a prompt to look, never a verdict. Nothing is blocked.</span>
  </div>
</template>

<style scoped>
.kn { display: grid; gap: 8px; }
</style>
