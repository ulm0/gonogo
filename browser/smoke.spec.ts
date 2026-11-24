/*
 * The real-browser smoke. Three 0.5.x bugs passed every test and broke in a real browser: Referrer-Policy no-referrer made forms
 * send `Origin: null`, a lost `}` nested the whole style sheet, and a command was unreachable. Node clients set headers by hand and
 * jsdom has no layout, so this runs the built server with the stand-in agent and drives Chromium through it.
 */
import { createHmac } from 'node:crypto';
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

test('setup, login with a second factor, styles, a room with a live link and a console, the service worker', async ({ page, request }) => {
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
  // with one room "/" goes straight into it (main); the list is asked for
  await page.waitForURL((url) => url.pathname === '/' || url.pathname === '/r/main/');
  await expect(page.locator('.topbar')).toBeVisible();
  expectClean('/');
  await page.goto(`${base}/?list`);
  await expect(page.locator('a[href^="/r/main/"]').first()).toBeVisible();
  expectClean('the list of rooms');

  // 3. the style sheet is applied and the fonts came
  await page.goto(`${base}/r/main/`);
  await expect(page.locator('.topbar')).toBeVisible();
  const topbar = await page.locator('.topbar').evaluate((el) => ({ display: getComputedStyle(el).display, height: el.getBoundingClientRect().height }));
  expect(topbar.display).toBe('flex');
  expect(topbar.height).toBeGreaterThan(40);
  expect(topbar.height).toBeLessThan(200);
  // rules far down the sheets: a lost `}` nests every later rule under the broken one, and these lose their selectors
  const lamp = await page.locator('.lamp').evaluate((el) => ({ display: getComputedStyle(el).display, size: getComputedStyle(el).fontSize }));
  expect(lamp).toEqual({ display: 'flex', size: '10.5px' });
  expect(await page.locator('.mark-name').evaluate((el) => getComputedStyle(el).height)).toBe('26px');
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => [...document.fonts].some((face) => face.family.includes('Geist') && face.status === 'loaded'))).toBe(true);

  // 4. the room: the socket is up and an agent console draws text
  await expect(page.locator('.lamp')).toHaveAttribute('data-link', 'up', { timeout: 30_000 });
  await expectConsoleText(page);
  expectClean('/r/main/');

  // 5. the service worker registers and a reload still shows the page
  // WebKit under Playwright hangs the page once a service worker is installed (the project blocks them, see playwright.config.ts)
  if (test.info().project.use.serviceWorkers !== 'block') await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect(page.locator('.topbar')).toBeVisible();
  expectClean('after the reload');

  // 6. the headers and the cookie the browser really got (a Node client sees them too, but only a browser enforces them)
  await test.step('cookie flags and CSP headers', async () => {
    const cookie = (await page.context().cookies()).find((c) => c.name === 'gonogo-session');
    expect(cookie, 'the session cookie of a loopback name').toBeDefined();
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/', secure: false });
    expect(await page.evaluate(() => document.cookie), 'script cannot read the session cookie').not.toContain('gonogo-session');
    // the login page, asked without the cookie
    const login = await request.get(`${base}/login`);
    expect(login.status()).toBe(200);
    expect(login.headers()['content-security-policy']).toMatch(/default-src 'none'.*frame-ancestors 'none'/);
    expect(login.headers()['referrer-policy']).toBe('same-origin');
    // the built client of a room, asked with it
    const room = await page.request.get(`${base}/r/main/`);
    expect(room.status()).toBe(200);
    expect(room.headers()['content-security-policy']).toMatch(/script-src 'self'.*frame-ancestors 'none'/);
    expect(room.headers()['referrer-policy']).toBe('same-origin');
  });

  // Enter in a box that sends: Shift+Enter is a new line and sends nothing (the Brief box and the reply boxes share the rule)
  await test.step('shift+enter is a new line', async () => {
    const box = page.locator('.brief-input');
    // the box is off while FLIGHT is stopped (a room without a boss): then there is nothing to type in
    if (!(await box.isEnabled({ timeout: 5000 }).catch(() => false))) return;
    await box.fill('');
    await box.pressSequentially('one');
    await box.press('Shift+Enter');
    await box.pressSequentially('two');
    await expect(box).toHaveValue('one\ntwo');
    await box.fill('');
  });

  // a paste over a message (20,000 characters) is not cut by the box: it is sent as a file in FLIGHT's folder, and the box says so (shared/longtext.ts)
  await test.step('a long text goes as a file', async () => {
    const box = page.locator('.brief-input');
    if (!(await box.isEnabled({ timeout: 5000 }).catch(() => false))) return;
    const text = `A log from the other session\n${'2026-11-24 18:30:01 INFO a line of the log\n'.repeat(1000)}`;
    await box.fill(text);
    await expect(box).toHaveValue(text);
    await expect(page.locator('.brief-long')).toContainText('Long text: 43,028 characters') // the box counts the text it sends: trimmed, so without the last newline;
    await box.press('Enter');
    await expect(page.locator('.brief-note[role=status]')).toContainText('saved as a file', { timeout: 15_000 });
    await expect(box).toHaveValue('');
    const saved = readdirSync(join(home, 'rooms', 'main', 'agents'), { recursive: true, encoding: 'utf8' }).filter((p) => p.endsWith('-long-text.txt'));
    expect(saved).toHaveLength(1);
    expect(readFileSync(join(home, 'rooms', 'main', 'agents', saved[0] as string), 'utf8')).toBe(text);
    // over the most, Send does nothing and the line says why
    await box.fill('x'.repeat(1_000_001));
    await expect(page.locator('.brief-long.error')).toContainText('Too long to send: 1,000,001 characters');
    await box.fill('');
    expectClean('the long text');
  });

  // 7. Flight Rules: the blocks the audit listed, drawn from the built client
  await test.step('flight rules blocks', async () => {
    // the switch of Knowledge anchors is off in a new room: turn it on, as the owner would in the Features block
    const on = await page.request.put(`${base}/api/features`, { headers: { origin: base }, data: { off: [], expect: [], confirm: true } });
    expect(on.status(), await on.text()).toBe(200);
    await page.goto(`${base}/r/main/`);
    await page.locator('.topbar').getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('group', { name: 'More' }).getByRole('button', { name: 'Flight Rules', exact: true }).click();
    // the groups are an accordion (one open) and each setting is a row that opens on Edit: open a group and all its rows, then look for the blocks it holds
    const open = async (group: RegExp): Promise<void> => {
      const key = page.locator('.lay-group-nav a', { hasText: group });
      await key.click();
      await expect(key).toHaveAttribute('aria-current', 'true');
      await expect(page.locator('.lay-group-body').first()).toBeVisible();
      await expect(page.locator('details.lay-row').first()).toBeVisible();
      await page.locator('details.lay-row').evaluateAll((rows) => rows.forEach((row) => ((row as HTMLDetailsElement).open = true)));
    };
    await open(/^Room/);
    for (const heading of ['ROOM RULES', 'CLOSING CHECKLIST TEMPLATE']) await expect(page.getByRole('heading', { name: heading, exact: true }), heading).toBeVisible();
    await open(/^Agents/);
    await expect(page.getByRole('heading', { name: 'SKILLS', exact: true }), 'SKILLS').toBeVisible();
    await open(/^Knowledge/);
    await expect(page.getByRole('heading', { name: 'KNOWLEDGE', exact: true }), 'KNOWLEDGE').toBeVisible();
    // the switch is on: the block says nothing about being off, and shows no error
    const knowledge = page.locator('section', { has: page.getByRole('heading', { name: 'KNOWLEDGE', exact: true }) });
    await expect(knowledge.getByText('Turn on Knowledge in the Features block')).toHaveCount(0);
    expect(await knowledge.getByRole('alert').allTextContents(), 'the Knowledge block shows an error').toEqual([]);
    expectClean('Flight Rules');
  });

  // 7b. Ctrl+K right after the room has loaded opens the Patch Panel: the boss's terminal must not have taken the keyboard (xterm keeps Ctrl+K for itself)
  await test.step('ctrl+k opens the patch panel right after load', async () => {
    await page.goto(`${base}/r/main/`);
    await expectConsoleText(page);
    // give the terminal the time it would have taken the focus in
    await page.waitForTimeout(1500);
    await page.keyboard.press('Control+k');
    await expect(page.locator('.patch-input')).toBeVisible({ timeout: 5000 });
    await page.keyboard.press('Escape');
  });

  // 8. a mission and its closing checklist
  await test.step('mission closing checklist', async () => {
    const made = await page.request.post(`${base}/api/missions`, { headers: { origin: base }, data: { name: 'Smoke mission' } });
    expect(made.status(), await made.text()).toBe(201);
    await page.goto(`${base}/r/main/`);
    await page.locator('.topbar').getByRole('button', { name: 'Work', exact: true }).click();
    await page.getByRole('group', { name: 'Work' }).getByRole('button', { name: 'Missions', exact: true }).click();
    // the row opens the mission; its closing checklist is in it
    await page.getByText('Smoke mission').first().click();
    await expect(page.locator('[aria-label^="Closing checklist of"]').first()).toBeVisible();
    expectClean('Missions');
  });
});

/** The boss is started with the room: its console is an xterm that has drawn something. */
async function expectConsoleText(page: Page): Promise<void> {
  await expect(async () => {
    const text = await page.locator('.xterm-rows').first().innerText();
    expect(text.trim().length).toBeGreaterThan(0);
  }).toPass({ timeout: 30_000 });
}
