#!/usr/bin/env node
/**
 * pnpm check:pack: packs the project, then runs the packed package in plain Node (contract 10.8).
 *
 * Nothing else does this. `pnpm test` runs from `src` through vitest, and the failures that only a built run shows (a
 * CommonJS named import, a missing `.js` suffix, a wrong `dist` layout, the `../../package.json` read, the default
 * `dist/client` path, the bin and its shebang, the engines guard) would otherwise reach the first user.
 *
 * It runs `pnpm pack`, whose `prepack` removes and rebuilds `dist`, so do not run it while something else uses `dist`.
 * Run it through `pnpm check:pack`: every step uses the pnpm that runs the script (package.json `packageManager`).
 * Needs the npm registry (the packed package's dependencies are installed). Every pnpm call runs with an empty user
 * config and a temporary HOME, store and cache: the owner's ~/.npmrc holds a registry token that must never be read or sent.
 * Prints `ok <n> <step>` per step; the first failure prints `check-pack: FAIL <step>: <reason>` and exits 1.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_READY = /^gonogo ready: (\S+)$/m;
// Only what a proxy or a private CA needs; everything else is dropped, like `env -i`.
const NETWORK_ENV = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tail = (text, lines = 25) => text.trimEnd().split('\n').slice(-lines).join('\n');
const fail = (step, reason) => {
  throw new Error(`${step}: ${reason}`);
};

/**
 * Problems in the tarball's file list, [] when it is exactly what contract 10.8 step 1 allows. `serverModules` are the
 * names of src/server/*.ts: a compiled module without a source is stale, a source without a compiled module is missing.
 */
export function listProblems(entries, serverModules) {
  const problems = [];
  const have = new Set(entries);
  // The licence and the notices of the bundled client libraries are what make a publish safe, so a
  // pack that loses one of them fails here instead of reaching a user.
  const required = [
    'package/bin/gonogo.js',
    'package/package.json',
    'package/README.md',
    'package/LICENSE',
    'package/dist/shared/protocol.js',
    'package/dist/shared/positions.js',
    'package/dist/shared/fuel.js',
    'package/dist/shared/cron.js',
    'package/dist/shared/diff.js',
    'package/dist/shared/layout.js',
    'package/dist/shared/livery.js',
    'package/dist/shared/prices.js',
    'package/dist/client/index.html',
    'package/dist/client/THIRD-PARTY-NOTICES.md',
    ...serverModules.map((m) => `package/dist/server/${m}.js`),
  ];
  for (const r of required) if (!have.has(r)) problems.push(`missing ${r}`);
  const fixed = [
    /^package\/bin\/gonogo\.js$/,
    /^package\/package\.json$/,
    /^package\/README\.md$/,
    /^package\/licen[cs]e(\.[^/]+)?$/i,
    /^package\/dist\/shared\/(protocol|positions|fuel|cron|diff|layout|livery|prices)\.js$/,
    /^package\/dist\/client\/.+/,
  ];
  for (const e of entries) {
    if (fixed.some((re) => re.test(e))) continue;
    const module = /^package\/dist\/server\/([^/]+)\.js$/.exec(e);
    if (module && serverModules.includes(module[1])) continue;
    problems.push(module ? `stale module ${e} (there is no src/server/${module[1]}.ts)` : `unexpected ${e}`);
  }
  return problems;
}

/** Runs a command to the end. Output is kept and shown only on failure. The child stays in our process group so Ctrl-C reaches it. */
function run(cmd, args, { cwd, env, timeoutMs }) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      done({ code: -1, signal: null, stdout, stderr: `${stderr}${e.message}`, timedOut });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      done({ code, signal, stdout, stderr, timedOut });
    });
  });
}

/** Sends `path` exactly as given (fetch would normalise it), so `//` really reaches the server. */
function get(port, path, headers = {}) {
  return new Promise((done, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => done({ status: res.statusCode, headers: res.headers, body }));
    });
    req.setTimeout(10_000, () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end();
  });
}
const ask = (port, path, headers) => get(port, path, headers).catch((e) => fail('http', `GET ${path}: ${e.message}`));

const portIsClosed = (port) =>
  new Promise((done) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => {
      s.destroy();
      done(false);
    });
    s.once('error', () => done(true));
  });

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/** pids of the stand-in agents, from the `start` lines the stand-in writes into FAKE_CLAUDE_LOG_DIR (contract 9.9). */
async function standInPids(logDir) {
  const pids = [];
  for (const file of await readdir(logDir).catch(() => [])) {
    if (!file.endsWith('.jsonl')) continue;
    for (const line of (await readFile(join(logDir, file), 'utf8')).split('\n')) {
      try {
        const record = JSON.parse(line);
        if (record.e === 'start' && Number.isInteger(record.pid)) pids.push(record.pid);
      } catch {
        // a partial or foreign line
      }
    }
  }
  return pids;
}

async function main() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  let tarballName = '';
  // `pnpm run` names itself here (a pnpm.cjs, or the standalone binary of @pnpm/exe), so every step runs the pnpm
  // that package.json `packageManager` pins.
  const pnpmPath = process.env.npm_execpath;
  if (!pnpmPath || !/\/pnpm(\.c?js)?$/.test(pnpmPath) || !existsSync(pnpmPath)) fail('setup', `run it as \`pnpm check:pack\` (npm_execpath is ${JSON.stringify(pnpmPath ?? null)})`);
  const pnpm = (args, opts) => (/\.c?js$/.test(pnpmPath) ? run(process.execPath, [pnpmPath, ...args], opts) : run(pnpmPath, args, opts));

  console.log('check-pack: packing (this runs the build), then installing from the npm registry; it takes a minute or two');
  const tmp = await mkdtemp(join(tmpdir(), 'gonogo-pack-'));
  const emptyRc = join(tmp, 'empty.npmrc');
  const nodeBin = join(tmp, 'node-bin');
  const logDir = join(tmp, 'standin-log');
  // Parent npm_*, pnpm_* and XDG_* variables (configs, lifecycle, store and cache places) are dropped so the empty user
  // config and the temporary HOME are the only ones.
  const isolated = (base, label) => ({
    ...Object.fromEntries(Object.entries(base).filter(([k]) => !/^(npm|pnpm|xdg)_/i.test(k))),
    HOME: join(tmp, `home-${label}`),
    NPM_CONFIG_USERCONFIG: emptyRc,
    npm_config_store_dir: join(tmp, `store-${label}`),
    npm_config_cache_dir: join(tmp, `cache-${label}`),
    npm_config_update_notifier: 'false',
  });
  // Like `env -i`, with a PATH that holds node and /bin only: /usr/bin is left out because macOS keeps cc and make
  // shims there, and an install that needs a compiler must fail here. pnpm's bin shims are sh scripts that call sed,
  // dirname and uname, so those three (and nothing else of /usr/bin) are linked next to node.
  const cleanBase = {
    PATH: [nodeBin, '/bin'].join(delimiter),
    ...Object.fromEntries(NETWORK_ENV.filter((k) => process.env[k]).map((k) => [k, process.env[k]])),
  };
  let server = null;
  let exited = null;

  try {
    await writeFile(emptyRc, '');
    await mkdir(nodeBin);
    await symlink(process.execPath, join(nodeBin, 'node'));
    for (const tool of ['sed', 'dirname', 'uname']) {
      const found = ['/bin', '/usr/bin'].map((d) => join(d, tool)).find((p) => existsSync(p));
      if (!found) fail('setup', `${tool} is in neither /bin nor /usr/bin; pnpm's bin shims need it`);
      await symlink(found, join(nodeBin, tool));
    }
    for (const label of ['pack', 'dlx', 'install', 'run']) await mkdir(join(tmp, `home-${label}`));

    // 1. pack: the tarball holds exactly the files of 10.8, no stale module.
    const packDir = join(tmp, 'pack');
    await mkdir(packDir);
    const packed = await pnpm(['pack', '--pack-destination', packDir], { cwd: ROOT, env: isolated(process.env, 'pack'), timeoutMs: 10 * 60_000 });
    if (packed.code !== 0) fail('pack', `pnpm pack exited ${packed.code}${packed.timedOut ? ' (timed out)' : ''}\n${tail(packed.stderr + packed.stdout, 40)}`);
    // pnpm names a scoped package's tarball <scope>-<name>-<version>.tgz and prints its path as the last line.
    const tgz = packed.stdout.trimEnd().split('\n').at(-1)?.trim() ?? '';
    tarballName = basename(tgz);
    if (!tarballName.endsWith('.tgz') || !existsSync(tgz) || realpathSync(dirname(tgz)) !== realpathSync(packDir)) fail('pack', `pnpm pack printed no tarball in ${packDir} (last line ${JSON.stringify(tgz)}): ${(await readdir(packDir)).join(', ') || 'nothing there'}`);
    const listed = await run('tar', ['-tzf', tgz], { cwd: tmp, env: { PATH: process.env.PATH }, timeoutMs: 60_000 });
    if (listed.code !== 0) fail('pack', `tar could not list ${tgz}: ${listed.stderr}`);
    const entries = listed.stdout.split('\n').filter((l) => l && !l.endsWith('/'));
    const serverModules = (await readdir(join(ROOT, 'src', 'server'))).filter((f) => f.endsWith('.ts')).map((f) => f.slice(0, -3));
    const problems = listProblems(entries, serverModules);
    if (problems.length) fail('pack', `the tarball file list is wrong:\n  ${problems.join('\n  ')}`);
    console.log(`ok 1 pack: ${tarballName}, ${entries.length} files, nothing missing, nothing extra`);

    // 2. pnpm dlx in an empty directory, empty HOME, store and cache, no compiler.
    const emptyDir = join(tmp, 'empty');
    await mkdir(emptyDir);
    const probe = spawnSync('/bin/sh', ['-c', 'for c in cc gcc c++ g++ make python3; do command -v "$c"; done'], { env: { PATH: cleanBase.PATH }, encoding: 'utf8' });
    const compilers = probe.stdout.trim();
    const version = await pnpm(['dlx', `file:${tgz}`, '--version'], { cwd: emptyDir, env: isolated(cleanBase, 'dlx'), timeoutMs: 5 * 60_000 });
    if (version.code !== 0) fail('dlx', `pnpm dlx exited ${version.code}${version.timedOut ? ' (timed out)' : ''}\n${tail(version.stderr + version.stdout, 40)}`);
    if (version.stdout.trim() !== `gonogo ${pkg.version}`) fail('dlx', `--version printed ${JSON.stringify(version.stdout.trim())}, expected "gonogo ${pkg.version}"`);
    console.log(
      `ok 2 pnpm dlx file:<tgz> --version printed "gonogo ${pkg.version}"` +
        (compilers ? ` (note: this PATH can reach ${compilers.split('\n').join(', ')}, so it does not prove that no compiler is needed)` : ''),
    );

    // 3. install (pnpm 10 runs no dependency build script unless allowed), start the bin with the stand-in agent.
    const project = join(tmp, 'project');
    await mkdir(project);
    await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'gonogo-check', version: '1.0.0', private: true }));
    const installed = await pnpm(['add', `file:${tgz}`], { cwd: project, env: isolated(cleanBase, 'install'), timeoutMs: 5 * 60_000 });
    if (installed.code !== 0) fail('install', `pnpm add exited ${installed.code}${installed.timedOut ? ' (timed out)' : ''}\n${tail(installed.stderr + installed.stdout, 40)}`);
    const bin = join(project, 'node_modules', '.bin', 'gonogo');
    const standIn = join(ROOT, 'test', 'fake-claude.mjs');
    if (!existsSync(standIn)) fail('start', `${standIn} is missing`);
    const bossDir = join(tmp, 'boss');
    await mkdir(logDir);
    await mkdir(bossDir);
    let stderr = '';
    server = spawn(bin, ['--port', '0', '--home', join(tmp, 'gonogo-home')], {
      cwd: bossDir,
      env: { ...cleanBase, HOME: join(tmp, 'home-run'), GONOGO_AGENT_CMD: JSON.stringify(['node', standIn]), FAKE_CLAUDE_LOG_DIR: logDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    exited = new Promise((done) => server.once('exit', (code, signal) => done({ code, signal })));
    server.stderr.on('data', (d) => (stderr += d));
    const url = await new Promise((done, reject) => {
      let stdout = '';
      const timer = setTimeout(() => reject(new Error(`no "gonogo ready:" line within 30 s\n${tail(stderr)}`)), 30_000);
      server.stdout.on('data', (d) => {
        stdout += d;
        const m = SERVER_READY.exec(stdout);
        if (m) {
          clearTimeout(timer);
          done(m[1]);
        }
      });
      server.once('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`cannot start ${bin}: ${e.message}`));
      });
      exited.then(({ code, signal }) => {
        clearTimeout(timer);
        reject(new Error(`exited (${code ?? signal}) before it was ready\n${tail(stderr)}`));
      });
    }).catch((e) => fail('start', e.message));
    const parsed = new URL(url);
    const port = Number(parsed.port);
    const token = parsed.hash.replace(/^#token=/, '');
    if (!port || !/^[0-9a-f]{64}$/.test(token)) fail('start', `the ready line has no port or no 64 hex token: ${url.replace(token, '<token>')}`);
    console.log(`ok 3 pnpm add with no build script run, start: ${parsed.origin}`);

    // 4. what only a built run shows.
    const index = await ask(port, '/');
    if (index.status !== 200 || !/^text\/html/.test(index.headers['content-type'] ?? '')) fail('http', `GET / answered ${index.status} ${index.headers['content-type']}, expected 200 text/html`);
    const wanted = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' };
    for (const [name, value] of Object.entries(wanted)) {
      if (index.headers[name] !== value) fail('http', `GET / header ${name} is ${JSON.stringify(index.headers[name])}, expected ${value}`);
    }
    const noToken = await ask(port, '/api/state');
    if (noToken.status !== 401) fail('http', `GET /api/state without a token answered ${noToken.status}, expected 401`);
    const slashes = await get(port, '//').catch((e) => fail('http', `GET // broke the connection or the server: ${e.message}`));
    if (slashes.status !== 404) fail('http', `GET // answered ${slashes.status}, expected 404`);
    const again = await get(port, '/').catch((e) => fail('http', `the server did not answer after GET //: ${e.message}`));
    if (again.status !== 200) fail('http', `after GET // the server answered ${again.status} to GET /, expected 200`);
    const deadline = Date.now() + 30_000;
    let boss = null;
    let status = 0;
    while (Date.now() < deadline) {
      const state = await ask(port, '/api/state', { Authorization: `Bearer ${token}` });
      status = state.status;
      boss = status === 200 ? (JSON.parse(state.body).agents ?? []).find((a) => a.boss) : null;
      if (boss?.state === 'idle') break;
      if (boss?.state === 'stopped') fail('boss', `the boss stopped: ${boss.exit?.text ?? 'no reason given'}`);
      await sleep(250);
    }
    if (boss?.state !== 'idle') fail('boss', `the boss is ${boss?.state ?? `missing (GET /api/state answered ${status})`} after 30 s, expected idle`);
    const pids = await standInPids(logDir);
    if (!pids.length || !pids.every(alive)) fail('boss', `no live stand-in process in ${logDir} (${pids.length} start lines); the stand-in must log "start" with its pid (contract 9.9)`);
    console.log(`ok 4 GET / is 200 text/html with the 3 headers, no token is 401, GET // is 404 and the server still answers, ${boss.name} is idle (stand-in pid ${pids.join(', ')})`);

    // 5. SIGTERM: exit 0 in 15 s, the port is free, no stand-in process is left.
    server.kill('SIGTERM');
    const result = await Promise.race([exited, sleep(15_000).then(() => null)]);
    if (!result) fail('stop', 'still running 15 s after SIGTERM');
    if (result.code !== 0) fail('stop', `exit code ${result.code ?? result.signal}, expected 0\n${tail(stderr)}`);
    if (!(await portIsClosed(port))) fail('stop', `port ${port} still accepts connections`);
    for (let i = 0; i < 30 && pids.some(alive); i++) await sleep(100);
    const left = pids.filter(alive);
    if (left.length) fail('stop', `stand-in process ${left.join(', ')} is still running after the server exited`);
    console.log('ok 5 SIGTERM: exit 0, port free, no stand-in process left');
    console.log(`check-pack: all 5 steps passed for ${tarballName}`);
  } finally {
    // A failed run must leave nothing behind: ask the server to stop its agents first, then insist.
    if (server && exited && server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM');
      if (!(await Promise.race([exited, sleep(15_000).then(() => null)]))) server.kill('SIGKILL');
    }
    for (const pid of await standInPids(logDir)) if (alive(pid)) process.kill(pid, 'SIGKILL');
    await rm(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().then(
    () => process.exit(0),
    (e) => {
      process.stderr.write(`check-pack: FAIL ${e.message}\n`);
      process.exit(1);
    },
  );
}
