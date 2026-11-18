<script setup lang="ts">
// Commissioning at the top of docs/features/flight-rules.md, as a local preview: the four steps of an empty room, ticked by the
// keys here instead of by the room. Rows as in src/client/Rules.tsx.
import { computed, ref } from 'vue';

const STEPS = [
  { id: 'flight', title: 'Staff FLIGHT', detail: 'It is staffed once it is up and past its startup questions.', key: 'Open FLIGHT' },
  { id: 'propellant', title: 'Set a Propellant limit', detail: 'A token budget for the room.', key: 'Flight Rules' },
  { id: 'livery', title: 'Pick a livery', detail: 'The look every device shows.', key: 'Livery' },
  { id: 'note', title: 'Read the security note', detail: 'Opening the note ticks it.', key: 'Show the note' },
];
const done = ref<string[]>(['flight']);
const away = ref(false);
const count = computed(() => done.value.length);
const tick = (id: string): void => {
  if (!done.value.includes(id)) done.value = [...done.value, id];
};
</script>

<template>
  <div class="mk">
    <section v-if="!away" class="module mk-panel" aria-label="Commissioning, a preview">
      <div class="mk-head">
        <span class="label">Commissioning</span>
        <span class="hint">{{ count }} of 4 done</span>
        <button type="button" class="btn" data-kind="quiet" @click="away = true">Put away</button>
      </div>
      <ol class="mk-steps">
        <li v-for="s in STEPS" :key="s.id" :data-done="done.includes(s.id) || undefined">
          <span class="led" :data-on="done.includes(s.id)" :style="done.includes(s.id) ? { '--led': 'var(--go)' } : undefined" aria-hidden="true"></span>
          <span class="mk-text">
            <span class="mk-title">{{ s.title }}<span class="mk-sr">{{ done.includes(s.id) ? ', done' : ', to do' }}</span></span>
            <span class="hint">{{ s.detail }}</span>
          </span>
          <button type="button" class="btn" @click="tick(s.id)">{{ s.key }}</button>
        </li>
      </ol>
    </section>
    <div v-else class="mk-away">
      <span class="hint">Put away. Flight Rules has SHOW COMMISSIONING AGAIN.</span>
      <button type="button" class="btn" @click="away = false">Show Commissioning again</button>
    </div>
  </div>
</template>

<style scoped>
.mk {
  padding: 12px;
  border: 1px solid var(--edge);
  border-radius: var(--radius-module);
  background: var(--body);
  color: var(--text);
}

.mk-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
}

.mk-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
}

.mk-head .btn {
  margin-left: auto;
}

.mk-steps {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.mk-steps li {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px 12px;
  margin: 0;
}

.mk-text {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.mk-title {
  font-size: 14px;
  font-weight: 600;
}

li[data-done] .mk-title {
  color: var(--text-2);
  text-decoration: line-through;
}

/* read by a screen reader, not drawn */
.mk-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.mk-away {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

@media (max-width: 520px) {
  .mk-steps li {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .mk-steps li > .btn {
    grid-column: 2;
    justify-self: start;
  }
}
</style>
