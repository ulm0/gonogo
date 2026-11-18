<script setup lang="ts">
// The Recorder at the top of docs/features/recorder.md: changed files in the app's own words, a diff coloured by the app's own
// reader of diffs (src/client/changes.ts), and a commit form that says why it cannot commit, as the app does.
import { computed, ref } from 'vue';
import { commitProblem, diffLines, fileLabels, stagedCount } from '../../../src/client/changes';
import type { RecorderFile, RecorderScope } from '../../../src/shared/protocol';

const FILES: RecorderFile[] = [
  { path: 'src/index.ts', index: 'M', tree: ' ' },
  { path: 'src/util.ts', index: ' ', tree: 'M' },
  { path: 'docs/new.md', index: '?', tree: '?' },
];
const DIFF = 'diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1,3 +1,3 @@\n export function greet(name: string): string {\n-  return `hello ${name}`;\n+  return `hello, ${name}!`;\n }\n';
const lines = diffLines(DIFF);
const message = ref('');
const scope = ref<RecorderScope>('all');
const why = computed(() => commitProblem(message.value, scope.value, FILES, true));
</script>

<template>
  <div class="module rc-mock">
    <div class="mk-side">
      <span class="label">Changes <span class="chip" data-tone="quiet">main</span></span>
      <span v-for="f in FILES" :key="f.path" class="mk-file">
        <span class="mk-path">{{ f.path }}</span>
        <span class="mk-labels"><span v-for="l in fileLabels(f)" :key="l.text" class="chip" :data-tone="l.staged ? 'go' : 'quiet'">{{ l.text }}</span></span>
      </span>
      <div class="field">
        <label for="rc-mock-message">Message</label>
        <textarea id="rc-mock-message" v-model="message" class="textarea" rows="2" autocomplete="off" />
      </div>
      <label class="mk-radio"><input v-model="scope" type="radio" class="radio" value="all" />All changes ({{ FILES.length }}): git adds them first</label>
      <label class="mk-radio"><input v-model="scope" type="radio" class="radio" value="staged" />Only what is staged ({{ stagedCount(FILES) }})</label>
      <span class="mk-commit"><span class="btn" data-kind="primary" :aria-disabled="why !== null || undefined">Commit</span><span class="hint" aria-live="polite">{{ why ?? 'Ready.' }}</span></span>
    </div>
    <pre class="lcd mk-diff" role="region" aria-label="Diff of src/index.ts" tabindex="0"><span v-for="(l, i) in lines" :key="i" :data-kind="l.kind">{{ l.text }}
</span></pre>
  </div>
</template>

<style scoped>
.rc-mock {
  display: grid;
  grid-template-columns: minmax(220px, 340px) minmax(0, 1fr);
  gap: 14px;
  padding: 14px;
}

.mk-side {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.mk-file {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 8px 12px;
  border: 1px solid var(--edge);
  border-bottom-width: 3px;
  border-radius: var(--radius-key);
  background: var(--key);
  color: var(--text);
}

.mk-path {
  font-family: var(--font-mono);
  font-size: 12.5px;
}

.mk-labels {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.mk-radio {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 36px;
  color: var(--text);
  font-size: 13px;
}

.mk-commit {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.btn {
  cursor: default;
}

.mk-diff {
  min-width: 0;
  margin: 0;
  padding: 10px 12px;
  overflow: auto;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre;
}

.mk-diff [data-kind='ctx'],
.mk-diff [data-kind='meta'] {
  color: var(--lcd-dim);
}

.mk-diff [data-kind='meta'],
.mk-diff [data-kind='hunk'] {
  font-weight: 600;
}

.mk-diff [data-kind='add'],
.mk-diff [data-kind='hunk'] {
  color: var(--lcd-text);
}

.mk-diff [data-kind='del'] {
  color: var(--lcd-warm);
}

@media (max-width: 640px) {
  .rc-mock {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
