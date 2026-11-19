/*
 * The real-browser smoke. Three 0.5.x bugs passed every test and broke in a real browser: Referrer-Policy no-referrer made forms
 * send `Origin: null`, a lost `}` nested the whole style sheet, and a command was unreachable. Node clients set headers by hand and
 * jsdom has no layout, so this runs the built server with the stand-in agent and drives Chromium through it.
 */
import { createHmac } from 'node:crypto';
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'smoke-test-password-1';
let server: ChildProcess;
let home = '';
let base = '';
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

/** RFC 6238, written again here on purpose: the test must not borrow the code it checks. */
function totp(secret: string, step: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of secret.replace(/=+$/, '')) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const at = (mac[mac.length - 1] as number) & 15;
  const binary = (((mac[at] as number) & 127) << 24) | (((mac[at + 1] as number) & 255) << 16) | (((mac[at + 2] as number) & 255) << 8) | ((mac[at + 3] as number) & 255);
  return String(binary % 1_000_000).padStart(6, '0');
}

async function waitFor<T>(what: string, read: () => T | undefined | false, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const got = read();
    if (got) return got;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${output.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test.beforeAll(async () => {
  // a short path: the server's unix socket lives under the home, and a socket path is limited to about 100 bytes
  home = await mkdtemp(join(tmpdir(), 'gn-smoke-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['bin/gonogo.js', '--port', String(port), '--no-update-check'], {
    env: { ...process.env, GONOGO_HOME: home, GONOGO_AGENT_CMD: `${process.execPath} test/fake-claude.mjs` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  server.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  await waitFor('the server and its setup token', () => existsSync(join(home, 'setup-token')) && output.includes(String(port)));
});

test.afterAll(async () => {
  server?.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
  if (server && server.exitCode === null) server.kill('SIGKILL');
  await rm(home, { recursive: true, force: true });
});

test('setup, login with a second factor, styles, a room with a live link and a console, the service worker', async ({ page }) => {
  // every console error and every page error fails the run: a CSP block ("Refused to ...") is a console error
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  const expectClean = (where: string): void => expect(problems, `console errors on ${where}`).toEqual([]);

  // 1. setup with the printed token: a real form POST, so the browser sends its own Origin
  await page.goto(`${base}/setup`);
  await page.locator('input[name=token]').fill(readFileSync(join(home, 'setup-token'), 'utf8').trim());
  await page.locator('input[name=password]').fill(PASSWORD);
  await page.locator('form button[type=submit], form input[type=submit]').first().click();
  await page.waitForURL((url) => !url.pathname.startsWith('/setup'));
  expect(await page.locator('.topbar').count()).toBeGreaterThan(0);

  // the second factor: the page's own fetch (cookie and Origin as the browser sends them), then log out
  const secret = await page.evaluate(async () => ((await (await fetch('/api/auth/mfa/begin', { method: 'POST' })).json()) as { secret: string }).secret);
  const step = Math.floor(Date.now() / 30_000);
  const enabled = await page.evaluate(async (code) => (await fetch('/api/auth/mfa/enable', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) })).status, totp(secret, step));
  expect(enabled).toBe(200);
  await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST' }));

  // 2. the login form, then the code (the next step: a code works once and the enrolment used this one), then the list
  await page.goto(`${base}/login`);
  expectClean('/login');
  await page.locator('input[name=password]').fill(PASSWORD);
  await page.locator('form button[type=submit], form input[type=submit]').first().click();
  await page.locator('input[name=code]').fill(totp(secret, step + 1));
  await page.locator('form button[type=submit], form input[type=submit]').first().click();
  await page.waitForURL(`${base}/`);
  await expect(page.locator('a[href^="/r/main/"]').first()).toBeVisible();
  expectClean('/');

  // 3. the style sheet is applied and the fonts came
  await page.goto(`${base}/r/main/`);
  await expect(page.locator('.topbar')).toBeVisible();
  const topbar = await page.locator('.topbar').evaluate((el) => ({ display: getComputedStyle(el).display, height: el.getBoundingClientRect().height }));
  expect(topbar.display).toBe('flex');
  expect(topbar.height).toBeGreaterThan(40);
  expect(topbar.height).toBeLessThan(200);
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => [...document.fonts].some((face) => face.family.includes('Geist') && face.status === 'loaded'))).toBe(true);

  // 4. the room: the socket is up and an agent console draws text
  await expect(page.locator('.lamp')).toHaveAttribute('data-link', 'up', { timeout: 30_000 });
  await expectConsoleText(page);
  expectClean('/r/main/');

  // 5. the service worker registers and a reload still shows the page
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect(page.locator('.topbar')).toBeVisible();
  expectClean('after the reload');
});

/** The boss is started with the room: its console is an xterm that has drawn something. */
async function expectConsoleText(page: Page): Promise<void> {
  await expect(async () => {
    const text = await page.locator('.xterm-rows').first().innerText();
    expect(text.trim().length).toBeGreaterThan(0);
  }).toPass({ timeout: 30_000 });
}
