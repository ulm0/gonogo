<script setup lang="ts">
// The version of the build, small beside the logo in the navbar. config.mts reads package.json at build time.
declare const __GONOGO_VERSION__: string;
const version = __GONOGO_VERSION__;
</script>

<template>
  <a class="nav-version" :href="`https://github.com/ulm0/gonogo/releases/tag/v${version}`" target="_blank" rel="noreferrer noopener" :aria-label="`gonogo ${version}, open the release`">v{{ version }}</a>
</template>

<style scoped>
.nav-version {
  margin-left: 8px;
  color: var(--text-2);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1;
  text-decoration: none;
  white-space: nowrap;
}

.nav-version:hover,
.nav-version:focus-visible {
  color: var(--text);
  text-decoration: underline;
}
</style>
