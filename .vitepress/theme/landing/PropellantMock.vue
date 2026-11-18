<script setup lang="ts">
// The F · PROPELLANT module tripping Redline: on the landing and at the top of docs/features/propellant.md.
import { computed, ref } from 'vue';
import './landing.css';

const LIMIT = 2_000_000;
const used = ref(1_200_000);
const tripped = computed(() => used.value >= LIMIT);
const fuel = computed(() => Math.min(100, (used.value / LIMIT) * 100));
const burn = (): void => void (used.value = Math.min(LIMIT, used.value + 400_000));
const refill = (): void => void (used.value = 1_200_000);
const fmt = (n: number): string => `${(n / 1_000_000).toFixed(1)}M`;
</script>

<template>
  <div class="module lp-visual">
    <div class="lp-row">
      <span class="label">F · Propellant · day</span>
      <span class="legend">{{ fmt(used) }} / 2M</span>
    </div>
    <span class="lp-bar lp-bar-big" :data-warn="fuel >= 80" role="meter" aria-label="Propellant used today" aria-valuemin="0" :aria-valuemax="LIMIT" :aria-valuenow="used">
      <span :style="{ width: `${fuel}%` }"></span>
    </span>
    <div class="tile room-tile lp-static" :data-kind="tripped ? 'needs' : 'working'">
      <span class="tile-head"><span class="led" :data-kind="tripped ? 'needs' : 'working'" data-on="true"></span><span class="tile-legend">FIDO</span></span>
      <span class="tile-lcd">
        <span class="tile-sub">{{ tripped ? 'redline: propellant limit' : 'Edit src/hub.ts' }}</span>
        <span class="tile-sub">{{ tripped ? 'held: redline on fido' : 'working' }}</span>
      </span>
      <span class="tile-foot"><span class="tile-state">{{ tripped ? 'needs you' : 'working' }}</span></span>
    </div>
    <div class="lp-row-keys">
      <button v-if="!tripped" type="button" class="btn" @click="burn">Burn 400k</button>
      <button v-else type="button" class="btn" @click="refill">Raise the limit</button>
    </div>
  </div>
</template>
