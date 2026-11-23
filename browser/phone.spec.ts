/*
 * The phone (t80): at 390 and 360 px wide a room on the list can be tapped and opens, the top bar of a room has no key over another, and the page does not
 * scroll sideways. A key pushed over its neighbour by a bar that was too wide for the phone passed every test: jsdom has no layout. Runs the built server
 * with the stand-in agent, like smoke.spec.ts.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

const PASSWORD = 'phone-test-password-1';
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

test.beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'gn-phone-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['bin/gonogo.js', '--port', String(port), '--no-update-check'], {
    env: { ...process.env, GONOGO_HOME: home, GONOGO_AGENT_CMD: `${process.execPath} test/fake-claude.mjs` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  server.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const end = Date.now() + 60_000;
  while (!(existsSync(join(home, 'setup-token')) && output.includes(String(port)))) {
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

/** A phone: a touch screen of this size, signed in with the account the first test makes. */
async function phone(browser: Browser, width: number, height: number): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.goto(`${base}/setup`);
  if (page.url().includes('/setup')) {
    await page.locator('input[name=token]').fill(readFileSync(join(home, 'setup-token'), 'utf8').trim());
    await page.locator('input[name=password]').fill(PASSWORD);
    await page.locator('form button[type=submit], form input[type=submit]').first().click();
    await page.waitForURL((url) => !url.pathname.startsWith('/setup'));
  } else {
    await page.goto(`${base}/login`);
    await page.locator('input[name=password]').fill(PASSWORD);
    await page.locator('form button[type=submit], form input[type=submit]').first().click();
    // with one room the list is not shown: "/" goes straight into main
    await page.waitForURL((url) => url.pathname === '/' || url.pathname === '/r/main/');
  }
  return page;
}

/** The boxes of what the top bar shows, and the pairs of them that cross. */
async function crossings(page: Page): Promise<{ boxes: number; crossing: string[]; sideways: boolean }> {
  return page.locator('.topbar').evaluate((bar) => {
    const items = [...bar.children].filter((el) => getComputedStyle(el).display !== 'none').map((el) => ({ name: (el.getAttribute('aria-label') ?? el.textContent ?? el.className).trim().slice(0, 24), box: el.getBoundingClientRect() }));
    const crossing: string[] = [];
    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        const a = items[i]!.box;
        const b = items[j]!.box;
        // a pixel of slack for the rounding of the layout
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) crossing.push(`${items[i]!.name} / ${items[j]!.name}`);
      }
    }
    return { boxes: items.length, crossing, sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth };
  });
}

for (const [width, height] of [
  [390, 844],
  [360, 780],
] as const) {
  test(`${width} px: the list opens a room by a tap on its key or its card, and no key of the top bar is over another`, async ({ browser }) => {
    const page = await phone(browser, width, height);
    // the list of rooms (asked for: with one room "/" opens main)
    await page.goto(`${base}/?list`);
    await expect(page.locator('a[href="/r/main/"]').first()).toBeVisible();
    expect(await crossings(page)).toMatchObject({ crossing: [], sideways: false });
    // every key is inside its card (a card cut short let its keys spill over the next block), and the empty-state text stays in its box
    const spill = await page.locator('.rl-card').evaluateAll((cards) =>
      cards.flatMap((card) => {
        const box = card.getBoundingClientRect();
        return [...card.querySelectorAll('a, button, p, .tile-sub')].filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && (r.bottom > box.bottom + 1 || r.right > box.right + 1);
        }).map((el) => `${el.textContent?.slice(0, 20)} leaves its card`);
      }),
    );
    expect(spill).toEqual([]);
    // a tap on the OPEN key
    await page.locator('a[href="/r/main/"]').first().tap();
    await page.waitForURL(`${base}/r/main/`);
    // a room: the bar, the keys, the Rooms key at 44 px
    await expect(page.locator('.topbar')).toBeVisible();
    await expect(page.locator('.lamp')).toHaveAttribute('data-link', 'up', { timeout: 30_000 });
    const room = await crossings(page);
    expect(room.crossing, 'keys over each other in the bar of a room').toEqual([]);
    expect(room.sideways, 'the page scrolls sideways').toBe(false);
    const rooms = page.locator('.topbar a[aria-label="Rooms"]');
    expect((await rooms.boundingBox())?.width).toBeGreaterThanOrEqual(44);
    // the Rooms key goes back to the list, and a tap on the card (its name) opens the room again
    await rooms.tap();
    await page.waitForURL(`${base}/`);
    await page.locator('.rl-card .rl-name').first().tap();
    await page.waitForURL(`${base}/r/main/`);
    await page.context().close();
  });
}
