<script setup lang="ts">
// Post-Flight Review at the top of docs/features/review.md: the verdict keys over one hunk with a note under its line.
import '../landing/landing.css';
</script>

<template>
  <div class="module lp-visual rv" role="img" aria-label="Post-Flight Review: keys Approve, Request changes, Ask walkthrough, Peer review; a diff hunk with one warning note by guido.">
    <span class="label">Post-Flight Review · 1 file</span>
    <span class="lp-row-keys"><span class="btn" data-kind="primary">Approve</span><span class="btn" data-kind="quiet">Request changes</span><span class="btn" data-kind="quiet">Ask walkthrough</span><span class="btn" data-kind="quiet">Peer review</span></span>
    <div class="lcd rv-diff"><span class="rv-l">src/server/hub.ts</span>
<span class="rv-l rv-del">41 - if (held) return;</span>
<span class="rv-l rv-add">41 + if (held &amp;&amp; !urgent) return;</span></div>
    <div class="rv-note"><span class="lp-row"><span class="chip" data-tone="amber">WARNING</span><span class="rv-author">GUIDO</span></span><span>Does urgent mail skip Hold?</span><span class="lp-row-keys"><span class="btn" data-kind="quiet">Reply</span><span class="btn" data-kind="quiet">Resolve</span><span class="btn" data-kind="quiet">Delete</span></span></div>
  </div>
</template>

<style scoped>
.rv { display: grid; gap: 8px; }
.rv-diff { display: grid; font-size: 12px; white-space: pre; overflow-x: auto; }
.rv-l { display: block; }
.rv-del { color: var(--lcd-warm); }
.rv-add { color: var(--lcd-text); }
.rv-note { display: grid; gap: 6px; padding: 8px 10px; border: 1px solid var(--edge); border-left: 4px solid var(--you-edge); border-radius: 4px; background: var(--well); }
.rv-author { font-weight: 600; }
</style>
