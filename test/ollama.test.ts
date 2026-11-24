import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createManagedOllama, DEFAULT_SETTINGS, ManagedError, settingsProblem, sharedNetwork } from '../src/server/ollama.js';
import type { ManagedOllama } from '../src/server/ollama.js';
import { nullLogger } from '../src/server/constants.js';

/** A stand-in `ollama`: the few routes gonogo uses, on OLLAMA_HOST; `POST /crash` dies; it starts a `sleep` child so that the group has two processes. */
const FAKE = `#!/usr/bin/env node
const http = require('node:http');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
if (process.argv[2] === '--version') { console.log('Warning: could not connect to a running Ollama instance'); console.log('ollama version is 0.40.18'); process.exit(0); }
const [host, port] = process.env.OLLAMA_HOST.split(':');
const models = process.env.OLLAMA_MODELS;
fs.mkdirSync(models, { recursive: true });
const runner = spawn('sleep', ['300'], { stdio: 'ignore' });
fs.writeFileSync(models + '/runner.pid', String(runner.pid));
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url === '/api/version') return res.end('{"version":"0.0.0-fake"}');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: fs.readdirSync(models).filter((f) => f.endsWith('.model')).map((f) => ({ name: f.replace('.model', '') + ':latest' })) }));
    if (req.url === '/api/pull') {
      const name = JSON.parse(body).model;
      if (name === 'fail-me') { res.write(JSON.stringify({ error: 'nope, a secret detail' }) + '\\n'); return res.end(); }
      res.write(JSON.stringify({ status: 'pulling', total: 100, completed: 50 }) + '\\n');
      fs.writeFileSync(models + '/' + name + '.model', 'x');
      res.write(JSON.stringify({ status: 'success' }) + '\\n');
      return res.end();
    }
    if (req.url === '/env') return res.end(JSON.stringify({ env: process.env, host, port }));
    if (req.url === '/crash') { res.end('bye'); return setTimeout(() => process.exit(1), 20); }
    res.statusCode = 404; res.end('{}');
  });
}).listen(Number(port), host);
`;

let work: string;
let releaseServer: http.Server;
let releaseUrl: string;
let sha: string;
let hits: number;

/** A tar.zst of a tiny release: the binary, a CPU library, and a CUDA folder that must not be unpacked. */
function buildArchive(dir: string): Buffer {
  const root = join(dir, 'release');
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'lib', 'ollama', 'cuda_v12'), { recursive: true });
  writeFileSync(join(root, 'bin', 'ollama'), FAKE, { mode: 0o755 });
  writeFileSync(join(root, 'lib', 'ollama', 'libggml-base.so.1.0.0'), 'cpu');
  writeFileSync(join(root, 'lib', 'ollama', 'cuda_v12', 'libggml-cuda.so'), 'cuda');
  const tar = spawnSync('tar', ['-cf', '-', '-C', root, 'bin', 'lib'], { maxBuffer: 1 << 26 });
  if (tar.status !== 0) throw new Error('tar failed');
  return zstdCompressSync(tar.stdout);
}

beforeEach(async () => {
  work = mkdtempSync(join(tmpdir(), 'gonogo-ollama-'));
  const archive = buildArchive(work);
  sha = createHash('sha256').update(archive).digest('hex');
  hits = 0;
  releaseServer = http.createServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { 'content-length': archive.length, 'content-type': 'application/octet-stream' });
    res.end(archive);
  });
  await new Promise<void>((resolve) => releaseServer.listen(0, '127.0.0.1', resolve));
  releaseUrl = `http://127.0.0.1:${(releaseServer.address() as { port: number }).port}/ollama.tar.zst`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => releaseServer.close(() => resolve()));
  rmSync(work, { recursive: true, force: true });
});

const make = (extra: Partial<Parameters<typeof createManagedOllama>[0]> = {}): ManagedOllama =>
  createManagedOllama({ dir: join(work, 'ollama'), log: nullLogger, now: () => Date.now(), arch: 'x64', platform: 'linux', releaseUrl: () => releaseUrl, sha256: sha, imageBin: join(work, 'no-image', 'bin', 'ollama'), env: { PATH: process.env.PATH, GONOGO_TOKEN: 'secret-token' }, backoffMs: 20, tickMs: 20, ...extra });

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const json = async (url: string): Promise<Record<string, unknown>> => (await (await fetch(url)).json()) as Record<string, unknown>;

describe('managed Ollama', () => {
  it('downloads the pinned release, unpacks only the CPU part, starts on loopback with an environment of its own, and pulls the model', async () => {
    const m = make();
    expect(await m.needsDownload()).toBe(true);
    const url = await m.acquire('nomic-embed-text');
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(hits).toBe(1);
    const unpacked = join(work, 'ollama', '0.40.18');
    expect(existsSync(join(unpacked, 'bin', 'ollama'))).toBe(true);
    expect(existsSync(join(unpacked, 'lib', 'ollama', 'libggml-base.so.1.0.0'))).toBe(true);
    expect(existsSync(join(unpacked, 'lib', 'ollama', 'cuda_v12'))).toBe(false);
    // no temporary file is left
    expect(readdirSync(join(work, 'ollama')).filter((n) => n.startsWith('.install'))).toEqual([]);
    expect(m.status()).toMatchObject({ state: 'ready', port: expect.any(Number), version: '0.40.18' });
    // it listens where it was told to and nothing of gonogo's environment reached it
    const seen = (await json(`${url}/env`)) as { env: Record<string, string>; host: string };
    expect(seen.host).toBe('127.0.0.1');
    expect(Object.keys(seen.env).filter((k) => k.startsWith('OLLAMA_')).sort()).toEqual(['OLLAMA_HOST', 'OLLAMA_KEEP_ALIVE', 'OLLAMA_MAX_LOADED_MODELS', 'OLLAMA_MODELS', 'OLLAMA_NOHISTORY', 'OLLAMA_NO_CLOUD', 'OLLAMA_NUM_PARALLEL']);
    expect(JSON.stringify(seen.env)).not.toContain('secret-token');
    expect(seen.env.OLLAMA_HOST).toBe(`127.0.0.1:${m.status().port}`);
    expect(((await json(`${url}/api/tags`)) as { models: Array<{ name: string }> }).models.map((x) => x.name)).toEqual(['nomic-embed-text:latest']);
    // a second request does not start anything again
    expect(await m.acquire('nomic-embed-text')).toBe(url);
    expect(hits).toBe(1);
    await m.stop();
    expect(m.status().state).toBe('off');
    expect(await m.needsDownload()).toBe(false);
  });

  it('refuses an archive that does not match the pinned checksum, and unpacks nothing of it', async () => {
    const m = make({ sha256: '0'.repeat(64) });
    await expect(m.acquire('nomic-embed-text')).rejects.toThrow(/does not match the checksum/);
    expect(existsSync(join(work, 'ollama', '0.40.18'))).toBe(false);
    expect(readdirSync(join(work, 'ollama'))).toEqual([]);
    expect(m.status()).toMatchObject({ state: 'error', reason: expect.stringContaining('checksum') });
    // the error is not retried at once
    await expect(m.acquire('nomic-embed-text')).rejects.toThrow(/checksum/);
    expect(hits).toBe(1);
  });

  it('says in fixed words that a model could not be pulled, and keeps what the server said out of it', async () => {
    const m = make();
    const error = await m.acquire('fail-me').then(() => null, (e: unknown) => e as Error);
    expect(error).toBeInstanceOf(ManagedError);
    expect(error?.message).toBe('the model could not be pulled (is the name right, and the machine online?)');
    expect(JSON.stringify(m.status())).not.toContain('secret detail');
    await m.stop();
  });

  it('kills the whole group when it stops: the server and the process it started', async () => {
    const m = make();
    const url = await m.acquire('nomic-embed-text');
    const pid = Number((await import('node:fs')).readFileSync(join(work, 'ollama', 'models', 'runner.pid'), 'utf8'));
    expect(alive(pid)).toBe(true);
    void url;
    await m.stop();
    expect(alive(pid)).toBe(false);
  });

  it('starts it again after it dies, with a backoff, on another port, and does not leave the process it had started', async () => {
    const m = make();
    const url = await m.acquire('nomic-embed-text');
    const first = m.status().port;
    const orphan = Number((await import('node:fs')).readFileSync(join(work, 'ollama', 'models', 'runner.pid'), 'utf8'));
    expect(alive(orphan)).toBe(true);
    await fetch(`${url}/crash`).catch(() => undefined);
    for (let i = 0; i < 200 && !(m.status().restarts >= 1 && m.status().state === 'ready'); i += 1) await new Promise((r) => setTimeout(r, 50));
    expect(m.status()).toMatchObject({ state: 'ready', restarts: 1 });
    expect(m.status().port).not.toBeNull();
    expect(m.status().port).not.toBe(first);
    // the runner of the dead server went with its group (it would hold the model in memory for ever)
    for (let i = 0; i < 100 && alive(orphan); i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(alive(orphan)).toBe(false);
    await m.stop();
  });

  it('stops after it has been idle, and starts again for the next request', async () => {
    let clock = Date.now();
    const m = make({ now: () => clock });
    await m.acquire('nomic-embed-text');
    m.settings({ idleMinutes: 1 });
    clock += 30_000;
    await new Promise((r) => setTimeout(r, 100));
    expect(m.status().state).toBe('ready');
    clock += 31_000;
    for (let i = 0; i < 100 && m.status().state === 'ready'; i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(m.status().state).toBe('off');
    expect(m.status().reason).toContain('idle');
    expect(m.status().port).toBeNull();
    const again = await m.acquire('nomic-embed-text').catch((e: unknown) => { throw new Error(`${(e as Error).message} :: ${m.logs().join(' | ')}`); });
    expect(again).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(hits).toBe(1);
    await m.stop();
  });

  it('stops over its memory limit and waits for the Director', async () => {
    const m = make({ rss: async () => 500 });
    await m.acquire('nomic-embed-text');
    m.settings({ memoryMb: 100 });
    for (let i = 0; i < 100 && m.status().state === 'ready'; i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(m.status()).toMatchObject({ state: 'error', port: null });
    expect(m.status().reason).toContain('500 MB');
    await expect(m.acquire('nomic-embed-text')).rejects.toThrow(/over the limit/);
    // a larger limit, or his start key, lets it run
    m.settings({ memoryMb: 0 });
    expect(await m.acquire('nomic-embed-text')).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await m.stop();
  });

  it('is not offered on a platform it has no release for', async () => {
    const m = make({ platform: 'darwin' });
    expect(m.status()).toMatchObject({ state: 'unsupported' });
    await expect(m.acquire('nomic-embed-text')).rejects.toThrow(/Linux/);
    expect(hits).toBe(0);
  });

  it('does not run a downloaded copy that says it is another version, and downloads the pinned one', async () => {
    const stale = join(work, 'ollama', '0.40.18', 'bin');
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, 'ollama'), "#!/bin/sh\necho 'ollama version is 9.9.9'\n", { mode: 0o755 });
    const m = make();
    expect(await m.needsDownload()).toBe(true);
    await m.acquire('nomic-embed-text');
    expect(hits).toBe(1);
    expect(m.status().state).toBe('ready');
    await m.stop();
    // the pinned one replaced it and says so
    expect(spawnSync(join(work, 'ollama', '0.40.18', 'bin', 'ollama'), ['--version'], { encoding: 'utf8' }).stdout).toContain('0.40.18');
  });

  it('says in its status when the Clean Rooms share gonogo\'s network', () => {
    expect(make().status().shared).toBe(false);
    expect(make({ env: { PATH: process.env.PATH, GONOGO_CLEANROOM_NETWORK: 'container:self' } }).status().shared).toBe(true);
    expect(make({ env: { PATH: process.env.PATH, GONOGO_CLEANROOM_NETWORK: 'gonogo_default' } }).status().shared).toBe(false);
    expect(sharedNetwork({})).toBe(false);
  });

  it('uses a binary it is given instead of downloading', async () => {
    const own = join(work, 'own', 'ollama');
    mkdirSync(join(work, 'own'), { recursive: true });
    writeFileSync(own, FAKE, { mode: 0o755 });
    const m = make({ env: { PATH: process.env.PATH, GONOGO_OLLAMA_BIN: own } });
    expect(await m.needsDownload()).toBe(false);
    await m.acquire('nomic-embed-text');
    expect(hits).toBe(0);
    await m.stop();
  });

  it('keeps the last 200 lines the server wrote, and validates the settings', async () => {
    expect(settingsProblem({ keepAlive: '5m', idleMinutes: 10, threads: 0, memoryMb: 0 })).toBeNull();
    expect(settingsProblem({ keepAlive: 'forever' })?.field).toBe('keepAlive');
    expect(settingsProblem({ idleMinutes: -1 })?.field).toBe('idleMinutes');
    expect(settingsProblem({ threads: 1.5 })?.field).toBe('threads');
    expect(settingsProblem({ memoryMb: 'big' })?.field).toBe('memoryMb');
    expect(settingsProblem({ shell: 'sh' })?.field).toBe('shell');
    const m = make();
    expect(m.settings()).toEqual(DEFAULT_SETTINGS);
    expect(() => m.settings({ keepAlive: 'x' })).toThrow(ManagedError);
    expect(m.logs()).toEqual([]);
  });
});
