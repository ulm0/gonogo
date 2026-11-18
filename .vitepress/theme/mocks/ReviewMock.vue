<script setup lang="ts">
// Post-Flight Review at the top of docs/features/review.md: the verdict keys over one hunk with a note under its line.
import '../landing/landing.css';
</script>

<template>
  <div class="module lp-visual rv" role="img" aria-label="Post-Flight Review: keys Approve, Request changes, Ask walkthrough, Peer review; a diff hunk with one warning note by guido, open.">
    <span class="label">Post-Flight Review · 1 file</span>
    <span class="lp-row-keys"><span class="btn" data-kind="primary">Approve</span><span class="btn" data-kind="quiet">Request changes</span><span class="btn" data-kind="quiet">Ask walkthrough</span><span class="btn" data-kind="quiet">Peer review</span></span>
    <div class="lcd rv-diff"><span class="rv-l">src/server/hub.ts</span>
<span class="rv-l rv-del">41 - if (held) return;</span>
<span class="rv-l rv-add">41 + if (held &amp;&amp; !urgent) return;</span></div>
    <div class="flood rv-note" data-tone="lit"><span class="lp-row"><span class="chip" data-tone="amber">warning</span><span class="legend">GUIDO</span><span class="hint">open</span></span><span>Does urgent mail skip Hold?</span><span class="lp-row-keys"><span class="btn" data-kind="quiet">Reply</span><span class="btn" data-kind="quiet">Resolve</span></span></div>
  </div>
</template>

<style scoped>
.rv { display: grid; gap: 8px; }
.rv-diff { display: grid; font-size: 12px; white-space: pre; overflow-x: auto; }
.rv-l { display: block; }
.rv-del { color: var(--nogo-text); }
.rv-add { color: var(--go); }
.rv-note { display: grid; gap: 6px; padding: 10px; }
</style>
