<script setup lang="ts">
// A still-complete picture of the room, built from the app's own classes (primitives.css). One console changes every few
// seconds; under prefers-reduced-motion nothing moves and the first frame already shows every state.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import './landing.css';

type Frame = { kind: string; lines: [string, string]; state: string; vote?: boolean };
const FRAMES: Frame[] = [
  { kind: 'idle', lines: ['idle', 'no mail'], state: 'idle' },
  { kind: 'working', lines: ['Edit src/room.ts', 'running pnpm test'], state: 'working' },
  { kind: 'needs', lines: ['Bash: git push', 'wants your call'], state: 'needs you', vote: true },
  { kind: 'needs', lines: ['redline: loop', 'held: redline on it'], state: 'needs you' },
];
const CONSOLES = ['FLIGHT', 'FIDO', 'GUIDO', 'EECOM', 'RETRO', 'INCO'];
const at = ref([1, 2, 0, 1, 3, 0]);
const tiles = computed(() => CONSOLES.map((name, i) => ({ name, n: `0${i + 1}`, ...FRAMES[at.value[i] as number]! })));

const seconds = ref(41 * 60 + 7);
const clock = computed(() => [seconds.value / 3600, (seconds.value / 60) % 60, seconds.value % 60].map((v) => String(Math.floor(v)).padStart(2, '0')).join(':'));

let tick: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  let step = 0;
  tick = setInterval(() => {
    seconds.value++;
    if (seconds.value % 3 === 0) {
      const i = (step++ * 5) % CONSOLES.length; // 5 is prime to 6: every console gets its turn, never two neighbours in a row
      at.value = at.value.map((f, j) => (j === i ? (f + 1) % FRAMES.length : f));
    }
  }, 1000);
});
onBeforeUnmount(() => clearInterval(tick));
</script>

<template>
  <div
    class="lp-room"
    role="img"
    aria-label="The gonogo room: a top bar of keys, a wall with the mission clock, the T-minus poll and Propellant, and six consoles that are idle, working, or waiting for the Director."
  >
    <div class="lp-room-bar">
      <img src="/mark.svg" alt="" width="24" height="24" />
      <span class="legend">gonogo</span>
      <span class="lp-room-keys">
        <span class="btn lp-hide-sm">Flight plan</span>
        <span class="btn lp-hide-sm">Mission log</span>
        <span class="btn lp-hide-md">Launch window</span>
        <span class="btn">Downlink <span class="chip" data-tone="amber">2</span></span>
        <span class="btn" data-shape="round"><span class="icon" data-icon="half" aria-hidden="true" /></span>
      </span>
    </div>
    <div class="lp-room-wall">
      <div class="module lp-room-mod">
        <span class="label">A · Mission</span>
        <span class="lcd lp-room-clock"><span class="lcd-num">{{ clock }}</span></span>
        <span class="lp-room-sub">Ship the docs site</span>
      </div>
      <div class="module lp-room-mod">
        <span class="label">T-minus</span>
        <span class="disp lp-room-word">Standby</span>
      </div>
      <div class="module lp-room-mod">
        <span class="label">F · Propellant</span>
        <span class="lp-bar"><span style="width: 62%"></span></span>
        <span class="lp-room-sub">day · limit 2M</span>
      </div>
    </div>
    <div class="lp-room-grid">
      <div v-for="t in tiles" :key="t.name" class="tile room-tile" :data-kind="t.kind === 'idle' ? undefined : t.kind">
        <span class="tile-head">
          <span class="led" :data-kind="t.kind" :data-on="t.kind !== 'idle'"></span>
          <span class="tile-legend">{{ t.name }}</span>
          <span class="tile-num">{{ t.n }}</span>
        </span>
        <span class="tile-lcd"><span class="tile-sub">{{ t.lines[0] }}</span><span class="tile-sub">{{ t.lines[1] }}</span></span>
        <span class="tile-foot">
          <span class="tile-state">{{ t.state }}</span>
          <span v-if="t.vote" class="lp-room-vote"><span class="chip" data-tone="go">Go</span><span class="chip" data-tone="nogo">No-go</span></span>
        </span>
      </div>
    </div>
  </div>
</template>
