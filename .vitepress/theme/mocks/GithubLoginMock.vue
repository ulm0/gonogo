<script setup lang="ts">
// A GitHub login per room, at the top of docs/features/github-login.md: two rooms, each with its own gh folder, and a console that logs in.
import '../landing/landing.css';
</script>

<template>
  <div class="module lp-visual gl" role="img" aria-label="Room main: GH_CONFIG_DIR is its home's gh folder, logged in as one GitHub account. Room client: its own gh folder, logged in as another account. A console in client runs gh auth login and only client changes.">
    <span class="label">Room · main</span>
    <span class="lcd gl-lcd">GH_CONFIG_DIR=~/.gonogo/gh        gh: logged in as ulm0</span>
    <span class="label">Room · client</span>
    <span class="lcd gl-lcd">GH_CONFIG_DIR=~/.gonogo/rooms/client/gh        gh: not logged in</span>
    <span class="label">A console of client</span>
    <span class="lcd gl-lcd">$ gh auth login
? Where do you use GitHub? GitHub.com
Logged in as client-bot  (only room client)</span>
  </div>
</template>

<style scoped>
.gl { display: grid; gap: 8px; }
.gl-lcd { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
</style>
