<script setup lang="ts">
// The home page: the room itself as the illustration, small demos built from the app's classes, every claim from docs/features.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { BUILTIN_LIVERIES, schemeOf } from '../../../src/shared/livery';
import PropellantMock from './PropellantMock.vue';
import RoomMock from './RoomMock.vue';
import './landing.css';

const ROOM = '/guide/the-room#positions-t-minus-max-q-and-custom-agents';

// ---- install lines ----
const INSTALL = ['npm i -g @ulm0/gonogo@latest', 'docker pull ghcr.io/ulm0/gonogo'];
const copied = ref('');
async function copy(line: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(line);
    copied.value = `Copied: ${line}`;
  } catch {
    copied.value = 'Copy blocked by the browser: select the line instead.';
  }
}

// ---- T-minus: the first no-go holds the poll; all go reads GO ----
const POLLED = ['FIDO', 'GUIDO', 'EECOM'];
const polling = ref(false);
const votes = ref<Record<string, 'go' | 'no-go'>>({});
const poll = computed(() => {
  if (!polling.value) return { word: 'Standby', tone: undefined, note: 'Start a poll to ask every running agent.' };
  const no = POLLED.find((n) => votes.value[n] === 'no-go');
  if (no) return { word: 'Hold', tone: 'nogo', note: `${no} said no-go: "tests are red on main".` };
  if (POLLED.every((n) => votes.value[n] === 'go')) return { word: 'Go', tone: 'go', note: 'FLIGHT is told: T-minus: all go.' };
  return { word: 'Polling', tone: 'amber', note: 'Vote for each agent, as it would with the go_nogo tool.' };
});
function startPoll(): void {
  votes.value = {};
  polling.value = !polling.value;
}

// ---- Mission Log: a word in the title or a tag counts three times one in the body ----
const ENTRIES = [
  { id: 'l4', title: 'Release checklist', tags: ['release', 'ci'], body: 'Tag, build the image, run the smoke test, then publish the package.' },
  { id: 'l3', title: 'Why the build is slow', tags: ['build'], body: 'The client build runs twice when the cache is cold; warm it in CI first.' },
  { id: 'l2', title: 'Test database', tags: ['tests'], body: 'Tests use a fresh home per run, so the build never sees old state.' },
  { id: 'l1', title: 'Naming', tags: ['style'], body: 'Call signs are lowercase letters, digits and hyphens.' },
];
const query = ref('build');
const words = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
const results = computed(() => {
  const q = words(query.value);
  if (!q.length) return ENTRIES;
  return ENTRIES.map((e) => {
    const head = [...words(e.title), ...e.tags];
    const body = words(e.body);
    const score = q.reduce((s, w) => s + 3 * head.filter((x) => x === w).length + body.filter((x) => x === w).length, 0);
    return { ...e, score };
  })
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score);
});

// ---- Livery: the same switch as the top bar key ----
const look = ref('instrument');
let watcher: MutationObserver | undefined;
onMounted(() => {
  const read = (): void => void (look.value = document.documentElement.dataset.livery ?? 'instrument');
  read();
  watcher = new MutationObserver(read);
  watcher.observe(document.documentElement, { attributes: true, attributeFilter: ['data-livery'] });
});
onBeforeUnmount(() => watcher?.disconnect());
function wear(slug: string): void {
  const l = BUILTIN_LIVERIES.find((x) => x.slug === slug);
  if (!l) return;
  document.documentElement.dataset.livery = slug;
  document.documentElement.classList.toggle('dark', schemeOf(l.tokens) === 'dark');
  try {
    localStorage.setItem('gonogo.docs.livery', slug);
  } catch {
    // storage blocked: the livery holds for this visit only
  }
}

const ENGINES = [
  { name: 'Claude Code', bin: 'claude', checked: 'tested: real runs' },
  { name: 'Gemini CLI', bin: 'gemini', checked: 'not run: gemini --help and source' },
  { name: 'Antigravity CLI', bin: 'agy', checked: 'not run: agy --help' },
  { name: 'Codex', bin: 'codex', checked: 'not run: vendor docs only' },
  { name: 'opencode', bin: 'opencode', checked: 'partly: real room' },
  { name: 'Kimi CLI', bin: 'kimi', checked: 'not run: vendor docs only' },
  { name: 'Copilot CLI', bin: 'copilot', checked: 'not run: vendor docs only' },
  { name: 'pi', bin: 'pi', checked: 'partly: real room' },
  { name: 'Qwen Code', bin: 'qwen', checked: 'not run: vendor docs only' },
  { name: 'Grok CLI', bin: 'grok', checked: 'not run: vendor docs only' },
  { name: 'Crush', bin: 'crush', checked: 'not run: vendor docs only' },
  { name: 'Cursor Agent', bin: 'cursor-agent', checked: 'not run: vendor docs only' },
];

const PLAN = [
  { col: 'Todo', cards: [{ id: 't5', who: 'RETRO', kind: 'idle', title: 'Write the release notes' }] },
  { col: 'Doing', cards: [{ id: 't3', who: 'FIDO', kind: 'working', title: 'Split the room view' }] },
  { col: 'Review', cards: [{ id: 't2', who: 'GUIDO', kind: 'idle', title: 'Phone bar keys' }] },
  { col: 'Blocked', cards: [{ id: 't4', who: 'EECOM', kind: 'needs', title: 'Needs a Docker host' }] },
  { col: 'Done', cards: [{ id: 't1', who: 'FLIGHT', kind: 'idle', title: 'Plan the week' }] },
];

const SMALL = [
  { label: 'Uplink', href: '/features/uplink', text: 'A webhook address. Each signed post reaches an agent as a message from you, through the same path as the Brief box.' },
  { label: 'Downlink', href: '/features/downlink', text: 'Your inbox: what agents send you, Redline trips, poll results. Read state lives on the server, so phone and desk agree.' },
  { label: 'Payload', href: '/features/payload', text: 'MCP servers and skills for one agent, on top of the gonogo tools.' },
  { label: 'Relay', href: '/features/relay', text: 'Slack, GitHub, Linear and Telegram come in as uplinks; replies go out to Slack or Telegram. Not yet tried against the real services.' },
  { label: 'Max Q', href: ROOM, text: 'A cap on how many agents work at once. Mail to an idle agent waits until a slot frees; yours never waits.' },
];
</script>

<template>
  <div class="lp">
    <!-- hero -->
    <section class="lp-hero lp-wrap">
      <div class="lp-hero-copy">
        <p class="label">Mission control for coding agents</p>
        <h1 class="disp lp-h1">Your agents have the consoles. You have the call.</h1>
        <p class="lp-pitch">
          <dfn>go / no-go</dfn>: in mission control, the roll call before a launch, where each console answers "go" or "no-go".
          Here the agents work the consoles, and the call is yours.
        </p>
        <div class="lp-actions">
          <a class="btn" data-kind="primary" data-size="big" href="/guide/getting-started">Get started</a>
          <a class="btn" data-size="big" href="https://github.com/ulm0/gonogo">GitHub</a>
        </div>
        <ul class="lp-install" aria-label="Install">
          <li v-for="line in INSTALL" :key="line" class="lcd">
            <code>{{ line }}</code>
            <button type="button" class="btn" data-kind="quiet" @click="copy(line)">Copy<span class="visually-hidden"> {{ line }}</span></button>
          </li>
        </ul>
        <p class="lp-status" role="status">{{ copied }}</p>
      </div>
      <RoomMock />
    </section>

    <!-- T-minus -->
    <section class="lp-feature lp-wrap" aria-labelledby="lp-tminus">
      <div class="lp-copy">
        <p class="label">T-minus</p>
        <h2 id="lp-tminus" class="disp">Poll the room before you fly.</h2>
        <p>
          Start a go/no-go poll and every running agent answers with a vote and one sentence of reason. The first no-go holds the poll and shows
          who and why. When all say go, FLIGHT hears about it. A stopped agent counts as no-go.
        </p>
        <a class="lp-more" :href="ROOM">T-minus in The room</a>
      </div>
      <div class="flood lp-visual" :data-tone="poll.tone ?? 'lit'">
        <div class="lp-row">
          <span class="label">T-minus · go/no-go poll</span>
          <button type="button" class="btn" @click="startPoll">{{ polling ? 'Clear' : 'Start poll' }}</button>
        </div>
        <p class="disp lp-word" aria-live="polite">{{ poll.word }}</p>
        <p class="lp-note">{{ poll.note }}</p>
        <ul v-if="polling" class="lp-votes">
          <li v-for="n in POLLED" :key="n">
            <span class="legend">{{ n }}</span>
            <span class="lp-row-keys" role="group" :aria-label="`${n} votes`">
              <button type="button" class="btn" :aria-pressed="votes[n] === 'go'" @click="votes = { ...votes, [n]: 'go' }">Go</button>
              <button type="button" class="btn" data-kind="danger" :aria-pressed="votes[n] === 'no-go'" @click="votes = { ...votes, [n]: 'no-go' }">No-go</button>
            </span>
          </li>
        </ul>
      </div>
    </section>

    <!-- Propellant and Redline -->
    <section class="lp-feature lp-wrap lp-flip" aria-labelledby="lp-fuel">
      <div class="lp-copy">
        <p class="label">Propellant · Redline</p>
        <h2 id="lp-fuel" class="disp">A budget with a breaker on it.</h2>
        <p>
          Propellant counts each Claude agent's tokens in rolling windows (5 hours, day, week, month) against the limits you set; the bar turns
          saffron at 80 %. At the limit, Redline stops the agent at the end of its turn and holds its mail until you resume or stop it. Redline
          also trips by itself on a loop, an error storm or a ping-pong between two agents.
        </p>
        <a class="lp-more" href="/features/propellant">Propellant</a>
        <a class="lp-more" href="/features/redline">Redline</a>
      </div>
      <PropellantMock />
    </section>

    <!-- Launch Window -->
    <section class="lp-feature lp-wrap" aria-labelledby="lp-launch">
      <div class="lp-copy">
        <p class="label">Launch Window</p>
        <h2 id="lp-launch" class="disp">The room keeps its own schedule.</h2>
        <p>
          A schedule is a message gonogo sends by itself on a five-field cron rule, as if you typed it into the Brief box, in the time zone of the
          machine that runs it. Send it to FLIGHT or to one console.
        </p>
        <a class="lp-more" href="/features/launch-window">Launch Window</a>
      </div>
      <ul class="module lp-visual lp-list">
        <li><span class="legend">Stand-up</span><span class="chip" data-tone="ink">FLIGHT</span><code>0 9 * * mon-fri</code></li>
        <li><span class="legend">Dependency check</span><span class="chip" data-tone="quiet">RETRO</span><code>30 2 * * sun</code></li>
        <li><span class="legend">Inbox sweep</span><span class="chip" data-tone="quiet">INCO</span><code>*/15 9-17 * * *</code></li>
      </ul>
    </section>

    <!-- Flight Plan -->
    <section class="lp-feature lp-wrap lp-wide" aria-labelledby="lp-plan">
      <div class="lp-copy">
        <p class="label">Flight Plan</p>
        <h2 id="lp-plan" class="disp">One board, for you and the agents.</h2>
        <p>Agents make, take and move tasks with their own tools; you do it from the page. Every change leaves a line of history with who and when.</p>
        <a class="lp-more" href="/features/flight-plan">Flight Plan</a>
      </div>
      <div class="lp-plan">
        <div v-for="c in PLAN" :key="c.col" class="module lp-plan-col">
          <span class="label">{{ c.col }}</span>
          <div v-for="t in c.cards" :key="t.id" class="lp-card">
            <span class="lp-row"><span class="tile-num">{{ t.id }}</span><span class="led" :data-kind="t.kind" data-on="true"></span><span class="legend">{{ t.who }}</span></span>
            <span>{{ t.title }}</span>
          </div>
        </div>
      </div>
    </section>

    <!-- Mission Log -->
    <section class="lp-feature lp-wrap lp-flip" aria-labelledby="lp-log">
      <div class="lp-copy">
        <p class="label">Mission Log</p>
        <h2 id="lp-log" class="disp">A memory the whole room shares.</h2>
        <p>
          Entries with a title, tags and a body, written by you or any agent, ranked by BM25. A word in the title or a tag counts three times one
          in the body. No stemming: <code>builds</code> does not find <code>build</code>. This demo ranks a simpler way.
        </p>
        <a class="lp-more" href="/features/mission-log">Mission Log</a>
      </div>
      <div class="module lp-visual">
        <div class="field">
          <label for="lp-q">Search the log</label>
          <input id="lp-q" v-model="query" class="input" type="search" autocomplete="off" />
          <span class="hint" aria-live="polite">{{ results.length }} {{ results.length === 1 ? 'entry' : 'entries' }}</span>
        </div>
        <ul class="lp-list lp-hits">
          <li v-for="e in results" :key="e.id">
            <span class="lp-row"><span class="tile-num">{{ e.id }}</span><strong>{{ e.title }}</strong></span>
            <span class="lp-note">{{ e.body }}</span>
            <span class="lp-row-keys"><span v-for="t in e.tags" :key="t" class="chip" data-tone="quiet">{{ t }}</span></span>
          </li>
        </ul>
      </div>
    </section>

    <!-- Clean Room -->
    <section class="lp-feature lp-wrap" aria-labelledby="lp-clean">
      <div class="lp-copy">
        <p class="label">Clean Room</p>
        <h2 id="lp-clean" class="disp">A sandbox per agent.</h2>
        <p>
          A Claude Code agent can run in a Docker container that holds a git worktree of the project and its own files, and nothing else of your
          machine. Your <code>~/.claude</code> is not shared. Read the known limits before you rely on it.
        </p>
        <a class="lp-more" href="/features/clean-room">Clean Room</a>
      </div>
      <div class="lp-visual lp-nest" role="img" aria-label="Nested boxes: your machine holds Docker, Docker holds the agent's container, the container holds only the worktree and the agent's folder.">
        <div class="module"><span class="label">Your machine</span>
          <div class="flood" data-tone="lit"><span class="label">Docker</span>
            <div class="module"><span class="label">Container · gonogo-&lt;name&gt;</span>
              <div class="flood" data-tone="go"><span class="label">Worktree · branch gonogo/&lt;name&gt;</span><code>~/.gonogo/cleanroom/&lt;name&gt;</code></div>
              <div class="flood" data-tone="lit"><span class="label">Agent folder</span><code>~/.gonogo/agents/&lt;name&gt;</code></div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Docking -->
    <section class="lp-feature lp-wrap lp-flip" aria-labelledby="lp-dock">
      <div class="lp-copy">
        <p class="label">Docking</p>
        <h2 id="lp-dock" class="disp">Two stations, one conversation.</h2>
        <p>
          Dock this gonogo to another one: their agents message each other and a task can be handed to the other board. A pairing code is shown
          once, works once, for 15 minutes, and never carries the secret. Only tried between two servers on one machine so far.
        </p>
        <a class="lp-more" href="/features/docking">Docking</a>
      </div>
      <div class="lp-visual lp-dock" role="img" aria-label="Two docked stations, each with its consoles, linked to the other.">
        <div class="module lp-station">
          <span class="label">Station · desk</span>
          <span class="lamp" data-link="up"><span class="led" data-on="true"></span>DOCKED</span>
          <span class="lp-row-keys"><span class="chip" data-tone="quiet">FLIGHT</span><span class="chip" data-tone="quiet">FIDO</span></span>
        </div>
        <span class="lp-link" aria-hidden="true"></span>
        <div class="module lp-station">
          <span class="label">Station · lab</span>
          <span class="lamp" data-link="up"><span class="led" data-on="true"></span>DOCKED</span>
          <span class="lp-row-keys"><span class="chip" data-tone="quiet">FLIGHT</span><span class="chip" data-tone="quiet">GUIDO</span></span>
        </div>
      </div>
    </section>

    <!-- Engine Bay -->
    <section class="lp-feature lp-wrap lp-wide" aria-labelledby="lp-engine">
      <div class="lp-copy">
        <p class="label">Engine Bay</p>
        <h2 id="lp-engine" class="disp">Bring your own engine.</h2>
        <p>
          Each agent runs one CLI, picked when you hire it. You sign in to each CLI yourself. How far each one was checked is written down: Claude Code is used daily to build gonogo itself; pi and opencode
          have run as agents in that room; the others have not had real runs.
        </p>
        <a class="lp-more" href="/features/engine-bay">Engine Bay</a>
      </div>
      <ul class="lp-engines">
        <li v-for="e in ENGINES" :key="e.bin" class="module">
          <span class="legend">{{ e.name }}</span>
          <code>{{ e.bin }}</code>
          <span class="chip" :data-tone="e.checked.startsWith('tested') ? 'go' : 'quiet'">{{ e.checked }}</span>
        </li>
      </ul>
    </section>

    <!-- Livery -->
    <section class="lp-feature lp-wrap" aria-labelledby="lp-livery">
      <div class="lp-copy">
        <p class="label">Livery</p>
        <h2 id="lp-livery" class="disp">Repaint the room.</h2>
        <p>
          A livery is a value for each colour token. Four ship, and an agent can design another. One is refused unless every text reaches 4.5:1
          on the surfaces it sits on. These keys repaint this page.
        </p>
        <a class="lp-more" href="/features/livery">Livery</a>
      </div>
      <div class="module lp-visual lp-liveries" role="group" aria-label="Livery">
        <button v-for="l in BUILTIN_LIVERIES" :key="l.slug" type="button" class="tile" :aria-pressed="look === l.slug" @click="wear(l.slug)">
          <span class="lp-swatch" aria-hidden="true">
            <span :style="{ background: l.tokens['--body'] }"></span><span :style="{ background: l.tokens['--lcd'] }"></span><span
              :style="{ background: l.tokens['--work'] }"
            ></span><span :style="{ background: l.tokens['--you'] }"></span>
          </span>
          <span class="tile-legend">{{ l.name }}</span>
          <span class="tile-state">{{ l.description }}</span>
        </button>
      </div>
    </section>

    <!-- the small ones -->
    <section class="lp-wrap lp-small" aria-labelledby="lp-more-h">
      <h2 id="lp-more-h" class="label">Also on the board</h2>
      <ul>
        <li v-for="s in SMALL" :key="s.label" class="module">
          <a :href="s.href" class="legend">{{ s.label }}</a>
          <p>{{ s.text }}</p>
        </li>
      </ul>
    </section>

    <!-- closing poll -->
    <section class="lp-wrap" aria-labelledby="lp-final">
      <div class="flood lp-final" data-tone="amber">
        <span class="label">T-minus · go/no-go poll · Director</span>
        <h2 id="lp-final" class="disp lp-word">Director, are you go?</h2>
        <p class="lp-note">Node 24, macOS or Linux, and one agent CLI that has run once and is signed in (Claude Code, Codex, Gemini CLI, Antigravity, opencode, pi, ...). Or Docker. New here? <a href="/guide/glossary">The words you will meet</a>.</p>
        <div class="lp-actions">
          <a class="btn" data-kind="primary" data-size="big" href="/guide/getting-started">Go: get started</a>
          <a class="btn" data-size="big" href="/reference/not-verified">Hold: read what is not verified</a>
        </div>
      </div>
    </section>

    <footer class="lp-wrap lp-foot">
      <a href="/guide/getting-started">Docs</a>
      <a href="https://github.com/ulm0/gonogo">GitHub</a>
      <a href="https://github.com/ulm0/gonogo/pkgs/container/gonogo">ghcr.io/ulm0/gonogo</a>
      <a href="https://www.npmjs.com/package/@ulm0/gonogo">npm @ulm0/gonogo</a>
      <a href="https://github.com/ulm0/gonogo/blob/main/LICENSE">MIT</a>
    </footer>
  </div>
</template>
