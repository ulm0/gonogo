<script setup lang="ts">
// The door at the top of docs/features/door.md: the RULES block of Flight Rules, and the role text an agent starts with.
import '../landing/landing.css';
</script>

<template>
  <div class="module lp-visual dm" role="img" aria-label="The Flight Rules block RULES with a text box holding 'Never push to main. Report in the language of the Director.' and the counter 71 of 8192 bytes; below it the start of an agent: the role, then the room rules, then one sentence saying the project's own rules are in AGENTS.md.">
    <div class="dm-rule"><span class="label">RULES</span><span class="dm-box">Never push to main.
Report in the language of the Director.</span><span class="hint">71 of 8192 bytes</span></div>
    <span class="dm-role"><span class="label">ROLE TEXT AT START</span>
Your role: Reviews pull requests.
<b>Room rules, written by the Director for every agent of this room:</b>
Never push to main. Report in the language of the Director.
<b>The project's own rules are in the file AGENTS.md at the root of the repository you work in …</b></span>
  </div>
</template>

<style scoped>
.dm { display: grid; gap: 10px; }
.dm-rule { display: grid; gap: 6px; }
.dm-box, .dm-role { white-space: pre-wrap; font-family: var(--font-mono); font-size: 12px; }
.dm-box { border: 1px solid var(--line, currentColor); padding: 6px 8px; }
.dm-role { display: grid; gap: 4px; }
</style>
