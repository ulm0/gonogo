import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitepress';
import { BUILTIN_LIVERIES, schemeOf } from '../src/shared/livery.ts';
import { ogHead } from './og.ts';

// The livery of the site, before the first paint: the one chosen here before (theme/LiverySwitch.vue keeps it), else the one
// that matches the system's light or dark. `dark` is the class VitePress reads (logo, code), set for a livery with a dark body.
const liveries = BUILTIN_LIVERIES.map((l) => l.slug);
const darkLiveries = BUILTIN_LIVERIES.filter((l) => schemeOf(l.tokens) === 'dark').map((l) => l.slug);
const liveryScript = `(() => {
  const all = ${JSON.stringify(liveries)}, dark = ${JSON.stringify(darkLiveries)}, d = document.documentElement;
  const system = matchMedia('(prefers-color-scheme: dark)');
  const saved = () => { try { const s = localStorage.getItem('gonogo.docs.livery'); return all.includes(s) ? s : null; } catch { return null; } };
  const put = (s) => { d.dataset.livery = s; d.classList.toggle('dark', dark.includes(s)); };
  put(saved() ?? (system.matches ? 'night-shift' : 'instrument'));
  system.addEventListener('change', (e) => { if (!saved()) put(e.matches ? 'night-shift' : 'instrument'); });
})();`;

// The site is built from docs/ in place; the design notes there (specs, contract, backlog, facts) stay out of it.
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

const SITE_DESCRIPTION = 'Self-hosted mission control for AI coding agents, in a browser tab.';

export default defineConfig({
  title: 'gonogo',
  description: SITE_DESCRIPTION,
  base: '/',
  srcDir: 'docs',
  srcExclude: [
    '*-spec.md',
    'contract.md',
    'backlog.md',
    'scaffold-notes.md',
    'themes.md',
    'design/**',
    'facts/**',
    'superpowers/**',
  ],
  // The logo and the favicon are served from docs/brand as they are, not copied.
  vite: { publicDir: 'brand', define: { __GONOGO_VERSION__: JSON.stringify(version) } },
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    ['link', { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' }],
    ['script', {}, liveryScript],
  ],
  // Link previews (WhatsApp, LinkedIn, Slack): Open Graph and Twitter tags with absolute addresses, on every page (og.ts).
  transformHead: ({ pageData }) => ogHead(pageData, SITE_DESCRIPTION),
  // The livery key (theme/LiverySwitch.vue) replaces the light/dark switch.
  appearance: false,
  // One dark theme: every code block is an LCD, a dark screen in every livery. Its high-contrast colours stay above 6:1 on all four.
  markdown: {
    theme: 'github-dark-high-contrast',
    // %VERSION% in a page is this build's package.json version (a command that names the exact release: docs/guide/getting-started.md).
    config: (md) => {
      md.core.ruler.push('gonogo-version', (state) => {
        for (const t of state.tokens) {
          if (t.type === 'fence') t.content = t.content.replaceAll('%VERSION%', version);
          for (const c of t.children ?? []) c.content = c.content.replaceAll('%VERSION%', version);
        }
      });
    },
  },
  lastUpdated: false,
  themeConfig: {
    // The app's top bar: the two keys and the dot-matrix word, no text title (custom.css turns it on a dark livery, as the app does).
    logo: { src: '/lockup.svg', alt: 'gonogo' },
    siteTitle: false,
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Features', link: '/features/engine-bay' },
      { text: 'Reference', link: '/reference/configuration' },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting started', link: '/guide/getting-started' },
          { text: 'The room', link: '/guide/the-room' },
          { text: 'Glossary', link: '/guide/glossary' },
          { text: 'Running in Docker', link: '/guide/docker' },
          { text: 'Run it as a service', link: '/guide/service' },
          { text: 'Exposing it safely (HTTPS)', link: '/https' },
          { text: 'Expose: print the config, then check', link: '/features/expose' },
          { text: 'Expose: Tailscale Serve', link: '/expose/tailscale' },
          { text: 'Expose: Cloudflare tunnel', link: '/expose/cloudflare' },
          { text: 'Expose: Caddy', link: '/expose/caddy' },
          { text: 'Expose: Tailscale Funnel', link: '/expose/funnel' },
          { text: 'Expose: ngrok', link: '/expose/ngrok' },
        ],
      },
      {
        text: 'Features',
        items: [
          { text: 'Engine Bay', link: '/features/engine-bay' },
          { text: 'Payload', link: '/features/payload' },
          { text: 'Registry', link: '/features/registry' },
          { text: 'Room keys', link: '/features/room-keys' },
          { text: 'Knowledge', link: '/features/knowledge' },
          { text: 'Search by meaning', link: '/features/semantic-search' },
          { text: 'Clean Room', link: '/features/clean-room' },
          { text: 'Worktrees', link: '/features/worktrees' },
          { text: 'Feature toggles', link: '/features/features' },
          { text: 'Subagents', link: '/features/subagents' },
          { text: 'Login', link: '/features/login' },
          { text: 'Co-author line', link: '/features/coauthor' },
          { text: 'Room rules and AGENTS.md', link: '/features/door' },
          { text: 'Tool permissions', link: '/features/permissions' },
          { text: 'Start again after a restart', link: '/features/autostart' },
          { text: 'Redline', link: '/features/redline' },
          { text: 'Static fire', link: '/features/static-fire' },
          { text: 'Hold', link: '/features/hold' },
          { text: 'Propellant', link: '/features/propellant' },
          { text: 'Cost', link: '/features/cost' },
          { text: 'Plan quota', link: '/features/quota' },
          { text: 'Telemetry', link: '/features/telemetry' },
          { text: 'Launch Window', link: '/features/launch-window' },
          { text: 'History of triggers', link: '/features/triggers' },
          { text: 'Uplink', link: '/features/uplink' },
          { text: 'Relay', link: '/features/relay' },
          { text: 'Phone approvals', link: '/features/phone-approvals' },
          { text: 'Live reload', link: '/features/live-reload' },
          { text: 'Update from the page', link: '/features/update' },
          { text: 'Rooms', link: '/features/rooms' },
          { text: 'A GitHub login per room', link: '/features/github-login' },
          { text: 'Flight Plan', link: '/features/flight-plan' },
          { text: 'Missions', link: '/features/missions' },
          { text: 'Room editor', link: '/features/room-editor' },
          { text: 'Comms', link: '/features/comms' },
          { text: 'Downlink', link: '/features/downlink' },
          { text: 'Party Line', link: '/features/party-line' },
          { text: 'Notifications', link: '/features/notifications' },
          { text: 'The phone app', link: '/features/mobile' },
          { text: 'Mission Log', link: '/features/mission-log' },
          { text: 'Star Chart', link: '/features/star-chart' },
          { text: 'Knowledge', link: '/features/knowledge' },
          { text: 'Knowledge anchors', link: '/features/knowledge-anchors' },
          { text: 'Mass Budget', link: '/features/mass-budget' },
          { text: 'Plot Board', link: '/features/plot-board' },
          { text: 'Black Box', link: '/features/black-box' },
          { text: 'Livery', link: '/features/livery' },
          { text: 'Docking', link: '/features/docking' },
          { text: 'Patch Panel', link: '/features/patch-panel' },
          { text: 'Flight Rules', link: '/features/flight-rules' },
          { text: 'Relief', link: '/features/relief' },
          { text: 'Rollout', link: '/features/rollout' },
          { text: 'Hangar', link: '/features/hangar' },
          { text: 'Recorder', link: '/features/recorder' },
          { text: 'Post-Flight Review', link: '/features/review' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Configuration', link: '/reference/configuration' },
          { text: 'Security', link: '/reference/security' },
          { text: 'Troubleshooting', link: '/reference/troubleshooting' },
          { text: 'What was not verified', link: '/reference/not-verified' },
          { text: 'Design system', link: '/design-system' },
          { text: 'Contributing', link: '/contributing' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/ulm0/gonogo' }],
    editLink: { pattern: 'https://github.com/ulm0/gonogo/edit/main/docs/:path' },
    search: { provider: 'local' },
    outline: [2, 3],
    footer: { message: 'MIT License' },
  },
});
