<script setup lang="ts">
// The livery key of the site, in place of the light/dark switch. The script in config.mts puts the livery on <html> before the
// first paint; this key changes it and keeps the choice in the browser.
import { onMounted, ref } from 'vue';
import { BUILTIN_LIVERIES, schemeOf } from '../../src/shared/livery';

const KEY = 'gonogo.docs.livery';
const look = ref('');

onMounted(() => {
  const read = () => (look.value = document.documentElement.dataset.livery ?? 'instrument');
  read();
  // Follow every change to the livery: the system's (config.mts) and the landing's livery keys.
  new MutationObserver(read).observe(document.documentElement, { attributes: true, attributeFilter: ['data-livery'] });
});

function choose(slug: string): void {
  const livery = BUILTIN_LIVERIES.find((l) => l.slug === slug);
  if (!livery) return;
  look.value = slug;
  document.documentElement.dataset.livery = slug;
  document.documentElement.classList.toggle('dark', schemeOf(livery.tokens) === 'dark');
  try {
    localStorage.setItem(KEY, slug);
  } catch {
    // storage blocked: the livery holds for this visit only
  }
}
</script>

<template>
  <label class="livery-key">
    <span class="livery-key-mark icon" data-icon="half" aria-hidden="true" />
    <span class="visually-hidden">Livery</span>
    <select :value="look" @change="choose(($event.target as HTMLSelectElement).value)">
      <option v-for="l in BUILTIN_LIVERIES" :key="l.slug" :value="l.slug">{{ l.name }}</option>
    </select>
  </label>
</template>
