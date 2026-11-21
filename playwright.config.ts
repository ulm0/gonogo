import { defineConfig } from '@playwright/test';

// The real-browser smoke (browser/smoke.spec.ts). It starts the built gonogo (`pnpm build` first) itself.
// PW_BROWSERS picks the engines, comma separated; Chromium alone by default (the release gate). browsers.yml runs firefox and webkit.
const engines = (process.env.PW_BROWSERS ?? 'chromium').split(',').map((name) => name.trim());

export default defineConfig({
  testDir: 'browser',
  timeout: 120_000,
  // one retry in CI: this gates a release, and a single browser start failure must not stop a publish
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list']],
  outputDir: 'browser-results',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: engines.map((name) => ({ name, use: { browserName: name as 'chromium' | 'firefox' | 'webkit', ...(name === 'webkit' ? { serviceWorkers: 'block' as const } : {}) } })),
});
