import { defineConfig } from 'vitepress';

// The site is built from docs/ in place; the design notes there (specs, contract, backlog, facts) stay out of it.
export default defineConfig({
  title: 'gonogo',
  description: 'Self-hosted mission control for AI coding agents, in a browser tab.',
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
  vite: { publicDir: 'brand' },
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    ['link', { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' }],
  ],
  lastUpdated: false,
  themeConfig: {
    logo: { light: '/mark.svg', dark: '/mark-dark.svg', alt: '' },
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
          { text: 'Running in Docker', link: '/guide/docker' },
          { text: 'Exposing it safely (HTTPS)', link: '/https' },
        ],
      },
      {
        text: 'Features',
        items: [
          { text: 'Engine Bay', link: '/features/engine-bay' },
          { text: 'Payload', link: '/features/payload' },
          { text: 'Clean Room', link: '/features/clean-room' },
          { text: 'Redline', link: '/features/redline' },
          { text: 'Propellant', link: '/features/propellant' },
          { text: 'Launch Window', link: '/features/launch-window' },
          { text: 'Uplink', link: '/features/uplink' },
          { text: 'Relay', link: '/features/relay' },
          { text: 'Flight Plan', link: '/features/flight-plan' },
          { text: 'Downlink', link: '/features/downlink' },
          { text: 'Mission Log', link: '/features/mission-log' },
          { text: 'Livery', link: '/features/livery' },
          { text: 'Docking', link: '/features/docking' },
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
