<script setup lang="ts">
// Static fire at the top of docs/features/static-fire.md: the T-minus block during a static fire, as WallView.tsx draws it,
// with the answers SIMSUP and RETRO give through go_nogo and the line the Downlink gets.
import '../landing/landing.css';

const ANSWERS = [
  { call: 'SIMSUP', verdict: 'NO-GO', on: 'nogo' },
  { call: 'RETRO', verdict: 'GO', on: 'go' },
];
</script>

<template>
  <div
    class="module lp-visual flood"
    data-tone="nogo"
    role="img"
    aria-label="The wall's static fire block on the login form: SIMSUP answered no-go, the empty password was accepted; RETRO answered go with the rollback, revert the merge. The word reads NO-GO, with the keys Abort and Clear."
  >
    <span class="label">C · Static fire</span>
    <span class="disp sf-word">NO-GO</span>
    <span class="sf-note">the login form · no-go: simsup · SIMSUP: empty password accepted · RETRO: revert the merge, then drop the new column</span>
    <span class="sf-chips">
      <span v-for="a in ANSWERS" :key="a.call" class="chip" :data-tone="a.on">{{ a.call }} {{ a.verdict }}</span>
    </span>
    <span class="lp-row-keys"><span class="btn" data-kind="danger">Abort</span><span class="btn" data-kind="primary">Clear</span></span>
  </div>
</template>

<style scoped>
.sf-word {
  font-size: 30px;
  line-height: 1.1;
}

.sf-note {
  font-size: 12px;
  overflow-wrap: anywhere;
}

.sf-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.btn {
  cursor: default;
}
</style>
