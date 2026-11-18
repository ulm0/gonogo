<script setup lang="ts">
// The Engine Bay of the landing at the top of docs/features/engine-bay.md: each engine, its program and how far it was checked
// (the page's table). Decorative: the table below says the same.
import '../landing/landing.css';

const ENGINES = [
  { name: 'Claude Code', bin: 'claude', checked: 'real runs' },
  { name: 'Gemini CLI', bin: 'gemini', checked: 'help and source' },
  { name: 'Codex', bin: 'codex', checked: 'docs only' },
  { name: 'opencode', bin: 'opencode', checked: 'docs only' },
  { name: 'Kimi CLI', bin: 'kimi', checked: 'docs only' },
  { name: 'Copilot CLI', bin: 'copilot', checked: 'docs only' },
  { name: 'pi', bin: 'pi', checked: 'its help' },
  { name: 'Qwen Code', bin: 'qwen', checked: 'docs only' },
  { name: 'Grok CLI', bin: 'grok', checked: 'docs only' },
  { name: 'Crush', bin: 'crush', checked: 'docs only' },
  { name: 'Cursor Agent', bin: 'cursor-agent', checked: 'docs only' },
];
</script>

<template>
  <div class="eb" aria-hidden="true">
    <span class="label">Engine · checked</span>
    <ul class="lp-engines">
      <li v-for="e in ENGINES" :key="e.bin" class="module">
        <span class="legend">{{ e.name }}</span>
        <span class="eb-bin">{{ e.bin }}</span>
        <span class="chip" :data-tone="e.checked === 'real runs' ? 'go' : 'quiet'">{{ e.checked }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.eb {
  display: grid;
  gap: 10px;
}

.eb ul {
  margin: 0;
  padding: 0;
  list-style: none;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 150px), 1fr));
}

.eb li {
  margin: 0;
}

.eb-bin {
  color: var(--text-2);
  font-family: var(--font-mono);
  font-size: 13px;
}
</style>
