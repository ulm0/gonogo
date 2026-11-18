<script setup lang="ts">
// The Clean Room nesting of the landing at the top of docs/features/clean-room.md: what the container holds, and nothing else.
import '../landing/landing.css';
</script>

<template>
  <div
    class="lp-visual lp-nest cr"
    role="img"
    aria-label="Nested boxes: your machine holds Docker, Docker holds the agent's container, the container holds only the worktree and the agent's folder. Your ~/.claude is not shared."
  >
    <div class="module">
      <span class="label">Your machine · ~/.claude not shared</span>
      <div class="flood" data-tone="lit">
        <span class="label">Docker</span>
        <div class="module">
          <span class="label">Container · gonogo-&lt;name&gt;-&lt;hash&gt;</span>
          <div class="flood" data-tone="go">
            <span class="label cr-ink">Worktree · branch gonogo/&lt;name&gt;</span><span class="cr-path">~/.gonogo/cleanroom/&lt;name&gt;</span>
          </div>
          <div class="flood" data-tone="lit">
            <span class="label">Agent folder</span><span class="cr-path">~/.gonogo/agents/&lt;name&gt;</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cr-path {
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 12px;
  overflow-wrap: anywhere;
}

/* muted is checked on body, panel, key and well, not on the go tint: the ink of the tint carries the label there */
.cr-ink {
  color: var(--go-ink);
}
</style>
