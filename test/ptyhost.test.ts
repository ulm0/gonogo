// Live reload, the pty host and its client (docs/live-reload-spec.md): a real terminal host behind a real unix socket, with real
// ptys running node. No claude: the agents here are small node scripts.
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SpawnSpec, TerminalEvent } from '../src/shared/protocol.js';
import { startPtyHost, keyPathOf, prepareRunDir, runDir, socketPathOf } from '../src/server/ptyhost.js';
import type { PtyHost } from '../src/server/ptyhost.js';
import { encodeJson, FrameReader, PTYHOST_VERSION } from '../src/server/ptyhostproto.js';
import { createRemoteTerminalHost } from '../src/server/remoteterminal.js';
import type { RemoteTerminalHost } from '../src/server/remoteterminal.js';
import { createTerminalHost } from '../src/server/terminal.js';

const POINTER = 'gonogo: 1 new message from user. Call read_messages.';
let home: string;
let inner: ReturnType<typeof createTerminalHost>;
let host: PtyHost | null;
const clients: RemoteTerminalHost[] = [];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gng-ph-'));
  inner = createTerminalHost();
  host = null;
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.disconnect();
  await inner.stopAll();
  await host?.close();
  await rm(home, { recursive: true, force: true });
});

/** A child that prints a counter every 40 ms, and echoes what is typed into it. */
const counting = (): SpawnSpec => ({
  file: process.execPath,
  args: ['-e', 'let n = 0; setInterval(() => process.stdout.write("tick" + (n++) + "\\r\\n"), 40); process.stdin.on("data", (d) => process.stdout.write("got:" + d));'],
  env: { PATH: process.env.PATH ?? '' },
  cwd: home,
});

const client = (over: Partial<Parameters<typeof createRemoteTerminalHost>[0]> = {}): RemoteTerminalHost => {
  const c = createRemoteTerminalHost({ homeDir: home, reconnectWindowMs: 400, ...over });
  clients.push(c);
  return c;
};
const until = async (check: () => boolean, ms = 8000, what = 'a condition'): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
const modeOf = (path: string): number => statSync(path).mode & 0o777;

describe('the pty host: files and the socket', () => {
  it('keeps its folder at 0700, its socket and key at 0600, inside the home', async () => {
    host = await startPtyHost({ homeDir: home, host: inner });
    expect(host.socketPath).toBe(join(home, 'run', 'ptyhost.sock'));
    expect(modeOf(runDir(home))).toBe(0o700);
    expect(modeOf(socketPathOf(home))).toBe(0o600);
    expect(modeOf(keyPathOf(home))).toBe(0o600);
    expect((await readFile(keyPathOf(home), 'utf8')).trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('corrects a key file or folder with looser modes', async () => {
    mkdirSync(runDir(home), { mode: 0o755 });
    writeFileSync(keyPathOf(home), `${'a'.repeat(64)}\n`, { mode: 0o644 });
    await prepareRunDir(home);
    expect(modeOf(runDir(home))).toBe(0o700);
    expect(modeOf(keyPathOf(home))).toBe(0o600);
  });

  it('refuses a peer with a wrong key, and a peer that sends anything before hello', async () => {
    host = await startPtyHost({ homeDir: home, host: inner });
    for (const first of [{ op: 'hello', key: 'f'.repeat(64), version: PTYHOST_VERSION }, { op: 'list', id: 1 }]) {
      const s = net.connect(host.socketPath);
      const got: unknown[] = [];
      const reader = new FrameReader();
      s.on('data', (d) => got.push(...reader.push(d)));
      await new Promise<void>((resolve) => {
        s.once('connect', () => s.write(encodeJson(first)));
        s.once('close', () => resolve());
      });
      expect(got, 'nothing is answered to a peer without the key').toEqual([]);
    }
  });

  it('answers a hello of another protocol version with the version, and nothing else', async () => {
    host = await startPtyHost({ homeDir: home, host: inner });
    const key = (await readFile(keyPathOf(home), 'utf8')).trim();
    const s = net.connect(host.socketPath);
    const got: Array<{ json?: Record<string, unknown> }> = [];
    const reader = new FrameReader();
    s.on('data', (d) => got.push(...(reader.push(d) as typeof got)));
    await new Promise<void>((resolve) => {
      s.once('connect', () => s.write(encodeJson({ op: 'hello', key, version: PTYHOST_VERSION + 1 })));
      s.once('close', () => resolve());
    });
    expect(got).toHaveLength(1);
    expect(got[0]?.json).toMatchObject({ op: 'hello', ok: false, reason: 'version', version: PTYHOST_VERSION });
  });

  it('removes a stale socket file and listens again; refuses to take the place of a live host', async () => {
    mkdirSync(runDir(home), { mode: 0o700 });
    writeFileSync(socketPathOf(home), 'left behind by a crash');
    host = await startPtyHost({ homeDir: home, host: inner });
    expect(modeOf(socketPathOf(home))).toBe(0o600);
    await expect(startPtyHost({ homeDir: home, host: createTerminalHost() })).rejects.toThrow(/already listening/);
  });

  it('refuses a socket path that is too long for a unix socket, with the path in the message', async () => {
    const long = join(home, 'x'.repeat(120));
    await expect(startPtyHost({ homeDir: long, host: inner })).rejects.toThrow(/too long/);
  });

  it('exits by itself after the idle time with no agent and no hub, and leaves no socket', async () => {
    let exited = false;
    host = await startPtyHost({ homeDir: home, host: inner, idleExitMs: 300, onExit: () => (exited = true) });
    await until(() => exited, 4000, 'the idle exit');
    await expect(readFile(socketPathOf(home))).rejects.toThrow();
  });
});

describe('the remote terminal host', () => {
  it('spawns, shows output through attach, types, resizes and stops, like the local host', async () => {
    host = await startPtyHost({ homeDir: home, host: inner });
    const remote = client();
    const hello = await remote.connect();
    expect(hello.ok).toBe(true);
    const events: TerminalEvent[] = [];
    remote.onEvent((e) => events.push(e));

    const { pid } = await remote.spawnAsync('ana', 1, counting());
    expect(pid).toBeGreaterThan(0);
    expect(remote.info('ana')).toMatchObject({ running: true, generation: 1 });
    await until(() => remote.outputBytes('ana') > 20, 8000, 'output bytes');

    const attachment = await remote.attach('ana', () => undefined);
    expect(attachment.snapshot.running).toBe(true);
    const seen: string[] = [];
    const second = await remote.attach('ana', (chunk) => seen.push(Buffer.from(chunk).toString()));
    second.start();
    expect(remote.write('ana', 'hello\r')).toBe(true);
    await until(() => seen.join('').includes('got:hello'), 8000, 'the echo of what was typed');
    second.detach();
    attachment.detach();

    expect(remote.resize('ana', 100, 30)).toBe(true);
    await until(() => remote.info('ana')?.cols === 100, 4000, 'the new size');
    expect(remote.write('nobody', 'x')).toBe(false);

    await remote.stop('ana', 1);
    expect(events.some((e) => e.kind === 'exit' && e.name === 'ana' && e.generation === 1 && e.info.requested)).toBe(true);
    expect(remote.info('ana')?.running).toBe(false);
    expect(remote.write('ana', 'x')).toBe(false);
  });

  it('keeps the agents running when the hub goes; the next hub finds them with their output still counting', async () => {
    host = await startPtyHost({ homeDir: home, host: inner });
    const first = client();
    await first.connect();
    await first.spawnAsync('ana', 3, counting());
    await until(() => first.outputBytes('ana') > 20, 8000, 'output');
    const pid = first.info('ana')?.pid;
    first.disconnect();

    const second = client();
    const hello = await second.connect();
    expect(hello.ok && hello.agents.map((a) => ({ name: a.name, generation: a.generation, pid: a.pid, running: a.running }))).toEqual([{ name: 'ana', generation: 3, pid, running: true }]);
    await until(() => second.info('ana')?.running === true, 4000, 'the pushed state');
    const before = second.outputBytes('ana');
    await until(() => second.outputBytes('ana') > before + 20, 8000, 'more output after the hand-over');
    expect(second.write('ana', 'again\r')).toBe(true);
  });

  it('lets a newer hub take the host over, and the old hub does not take it back', async () => {
    host = await startPtyHost({ homeDir: home, host: inner });
    const older = client();
    await older.connect();
    const newer = client();
    await newer.connect();
    await until(() => !older.connected(), 4000, 'the old hub to be dropped');
    await new Promise((r) => setTimeout(r, 800));
    expect(older.connected(), 'the old hub does not reconnect').toBe(false);
    expect(newer.connected()).toBe(true);
  });

  it('starts the host itself when none answers, through startHost', async () => {
    let calls = 0;
    const remote = client({
      startHost: () => {
        calls += 1;
        void startPtyHost({ homeDir: home, host: inner }).then((h) => (host = h));
      },
    });
    expect((await remote.connect()).ok).toBe(true);
    expect(calls).toBe(1);
  });

  it('when the host dies, every agent it ran gets an exit event (not requested) and spawning works again with a new host', async () => {
    host = await startPtyHost({ homeDir: home, host: inner });
    const remote = client({
      startHost: () => {
        void startPtyHost({ homeDir: home, host: createTerminalHost() }).then((h) => (host = h));
      },
    });
    await remote.connect();
    const events: TerminalEvent[] = [];
    remote.onEvent((e) => events.push(e));
    await remote.spawnAsync('ana', 1, counting());
    await until(() => remote.info('ana')?.running === true);
    await host.close(true); // the host process is gone, and its agents with it
    host = null;
    await until(() => events.some((e) => e.kind === 'exit' && e.name === 'ana'), 8000, 'the exit event of the lost agent');
    const exit = events.find((e) => e.kind === 'exit' && e.name === 'ana');
    expect(exit?.kind === 'exit' && exit.info.requested).toBe(false);
    expect(remote.info('ana')?.running).toBe(false);
    expect(remote.write('ana', 'x')).toBe(false);
    // a start after the loss brings up a new host
    const { pid } = await remote.spawnAsync('ana', 2, counting());
    expect(pid).toBeGreaterThan(0);
    await remote.stopAll();
  });

  it('a submit goes through only once the agent has bracketed paste on, and only for its generation', async () => {
    host = await startPtyHost({ homeDir: home, host: inner });
    const remote = client();
    await remote.connect();
    await remote.spawnAsync('ana', 1, {
      file: process.execPath,
      args: ['-e', 'process.stdout.write("\\x1b[?2004h"); process.stdin.on("data", (d) => process.stdout.write("got:" + JSON.stringify(String(d)))); setInterval(() => {}, 1000);'],
      env: { PATH: process.env.PATH ?? '' },
      cwd: home,
    });
    await until(() => remote.list?.().find((i) => i.name === 'ana')?.paste === true, 8000, 'paste mode');
    expect(remote.submit('ana', 2, 'wrong generation')).toBe(false);
    expect(remote.submit('ana', 1, POINTER)).toBe(true);
    const seen: string[] = [];
    const a = await remote.attach('ana', (c) => seen.push(Buffer.from(c).toString()));
    a.start();
    await until(() => (a.snapshot.data + seen.join('')).includes('read_messages'), 8000, 'the pasted text');
    a.detach();
  });
});
