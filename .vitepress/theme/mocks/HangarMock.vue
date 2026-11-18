<script setup lang="ts">
// The Hangar at the top of docs/features/hangar.md: a tree and the editor, with the app's own line numbers, size words and line
// count (src/client/editor.ts). The box is a real textarea: type in it and the chip changes, as in the app.
import { computed, ref } from 'vue';
import { gutterText, lineCount, sizeText } from '../../../src/client/editor';

const FILES = [
  { name: 'index.ts', size: 76 },
  { name: 'util.ts', size: 69 },
];
const SAVED = "export function greet(name: string): string {\n  return `hello, ${name}!`;\n}\n";
const text = ref(SAVED);
const lines = computed(() => lineCount(text.value));
const numbers = computed(() => gutterText(lines.value));
const dirty = computed(() => text.value !== SAVED);
</script>

<template>
  <div class="module hg-mock">
    <div class="mk-side">
      <span class="label">Files</span>
      <span class="mk-item"><span class="mk-mark" aria-hidden="true">▸</span>docs</span>
      <span class="mk-item"><span class="mk-mark" aria-hidden="true">▾</span>src</span>
      <span v-for="f in FILES" :key="f.name" class="mk-item mk-file" :aria-current="f.name === 'index.ts' ? 'true' : undefined"><span>{{ f.name }}</span><span class="mk-size">{{ sizeText(f.size) }}</span></span>
      <span class="mk-item mk-file"><span>README.md</span><span class="mk-size">{{ sizeText(45) }}</span></span>
      <span class="mk-item mk-file mk-quiet"><span>leak</span><span class="chip" data-tone="quiet">link</span></span>
    </div>
    <div class="mk-edit">
      <div class="mk-bar">
        <strong class="mk-path">src/index.ts</strong>
        <span class="chip" :data-tone="dirty ? 'amber' : 'quiet'" role="status">{{ dirty ? 'Unsaved changes' : 'No changes' }}</span>
        <span class="mk-size">{{ lines }} {{ lines === 1 ? 'line' : 'lines' }}</span>
        <span class="btn" data-kind="primary" :aria-disabled="!dirty || undefined">Save</span>
      </div>
      <div class="mk-box">
        <pre class="mk-gutter" aria-hidden="true">{{ numbers }}</pre>
        <textarea v-model="text" class="mk-text" wrap="off" spellcheck="false" aria-label="Contents of src/index.ts" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.hg-mock {
  display: grid;
  grid-template-columns: minmax(150px, 220px) minmax(0, 1fr);
  gap: 14px;
  padding: 14px;
}

.mk-side,
.mk-edit {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.mk-item {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 0 8px;
  border-radius: var(--radius-key);
  color: var(--text);
  font-size: 13px;
}

.mk-file {
  justify-content: space-between;
  padding-left: 24px;
}

.mk-file[aria-current='true'] {
  background: var(--well);
  box-shadow: inset 3px 0 0 var(--work);
  font-weight: 600;
}

.mk-quiet {
  color: var(--muted);
}

.mk-mark {
  width: 12px;
  color: var(--muted);
}

.mk-size {
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11px;
}

.mk-edit {
  gap: 10px;
}

.mk-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 10px;
}

.mk-path {
  flex: 1 1 120px;
  font-family: var(--font-mono);
  font-size: 13px;
}

.btn {
  cursor: default;
}

.mk-box {
  display: flex;
  height: 150px;
  border: 1px solid var(--edge);
  border-radius: var(--radius-key);
  background: var(--key);
  overflow: hidden;
}

.mk-gutter,
.mk-text {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 20px;
}

.mk-gutter {
  flex: none;
  padding: 10px 8px 10px 10px;
  background: var(--well);
  color: var(--muted);
  text-align: right;
  overflow: hidden;
}

.mk-text {
  flex: 1 1 auto;
  min-width: 0;
  padding: 10px 12px;
  border: 0;
  background: transparent;
  color: var(--text);
  overflow: auto;
  resize: none;
  white-space: pre;
}

@media (max-width: 640px) {
  .hg-mock {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
