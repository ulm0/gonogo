<script setup lang="ts">
// Cost at the top of docs/features/cost.md: the TOKENS | DOLLARS meter against a budget, at 80 % and over it, and one price row.
// Static: numbers are the page's own examples.
import '../landing/landing.css';
</script>

<template>
  <div class="module lp-visual cm" role="img" aria-label="Propellant meter in dollars: the day window at 82 percent of a 10 dollar budget, saffron. One price row: claude-sonnet-5-5, 3 dollars in, 15 out.">
    <span class="label">Propellant · DOLLARS</span>
    <span class="lp-row-keys"><span class="btn" data-kind="quiet">Tokens</span><span class="btn" data-kind="primary">Dollars</span></span>
    <div class="cm-row"><span class="legend">5 H</span><span class="cm-bar"><i style="width: 31%"></i></span><span class="lcd-num">$1.20 / $4.00</span></div>
    <div class="cm-row" data-hot="true"><span class="legend">DAY</span><span class="cm-bar"><i style="width: 82%"></i></span><span class="lcd-num">$8.20 / $10.00</span><span class="chip" data-tone="amber">80 %</span></div>
    <div class="cm-row"><span class="legend">WEEK</span><span class="cm-bar"><i style="width: 40%"></i></span><span class="lcd-num">$24.00 / $60.00</span></div>
    <span class="label">Prices · $ per million tokens</span>
    <span class="lcd cm-price">claude-sonnet-5-5   in 3.00   out 15.00   cache write 3.75   cache read 0.30   copied 2026-11-18</span>
  </div>
</template>

<style scoped>
.cm { display: grid; gap: 8px; }
.cm-row { display: grid; grid-template-columns: 52px 1fr auto auto; gap: 10px; align-items: center; }
.cm-bar { height: 8px; background: var(--key); border-radius: 4px; overflow: hidden; }
.cm-bar i { display: block; height: 100%; background: var(--work); }
.cm-row[data-hot='true'] .cm-bar i { background: var(--you); }
.cm-price { overflow-wrap: anywhere; font-size: 12px; }
</style>
