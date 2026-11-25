/*
 * CLIENT ERROR (src/client/App.tsx): when the server answers but the page throws while it takes in the state, the page says so with the error,
 * not LOSS OF SIGNAL. The state is the real server's, with one agent made null so that the page's own applyServerFrame throws. Desktop and
 * phone: the screen must render, fit and copy its details. Runs the built server with the stand-in agent, like smoke.spec.ts.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

let server: ChildProcess;
let home = '';
let link = '';
let output = '';

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

test.beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'gn-cerr-'));
  const port = await freePort();
  server = spawn(process.execPath, ['bin/gonogo.js', '--port', String(port), '--no-update-check'], {
    env: { ...process.env, GONOGO_HOME: home, GONOGO_AGENT_CMD: `${process.execPath} test/fake-claude.mjs` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  server.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const end = Date.now() + 60_000;
  // no login yet: the printed address with the key opens the room
  for (;;) {
    const found = /gonogo ready: (http:\/\/127\.0\.0\.1:\d+\/#token=[0-9a-f]+)/.exec(output);
    if (found) {
      link = found[1] as string;
      break;
    }
    if (Date.now() > end) throw new Error(`the server did not come up:\n${output}`);
    await new Promise((r) => setTimeout(r, 100));
  }
});

test.afterAll(async () => {
  server?.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
  if (server && server.exitCode === null) server.kill('SIGKILL');
  await rm(home, { recursive: true, force: true });
});

for (const device of [
  { name: 'desktop', viewport: { width: 1280, height: 800 }, isMobile: false },
  { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true },
]) {
  test(`a page that throws on the state shows CLIENT ERROR, not LOSS OF SIGNAL (${device.name})`, async ({ browser, browserName }) => {
    const context = await browser.newContext({ viewport: device.viewport, isMobile: device.isMobile, hasTouch: device.isMobile });
    // only Chromium lets a test grant the clipboard; elsewhere the copy is not checked
    if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    // the real state, with an agent that is null: it passes the shape check, and the page's own code throws on it
    await page.route(/\/api\/state$/, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { agents: unknown[] };
      await route.fulfill({ response, json: { ...body, agents: [null, ...body.agents] } });
    });
    await page.goto(link);

    await expect(page.getByRole('alert')).toContainText('CLIENT ERROR:', { timeout: 15_000 });
    await expect(page.getByText('LOSS OF SIGNAL')).toHaveCount(0);
    const copy = page.getByRole('button', { name: 'Copy details' });
    await expect(copy).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Retry now' })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(errors.some((text) => text.includes('gonogo client error'))).toBe(true);

    if (browserName === 'chromium') {
      await copy.click();
      await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      expect(copied).toMatch(/^CLIENT ERROR: /);
      expect(copied).toMatch(/\ngonogo \d+\.\d+\.\d+/);
      expect(copied).toMatch(/\n\s*at /);
    }
    await page.screenshot({ path: test.info().outputPath(`client-error-${device.name}.png`) });
    await context.close();
  });
}
