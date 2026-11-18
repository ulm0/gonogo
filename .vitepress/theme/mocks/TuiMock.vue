<script setup lang="ts">
// The terminal client at the top of docs/features/tui.md: one rendered frame, the status line, the needs line and the room list.
import '../landing/landing.css';
</script>

<template>
  <div class="module lp-visual" role="img" aria-label="A terminal frame of gonogo tui: connected, NEEDS 2: ana: permission request: Bash: git push, and the roster with each console's state.">
    <pre class="lcd tm">gonogo  connected        1 ROOM  2 INBOX  3 NEEDS  4 POLL
NEEDS 2: ana: permission request: Bash: git push (press 3)
------------------------------------------------------------
> flight   idle     Brief the room
  ana      needs    Bash: git push
  guido    working  Edit src/server/hub.ts
  retro    idle
------------------------------------------------------------
Enter attach   n write   h hold   r resume   ? keys   q quit</pre>
  </div>
</template>

<style scoped>
.tm { margin: 0; font-size: 12px; line-height: 1.5; overflow-x: auto; white-space: pre; }
</style>
