<script setup lang="ts">
// The rule field of a Launch Window schedule at the top of docs/features/launch-window.md: type a rule (or take one of the
// page's examples) and see the next three fire times, worked out by the app's own code (src/client/launch.ts) in this browser.
import { computed, onMounted, ref } from 'vue';
import { previewOf } from '../../../src/client/launch';
import '../landing/landing.css';

const EXAMPLES = ['0 9 * * mon-fri', '30 8 1 * *', '*/20 * * * *'];
const rule = ref(EXAMPLES[0]!);
// The clock is read after mount, so the server's render and the browser's agree.
const now = ref<number | null>(null);
onMounted(() => void (now.value = Date.now()));
const preview = computed(() => (now.value === null ? { times: [], problem: null } : previewOf(rule.value, now.value)));
</script>

<template>
  <div class="module lp-visual lw">
    <span class="label">Launch Window · rule</span>
    <div class="lw-field">
      <label for="lw-rule">Rule</label>
      <input id="lw-rule" v-model="rule" class="input lw-input" type="text" spellcheck="false" autocomplete="off" aria-describedby="lw-hint" />
      <span id="lw-hint" class="hint">minute hour day-of-month month day-of-week</span>
    </div>
    <div class="lp-row-keys" role="group" aria-label="Examples">
      <button v-for="r in EXAMPLES" :key="r" type="button" class="btn" :aria-pressed="rule === r" @click="rule = r">{{ r }}</button>
    </div>
    <div aria-live="polite">
      <span v-if="preview.problem !== null" class="hint lw-problem">{{ preview.problem }}</span>
      <template v-else-if="preview.times.length">
        <span class="label">Next three</span>
        <ol class="lw-times">
          <li v-for="t in preview.times" :key="t" class="lcd">{{ t }}</li>
        </ol>
      </template>
    </div>
  </div>
</template>

<style scoped>
.lw-field {
  display: grid;
  gap: 6px;
}

.lw-field label {
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-2);
}

.lw-input {
  font-family: var(--font-mono);
}

.lw .btn {
  min-height: 36px;
  padding: 0 12px;
  text-transform: none;
}

.lw .btn[aria-pressed='true'] {
  border-color: var(--text);
  background: var(--text);
  color: var(--panel);
}

.lw-times {
  display: grid;
  gap: 6px;
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
}

.lw-times li {
  margin: 0;
  padding: 8px 12px;
  font-size: 13px;
}

.lw-problem {
  font-size: 14px;
  color: var(--nogo-text);
}
</style>
