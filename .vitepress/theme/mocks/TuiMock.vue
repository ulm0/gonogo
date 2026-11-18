<script setup lang="ts">
// The terminal client at the top of docs/features/tui.md: one rendered frame, the status line, the needs line and the room list.
import '../landing/landing.css';
</script>

<template>
  <div class="module lp-visual" role="img" aria-label="A terminal frame of gonogo tui: the screens and the link, NEEDS 1: ana: permission request: Bash: git push, and the roster with a glyph and a word for each console's state.">
    <pre class="lcd tm">gonogo   1 ROOM  2 INBOX 1  3 NEEDS 1  4 POLL  connected
NEEDS 1: ana: permission request: Bash: git push (press 3)
ROOM
> * flight      working   flight
  ! ana         needs you fido      permission request: Bash: git push
  . guido       idle      guido
  - retro       stopped
Enter attach  n message  h hold  r resume  Tab screens  ? help  q quit</pre>
  </div>
</template>

<style scoped>
.tm { margin: 0; font-size: 12px; line-height: 1.5; overflow-x: auto; white-space: pre; }
</style>
