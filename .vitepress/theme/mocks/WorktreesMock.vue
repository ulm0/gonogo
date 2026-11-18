<script setup lang="ts">
// Worktrees at the top of docs/features/worktrees.md: the hire form box and the folder and branch it makes.
import '../landing/landing.css';
</script>

<template>
  <div class="module lp-visual wt" role="img" aria-label="Hire form box: Own git worktree, ticked. It makes ~/.gonogo/worktrees/ana on the branch gonogo/ana. The remove dialog has Also delete its worktree and branch, off.">
    <span class="label">Own git worktree</span>
    <label class="wt-box"><input type="checkbox" checked disabled /> Own git worktree</label>
    <span class="lcd wt-path">~/.gonogo/worktrees/ana   branch gonogo/ana   from HEAD</span>
    <label class="wt-box"><input type="checkbox" disabled /> Also delete its worktree and branch</label>
  </div>
</template>

<style scoped>
.wt { display: grid; gap: 8px; }
.wt-box { display: flex; gap: 8px; align-items: center; font-size: 13px; }
.wt-path { font-size: 12px; overflow-wrap: anywhere; }
</style>
