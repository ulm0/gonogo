/**
 * Search by meaning, managed mode (docs/features/semantic-search.md): gonogo runs its own Ollama so that nothing has to be installed. It
 *
 * - finds a pinned Ollama: `GONOGO_OLLAMA_BIN`, the one the Docker image carries (`/opt/ollama`), or one it downloads once into `<dir>/<version>`: the
 *   release archive of that exact version (CPU is all it needs: the binary and the ggml CPU libraries, 79 MB of the 1.6 GB archive), checked against the
 *   sha256 written in this file BEFORE a byte of it is unpacked;
 * - starts `ollama serve` itself, on demand, with no shell, in its own process group, on `127.0.0.1:<a free port>` (never another address), with an
 *   environment of its own (PATH and the OLLAMA_ variables below: no token or key of gonogo's reaches it), its models in `<dir>/models`;
 * - pulls the embedding model when it is not there, with progress;
 * - restarts it when it dies, with a backoff, stops it after it has been idle for a while or when it holds too much memory, and kills its whole group when
 *   gonogo stops.
 * What it says on its output is kept (the last 200 lines) for the page; what the registry or the release server says is never shown: fixed words.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rename, rm, stat, statfs } from 'node:fs/promises';
import { createServer } from 'node:net';
import { arch as osArch, platform as osPlatform } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { createZstdDecompress } from 'node:zlib';
import type { Logger } from '../shared/protocol.js';
import { DIR_MODE } from './constants.js';

/** The Ollama release gonogo pins, and the sha256 of its linux archive for each CPU (from the release's sha256sum.txt, 2026-11-24). */
export const OLLAMA_VERSION = '0.40.18';
export const OLLAMA_SHA256: Readonly<Record<'x64' | 'arm64', string>> = {
  x64: 'b82649006cb5b54ed1237fa2d1a26a7f939a4fd03150033759acbff7ff315adf',
  arm64: '63f01dae3b65641866991e75e2aecb7aed8a4041f4c2c3c7d92862c5a47ebed6',
};
const RELEASE_ARCH: Readonly<Record<'x64' | 'arm64', string>> = { x64: 'amd64', arm64: 'arm64' };
/** The archive is refused past this size (it is 1.65 to 1.7 GB), and the disk must have room for it. */
export const DOWNLOAD_MAX_BYTES = 2_200_000_000;
/** Inside the Docker image: the CPU subset of the same release, put there at build time. */
export const IMAGE_OLLAMA_BIN = '/opt/ollama/bin/ollama';

export const LOG_LINES_MAX = 200;
export const READY_TIMEOUT_MS = 30_000;
const CRASH_WINDOW_MS = 600_000;
const CRASHES_MAX = 5;
const BACKOFF_MAX_MS = 30_000;
const KILL_GRACE_MS = 5_000;
/** After a failure `acquire` leaves it alone for this long. */
export const RETRY_MS = 60_000;

export type ManagedState = 'off' | 'unsupported' | 'downloading' | 'starting' | 'pulling' | 'ready' | 'error';

export interface ManagedSettings {
  /** How long Ollama keeps the model in memory after a request (OLLAMA_KEEP_ALIVE: `5m`, `30s`, `0`). */
  keepAlive: string;
  /** Minutes without a request after which gonogo stops the server (0: it is stopped by hand only). */
  idleMinutes: number;
  /** CPU threads for an embedding (0: Ollama chooses). */
  threads: number;
  /** Memory the server and its children may hold, in MB (0: no limit); over it the server is stopped. */
  memoryMb: number;
}

export const DEFAULT_SETTINGS: ManagedSettings = { keepAlive: '5m', idleMinutes: 10, threads: 0, memoryMb: 0 };
const KEEP_ALIVE_RE = /^(?:0|[1-9]\d{0,3}[smh])$/;

export interface ManagedStatus {
  state: ManagedState;
  /** Fixed words about the last failure or what is going on, or ''. */
  reason: string;
  version: string;
  /** The loopback port while it runs. */
  port: number | null;
  /** Bytes of the download, or of the model pull, while one is going. */
  progress: { done: number; total: number } | null;
  /** Memory of the server and its children, in MB, while it runs. */
  rssMb: number | null;
  /** How many times it was restarted after dying. */
  restarts: number;
  settings: ManagedSettings;
}

/** A failure with words that are fixed: nothing a server sent is in it. */
export class ManagedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManagedError';
  }
}

export interface ManagedOptions {
  /** `<room home>/ollama`: the downloaded release, the models, the server's own home. */
  dir: string;
  log: Logger;
  now(): number;
  env?: NodeJS.ProcessEnv;
  /** The page is told something changed (progress, state). */
  changed?(): void;
  /** For tests. */
  platform?: string;
  arch?: string;
  /** The archive URL for a version and a release CPU name (default: the GitHub release). */
  releaseUrl?: (version: string, arch: string) => string;
  sha256?: string;
  fetch?: typeof fetch;
  /** Memory of a process group in MB (default: read from /proc). */
  rss?: (pgid: number) => Promise<number>;
  tickMs?: number;
  /** Milliseconds before the first restart after a crash (doubles up to 30 s). */
  backoffMs?: number;
  readyTimeoutMs?: number;
}

export interface ManagedOllama {
  status(): ManagedStatus;
  /** Makes sure the server runs with `model` pulled and answers with its address, `http://127.0.0.1:<port>`. Calls that come together share one start. */
  acquire(model: string): Promise<string>;
  /** A request was made: the idle clock starts again. */
  touch(): void;
  /** Starts it now (the Director's key), also after an error that waited for him. */
  start(model: string): Promise<void>;
  /** Stops it and its children. */
  stop(): Promise<void>;
  settings(patch?: Partial<ManagedSettings>): ManagedSettings;
  logs(): string[];
  /** Is there something to download (no pinned Ollama is on the machine yet)? */
  needsDownload(): Promise<boolean>;
}

/** Why a setting is refused, or null. */
export function settingsProblem(patch: Record<string, unknown>): { message: string; field: string } | null {
  for (const key of Object.keys(patch)) if (!['keepAlive', 'idleMinutes', 'threads', 'memoryMb'].includes(key)) return { message: `unknown field "${key}"`, field: key };
  if (patch.keepAlive !== undefined && (typeof patch.keepAlive !== 'string' || !KEEP_ALIVE_RE.test(patch.keepAlive))) return { message: 'keep-alive is a time like 30s, 5m or 1h, or 0', field: 'keepAlive' };
  const whole = (v: unknown, max: number): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
  if (patch.idleMinutes !== undefined && !whole(patch.idleMinutes, 1440)) return { message: 'idle minutes is a whole number from 0 to 1440', field: 'idleMinutes' };
  if (patch.threads !== undefined && !whole(patch.threads, 256)) return { message: 'threads is a whole number from 0 to 256', field: 'threads' };
  if (patch.memoryMb !== undefined && !whole(patch.memoryMb, 1_048_576)) return { message: 'memory is a whole number of MB, 0 for no limit', field: 'memoryMb' };
  return null;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('no port'))));
    });
  });
}

/** Memory of every process in a process group, in MB, from /proc (Linux). */
async function groupRssMb(pgid: number): Promise<number> {
  let kb = 0;
  for (const name of await readdir('/proc').catch(() => [] as string[])) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = await readFile(`/proc/${name}/stat`, 'utf8');
      // after the command name (which may hold spaces and brackets): state, ppid, pgrp
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(rest[2]) !== pgid) continue;
      const status = await readFile(`/proc/${name}/status`, 'utf8');
      kb += Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0);
    } catch {
      // gone while it was read
    }
  }
  return Math.round(kb / 1024);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createManagedOllama(options: ManagedOptions): ManagedOllama {
  const { log, dir } = options;
  const platform = options.platform ?? osPlatform();
  const cpu = options.arch ?? osArch();
  const releaseArch = cpu === 'x64' || cpu === 'arm64' ? RELEASE_ARCH[cpu] : null;
  const supported = platform === 'linux' && releaseArch !== null;
  const expected = options.sha256 ?? (cpu === 'x64' || cpu === 'arm64' ? OLLAMA_SHA256[cpu] : '');
  const releaseUrl = options.releaseUrl ?? ((version, a) => `https://github.com/ollama/ollama/releases/download/v${version}/ollama-linux-${a}.tar.zst`);
  const doFetch = options.fetch ?? fetch;
  const env = options.env ?? process.env;
  const rssOf = options.rss ?? groupRssMb;
  let settings: ManagedSettings = { ...DEFAULT_SETTINGS };
  let state: ManagedState = supported ? 'off' : 'unsupported';
  let reason = supported ? '' : 'managed Ollama runs on Linux (x64 or arm64): install Ollama yourself and use the Remote mode';
  let port: number | null = null;
  let child: ChildProcess | null = null;
  let progress: ManagedStatus['progress'] = null;
  let rssMb: number | null = null;
  let restarts = 0;
  let crashes: number[] = [];
  let lastUse = 0;
  /** An error that waits for the Director (a memory limit): `acquire` does not start again by itself. */
  let blocked = false;
  let retryAt = 0;
  let wantedModel = '';
  let starting: Promise<string> | null = null;
  let stopping = false;
  let timer: NodeJS.Timeout | null = null;
  const lines: string[] = [];

  const tell = (): void => options.changed?.();
  const set = (next: ManagedState, why = ''): void => {
    state = next;
    reason = why;
    tell();
  };
  const note = (text: string): void => {
    for (const raw of text.split('\n')) {
      const line = raw.replace(/\s+$/, '').slice(0, 300);
      if (line === '') continue;
      lines.push(line);
      if (lines.length > LOG_LINES_MAX) lines.shift();
    }
  };

  const versionDir = (): string => join(dir, OLLAMA_VERSION);
  /** The pinned server: an explicit one, the image's, or the downloaded one. Null when it has to be downloaded. */
  async function findBin(): Promise<string | null> {
    for (const candidate of [env.GONOGO_OLLAMA_BIN ?? '', IMAGE_OLLAMA_BIN, join(versionDir(), 'bin', 'ollama')]) {
      if (candidate === '') continue;
      try {
        if ((await stat(candidate)).isFile()) return candidate;
      } catch {
        // not there
      }
    }
    return null;
  }

  /** Downloads the release archive, checks its sha256, and only then unpacks the CPU part of it. */
  async function install(): Promise<string> {
    if (releaseArch === null) throw new ManagedError('this CPU has no Ollama release');
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    const url = releaseUrl(OLLAMA_VERSION, releaseArch);
    const tmp = join(dir, `.install-${randomBytes(4).toString('hex')}`);
    const archive = `${tmp}.tar.zst`;
    set('downloading', 'downloading Ollama');
    progress = { done: 0, total: 0 };
    try {
      let res: Response;
      try {
        res = await doFetch(url, { redirect: 'follow' });
      } catch {
        throw new ManagedError('the download could not be started');
      }
      if (!res.ok || res.body === null) throw new ManagedError(`the download answered ${res.status}`);
      const total = Number(res.headers.get('content-length')) || 0;
      if (total > DOWNLOAD_MAX_BYTES) throw new ManagedError('the archive is larger than expected');
      progress = { done: 0, total };
      // room for the archive and a little more, before it is started
      const free = await statfs(dir).then((s) => s.bavail * s.bsize, () => Number.POSITIVE_INFINITY);
      if (free < (total || 1_800_000_000) * 1.1) throw new ManagedError('not enough free disk space for the download (about 2 GB)');
      const hash = createHash('sha256');
      let done = 0;
      const count = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          done += chunk.length;
          if (done > DOWNLOAD_MAX_BYTES) return cb(new ManagedError('the archive is larger than expected'));
          hash.update(chunk);
          progress = { done, total };
          cb(null, chunk);
        },
      });
      let last = 0;
      const poll = setInterval(() => {
        if (options.now() - last > 500) {
          last = options.now();
          tell();
        }
      }, 500);
      try {
        await pipeline(Readable.fromWeb(res.body as never), count, createWriteStream(archive, { mode: 0o600 }));
      } catch (e) {
        throw e instanceof ManagedError ? e : new ManagedError('the download broke');
      } finally {
        clearInterval(poll);
      }
      // nothing of it is unpacked before this
      if (hash.digest('hex') !== expected) throw new ManagedError('the download does not match the checksum pinned in this gonogo');
      const staged = join(tmp, 'unpacked');
      await mkdir(staged, { recursive: true, mode: DIR_MODE });
      await new Promise<void>((resolve, reject) => {
        const tar = spawn('tar', ['-xf', '-', '-C', staged, '--no-same-owner', '--no-same-permissions', '--exclude=lib/ollama/cuda_*', '--exclude=lib/ollama/vulkan', '--exclude=lib/ollama/rocm*', '--exclude=lib/ollama/mlx*', '--exclude=lib/ollama/jetpack*'], {
          stdio: ['pipe', 'ignore', 'ignore'],
        });
        tar.once('error', () => reject(new ManagedError('tar could not be run to unpack it')));
        tar.once('close', (code) => (code === 0 ? resolve() : reject(new ManagedError('the archive could not be unpacked'))));
        pipeline(createReadStream(archive), createZstdDecompress(), tar.stdin).catch(() => {
          tar.kill('SIGKILL');
          reject(new ManagedError('the archive could not be unpacked'));
        });
      });
      const bin = join(staged, 'bin', 'ollama');
      if (!(await stat(bin).then((s) => s.isFile(), () => false))) throw new ManagedError('the archive has no ollama binary');
      await chmod(bin, 0o755);
      await rm(versionDir(), { recursive: true, force: true });
      await rename(staged, versionDir());
      log.info(`Ollama ${OLLAMA_VERSION} installed in ${versionDir()}`);
      return join(versionDir(), 'bin', 'ollama');
    } finally {
      progress = null;
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      await rm(archive, { force: true }).catch(() => undefined);
    }
  }

  async function api(path: string, init?: RequestInit): Promise<Response> {
    return doFetch(`http://127.0.0.1:${port}${path}`, { ...init, redirect: 'manual', signal: AbortSignal.timeout(init?.method === 'POST' ? 3_600_000 : 10_000) });
  }

  async function launch(bin: string): Promise<void> {
    port = await freePort();
    await mkdir(join(dir, 'models'), { recursive: true, mode: DIR_MODE });
    await mkdir(join(dir, 'home'), { recursive: true, mode: DIR_MODE });
    const child1 = spawn(bin, ['serve'], {
      cwd: dir,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // an environment of its own: nothing of gonogo's (a token, a key) is in it, and it is told to listen on loopback only
      env: {
        PATH: env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: join(dir, 'home'),
        OLLAMA_HOST: `127.0.0.1:${port}`,
        OLLAMA_MODELS: join(dir, 'models'),
        OLLAMA_KEEP_ALIVE: settings.keepAlive,
        OLLAMA_MAX_LOADED_MODELS: '1',
        OLLAMA_NUM_PARALLEL: '1',
        OLLAMA_NOHISTORY: '1',
        OLLAMA_NO_CLOUD: '1',
      },
    });
    child = child1;
    child1.stdout?.on('data', (d: Buffer) => note(d.toString('utf8')));
    child1.stderr?.on('data', (d: Buffer) => note(d.toString('utf8')));
    child1.once('error', (e) => {
      note(`could not start: ${e.message}`);
    });
    child1.once('exit', (code, signal) => {
      if (child !== child1) return;
      child = null;
      port = null;
      rssMb = null;
      if (stopping) return;
      // it died by itself: the runner it started is still in its group, holding the model in memory: the whole group goes
      if (child1.pid !== undefined) {
        try {
          process.kill(-child1.pid, 'SIGKILL');
        } catch {
          // nothing left
        }
      }
      note(`exited (${signal ?? code})`);
      crashed();
    });
    // ready when it answers
    const limit = options.now() + (options.readyTimeoutMs ?? READY_TIMEOUT_MS);
    for (;;) {
      if (child !== child1) throw new ManagedError('the server stopped while it started');
      try {
        const r = await api('/api/version');
        if (r.status === 200) break;
      } catch {
        // not yet
      }
      if (options.now() > limit) throw new ManagedError('the server did not answer in time');
      await sleep(100);
    }
  }

  /** It died by itself: restart it after a backoff while it is wanted, and give up after five deaths in ten minutes. */
  function crashed(): void {
    const at = options.now();
    crashes = crashes.filter((t) => at - t < CRASH_WINDOW_MS);
    crashes.push(at);
    if (crashes.length >= CRASHES_MAX) {
      set('error', 'the server died five times in ten minutes: see the log');
      retryAt = at + RETRY_MS;
      return;
    }
    set('starting', 'the server died: starting it again');
    restarts += 1;
    const delay = Math.min(BACKOFF_MAX_MS, (options.backoffMs ?? 1000) * 2 ** (crashes.length - 1));
    setTimeout(() => {
      if (stopping || child !== null || starting !== null || wantedModel === '') return;
      starting = begin(wantedModel)
        .catch(() => undefined)
        .then(() => '')
        .finally(() => {
          starting = null;
        });
    }, delay).unref();
  }

  async function pullModel(model: string): Promise<void> {
    const tags = await api('/api/tags').then((r) => r.json() as Promise<{ models?: Array<{ name?: string }> }>, () => null);
    const has = tags?.models?.some((m) => typeof m.name === 'string' && (m.name === model || m.name === `${model}:latest`));
    if (has === true) return;
    set('pulling', `pulling ${model}`);
    progress = { done: 0, total: 0 };
    try {
      const res = await api('/api/pull', { method: 'POST', body: JSON.stringify({ model, stream: true }), headers: { 'content-type': 'application/json' } });
      if (res.status !== 200 || res.body === null) throw new ManagedError('the model could not be pulled');
      let buffer = '';
      let failed = false;
      let last = 0;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += Buffer.from(chunk).toString('utf8');
        const parts = buffer.split('\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          let message: { error?: unknown; total?: unknown; completed?: unknown; status?: unknown } = {};
          try {
            message = JSON.parse(part) as typeof message;
          } catch {
            continue;
          }
          if (message.error !== undefined) failed = true;
          if (typeof message.total === 'number' && typeof message.completed === 'number') progress = { done: message.completed, total: message.total };
          if (options.now() - last > 500) {
            last = options.now();
            tell();
          }
        }
      }
      if (failed) throw new ManagedError('the model could not be pulled (is the name right, and the machine online?)');
    } catch (e) {
      throw e instanceof ManagedError ? e : new ManagedError('the model could not be pulled');
    } finally {
      progress = null;
    }
  }

  async function begin(model: string): Promise<string> {
    wantedModel = model;
    try {
      let bin = await findBin();
      if (bin === null) bin = await install();
      if (child === null) {
        set('starting', 'starting the server');
        await launch(bin);
      }
      await pullModel(model);
      lastUse = options.now();
      set('ready');
      return `http://127.0.0.1:${port}`;
    } catch (e) {
      const why = e instanceof ManagedError ? e.message : 'the server could not be started';
      if (!(e instanceof ManagedError)) log.warn('managed Ollama could not be started', e);
      await killChild();
      set('error', why);
      retryAt = options.now() + RETRY_MS;
      throw e instanceof ManagedError ? e : new ManagedError(why);
    }
  }

  async function killChild(): Promise<void> {
    const c = child;
    if (c === null || c.pid === undefined) return;
    child = null;
    port = null;
    rssMb = null;
    const done = new Promise<void>((resolve) => c.once('exit', () => resolve()));
    // the whole group: the server and the runner it starts
    try {
      process.kill(-c.pid, 'SIGTERM');
    } catch {
      // gone
    }
    const killed = await Promise.race([done.then(() => true), sleep(KILL_GRACE_MS).then(() => false)]);
    if (!killed) {
      try {
        process.kill(-c.pid, 'SIGKILL');
      } catch {
        // gone
      }
      await Promise.race([done, sleep(1000)]);
    }
  }

  /** One tick at a time: a second one that came while the first was stopping the server would stop the next one too. */
  let ticking = false;
  const tick = (): void => {
    const c = child;
    if (ticking || c === null || c.pid === undefined || state !== 'ready') return;
    ticking = true;
    void (async () => {
      try {
        const held = await rssOf(c.pid as number);
        if (child !== c || state !== 'ready') return;
        rssMb = held;
        if (settings.memoryMb > 0 && held > settings.memoryMb) {
          note(`stopped: ${held} MB is over the limit of ${settings.memoryMb} MB`);
          await stopNow();
          blocked = true;
          set('error', `the server held ${held} MB, over the limit of ${settings.memoryMb} MB: raise the limit or start it again`);
          return;
        }
        if (settings.idleMinutes > 0 && options.now() - lastUse > settings.idleMinutes * 60_000) {
          log.info('managed Ollama stopped: idle');
          await stopNow();
          set('off', 'stopped after being idle');
          return;
        }
        tell();
      } catch {
        // the next tick
      } finally {
        ticking = false;
      }
    })();
  };

  async function stopNow(): Promise<void> {
    stopping = true;
    wantedModel = '';
    try {
      await killChild();
    } finally {
      stopping = false;
    }
  }

  const ensureTimer = (): void => {
    if (timer !== null) return;
    timer = setInterval(tick, options.tickMs ?? 5000);
    timer.unref();
  };

  return {
    status: () => ({ state, reason, version: OLLAMA_VERSION, port, progress, rssMb, restarts, settings: { ...settings } }),

    async acquire(model) {
      if (!supported) throw new ManagedError(reason);
      ensureTimer();
      if (state === 'ready' && child !== null && port !== null && model === wantedModel) {
        lastUse = options.now();
        return `http://127.0.0.1:${port}`;
      }
      if (starting !== null) return starting;
      if (blocked) throw new ManagedError(reason);
      if (state === 'error' && options.now() < retryAt) throw new ManagedError(reason);
      if (child !== null && model !== wantedModel) {
        // another model: the server stays, the model is pulled
        wantedModel = model;
        starting = pullModel(model)
          .then(() => {
            lastUse = options.now();
            set('ready');
            return `http://127.0.0.1:${port}`;
          })
          .catch((e) => {
            set('error', e instanceof ManagedError ? e.message : 'the model could not be pulled');
            retryAt = options.now() + RETRY_MS;
            throw e;
          })
          .finally(() => {
            starting = null;
          });
        return starting;
      }
      starting = begin(model).finally(() => {
        starting = null;
      });
      return starting;
    },

    touch() {
      lastUse = options.now();
    },

    async start(model) {
      if (!supported) throw new ManagedError(reason);
      blocked = false;
      retryAt = 0;
      crashes = [];
      ensureTimer();
      if (starting !== null) {
        await starting;
        return;
      }
      if (child !== null) await stopNow();
      starting = begin(model).finally(() => {
        starting = null;
      });
      await starting;
    },

    async stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      if (starting !== null) await starting.catch(() => undefined);
      await stopNow();
      if (supported) set('off', '');
    },

    settings(patch) {
      if (patch !== undefined) {
        const problem = settingsProblem(patch);
        if (problem !== null) throw new ManagedError(problem.message);
        const keepChanged = patch.keepAlive !== undefined && patch.keepAlive !== settings.keepAlive;
        settings = { ...settings, ...patch } as ManagedSettings;
        // a larger limit lets a stopped server start again
        if (patch.memoryMb !== undefined) blocked = false;
        // OLLAMA_KEEP_ALIVE is read at start: a running server is stopped, and the next request starts it with the new one
        if (keepChanged && child !== null) void stopNow().then(() => set('off', 'stopped to apply the new keep-alive'));
      }
      return { ...settings };
    },

    logs: () => [...lines],

    async needsDownload() {
      return supported && (await findBin()) === null && !existsSync(versionDir());
    },
  };
}
