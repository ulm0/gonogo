// Update from the page (docs/features/update.md): which install is which, what the installer is told, what it is given, and
// that nothing runs without the version the check found. No network, no installer: fakes for both.
import { describe, expect, it, vi } from 'vitest';
import type { RolloutView, UpdateView } from '../src/shared/protocol.js';
import { installCommand, PNPM_EXCLUDE, installKind, installNote } from '../src/server/rollout.js';
import { createUpdater, installerEnv, tailOf, UpdateError } from '../src/server/updater.js';
import type { RunResult } from '../src/server/updater.js';

const NPM = '/usr/local/lib/node_modules/@ulm0/gonogo/dist/server/cli.js';

describe('which install is this', () => {
  it('tells a container, a clone, a dlx run, npm, pnpm and the rest from the path of its own file', () => {
    expect(installKind({ file: NPM, docker: true, clone: false })).toBe('docker');
    expect(installKind({ file: '/src/gonogo/dist/server/cli.js', docker: false, clone: true })).toBe('clone');
    expect(installKind({ file: '/home/u/.cache/pnpm/dlx/abc/node_modules/@ulm0/gonogo/dist/server/cli.js', docker: false, clone: false })).toBe('dlx');
    expect(installKind({ file: NPM, docker: false, clone: false })).toBe('npm');
    expect(installKind({ file: '/home/u/.local/share/pnpm/global/5/node_modules/@ulm0/gonogo/dist/server/cli.js', docker: false, clone: false })).toBe('pnpm');
    expect(installKind({ file: '/opt/homebrew/Cellar/gonogo/0.4.0/libexec/lib/node_modules/@ulm0/gonogo/dist/server/cli.js', docker: false, clone: false })).toBe('brew');
    expect(installKind({ file: '/opt/somewhere/gonogo/dist/server/cli.js', docker: false, clone: false })).toBe('other');
  });

  it('an rpm (or any package under lib/node_modules) reads as npm, and the note says so', () => {
    expect(installKind({ file: '/usr/lib/node_modules/@ulm0/gonogo/dist/server/cli.js', docker: false, clone: false })).toBe('npm');
    expect(installNote('npm', true)).toMatch(/rpm.*npm/);
  });

  it('builds the install of one exact version for npm and pnpm only', () => {
    expect(installCommand('npm', '1.2.3')).toEqual({ file: 'npm', args: ['install', '-g', '@ulm0/gonogo@1.2.3'] });
    expect(installCommand('pnpm', '1.2.3')).toEqual({ file: 'pnpm', args: [PNPM_EXCLUDE, 'add', '-g', '@ulm0/gonogo@1.2.3'] });
    for (const kind of ['docker', 'brew', 'dlx', 'clone', 'other'] as const) expect(installCommand(kind, '1.2.3')).toBeNull();
  });

  it('the installer gets a small environment: no gonogo variable, no token', () => {
    const env = installerEnv({ PATH: '/bin', HOME: '/h', GONOGO_TOKEN: 'secret', GONOGO_HOME: '/x', ANTHROPIC_API_KEY: 'k', npm_config_registry: 'https://r/', PNPM_HOME: '/p' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', npm_config_registry: 'https://r/', PNPM_HOME: '/p' });
  });

  it('keeps the last 8 lines of output, cut and without control characters', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i}\u001b[31m`);
    const tail = tailOf(`${lines.join('\n')}\n${'x'.repeat(500)}\n\n`);
    expect(tail).toHaveLength(8);
    expect(tail.at(-1)?.length).toBe(200);
    expect(tail.join('')).not.toContain('\u001b');
  });
});

function setup(over: { kind?: Parameters<typeof createUpdater>[0]['kind']; view?: Partial<RolloutView>; run?: (file: string, args: string[]) => Promise<RunResult>; reload?: () => boolean; keepsAgents?: boolean; hook?: { url: string; token: string | null } | null; fetch?: typeof fetch } = {}) {
  const view: RolloutView = { enabled: true, current: '0.2.0', latest: '0.3.0', checkedAt: 1, newer: true, command: 'npm install -g @ulm0/gonogo@latest', ...over.view };
  const seen: UpdateView[] = [];
  const calls: Array<{ file: string; args: string[] }> = [];
  const updater = createUpdater({
    kind: over.kind ?? 'npm',
    cwd: '/tmp',
    current: '0.2.0',
    rollout: { view: () => view, setUpdate: (u) => void seen.push(u) },
    run:
      over.run ??
      (async (file, args) => {
        calls.push({ file, args });
        return { code: 0, out: 'added 1 package\n' };
      }),
    reload: over.reload ?? (() => true),
    keepsAgents: over.keepsAgents ?? true,
    hook: over.hook ?? null,
    fetch: over.fetch ?? (async () => new Response('ok')),
  });
  const settled = async (): Promise<UpdateView> => {
    await vi.waitFor(() => expect(['installed', 'reloading', 'hook-sent', 'failed']).toContain(seen.at(-1)?.state));
    return seen.at(-1) as UpdateView;
  };
  return { updater, seen, calls, settled };
}

describe('update from the page', () => {
  it('installs the version the check found, then reloads when the agents survive it, and shows the way back', async () => {
    const reload = vi.fn(() => true);
    const t = setup({ reload });
    expect(t.updater.start('0.3.0')).toMatchObject({ state: 'running', version: '0.3.0' });
    const done = await t.settled();
    expect(t.calls).toEqual([{ file: 'npm', args: ['install', '-g', '@ulm0/gonogo@0.3.0'] }]);
    expect(done).toMatchObject({ state: 'reloading', rollback: 'npm install -g @ulm0/gonogo@0.2.0' });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload without a pty host: it stops after the install and says what a reload would do', async () => {
    const reload = vi.fn(() => true);
    const t = setup({ reload, keepsAgents: false });
    t.updater.start('0.3.0');
    const done = await t.settled();
    expect(done.state).toBe('installed');
    expect(done.note).toMatch(/stops the agents/);
    expect(reload).not.toHaveBeenCalled();
  });

  it('refuses a version that is not the one found, a malformed one, and an update while the check is off', () => {
    const t = setup();
    expect(() => t.updater.start('0.9.9')).toThrow(UpdateError);
    expect(() => t.updater.start('0.3.0; rm -rf /')).toThrow(/release number/);
    expect(() => t.updater.start(undefined)).toThrow(/release number/);
    expect(() => t.updater.start('latest')).toThrow(/release number/);
    expect(() => setup({ view: { enabled: false } }).updater.start('0.3.0')).toThrow(/check is off/);
    expect(() => setup({ view: { newer: false } }).updater.start('0.3.0')).toThrow(/not the newer version/);
    expect(t.calls).toEqual([]);
  });

  it('runs one update at a time', async () => {
    let finish: (r: RunResult) => void = () => undefined;
    const t = setup({ run: () => new Promise<RunResult>((resolve) => (finish = resolve)) });
    t.updater.start('0.3.0');
    expect(() => t.updater.start('0.3.0')).toThrow(/already in progress/);
    finish({ code: 0, out: '' });
    await t.settled();
  });

  it('a failed install leaves the running version alone, shows the tail, and names an unwritable folder', async () => {
    const t = setup({ run: async () => ({ code: 243, out: 'npm error code EACCES\nnpm error path /usr/lib/node_modules\n' }) });
    t.updater.start('0.3.0');
    const done = await t.settled();
    expect(done).toMatchObject({ state: 'failed', rollback: null });
    expect(done.note).toMatch(/unchanged/);
    expect(done.note).toMatch(/not writable/);
    expect(done.tail.join(' ')).toContain('EACCES');
  });

  it('a container without a hook only says what to run on the host; with one, it calls the hook with the token and no redirect', async () => {
    expect(() => setup({ kind: 'docker', view: { command: 'docker compose pull && docker compose up -d' } }).updater.start('0.3.0')).toThrow(/cannot replace its own image.*docker compose/s);
    const fetchFake = vi.fn(async () => new Response('ok'));
    const t = setup({ kind: 'docker', hook: { url: 'http://watchtower:8080/v1/update', token: 'hook-token' }, fetch: fetchFake as unknown as typeof fetch });
    t.updater.start('0.3.0');
    const done = await t.settled();
    expect(done.state).toBe('hook-sent');
    expect(fetchFake).toHaveBeenCalledWith('http://watchtower:8080/v1/update', expect.objectContaining({ method: 'POST', redirect: 'error', headers: { authorization: 'Bearer hook-token' } }));
    expect(JSON.stringify(done)).not.toContain('hook-token');
  });

  it('a hook that refuses or cannot be reached is a failure, not a success', async () => {
    const refusing = setup({ kind: 'docker', hook: { url: 'http://h/', token: null }, fetch: (async () => new Response('no', { status: 401 })) as typeof fetch });
    refusing.updater.start('0.3.0');
    expect((await refusing.settled()).note).toMatch(/answered 401/);
    const down = setup({ kind: 'docker', hook: { url: 'http://h/', token: null }, fetch: (async () => Promise.reject(new TypeError('fetch failed'))) as typeof fetch });
    down.updater.start('0.3.0');
    expect((await down.settled()).state).toBe('failed');
  });

  it('an install that cannot be updated in place (dlx, clone, other) is told the command', () => {
    for (const kind of ['dlx', 'clone', 'other'] as const) expect(() => setup({ kind }).updater.start('0.3.0')).toThrow(/run npm install -g/);
  });
});
