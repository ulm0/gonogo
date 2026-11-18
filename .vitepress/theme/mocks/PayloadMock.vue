<script setup lang="ts">
// The PAYLOAD fold at the top of docs/features/payload.md: pick an engine and see what the fold takes for it (the page's
// Engines rule). The boxes are read-only; the example is the page's own.
import { computed, ref } from 'vue';
import '../landing/landing.css';

const ENGINES = [
  { name: 'Claude Code', takes: 'both' },
  { name: 'Gemini CLI', takes: 'servers' },
  { name: 'Kimi CLI', takes: 'servers' },
  { name: 'Codex', takes: 'none' },
  { name: 'opencode', takes: 'none' },
  { name: 'Copilot CLI', takes: 'none' },
  { name: 'Custom command', takes: 'none' },
] as const;
const SERVERS = '{"files": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]}}';

const engine = ref('Claude Code');
const takes = computed(() => ENGINES.find((e) => e.name === engine.value)?.takes ?? 'none');
</script>

<template>
  <div class="module lp-visual pl">
    <div class="field">
      <label for="pl-engine">Engine</label>
      <select id="pl-engine" v-model="engine" class="input">
        <option v-for="e in ENGINES" :key="e.name">{{ e.name }}</option>
      </select>
    </div>
    <div v-if="takes !== 'none'" class="flood pl-fold" data-tone="lit">
      <span class="label">Payload</span>
      <div class="field">
        <label for="pl-servers">MCP servers</label>
        <textarea id="pl-servers" class="textarea" rows="3" readonly :value="SERVERS"></textarea>
      </div>
      <div v-if="takes === 'both'" class="field">
        <label for="pl-skills">Skills</label>
        <textarea id="pl-skills" class="textarea" rows="2" readonly placeholder="Absolute paths of folders that each hold a SKILL.md, one per line"></textarea>
      </div>
      <span class="hint">{{ takes === 'both' ? 'Claude Code takes both.' : `${engine} takes the servers (in its per-agent file, beside gonogo).` }}</span>
    </div>
    <span v-else class="hint pl-none">The fold is not shown for {{ engine }}, and the server refuses one.</span>
    <span class="visually-hidden" aria-live="polite">{{ takes === 'none' ? 'No payload' : takes === 'both' ? 'MCP servers and skills' : 'MCP servers only' }}</span>
  </div>
</template>

<style scoped>
.pl .field {
  display: grid;
  gap: 6px;
}

.pl label {
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-2);
}

.pl-fold {
  display: grid;
  gap: 12px;
  padding: 12px;
}

.pl .textarea {
  resize: none;
  overflow-wrap: anywhere;
}

.pl .textarea:read-only {
  background: var(--well);
}

.pl .textarea::placeholder {
  color: var(--muted);
  opacity: 1;
}

.pl-none {
  font-size: 14px;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
