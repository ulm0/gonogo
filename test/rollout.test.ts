/**
 * Rollout (docs/rollout-spec.md): the daily check for a newer gonogo. A fake fetch and a fake clock: nothing here reaches the
 * network. What the request says, how often it is made, what is done with an answer, what is cached, and the commands that
 * `gonogo update` prints.
 */
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RolloutView } from '../src/shared/protocol.js';
import { ROLLOUT_EVERY_MS, ROLLOUT_MAX_BYTES, ROLLOUT_URL } from '../src/server/constants.js';
import { cachedLatest, createRollout, installCommand, isNewer, PNPM_EXCLUDE, pinCommand, updateCheckOff, updateCommand, updateText } from '../src/server/rollout.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gonogo-rollout-'));
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

const answer = (version: unknown, init: ResponseInit = {}): Response => new Response(JSON.stringify({ name: '@ulm0/gonogo', version }), { status: 200, ...init });

function setup(options: { enabled?: boolean; current?: string; fetch?: typeof fetch } = {}) {
  let clock = 1_000_000;
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const emitted: RolloutView[] = [];
  const next: Array<() => Response | Promise<Response>> = [];
  const fake = ((url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const make = next.shift() ?? (() => answer('0.2.0'));
    return Promise.resolve().then(make);
  }) as typeof fetch;
  const rollout = createRollout({ dir, now: () => clock, fetch: options.fetch ?? fake, enabled: options.enabled ?? true, current: options.current ?? '0.1.1', command: 'pnpm add -g @ulm0/gonogo@latest', emit: (v) => void emitted.push(v) });
  return { rollout, calls, emitted, next, advance: (ms: number) => void (clock += ms), now: () => clock };
}

describe('isNewer', () => {
  it.each([
    ['0.2.0', '0.1.1', true],
    ['0.1.2', '0.1.1', true],
    ['1.0.0', '0.9.9', true],
    ['0.10.0', '0.9.0', true],
    ['0.1.1', '0.1.1', false],
    ['0.1.0', '0.1.1', false],
    ['0.9.0', '0.10.0', false],
    ['0.2.0', '0.2.0-rc.1', true],
    ['0.2.1', '0.2.0-rc.1', true],
    ['0.2.0-rc.2', '0.1.1', false],
    ['latest', '0.1.1', false],
    ['0.2', '0.1.1', false],
    ['0.2.0', 'dev', false],
    ['', '0.1.1', false],
    ['0.2.0; rm -rf', '0.1.1', false],
  ])('%s over %s: %s', (latest, current, newer) => {
    expect(isNewer(latest, current)).toBe(newer);
  });
});

describe('updateCheckOff', () => {
  it.each([['0', true], ['off', true], ['OFF', true], [' false ', true], ['no', true], ['1', false], ['on', false], ['', false], [undefined, false]])('%j: %s', (value, off) => {
    expect(updateCheckOff(value)).toBe(off);
  });
});

describe('the request', () => {
  it('is one GET of the registry address with an Accept header and nothing of the user or the machine', async () => {
    const { rollout, calls } = setup();
    await rollout.check();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(ROLLOUT_URL);
    expect(ROLLOUT_URL).toBe('https://registry.npmjs.org/@ulm0%2Fgonogo/latest');
    const init = calls[0]?.init ?? {};
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({ accept: 'application/json' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.credentials).toBeUndefined();
  });
});

describe('the answer', () => {
  it('names a newer version: the view says so, the browsers are told, the file is cached with mode 0600', async () => {
    const { rollout, emitted, now } = setup();
    expect(rollout.view()).toEqual({ enabled: true, current: '0.1.1', latest: null, checkedAt: null, newer: false, command: 'pnpm add -g @ulm0/gonogo@latest' });
    const view = await rollout.check();
    expect(view).toEqual({ enabled: true, current: '0.1.1', latest: '0.2.0', checkedAt: now(), newer: true, command: 'pnpm add -g @ulm0/gonogo@0.2.0' });
    expect(emitted).toEqual([view]);
    const file = join(dir, 'rollout.json');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, checkedAt: now(), latest: '0.2.0' });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('the same version, or an older one, is not newer', async () => {
    const same = setup();
    same.next.push(() => answer('0.1.1'));
    expect((await same.rollout.check()).newer).toBe(false);
    const older = setup({ current: '0.3.0' });
    expect((await older.rollout.check()).newer).toBe(false);
  });

  it.each([
    ['a prerelease', () => answer('0.3.0-rc.1')],
    ['a version with text after it', () => answer('0.3.0; echo hi')],
    ['a version that is not text', () => answer(3)],
    ['no version', () => new Response('{}')],
    ['a body that is not JSON', () => new Response('<html>')],
    ['a 404', () => new Response('{"version":"9.9.9"}', { status: 404 })],
    ['a 500', () => new Response('', { status: 500 })],
    ['an answer over the limit', () => new Response(JSON.stringify({ version: '9.9.9', pad: 'x'.repeat(ROLLOUT_MAX_BYTES) }))],
  ])('%s leaves what was known as it was, and the try still counts', async (_what, make) => {
    const { rollout, next, now } = setup();
    await rollout.check();
    next.push(make);
    const view = await rollout.check();
    expect(view.latest).toBe('0.2.0');
    expect(view.checkedAt).toBe(now());
  });

  it('a request that fails (no network, a timeout) is not an error for the server', async () => {
    const { rollout, now } = setup({ fetch: (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch });
    const view = await rollout.check();
    expect(view).toMatchObject({ latest: null, newer: false, checkedAt: now() });
  });

  it('asks one at a time: two checks together make one request', async () => {
    const { rollout, calls } = setup();
    await Promise.all([rollout.check(), rollout.check()]);
    expect(calls).toHaveLength(1);
  });
});

describe('how often', () => {
  // Only the hourly timer is fake; the answer and the file are read and written for real, so each step waits for them to end.
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  const HOUR = 60 * 60 * 1000;
  const settle = async (rollout: { check(): Promise<unknown> }, calls: unknown[], count: number): Promise<void> => {
    await vi.waitFor(() => expect(calls).toHaveLength(count));
    // an ask that is running ends: check() joins it
    await rollout.check().catch(() => undefined);
  };

  it('start asks once, then not again until a day has passed since the try', async () => {
    const { rollout, calls, advance, emitted } = setup();
    rollout.start();
    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    expect(calls).toHaveLength(1);
    // the hourly looks come, but the day has not passed
    for (let hour = 0; hour < 3; hour += 1) {
      advance(HOUR);
      await vi.advanceTimersByTimeAsync(HOUR);
    }
    expect(calls).toHaveLength(1);
    advance(ROLLOUT_EVERY_MS);
    await vi.advanceTimersByTimeAsync(HOUR);
    await vi.waitFor(() => expect(emitted).toHaveLength(2));
    expect(calls).toHaveLength(2);
    await rollout.close();
    advance(ROLLOUT_EVERY_MS * 3);
    await vi.advanceTimersByTimeAsync(ROLLOUT_EVERY_MS);
    expect(calls).toHaveLength(2);
  });

  it('a restart within a day does not ask: the cache says when it was', async () => {
    const first = setup();
    await first.rollout.check();
    const second = setup();
    await second.rollout.load();
    expect(second.rollout.view()).toMatchObject({ latest: '0.2.0', newer: true });
    // the second clock starts at the same time as the first's try, so a day has not passed
    second.rollout.start();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(second.calls).toHaveLength(0);
    await second.rollout.close();
  });

  it('a restart after a day asks again', async () => {
    const first = setup();
    await first.rollout.check();
    const second = setup();
    await second.rollout.load();
    second.advance(ROLLOUT_EVERY_MS);
    second.rollout.start();
    await settle(second.rollout, second.calls, 1);
    await second.rollout.close();
  });

  it('a cache written in the future (a clock that went back) is asked again', async () => {
    await writeFile(join(dir, 'rollout.json'), JSON.stringify({ version: 1, checkedAt: 9_999_999_999_999, latest: '0.2.0' }));
    const { rollout, calls } = setup();
    await rollout.load();
    rollout.start();
    await settle(rollout, calls, 1);
    await rollout.close();
  });
});

describe('off', () => {
  it('asks nothing, whatever calls it, and shows no note even for a version the cache holds', async () => {
    await writeFile(join(dir, 'rollout.json'), JSON.stringify({ version: 1, checkedAt: 1, latest: '0.9.0' }));
    const { rollout, calls, emitted } = setup({ enabled: false });
    await rollout.load();
    rollout.start();
    const view = await rollout.check();
    expect(calls).toHaveLength(0);
    expect(emitted).toHaveLength(0);
    expect(view).toMatchObject({ enabled: false, latest: '0.9.0', newer: false });
    await rollout.close();
  });
});

describe('the cache file', () => {
  it('a file that is not ours, damaged or of another version is ignored', async () => {
    for (const text of ['not json', '[]', '{"version":2,"latest":"9.9.9","checkedAt":1}', '{"version":1,"latest":"latest","checkedAt":"x"}']) {
      await writeFile(join(dir, 'rollout.json'), text);
      const { rollout } = setup();
      await rollout.load();
      expect(rollout.view()).toMatchObject({ latest: null, checkedAt: null, newer: false });
    }
  });

  it('a folder that cannot be written is a warning, never a failure', async () => {
    await chmod(dir, 0o500);
    const { rollout } = setup();
    await expect(rollout.check()).resolves.toMatchObject({ latest: '0.2.0' });
    await chmod(dir, 0o700);
  });

  it('cachedLatest reads the file alone (what `gonogo --version` shows) and ignores anything odd', async () => {
    expect(cachedLatest(dir)).toBeNull();
    await writeFile(join(dir, 'rollout.json'), JSON.stringify({ version: 1, checkedAt: 1, latest: '0.2.0' }));
    expect(cachedLatest(dir)).toBe('0.2.0');
    await writeFile(join(dir, 'rollout.json'), JSON.stringify({ version: 1, checkedAt: 1, latest: '0.2.0\nrm -rf /' }));
    expect(cachedLatest(dir)).toBeNull();
    await writeFile(join(dir, 'rollout.json'), 'nope');
    expect(cachedLatest(dir)).toBeNull();
  });
});

describe('updateCommand: which command, by how gonogo was installed', () => {
  const where = { docker: false, clone: false };
  it.each([
    ['/home/me/.local/share/pnpm/global/5/.pnpm/@ulm0+gonogo@0.1.1/node_modules/@ulm0/gonogo/dist/server/cli.js', `pnpm add -g ${PNPM_EXCLUDE} @ulm0/gonogo@latest`],
    ['/home/me/.local/share/pnpm/global/5/node_modules/@ulm0/gonogo/dist/server/cli.js', `pnpm add -g ${PNPM_EXCLUDE} @ulm0/gonogo@latest`],
    ['/home/me/.cache/pnpm/dlx/abc/def/node_modules/@ulm0/gonogo/dist/server/cli.js', `pnpm dlx ${PNPM_EXCLUDE} @ulm0/gonogo@latest`],
    ['/home/me/.nvm/versions/node/v24.0.0/lib/node_modules/@ulm0/gonogo/dist/server/cli.js', 'npm install -g @ulm0/gonogo@latest'],
    ['/opt/homebrew/Cellar/gonogo/0.4.0/libexec/lib/node_modules/@ulm0/gonogo/dist/server/cli.js', 'brew upgrade gonogo'],
    ['/home/linuxbrew/.linuxbrew/Cellar/gonogo/0.4.0/libexec/lib/node_modules/@ulm0/gonogo/dist/server/cli.js', 'brew upgrade gonogo'],
    ['/somewhere/else/dist/server/cli.js', `pnpm add -g ${PNPM_EXCLUDE} @ulm0/gonogo@latest`],
  ])('%s', (file, command) => {
    expect(updateCommand({ file, ...where })).toBe(command);
  });

  it('a container pulls its image; a git checkout pulls and builds; both win over the path', () => {
    expect(updateCommand({ file: '/opt/gonogo/dist/server/cli.js', docker: true, clone: false })).toBe('docker compose pull && docker compose up -d');
    expect(updateCommand({ file: '/work/gonogo/dist/server/cli.js', docker: false, clone: true })).toBe('git pull && pnpm install && pnpm build');
    expect(updateCommand({ file: '/x/lib/node_modules/@ulm0/gonogo/cli.js', docker: true, clone: true })).toBe('docker compose pull && docker compose up -d');
  });

  it('a Windows style path is read the same way', () => {
    expect(updateCommand({ file: 'C:\\Users\\me\\AppData\\Local\\pnpm\\dlx\\x\\gonogo\\cli.js', ...where })).toBe(`pnpm dlx ${PNPM_EXCLUDE} @ulm0/gonogo@latest`);
  });
});

describe('updateText', () => {
  it('says what is out and prints the command; it says gonogo never updates itself', () => {
    const text = updateText('pnpm add -g @ulm0/gonogo@latest', false, { current: '0.1.1', latest: '0.2.0', newer: true });
    expect(text).toContain('gonogo 0.2.0 is out; this is 0.1.1.');
    expect(text).toContain('\n  pnpm add -g @ulm0/gonogo@0.2.0\n'); // exact version: @latest would resolve to an old one under pnpm's release age
    expect(text).toContain('gonogo never updates itself without your click.');
  });

  it('with nothing newer it still prints the command, and a container says where to run it', () => {
    const up = updateText('docker compose pull && docker compose up -d', true, { current: '0.2.0', latest: '0.2.0', newer: false });
    expect(up).toContain('This is gonogo 0.2.0; the newest the last check saw is 0.2.0.');
    expect(up).toContain('in the folder of your compose.yaml');
    expect(updateText('x', false, { current: '0.2.0', latest: null, newer: false })).toContain('This is gonogo 0.2.0.');
  });
});

describe('pinCommand', () => {
  it('puts the exact version where @latest was, for pnpm and dlx, and leaves npm and other commands alone', () => {
    for (const c of ['pnpm dlx', 'pnpm add -g']) expect(pinCommand(`${c} @ulm0/gonogo@latest`, '0.4.1')).toBe(`${c} @ulm0/gonogo@0.4.1`);
    expect(pinCommand('npm install -g @ulm0/gonogo@latest', '0.4.1')).toBe('npm install -g @ulm0/gonogo@latest');
    expect(pinCommand('brew upgrade gonogo', '0.4.1')).toBe('brew upgrade gonogo');
    expect(pinCommand('pnpm dlx @ulm0/gonogo@latest', null)).toBe('pnpm dlx @ulm0/gonogo@latest');
  });
});

describe('the three pnpm commands exempt gonogo from minimumReleaseAge and carry the exact version', () => {
  const where = { docker: false, clone: false };
  it('dlx and add -g in the note, and the Update button\'s command', () => {
    const view = (file: string) => pinCommand(updateCommand({ file, ...where }), '0.4.1');
    expect(view('/h/.cache/pnpm/dlx/a/node_modules/@ulm0/gonogo/dist/server/cli.js')).toBe('pnpm dlx --config.minimum-release-age-exclude=@ulm0/gonogo @ulm0/gonogo@0.4.1');
    expect(view('/h/.local/share/pnpm/global/5/node_modules/@ulm0/gonogo/dist/server/cli.js')).toBe('pnpm add -g --config.minimum-release-age-exclude=@ulm0/gonogo @ulm0/gonogo@0.4.1');
    expect(installCommand('pnpm', '0.4.1')).toEqual({ file: 'pnpm', args: ['add', '-g', '--config.minimum-release-age-exclude=@ulm0/gonogo', '@ulm0/gonogo@0.4.1'] });
  });
});
