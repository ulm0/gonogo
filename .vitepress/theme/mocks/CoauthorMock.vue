<script setup lang="ts">
// Co-author line at the top of docs/features/coauthor.md: a commit of an agent, and the box of the Flight Rules block.
import '../landing/landing.css';
</script>

<template>
  <div class="module lp-visual cm" role="img" aria-label="A commit message 'Fix the parser' followed by the lines Co-Authored-By: Claude and Co-Authored-By: flight (gonogo) with an address ending in gonogo.invalid; the Flight Rules block CO-AUTHOR LINE with its box ticked.">
    <span class="cm-msg">Fix the parser

Co-Authored-By: Claude &lt;noreply@anthropic.com&gt;
Co-Authored-By: flight (gonogo) &lt;flight@gonogo.invalid&gt;</span>
    <div class="cm-rule"><span class="label">CO-AUTHOR LINE</span><span class="staff-check"><span class="led" data-on="true" aria-hidden="true" /> Add a gonogo co-author line to commits agents make</span></div>
  </div>
</template>

<style scoped>
.cm { display: grid; gap: 10px; }
.cm-msg { white-space: pre; font-family: var(--font-mono); font-size: 12px; }
.cm-rule { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; }
</style>
