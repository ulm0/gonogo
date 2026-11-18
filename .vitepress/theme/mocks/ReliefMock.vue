<script setup lang="ts">
// Relief at the top of docs/features/relief.md: the saffron block that FLIGHT's hire request makes in your console, with the rows
// the app draws (src/client/relief.ts), and what each key does. Nothing leaves the page.
import { computed, ref } from 'vue';
import { positionById } from '../../../src/shared/positions';
import { reliefRows, reliefTitle } from '../../../src/client/relief';
import type { ReliefRequest } from '../../../src/shared/protocol';

const NOW = 0;
const request: ReliefRequest = {
  id: 'h1',
  by: 'flight',
  at: NOW,
  expiresAt: NOW + 24 * 60_000,
  name: 'guido-1',
  position: 'guido',
  role: positionById('guido')?.role ?? '',
  dir: '/work/app',
  provider: 'claude',
  mode: 'acceptEdits',
  cleanRoom: null,
};
const rows = reliefRows(request, NOW);
const title = reliefTitle(request, 'FLIGHT');
const answer = ref<'go' | 'no-go' | null>(null);
const said = computed(() =>
  answer.value === 'go' ? 'guido-1 is hired in /work/app and starting. FLIGHT gets a message: "Relief: guido-1 is staffed".' : 'Nobody is hired. FLIGHT gets a message: "Relief: request for guido-1 refused".',
);
</script>

<template>
  <div class="module mk">
    <section v-if="answer === null" class="flood mk-need" data-tone="amber" :aria-label="title">
      <h3 class="disp mk-title"><span class="led" data-on="true" data-blink="true" aria-hidden="true"></span>{{ title }}</h3>
      <dl class="mk-rows">
        <div v-for="row in rows" :key="row.label" class="mk-row">
          <dt>{{ row.label }}</dt>
          <dd>{{ row.value }}</dd>
        </div>
      </dl>
      <p class="mk-role-label" id="relief-mock-role">Role text ({{ request.role.length }} characters)</p>
      <p class="mk-role" role="group" tabindex="0" aria-labelledby="relief-mock-role">{{ request.role }}</p>
      <div class="mk-keys">
        <button type="button" class="btn" data-kind="danger" aria-label="NO-GO: do not hire guido-1" @click="answer = 'no-go'">NO-GO</button>
        <button type="button" class="btn" data-kind="primary" aria-label="GO: hire guido-1" @click="answer = 'go'">GO</button>
      </div>
    </section>
    <div v-else class="mk-done">
      <span class="chip" :data-tone="answer === 'go' ? 'go' : 'nogo'">{{ answer === 'go' ? 'GO' : 'NO-GO' }}</span>
      <span class="mk-said" role="status">{{ said }}</span>
      <button type="button" class="btn" @click="answer = null">Reset</button>
    </div>
  </div>
</template>

<style scoped>
.mk {
  padding: 14px;
}

.mk-need {
  display: grid;
  gap: 6px;
  padding: 12px 14px;
}

.mk-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 15px;
  line-height: 1.2;
  overflow-wrap: anywhere;
}

.mk-rows {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr));
  gap: 2px 16px;
  margin: 4px 0 0;
}

.mk-row {
  display: flex;
  gap: 6px;
  min-width: 0;
  color: var(--you-ink);
  font-family: var(--font-mono);
  font-size: 12px;
}

.mk-row dt {
  flex: none;
  font-weight: 600;
}

.mk-row dt::after {
  content: ':';
}

.mk-row dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}

.mk-role-label {
  margin: 6px 0 0;
  color: var(--you-ink);
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
}

.mk-role {
  max-height: 11em;
  margin: 0;
  padding: 4px 8px;
  overflow: auto;
  border: 1px solid var(--you-key);
  border-radius: var(--radius-key);
  color: var(--you-ink);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.mk-keys,
.mk-done {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.mk-keys {
  margin-top: 6px;
}

.mk-said {
  flex: 1 1 240px;
  min-width: 0;
  font-size: 14px;
}

.mk-keys .btn,
.mk-done .btn {
  min-height: 44px;
  padding: 0 20px;
}
</style>
