<script setup lang="ts">
// The version of the build, small in a corner like the app's .version-corner (src/client/shell.css). config.mts reads package.json at build time.
declare const __GONOGO_VERSION__: string;
const version = __GONOGO_VERSION__;
</script>

<template>
  <a class="version-corner" :href="`https://github.com/ulm0/gonogo/releases/tag/v${version}`" target="_blank" rel="noreferrer noopener" :aria-label="`gonogo ${version}, open the release`">v{{ version }}</a>
</template>

<style scoped>
.version-corner {
  position: fixed;
  right: 8px;
  bottom: 4px;
  z-index: 1;
  padding: 0 4px;
  color: var(--text-2);
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1.4;
  text-decoration: none;
  opacity: 0.7;
}

.version-corner:hover,
.version-corner:focus-visible {
  opacity: 1;
  text-decoration: underline;
}
</style>
