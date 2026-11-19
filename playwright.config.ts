import { defineConfig } from '@playwright/test';

// The real-browser smoke (browser/smoke.spec.ts). Chromium only; it starts the built gonogo (`pnpm build` first) itself.
export default defineConfig({
  testDir: 'browser',
  timeout: 120_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  outputDir: 'browser-results',
  use: { browserName: 'chromium', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
