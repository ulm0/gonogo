/*
 * Screenshots of every view, for the UI/UX audit (workflow screens.yml, by hand; not part of the smoke gate and not run by
 * `pnpm exec playwright test` unless SCREENS=1). It starts the built server with the stand-in agent, takes the empty states, seeds a few
 * agents, messages, tasks and log entries, then takes each view at 1280x800 and 390x844 in a light and a dark livery, and the docs site.
 * Best effort on purpose: one view that cannot be reached is written down in the index and the rest go on.
 * Out: screens/<scheme>-<size>/NN-name.png, screens/docs-<scheme>-<size>/..., screens/index.html.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { LINKS } from './linkFixtures.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { duplicates, geometry } from './geometry.js';
import { type BrowserContext, type Page, expect, test } from '@playwright/test';

test.skip(process.env.SCREENS !== '1', 'screenshots are taken by the screens workflow (SCREENS=1)');

const OUT = 'screens';
const PASSWORD = 'screens-password-1';
const SIZES = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'phone', width: 390, height: 844 },
] as const;
const SCHEMES = [
  { name: 'light', slug: 'instrument' },
  { name: 'dark', slug: 'night-shift' },
] as const;
const DOCS_PAGES = [
  ['home', '/'],
  ['getting-started', '/guide/getting-started'],
  ['feature-comms', '/features/comms'],
  ['feature-black-box', '/features/black-box'],
  ['feature-clean-room', '/features/clean-room'],
  ['reference-configuration', '/reference/configuration'],
] as const;

interface Shot {
  group: string;
  file: string;
  title: string;
}
const shots: Shot[] = [];
const missed: string[] = [];
/** What browser/geometry.ts found wrong in the views that are measured, one line each. */
const geo: string[] = [];
let n = 0;

const children: ChildProcess[] = [];
let home = '';
let base = '';
let docsBase = '';
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

async function waitFor<T>(what: string, read: () => Promise<T | undefined | false> | T | undefined | false, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const got = await read();
    if (got) return got;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${output.slice(-1500)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** One shot of the page as it is; a failure is written down, never thrown. */
async function shoot(page: Page, group: string, title: string, fullPage = false): Promise<void> {
  n += 1;
  const file = `${group}/${String(n).padStart(3, '0')}-${slug(title)}.png`;
  try {
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(OUT, file), fullPage });
    shots.push({ group, file, title });
  } catch (error) {
    missed.push(`${group}: ${title}: ${(error as Error).message.split('\n')[0]}`);
  }
}

/** The geometry rules (no overlap, no sideways scroll, no clipped text, keys 24 px or 44 on a phone) on the view the page shows now. */
async function measure(page: Page, group: string, title: string, scope = 'body'): Promise<void> {
  for (const problem of await geometry(page, group.endsWith('phone'), scope)) geo.push(`${group}: ${title}: ${problem}`);
}

/** A thing the terminal toolbar must do, checked in the page: a failure goes in geometry.txt like a geometry problem. */
async function proof(group: string, what: string, check: () => Promise<boolean>): Promise<void> {
  const ok = await check().catch(() => false);
  if (!ok) geo.push(`${group}: proof failed: ${what}`);
}

const clipboard = (page: Page): Promise<string> => page.evaluate(() => navigator.clipboard.readText());

/** Copy, Find and Full screen of the terminal toolbar, driven as a person would and checked (the clipboard, the selection, document.fullscreenElement). */
async function toolbarProofs(page: Page, group: string): Promise<void> {
  const phone = group.endsWith('phone');
  const needle = 'Fake model';
  await page.waitForTimeout(1500);
  const copyItem = async (name: string): Promise<void> => {
    await page.getByRole('button', { name: 'Copy' }).first().click({ timeout: 3000 });
    await page.getByRole('button', { name, exact: true }).click({ timeout: 3000 });
  };
  await copyItem('The screen');
  await proof(group, 'Copy > The screen puts the terminal text on the clipboard', async () => (await clipboard(page)).includes(needle));
  if (phone) {
    await page.getByRole('button', { name: 'More terminal keys' }).first().click({ timeout: 3000 });
    await page.getByRole('button', { name: 'Find', exact: true }).click({ timeout: 3000 });
  } else {
    await page.getByRole('button', { name: 'Find', exact: true }).click({ timeout: 3000 });
  }
  await page.getByLabel('Find in the terminal').fill('fake');
  await page.getByLabel('Find in the terminal').press('Enter');
  await page.waitForTimeout(600);
  await proof(group, 'Find highlights a match (xterm selection layer)', async () => (await page.locator('.xterm-selection div').count()) > 0);
  await copyItem('Selection');
  await proof(group, 'Copy > Selection puts the found text on the clipboard', async () => (await clipboard(page)).toLowerCase() === 'fake');
  if (!phone) {
    await page.getByRole('button', { name: 'More terminal keys' }).first().click({ timeout: 3000 });
    await page.getByRole('button', { name: 'Full screen', exact: true }).click({ timeout: 3000 });
    await page.waitForTimeout(500);
    await proof(group, 'Full screen enters', async () => page.evaluate(() => document.fullscreenElement !== null));
    await page.getByRole('button', { name: 'More terminal keys' }).first().click({ timeout: 3000 });
    await page.getByRole('button', { name: 'Leave full screen', exact: true }).click({ timeout: 3000 });
    await page.waitForTimeout(500);
    await proof(group, 'Full screen leaves', async () => page.evaluate(() => document.fullscreenElement === null));
  }
}

/** No control or label twice for the same thing (browser/geometry.ts) on the view the page shows now. */
async function measureDuplicates(page: Page, group: string, title: string, scope: string): Promise<void> {
  for (const problem of await duplicates(page, scope)) geo.push(`${group}: ${title}: duplicate: ${problem}`);
}

/** A write asks for the password again when the last check is old: answer it if the dialog comes. */
async function stepUpIfAsked(page: Page): Promise<void> {
  const dialog = page.locator('dialog.stepup[open]');
  if (await dialog.waitFor({ timeout: 2500 }).then(() => true, () => false)) {
    await dialog.getByLabel('Password').fill(PASSWORD);
    await dialog.locator('button[type=submit]').click();
  }
}

/**
 * The Docker update, as the Director meets it (the registry cannot be reached from a test, so the page is told what the server would tell it): the update strip, the version key,
 * the confirmation, the image that cannot be checked, and the way on. The WebSocket carries a rollout view that says a newer version is out and this install can update itself;
 * POST /api/update is answered by the page's own stand-in. The same steps run on the old flow and the new one (they look for the key by its words), and the clicks are counted.
 */
const UPDATE_NOTE =
  '9.9.9 was not run: gonogo could not check its image (gh has no GitHub login in this container, so attestations cannot be fetched: log in from a console of room main (`gh auth login`; the login stays in that room folder) or set GH_TOKEN in the container (a token with no permissions is enough)). Nothing was changed. Log in as said, or update anyway if you trust this image.';
const rolloutOf = (update?: Record<string, unknown>): Record<string, unknown> => ({
  enabled: true,
  current: '0.13.0',
  latest: '9.9.9',
  checkedAt: Date.now() - 120_000,
  newer: true,
  command: 'docker compose pull && docker compose up -d',
  install: 'docker',
  installNote: "Installed as a container image with the Docker socket: Update pulls this container's own tag and recreates it. The agents stop and the page reconnects.",
  canUpdate: true,
  selfUpdate: true,
  ...(update === undefined ? {} : { update }),
});

/** Docking 2 in the room: two docks (a routed WebSocket gives the state frame their list), a handoff waiting for GO, and the rules of a dock in Flight Rules. */
async function dockingTwo(page: Page, group: string): Promise<void> {
  const dock = (id: string, name: string, status: string): Record<string, unknown> => ({ id, name, url: `https://${name}.example.org`, since: Date.now() - 86_400_000, status, seenAt: Date.now() - 60_000, error: null, agents: [{ name: 'cara', role: 'Builds the notes', state: 'idle', boss: false }] });
  await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (typeof message === 'string') {
        try {
          const frame = JSON.parse(message) as { t?: string; state?: { docking?: unknown } };
          if (frame.t === 'state' && frame.state !== undefined) frame.state.docking = { station: 'main', docks: [dock('dk1', 'lab', 'ok'), dock('dk2', 'ops', 'ok')] };
          ws.send(JSON.stringify(frame));
          return;
        } catch {
          // not a frame of text: passed on as it is
        }
      }
      ws.send(message);
    });
  });
  await page.route('**/api/handoff-requests', (route) => route.fulfill({ json: { requests: [{ id: 'h1', dock: 'dk1', station: 'lab', from: 'flight', at: Date.now(), task: { title: 'Fix the login token', detail: 'The token expires after five minutes instead of an hour. Check the clock handling in the session code and add a test.' } }] } }));
  await page.route('**/api/docking/*/rules', (route) => route.fulfill({ json: { handoff: 'ask', incoming: 'auto', autoAccept: 'off', reportCost: 'off', serve: 'off', staleHours: 24 } }));
  await page.route('**/api/links', (route) => route.fulfill({ json: { links: LINKS } }));
  await page.goto(`${base}/r/main/`);
  await page.locator('.topbar').waitFor({ timeout: 30_000 });
  await view(page, group, 'docking 2: a handoff waits for GO', () => page.locator('.relief-need', { hasText: 'send a task to lab' }).waitFor({ timeout: 10_000 }), true);
  await page.locator('.topbar').getByRole('button', { name: 'More', exact: true }).click({ timeout: 3000 });
  await page.getByRole('group', { name: 'More' }).getByRole('button', { name: 'Flight Rules', exact: true }).click({ timeout: 3000 });
  await page.locator('.lay-group-nav a', { hasText: /Automation/ }).click({ timeout: 3000 });
  await page.locator('.lay-row', { hasText: 'Docking: other stations' }).locator('summary').first().click({ timeout: 3000 });
  await view(page, group, 'docking 2: the docks', () => page.locator('.dk-rules').first().waitFor({ timeout: 5000 }), true);
  await view(page, group, 'docking 2: the rules of a dock', () => page.locator('.dk-rules > summary').first().click({ timeout: 3000 }), true);
}

async function updateFlow(page: Page, group: string): Promise<void> {
  let current = rolloutOf();
  let tell: (rollout: Record<string, unknown>) => void = () => undefined;
  await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (typeof message === 'string') {
        try {
          const frame = JSON.parse(message) as { t?: string; state?: { rollout?: unknown }; rollout?: unknown };
          if (frame.t === 'state' && frame.state !== undefined) frame.state.rollout = current;
          if (frame.t === 'rollout') frame.rollout = current;
          ws.send(JSON.stringify(frame));
          return;
        } catch {
          // not a frame of text: passed on as it is
        }
      }
      ws.send(message);
    });
    tell = (rollout) => {
      current = rollout;
      ws.send(JSON.stringify({ t: 'rollout', rollout }));
    };
  });
  await page.route('**/api/update', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const forced = (route.request().postDataJSON() as { unverified?: boolean } | null)?.unverified === true;
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    setTimeout(() => tell(rolloutOf(forced ? { state: 'running', version: '9.9.9', note: 'Pulling 9.9.9 and checking it…', tail: [], rollback: null } : { state: 'failed', version: '9.9.9', note: UPDATE_NOTE, tail: [], rollback: null, verify: 'unchecked' })), 700);
  });
  await page.goto(`${base}/r/main/`);
  await page.locator('.topbar').waitFor({ timeout: 30_000 });
  await page.locator('.rollout-strip').waitFor({ timeout: 10_000 });
  let clicks = 0;
  const click = async (name: string | RegExp, within?: string): Promise<void> => {
    await (within === undefined ? page : page.locator(within)).getByRole('button', { name }).first().click({ timeout: 5000 });
    clicks += 1;
  };
  const where = '.rollout-strip, .lay-pop';
  const step = async (title: string): Promise<void> => {
    await page.waitForTimeout(400);
    await shoot(page, group, `update: ${title}`, true);
    for (const problem of await duplicates(page, where, true)) geo.push(`${group}: update: ${title}: duplicate: ${problem}`);
    for (const problem of await geometry(page, group.endsWith('phone'), where)) geo.push(`${group}: update: ${title}: ${problem}`);
  };
  await step('the strip when a newer gonogo is out');
  await page.getByRole('button', { name: /^(↑ )?\d+\.\d+\.\d+/ }).first().click({ timeout: 5000 });
  await step('the version key');
  // the version key offers Update only when the strip is not showing it (the old flow had it twice)
  if ((await page.locator('.lay-pop').getByRole('button', { name: /^Update to 9\.9\.9/ }).count()) > 0) {
    await click(/^Update to 9\.9\.9/, '.lay-pop');
    await step('after one click on Update in the version key');
  } else {
    await page.keyboard.press('Escape');
  }
  if (!(await page.getByRole('alertdialog').isVisible().catch(() => false))) await click(/^Update to 9\.9\.9/, '.rollout-strip');
  await step('the confirmation');
  await click(/^Update now$/);
  await page.locator('.rollout-strip [role=alert]').first().waitFor({ timeout: 8000 });
  await step('the image cannot be checked');
  const fix = page.locator('.rollout-fix > summary');
  if (await fix.isVisible().catch(() => false)) {
    await fix.click();
    await step('how to fix');
  }
  await click(/Update anyway|Update without checking/);
  await page.waitForTimeout(1200);
  await step('going on without the check');
  missed.push(`info: ${group}: update flow: ${clicks} clicks from the first look at the strip to the run (the password prompt not counted)`);
}

/** Runs a step that gets to a view and shoots it; whatever goes wrong is noted and the run goes on. */
async function view(page: Page, group: string, title: string, get: () => Promise<void>, fullPage = false): Promise<void> {
  try {
    await get();
  } catch (error) {
    missed.push(`${group}: ${title}: could not get there: ${(error as Error).message.split('\n')[0]}`);
    await page.keyboard.press('Escape').catch(() => undefined);
    return;
  }
  await shoot(page, group, title, fullPage);
}

/** A named key of the bar if it is there (a desktop), else the Patch Panel with a query (a phone, or a key that is not in the bar). */
async function open(page: Page, key: string, query = key): Promise<void> {
  // a prefix: the Comms key says how many are unread, the Flight Plan key how many are active
  const button = page.getByRole('button', { name: new RegExp('^' + key) });
  if (await button.first().isVisible().catch(() => false)) {
    await button.first().click({ timeout: 3000 });
    return;
  }
  await patch(page, query);
}

async function patch(page: Page, query: string): Promise<void> {
  // the Jump key of the top bar: Ctrl+K typed while the terminal has the focus stays in the terminal (xterm takes it), and a room that has just loaded gives the boss's terminal the focus
  const jump = page.getByRole('button', { name: /^Jump to/ });
  if (await jump.isVisible().catch(() => false)) await jump.click({ timeout: 3000 });
  else await page.keyboard.press('Control+k');
  const field = page.locator('.patch-input');
  await field.waitFor({ timeout: 3000 });
  await field.fill(query);
  await page.keyboard.press('Enter');
  // the panel closes when it runs a line; one that stays open (no match) is closed, so it is not in the next shot
  await field.waitFor({ state: 'hidden', timeout: 2000 }).catch(() => page.keyboard.press('Escape'));
}

async function api(context: BrowserContext, method: 'POST' | 'PUT', path: string, data: unknown): Promise<void> {
  const response = await context.request.fetch(`${base}${path}`, { method, headers: { Origin: base, 'content-type': 'application/json' }, data: JSON.stringify(data) });
  if (!response.ok()) throw new Error(`${method} ${path}: ${response.status()} ${(await response.text()).slice(0, 200)}`);
}

test.beforeAll(async () => {
  await mkdir(OUT, { recursive: true });
  home = await mkdtemp(join(tmpdir(), 'gn-scr-'));
  // the stand-in logs to a folder and reads a Claude config folder: without them it exits and every agent shows as stopped
  await mkdir(join(home, 'fake-log'));
  await mkdir(join(home, 'fake-claude'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['bin/gonogo.js', '--port', String(port), '--no-update-check'], {
    env: { ...process.env, GONOGO_HOME: join(home, 'gonogo'), CLAUDE_CONFIG_DIR: join(home, 'fake-claude'), FAKE_CLAUDE_LOG_DIR: join(home, 'fake-log'), GONOGO_AGENT_CMD: `${process.execPath} ${join(process.cwd(), "test", "fake-claude.mjs")}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(server);
  server.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  server.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  await waitFor('the server and its setup token', () => existsSync(join(home, 'gonogo', 'setup-token')) && output.includes(String(port)));
  if (process.env.SCREENS_DOCS === '1') {
    const docsPort = await freePort();
    docsBase = `http://127.0.0.1:${docsPort}`;
    children.push(spawn('pnpm', ['exec', 'vitepress', 'preview', '--port', String(docsPort), '--host', '127.0.0.1'], { stdio: 'ignore' }));
    await waitFor('the docs preview', async () => (await fetch(docsBase).catch(() => null))?.ok === true);
  }
});

test.afterAll(async () => {
  for (const child of children) child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  await rm(home, { recursive: true, force: true });
  const groups = [...new Set(shots.map((s) => s.group))];
  const html =
    `<!doctype html><meta charset="utf-8"><title>gonogo screens</title><style>body{font:14px system-ui;margin:16px;background:#eee}h2{margin:24px 0 8px}` +
    `.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}figure{margin:0;background:#fff;padding:6px;border:1px solid #ccc}` +
    `img{width:100%;display:block}figcaption{padding:4px 0 0;font-size:12px}</style><h1>gonogo screens</h1>` +
    `<p>${shots.length} shots, ${missed.length} missed.</p>` +
    (missed.length ? `<h2>Missed</h2><ul>${missed.map((m) => `<li>${m.replace(/</g, '&lt;')}</li>`).join('')}</ul>` : '') +
    groups.map((g) => `<h2>${g}</h2><div class="g">${shots.filter((s) => s.group === g).map((s) => `<figure><a href="${s.file}"><img loading="lazy" src="${s.file}" alt=""></a><figcaption>${s.title}</figcaption></figure>`).join('')}</div>`).join('');
  await writeFile(join(OUT, 'index.html'), html);
  await writeFile(join(OUT, 'geometry.txt'), geo.length === 0 ? 'no geometry problems\n' : geo.join('\n') + '\n');
});

/** Every view of the app, in the order a person meets them. `full` is the pass after the seed. */
async function app(page: Page, group: string, full: boolean): Promise<void> {
  const t = (title: string): string => (full ? title : `${title} (empty)`);
  await page.goto(`${base}/r/main/`);
  await page.locator('.topbar').waitFor({ timeout: 30_000 });
  await page.locator('.lamp[data-link="up"]').waitFor({ timeout: 30_000 }).catch(() => undefined);
  await shoot(page, group, t('room main'), true);
  if (full) await measure(page, group, 'room main');
  if (full) {
    await view(page, group, 'status strip: the clock open', () => page.getByRole('button', { name: /^(No mission|Mission )/ }).click({ timeout: 3000 }));
    await measure(page, group, 'the clock open');
    await page.keyboard.press('Escape');
    for (const [title, name] of [['layout', 'Layout of the room'], ['version key', /^\d+\.\d+\.\d+/], ['work menu', 'Work'], ['more menu', 'More']] as const) {
      await view(page, group, `top bar: ${title}`, () => page.getByRole('button', { name }).last().click({ timeout: 3000 }));
      await measure(page, group, title);
      await page.keyboard.press('Escape');
    }
    for (const density of ['Full wall', 'Focus', 'Standard'] as const) {
      await page.getByRole('button', { name: 'Layout of the room' }).click({ timeout: 3000 });
      await page.getByRole('button', { name: new RegExp('^' + density) }).click({ timeout: 3000 });
      await page.keyboard.press('Escape');
      if (density !== 'Standard') {
        await shoot(page, group, `layout: ${density}`, true);
        await measure(page, group, `layout: ${density}`);
      }
    }
    await toolbarProofs(page, group);
    await page.reload();
    await page.locator('.topbar').waitFor({ timeout: 30_000 });
    await view(page, group, 'terminal toolbar: copy menu', () => page.getByRole('button', { name: 'Copy' }).first().click({ timeout: 3000 }));
    await measure(page, group, 'copy menu');
    await page.keyboard.press('Escape');
    await view(page, group, 'terminal toolbar: more keys', () => page.getByRole('button', { name: 'More terminal keys' }).first().click({ timeout: 3000 }));
    await measure(page, group, 'more keys');
    await page.keyboard.press('Escape');
    if (group.endsWith('phone')) {
      await view(page, group, 'terminal: Select', () => page.getByRole('button', { name: 'Select', exact: true }).click({ timeout: 3000 }));
      await measure(page, group, 'Select');
      await page.getByRole('button', { name: 'Close' }).click({ timeout: 3000 }).catch(() => undefined);
    }
    await view(page, group, 'terminal: expanded', async () => {
      await page.getByRole('button', { name: 'Expand', exact: true }).click({ timeout: 3000 });
      await page.waitForTimeout(1200);
    });
    await measure(page, group, 'expanded');
    await page.getByRole('button', { name: /^Back/ }).click({ timeout: 3000 }).catch(() => undefined);
  }
  await view(page, group, t('comms inbox'), async () => {
    await open(page, 'Comms');
    await page.getByRole('tab', { name: /inbox/i }).click({ timeout: 3000 });
  });
  await view(page, group, t('comms traffic'), () => page.getByRole('tab', { name: /traffic/i }).click({ timeout: 3000 }));
  await view(page, group, t('comms threads'), () => page.getByRole('tab', { name: /threads/i }).click({ timeout: 3000 }));
  // Docking 2: the stand-in install has no second station, so the links are stood in (the same shapes as the server's)
  await page.route('**/api/links', (route) => route.fulfill({ json: { links: LINKS } }));
  await view(page, group, t('missions'), () => open(page, 'Missions'), true);
  await view(page, group, t('mission with a link'), () => page.getByRole('button', { name: /Ship the release/ }).first().click({ timeout: 3000 }), true);
  await view(page, group, t('launch window'), () => open(page, 'Launch Window'), true);
  if (full) await view(page, group, 'launch window history', () => page.getByRole('button', { name: /^History of/ }).first().click({ timeout: 3000 }), true);
  await view(page, group, t('flight plan'), () => open(page, 'Flight Plan'), true);
  await view(page, group, t('mission log'), () => open(page, 'Mission Log'), true);
  await view(page, group, t('hangar'), () => patch(page, 'hangar'), true);
  await view(page, group, t('recorder'), () => patch(page, 'recorder'), true);
  if (!full) return;
  await view(page, group, 'flight rules', () => open(page, 'Flight Rules', 'rules'), true);
  await measure(page, group, 'flight rules');
  await measureDuplicates(page, group, 'flight rules', '.lay-rules');
  // every group opened with every one of its rows open: the controls and the labels of each must be there once
  // the index at the top when there is one, else the heading keys of the groups
  const index = page.locator('.lay-group-nav a');
  const titles = (await index.count().catch(() => 0)) > 0 ? index : page.locator('.lay-group-title button');
  const count = await titles.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const title = ((await titles.nth(i).textContent()) ?? '').replace(/[▾▸]/g, '').trim();
    const label = `flight rules: ${title}, every row open`;
    await view(page, group, label, async () => {
      if ((await titles.nth(i).getAttribute('aria-expanded')) !== 'true') await titles.nth(i).click({ timeout: 3000 });
      await page.locator('details.lay-row').evaluateAll((rows) => rows.forEach((row) => ((row as HTMLDetailsElement).open = true)));
      await page.waitForTimeout(300);
    }, true);
    await measure(page, group, label, '.lay-rules');
    await measureDuplicates(page, group, label, '.lay-rules');
  }
  // Runtime settings (the System and update group is the one open now, with every row open): an editor, a refused value, the warning of a sensitive setting, a setting for all rooms only
  await view(page, group, 'runtime settings: change a setting', () => page.getByRole('button', { name: 'Change Message hops' }).click({ timeout: 3000 }), true);
  await measure(page, group, 'runtime settings: change a setting', '.lay-rules');
  await measureDuplicates(page, group, 'runtime settings: change a setting', '.lay-rules');
  await view(page, group, 'runtime settings: a refused value', async () => {
    await page.getByLabel('Message hops value').fill('abc');
    await page.getByRole('button', { name: 'Set', exact: true }).click({ timeout: 3000 });
    await stepUpIfAsked(page);
    await page.locator('.rt-editor [role=alert]').waitFor({ timeout: 5000 });
  }, true);
  await measure(page, group, 'runtime settings: a refused value', '.lay-rules');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click({ timeout: 3000 }).catch(() => undefined);
  await view(page, group, 'runtime settings: the agent command warns', () => page.getByRole('button', { name: 'Change Agent command' }).click({ timeout: 3000 }), true);
  await measure(page, group, 'runtime settings: the agent command warns', '.lay-rules');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click({ timeout: 3000 }).catch(() => undefined);
  await view(page, group, 'runtime settings: a setting for all rooms only', () => page.getByRole('button', { name: 'Change Log level' }).click({ timeout: 3000 }), true);
  await measure(page, group, 'runtime settings: a setting for all rooms only', '.lay-rules');
  await measureDuplicates(page, group, 'runtime settings: a setting for all rooms only', '.lay-rules');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click({ timeout: 3000 }).catch(() => undefined);
  // the project folder (Room group): the editor, a refused folder, a folder set (the boss runs elsewhere: the page offers to restart it), then Reset
  await page.locator('.lay-group-nav a', { hasText: 'Room' }).first().click({ timeout: 3000 }).catch(() => undefined);
  // a group that was just opened has its rows folded: the row of the project folder is opened
  await page.locator('details.lay-row').evaluateAll((rows) => rows.forEach((row) => ((row as HTMLDetailsElement).open = true))).catch(() => undefined);
  await view(page, group, 'project folder: the editor', () => page.getByRole('button', { name: 'Change the project folder' }).click({ timeout: 3000 }), true);
  await measure(page, group, 'project folder: the editor', '.lay-rules');
  await measureDuplicates(page, group, 'project folder: the editor', '.lay-rules');
  await view(page, group, 'project folder: a broad folder warns before the save', async () => {
    await page.getByLabel('Folder', { exact: true }).fill('/');
    await page.waitForTimeout(900);
  }, true);
  await measure(page, group, 'project folder: a broad folder warns before the save', '.lay-rules');
  await view(page, group, 'project folder: a refused folder', async () => {
    await page.getByLabel('Folder', { exact: true }).fill('relative/path');
    await page.getByRole('button', { name: 'Set the project folder' }).click({ timeout: 3000 });
    await stepUpIfAsked(page);
    await page.locator('.pf-editor [role=alert]').waitFor({ timeout: 5000 });
  }, true);
  await measure(page, group, 'project folder: a refused folder', '.lay-rules');
  await view(page, group, 'project folder: set, the boss runs elsewhere', async () => {
    await page.getByLabel('Folder', { exact: true }).fill(tmpdir());
    await page.getByRole('button', { name: 'Set the project folder' }).click({ timeout: 3000 });
    await stepUpIfAsked(page);
    await page.getByRole('button', { name: 'Restart the boss now' }).waitFor({ timeout: 5000 });
  }, true);
  await measure(page, group, 'project folder: set, the boss runs elsewhere', '.lay-rules');
  await measureDuplicates(page, group, 'project folder: set, the boss runs elsewhere', '.lay-rules');
  // back to the default, so that the shots that follow are as before
  await page.getByRole('button', { name: 'Change the project folder' }).click({ timeout: 3000 }).catch(() => undefined);
  await page.getByRole('button', { name: 'Reset the project folder' }).click({ timeout: 3000 }).catch(() => undefined);
  await stepUpIfAsked(page);
  await view(page, group, 'livery', () => open(page, 'Livery'), true);
  await view(page, group, 'patch panel', async () => {
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+k');
    await page.locator('.patch-input').waitFor({ timeout: 3000 });
  });
  await page.keyboard.press('Escape');
  await view(page, group, 'hire form', async () => {
    // the key is in the room view now (it was in the top bar): go back to the room first
    await page.goto(`${base}/r/main/`);
    await page.locator('.topbar').waitFor({ timeout: 30_000 });
    await page.getByRole('button', { name: /staff a console/i }).first().click({ timeout: 3000 });
  });
  await view(page, group, 'hire form: a position picked, the rest folded', () => page.getByRole('button', { name: /^FAO/ }).first().click({ timeout: 3000 }), true);
  await view(page, group, 'hire form: more settings open', () => page.locator('summary', { hasText: 'MORE SETTINGS' }).click({ timeout: 3000 }), true);
  await page.keyboard.press('Escape');
  // a fresh room page for what follows: the form must not be open when the Patch Panel is asked for
  await page.goto(`${base}/r/main/`);
  await page.locator('.topbar').waitFor({ timeout: 30_000 });
  await view(page, group, 'agent console', async () => {
    await patch(page, 'ana');
    await page.locator('.xterm-rows').first().waitFor({ timeout: 10_000 });
  });
  await view(page, group, 'agent detail folds opened', async () => {
    const summaries = page.locator('summary');
    const total = await summaries.count();
    for (let i = 0; i < total; i += 1) await summaries.nth(i).click({ timeout: 1000 }).catch(() => undefined);
  }, true);
  await view(page, group, 'telemetry', () => patch(page, 'telemetry'), true);
  await view(page, group, 'plot board', () => patch(page, 'board'), true);
  await view(page, group, 'black box', () => patch(page, 'black box'), true);
  // the update strip needs a newer version from the registry, which the stand-in setup cannot give: see the index
  missed.push(`${group}: update strip: not taken (it needs a newer gonogo from the npm registry; add a registry stand-in)`);
}

test('screens of the app and the docs', async ({ browser }) => {
  test.setTimeout(480_000);
  // 1. before an account: the setup page; 2. the account; 3. the login page
  // a newcomer: the address gonogo prints (with the key in it), before any account exists, then the same address after the login was set up
  const printed = /#token=([0-9a-f]{64})/.exec(output)?.[1] ?? '';
  const newcomer = async (stage: string): Promise<void> => {
    for (const size of SIZES) {
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height } });
      const page = await context.newPage();
      await page.goto(`${base}/${printed === '' ? '' : `#token=${printed}`}`);
      await page.waitForLoadState('load');
      await page.waitForTimeout(2500);
      const group = `newcomer-${size.name}`;
      await shoot(page, group, `${stage}: where the printed address lands (${new URL(page.url()).pathname})`, true);
      await measure(page, group, stage, 'body');
      await context.close();
    }
  };
  await newcomer('before the login');
  const setupContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const setupPage = await setupContext.newPage();
  await setupPage.goto(`${base}/setup`);
  await shoot(setupPage, 'before-account', 'setup page');
  await setupPage.locator('input[name=token]').fill(readFileSync(join(home, 'gonogo', 'setup-token'), 'utf8').trim());
  await setupPage.locator('input[name=password]').fill(PASSWORD);
  await setupPage.locator('form button[type=submit], form input[type=submit]').first().click();
  await setupPage.waitForURL((url) => !url.pathname.startsWith('/setup'));
  await newcomer('after the login: the same address');
  const state = await setupContext.storageState();

  const fresh = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const loginPage = await fresh.newPage();
  await loginPage.goto(`${base}/login`);
  await shoot(loginPage, 'before-account', 'login page');
  await fresh.close();

  // the empty states first (no agents but the boss, no messages, tasks or log), at the first livery, desktop and phone
  for (const size of SIZES) {
    const context = await browser.newContext({ storageState: state, viewport: { width: size.width, height: size.height } });
    const page = await context.newPage();
    await page.goto(`${base}/?list`);
    await shoot(page, `empty-${size.name}`, 'rooms list', true);
    await app(page, `empty-${size.name}`, false);
    await context.close();
  }

  // the seed: agents, a conversation, a plan, a log, a mission
  const work = await mkdtemp(join(tmpdir(), 'gn-scr-work-'));
  const seed = async (label: string, run: () => Promise<void>): Promise<void> => run().catch((error: Error) => void missed.push(`seed ${label}: ${error.message.split('\n')[0]}`));
  await seed('agents', async () => {
    for (const name of ['ana', 'ben']) await api(setupContext, 'POST', '/api/agents', { name, role: `${name} does what it is told`, dir: work, mode: 'default' });
    await new Promise((r) => setTimeout(r, 4000));
  });
  await seed('messages', async () => {
    await api(setupContext, 'POST', '/api/messages', { to: 'ana', subject: 'Plan the release', body: 'Write the release notes, then tell ben.' });
    await api(setupContext, 'POST', '/api/messages', { to: 'ben', subject: 'Review', body: 'Review the notes when ana is done.' });
    await api(setupContext, 'POST', '/api/messages', { to: 'ana', body: '@fake say Notes are drafted.' });
  });
  await seed('schedule', () => api(setupContext, 'POST', '/api/schedules', { name: 'Daily check', to: 'ana', subject: 'status', body: 'Where are you?', rule: '0 9 * * *' }));
  await seed('mission', () => api(setupContext, 'POST', '/api/missions', { name: 'Ship the release' }));
  await seed('tasks', async () => {
    await api(setupContext, 'POST', '/api/tasks', { title: 'Write the release notes', detail: 'One page.', assignee: 'ana' });
    await api(setupContext, 'POST', '/api/tasks', { title: 'Review the notes', assignee: 'ben' });
  });
  await seed('log', async () => {
    await api(setupContext, 'POST', '/api/log', { title: 'Release steps', body: 'Tag the release. See l1.', tags: ['release'] });
    await api(setupContext, 'POST', '/api/log', { title: 'Cache key', body: 'The key has the node version.', tags: ['build', 'cache'] });
  });
  await new Promise((r) => setTimeout(r, 3000));
  // what state the agents are in, and the tail of the server's output when one is stopped: it explains a screen of undelivered mail
  const roster = await (await setupContext.request.get(`${base}/api/state`)).json().catch(() => ({ agents: [] }));
  const states = ((roster as { agents?: Array<{ name: string; state: string }> }).agents ?? []).map((agent) => `${agent.name}=${agent.state}`);
  missed.push(`info: agents after the seed: ${states.join(', ')}${states.some((x) => x.endsWith('=stopped')) ? '; server output: ' + output.slice(-600).replace(/\s+/g, ' ') : ''}`);
  await setupContext.close();

  await seed('second room', async () => {
    const maker = await browser.newContext({ storageState: state });
    await api(maker, 'POST', '/api/rooms', { id: 'docs', name: 'Docs' });
    await maker.close();
  });

  // every view, light then dark (the livery is the server's, so it is chosen once per scheme), desktop and phone
  for (const scheme of SCHEMES) {
    const chooser = await browser.newContext({ storageState: state });
    await api(chooser, 'PUT', '/api/livery', { slug: scheme.slug }).catch((error: Error) => void missed.push(`livery ${scheme.slug}: ${error.message.split('\n')[0]}`));
    await chooser.close();
    for (const size of SIZES) {
      const group = `${scheme.name}-${size.name}`;
      const context = await browser.newContext({ storageState: state, viewport: { width: size.width, height: size.height }, permissions: ['clipboard-read', 'clipboard-write'] });
      const page = await context.newPage();
      await page.goto(`${base}/?list`);
      await shoot(page, group, 'rooms list', true);
      await measure(page, group, 'rooms list');
      await view(page, group, 'rooms list: the new room form', () => page.getByRole('button', { name: 'NEW ROOM' }).click({ timeout: 5000 }), true);
      await measure(page, group, 'rooms list: the new room form');
      await page.getByRole('button', { name: 'CANCEL' }).click({ timeout: 3000 }).catch(() => undefined);
      await view(page, group, 'rooms list: stop asks first', () => page.getByRole('button', { name: 'Stop Docs', exact: true }).click({ timeout: 5000 }), true);
      await measure(page, group, 'rooms list: stop asks first');
      await page.getByRole('button', { name: 'Keep Docs running' }).click({ timeout: 3000 }).catch(() => undefined);
      await view(page, group, 'rooms list: stop all asks first', () => page.getByRole('button', { name: 'Stop every room', exact: true }).click({ timeout: 5000 }), true);
      await measure(page, group, 'rooms list: stop all asks first');
      await page.getByRole('button', { name: 'Keep every room running' }).click({ timeout: 3000 }).catch(() => undefined);
      await app(page, group, true);
      await dockingTwo(await context.newPage(), group).catch((error: Error) => void missed.push(`${group}: docking 2: ${error.message.split('\n')[0]}`));
      await updateFlow(await context.newPage(), group).catch((error: Error) => void missed.push(`${group}: update flow: ${error.message.split("\n")[0]}`));
      await context.close();
    }
  }

  // the docs site, same four looks (it follows the browser's colour scheme)
  if (docsBase !== '') {
    for (const scheme of SCHEMES) {
      for (const size of SIZES) {
        const group = `docs-${scheme.name}-${size.name}`;
        const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, colorScheme: scheme.name });
        const page = await context.newPage();
        for (const [title, path] of DOCS_PAGES) {
          await view(page, group, title, async () => void (await page.goto(`${docsBase}${path}`)), true);
        }
        await context.close();
      }
    }
  } else {
    missed.push('docs: not taken (SCREENS_DOCS=1 and a built docs site are needed)');
  }
  await rm(work, { recursive: true, force: true });
  expect(geo, 'geometry of the measured views (see geometry.txt)').toEqual([]);
});

