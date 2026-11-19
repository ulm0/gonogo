<script setup lang="ts">
// The HISTORY tab of Launch Window at the top of docs/features/triggers.md: the filters and four rows (a webhook, a schedule, a Telegram message
// read by polling, a refused call). Static; the words are the page's own.
import '../landing/landing.css';
</script>

<template>
  <div class="module lp-visual tm" role="img" aria-label="Launch Window, History tab. Filters: kind, source, outcome. Rows: 09:00 Schedule Standup queued, to flight; 08:41 Webhook GitHub queued, push to main, to ana; 08:30 Telegram polling queued, status please, to flight; 08:12 Webhook Deploys refused, ana is not in the room.">
    <span class="tm-tabs"><span class="btn" data-kind="quiet">Triggers</span><span class="btn" data-kind="primary">History</span></span>
    <span class="tm-filters"><span class="input">All kinds</span><span class="input">All sources</span><span class="input">Any outcome</span><span class="btn">Refresh</span></span>
    <div class="tm-row"><span class="lcd-num">09:00</span><span class="chip" data-tone="quiet">Schedule</span><b>Standup</b><span class="chip" data-tone="amber">queued</span><span class="tm-what">Standup: Post your status. · to flight · m41</span></div>
    <div class="tm-row"><span class="lcd-num">08:41</span><span class="chip" data-tone="quiet">Webhook</span><b>GitHub</b><span class="chip" data-tone="amber">queued</span><span class="tm-what">push to main by ana · to ana · m40</span></div>
    <div class="tm-row"><span class="lcd-num">08:30</span><span class="chip" data-tone="quiet">Telegram (polling)</span><b>Telegram</b><span class="chip" data-tone="amber">queued</span><span class="tm-what">Telegram message from Ana in chat 777: status please · to flight · m39</span></div>
    <div class="tm-row"><span class="lcd-num">08:12</span><span class="chip" data-tone="quiet">Webhook</span><b>Deploys</b><span class="chip" data-tone="nogo">refused</span><span class="tm-what">deploy finished · ana is not in the room</span></div>
  </div>
</template>

<style scoped>
.tm { display: grid; gap: 8px; }
.tm-tabs, .tm-filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.tm-row { display: grid; grid-template-columns: auto auto 1fr auto; gap: 4px 10px; align-items: center; padding: 6px 0; border-top: 1px solid var(--edge); font-size: 13px; }
.tm-what { grid-column: 1 / -1; overflow-wrap: anywhere; color: var(--text-2); }
</style>
