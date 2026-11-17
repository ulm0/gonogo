#!/usr/bin/env node
/**
 * pnpm smoke:real --spend
 *
 * Starts the built server (dist/) with the REAL `claude` and walks one short path through it: the generated settings
 * pass `claude doctor`, the boss starts, an agent is hired, both answer a message, both stop, and a proxy in the
 * environment does not capture the loopback traffic (contract 10.8), and a T-minus poll gets a real go_nogo answer. It spends subscription tokens, so it refuses to
 * run without --spend, it is not part of `pnpm test`, and a person runs it.
 *
 * Needs `pnpm build` first and a signed-in `claude` on PATH. The model is haiku: the launcher passes no --model
 * (contract 7.2), so ANTHROPIC_MODEL carries the alias, and the script checks the boss's screen names haiku before it
 * sends anything. Gonogo's home is a fresh temp directory. Seed mode is off, so no Claude file of yours is written;
 * for that reason the boss works in a folder that Claude Code already trusts (default: this project, override with
 * --dir) and ana in a fresh subfolder of it. A trust question is shown with its screen and answered by you, once.
 *
 * Prints PASS/FAIL per step and exits 1 after the first fatal FAIL (steps 4b, 4c, 4d and 6 do not stop the run). The agents
 * are always stopped and the temp directories removed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, rmdir } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const READY_PROMPT = 'Reply to the user with send_message: "ready". Nothing else.';
const AGAIN_PROMPT = 'Reply to the user with send_message: "ready again". Nothing else.';
const ROLE = 'You are a smoke-test agent. Do exactly what a message asks and nothing else.';
const TYPED_PROMPT = 'Say OK.';
const DIALOG_WAIT_MS = 5 * 60_000;
const USAGE = `usage: node scripts/smoke-real.mjs --spend [--dir <folder>]

  --spend        required: this starts real claude agents and uses subscription tokens
  --dir <folder> a folder Claude Code already trusts, default: this project. The boss works there, ana in a fresh subfolder.
  -h, --help     this text`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cut = (text, n = 90) => (text.length > n ? `${text.slice(0, n)}...` : text);

/* ---- pure helpers (exported for a scratch test) ---- */

export function parseArgs(argv) {
  const out = { spend: false, dir: null, help: false, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--spend') out.spend = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--dir' || a.startsWith('--dir=')) {
      const value = a === '--dir' ? argv[++i] : a.slice('--dir='.length);
      if (value) out.dir = resolve(value);
      else out.error = '--dir needs a folder';
    } else out.error = `unknown option ${a}`;
  }
  return out;
}

// CSI, OSC and the two-character escapes a serialised xterm screen holds.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>78]/g;
export const screenText = (data) =>
  data
    .replace(ANSI, '')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .join('\n');

/**
 * Lines of `claude doctor` output that blame the probe project's settings file. doctor prints every problem as
 * `- <path> — <key>: <message>` under "Invalid settings" (facts hooks-mcp 1.5), so the unique probe folder name is
 * what ties a line to our file and not to the user's own settings. The heading proves doctor really ran.
 */
export function doctorProblems(output, probeDir) {
  const text = screenText(output);
  if (!/Claude Code doctor/i.test(text)) return [`doctor printed no report: ${cut(text, 200) || 'nothing'}`];
  const marker = basename(probeDir);
  const lines = text.split('\n');
  const problems = [];
  lines.forEach((line, i) => {
    // The probe sits in an untrusted temp folder, so doctor says it ignores the allow rules there: that is the folder, not the file.
    if (/workspace has not been trusted/i.test(line)) return;
    if (line.includes(marker) || (/crossSessionInbound/.test(line) && /invalid|ignored|unknown|unrecognized/i.test(line))) {
      problems.push(line.trim());
      // the "Suggested fix:" line that belongs to a problem is indented
      if (/^\s+\S/.test(lines[i + 1] ?? '') && !lines[i + 1].trimStart().startsWith('- ')) problems.push(lines[i + 1].trim());
    }
  });
  return problems;
}

/** A request that reached the recorder proxy and was meant for this machine: CONNECT host:port or an absolute-form URL. */
export function isLoopbackTarget(target) {
  const host = /^[a-z]+:\/\//i.test(target) ? safeHost(target) : (/^\[?([^\]]+?)\]?(?::\d+)?$/.exec(target)?.[1] ?? '');
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host.toLowerCase());
}
function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

const idNumber = (id) => Number(/^m(\d+)$/.exec(id)?.[1] ?? NaN);

/* ---- a recorder that plays the proxy of step 6 ---- */

function startProxy() {
  return new Promise((done, reject) => {
    const seen = [];
    const record = (entry) => {
      if (seen.length < 500) seen.push(entry);
    };
    const server = http.createServer((req, res) => {
      record({ kind: 'http', target: req.url ?? '' });
      req.resume();
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('gonogo smoke proxy: nothing is forwarded\n');
    });
    server.on('connect', (req, socket) => {
      record({ kind: 'connect', target: req.url ?? '' });
      socket.on('error', () => {});
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    });
    server.on('clientError', (_e, socket) => socket.destroy());
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => done({ seen, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }));
  });
}

/* ---- the browser's side of gonogo: REST for changes, one WebSocket for state, activity and terminals ---- */

function openWatcher(port, token) {
  return new Promise((done, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['gonogo.v1', `token.${token}`]);
    const w = { agents: new Map(), items: new Map(), trail: new Map(), closed: null, waiting: new Map(), seq: 0 };
    const note = (item) => {
      const trail = w.trail.get(item.id) ?? [];
      const last = trail.at(-1);
      if (!last || last.status !== item.status || last.note !== item.note) trail.push({ status: item.status, note: item.note });
      w.trail.set(item.id, trail);
      w.items.set(item.id, item);
    };
    let first = true;
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let frame;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (frame.t === 'state') {
        w.agents = new Map(frame.state.agents.map((a) => [a.name, a]));
        frame.state.activity.forEach(note);
        if (first) {
          first = false;
          done(w);
        }
      } else if (frame.t === 'agent') w.agents.set(frame.agent.name, frame.agent);
      else if (frame.t === 'agent-removed') w.agents.delete(frame.name);
      else if (frame.t === 'activity') note(frame.item);
      else if (frame.t === 'snapshot') w.waiting.get(frame.seq)?.resolve(frame);
      else if (frame.t === 'error' && frame.ref === 'attach') for (const p of w.waiting.values()) p.reject(new Error(`attach refused: ${frame.message}`));
    });
    ws.once('unexpected-response', (_req, res) => reject(new Error(`the WebSocket was refused with HTTP ${res.statusCode}`)));
    ws.on('error', reject);
    ws.once('close', (code) => {
      w.closed = code;
    });
    /** Attaches the terminal of `agent` and resolves with the screen as plain text. */
    w.attach = (agent) =>
      new Promise((res, rej) => {
        const seq = ++w.seq;
        const timer = setTimeout(() => rej(new Error(`no snapshot of ${agent} within 10 s`)), 10_000);
        w.waiting.set(seq, {
          resolve: (frame) => {
            clearTimeout(timer);
            w.waiting.delete(seq);
            res({ running: frame.running, text: screenText(frame.data) });
          },
          reject: (e) => {
            clearTimeout(timer);
            rej(e);
          },
        });
        ws.send(JSON.stringify({ t: 'attach', seq, agent, cols: 120, rows: 40 }));
      });
    w.type = (agent, data) => ws.send(JSON.stringify({ t: 'input', agent, data }));
    w.close = () => ws.close();
  });
}

/** Waits until `check()` returns something truthy; says what it was waiting for, and how the agents look, when it gives up. */
async function waitFor(label, check, { timeoutMs, describe }) {
  const started = Date.now();
  let nextNote = started + 20_000;
  for (;;) {
    const value = check();
    if (value) return value;
    const waited = Date.now() - started;
    if (waited > timeoutMs) throw new Error(`gave up after ${Math.round(waited / 1000)} s waiting for ${label}${describe ? ` (${describe()})` : ''}`);
    if (Date.now() > nextNote) {
      console.log(`     ... still waiting for ${label}, ${Math.round(waited / 1000)} s${describe ? ` (${describe()})` : ''}`);
      nextNote += 20_000;
    }
    await sleep(200);
  }
}

function processes() {
  const out = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,command=', '-ww'], { encoding: 'utf8' }).stdout ?? '';
  return out
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), command: m[3] }));
}

/** `claude doctor` in `cwd`, no model call. stdin is closed: it must print its report and exit. */
function runDoctor(cwd, env) {
  return new Promise((done, reject) => {
    const child = spawn('claude', ['doctor'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`claude doctor did not finish in 60 s: ${cut(screenText(out), 200)}`));
    }, 60_000);
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once('close', () => {
      clearTimeout(timer);
      done(out);
    });
  });
}

async function main(args) {
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.error) {
    console.error(`smoke-real: ${args.error}\n${USAGE}`);
    return 2;
  }
  if (!args.spend) {
    console.error('smoke-real: this starts real claude agents and uses subscription tokens. Run it again with --spend.');
    return 2;
  }

  const cliPath = join(ROOT, 'dist', 'server', 'cli.js');
  const constantsPath = join(ROOT, 'dist', 'server', 'constants.js');
  if (!existsSync(cliPath) || !existsSync(constantsPath)) {
    console.error('smoke-real: dist/server is missing. Run `pnpm build` first.');
    return 1;
  }
  const cli = await import(pathToFileURL(cliPath).href);
  const consts = await import(pathToFileURL(constantsPath).href);
  const trusted = args.dir ?? ROOT;

  // The environment of every claude this script starts: the session identity of the Claude Code that may be running
  // this script is removed (the launcher does the same for its children), no stand-in command can replace claude.
  const scrubbed = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !consts.SCRUB_ENV_EXACT.includes(k) && !consts.SCRUB_ENV_PREFIXES.some((p) => k.startsWith(p)) && k !== 'GONOGO_AGENT_CMD' && k !== 'GONOGO_SEED_CLAUDE',
    ),
  );
  const baseEnv = { ...scrubbed, ANTHROPIC_MODEL: 'haiku' };
  const log = consts.createLogger({ level: process.env.GONOGO_LOG_LEVEL ?? 'warn' });

  const scratch = join(trusted, 'scratch');
  const anaDir = join(scratch, `smoke-${process.pid}`);
  const madeScratch = !existsSync(scratch);
  let failed = false;
  const servers = [];
  const tmp = await mkdtemp(join(tmpdir(), 'gonogo-smoke-'));
  const findings = [];
  let proxy = null;
  let version = 'unknown';

  const describe = (server) => () =>
    (server.watcher.closed === null ? '' : `WebSocket closed with ${server.watcher.closed}; `) +
    [...server.watcher.agents.values()]
      .map((a) => `${a.name}: ${a.state}${a.needsReason ? ` - ${a.needsReason}` : ''}${a.held ? ` [${a.held.text}]` : ''}`)
      .join('; ');
  const trail = (server, id) => (server.watcher.trail.get(id) ?? []).map((t) => (t.note ? `${t.status} (${t.note})` : t.status)).join(' -> ');

  const api = async (server, method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${server.running.port}${path}`, {
      method,
      headers: { Authorization: `Bearer ${server.running.browserToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // not JSON: the status and the text say enough
    }
    return { status: res.status, json, text };
  };
  const send = async (server, to, body) => {
    const res = await api(server, 'POST', '/api/messages', { to, subject: 'smoke test', body });
    if (res.status !== 201) throw new Error(`POST /api/messages answered ${res.status}: ${cut(res.text, 200)}`);
    if (!res.json.ok) throw new Error(`the message to ${to} was not delivered: ${res.json.note}`);
    return res.json;
  };
  /** The messages `name` sent to you after message `afterId`, oldest first. */
  const repliesFrom = (server, name, afterId) =>
    [...server.watcher.items.values()]
      .filter((i) => i.from === name && i.status === 'to_user' && idNumber(i.id) > idNumber(afterId))
      .sort((a, b) => idNumber(a.id) - idNumber(b.id));
  const atLeast = (count, server, name, afterId) => () => {
    const replies = repliesFrom(server, name, afterId);
    return replies.length >= count ? replies : null;
  };

  const startServer = async (label, env) => {
    const home = await mkdtemp(join(tmp, `home-${label}-`));
    const running = await cli.startGonogo({ host: '127.0.0.1', port: 0, home, cwd: trusted, env, seed: false, agentCmd: null, staticDir: null, log, checkClaude: true });
    const server = { label, home, running };
    servers.push(server);
    server.watcher = await openWatcher(running.port, running.browserToken);
    return server;
  };

  /**
   * Waits for `name` to be idle. A startup dialog (Claude Code's trust question for a folder it has not seen) is shown
   * with its screen and answered by you in the terminal pane; the script then waits for it.
   */
  const idle = async (server, name, timeoutMs) => {
    const started = Date.now();
    let limit = started + timeoutMs;
    let announcedAt = 0; // stateSince of the dialog already shown: a second dialog (the bypass warning) is shown too
    for (;;) {
      const agent = server.watcher.agents.get(name);
      if (agent?.state === 'idle') return;
      if (agent?.state === 'stopped') throw new Error(`${name} stopped: ${agent.exit?.text ?? 'no reason given'}`);
      if (agent?.state === 'needs_you' && agent.needsKind !== 'startup_dialog') throw new Error(`${name} needs you: ${agent.needsReason}`);
      if (agent?.state === 'needs_you' && announcedAt !== agent.stateSince) {
        announcedAt = agent.stateSince;
        limit = Math.max(limit, Date.now() + DIALOG_WAIT_MS);
        const screen = await server.watcher.attach(name).catch((e) => ({ text: `(no screen: ${e.message})` }));
        console.log(`     ${name} waits at a startup dialog. Its screen:`);
        for (const line of screen.text.split('\n').slice(-14)) console.log(`       | ${line}`);
        console.log(`     Open ${server.running.url} , select ${name} and answer it in the terminal (once per folder). Waiting up to 5 minutes.`);
      }
      if (Date.now() > limit) throw new Error(`${name} is ${agent?.state ?? 'unknown'} after ${Math.round((Date.now() - started) / 1000)} s`);
      await sleep(200);
    }
  };

  class Abort extends Error {}
  let interrupted = false;
  const step = async (id, title, fn, { fatal = true } = {}) => {
    const started = Date.now();
    try {
      const detail = await fn();
      console.log(`PASS ${id} ${title}${detail ? `: ${detail}` : ''} [${((Date.now() - started) / 1000).toFixed(1)} s]`);
      return true;
    } catch (e) {
      if (interrupted) throw new Abort(); // the servers are being stopped under this step, its error means nothing
      const memoryPrompt = servers.flatMap((sv) => [...(sv.watcher?.agents.values() ?? [])]).find((a) => a.state === 'needs_you' && /memory\.md/.test(a.needsReason ?? ''));
      if (memoryPrompt) findings.push(`O4: NO, ${memoryPrompt.name} asks permission for its own memory file (${memoryPrompt.needsReason}), so the permissions.allow rule does not match`);
      failed = true;
      console.log(`FAIL ${id} ${title}: ${e.message}`);
      if (fatal) throw new Abort();
      return false;
    }
  };

  const cleanup = async () => {
    for (const s of servers) {
      s.watcher?.close();
      await Promise.race([s.running.stop().catch((e) => console.log(`     cleanup: stopping ${s.label} failed: ${e.message}`)), sleep(30_000)]);
    }
    proxy?.close();
    await rm(tmp, { recursive: true, force: true });
    await rm(anaDir, { recursive: true, force: true });
    if (madeScratch) await rmdir(scratch).catch(() => {});
  };
  const onSignal = () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.log('smoke-real: interrupted, stopping the agents (press again to exit at once)');
    cleanup().finally(() => process.exit(130));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  console.log('smoke-real: starting real claude agents (model alias haiku); this spends subscription tokens');
  try {
    await step('preflight', 'claude is installed, dist is built, the trusted folder exists', async () => {
      if (!existsSync(trusted)) throw new Error(`${trusted} does not exist`);
      const r = spawnSync('claude', ['--version'], { encoding: 'utf8', env: baseEnv });
      if (r.error || r.status !== 0) throw new Error(`\`claude --version\` failed: ${r.error?.message ?? r.stderr}`);
      version = r.stdout.trim();
      return `${version}, model alias haiku, trusted folder ${trusted}`;
    });

    let primary = null;
    let boss = '';
    await step('start', 'gonogo starts with a fresh home', async () => {
      primary = await startServer('main', baseEnv);
      boss = [...primary.watcher.agents.values()].find((a) => a.boss)?.name;
      if (!boss) throw new Error('the server has no boss');
      return `port ${primary.running.port}, home ${primary.home}, boss ${boss}`;
    });

    await step('0', 'claude doctor accepts the generated settings', async () => {
      const settings = join(primary.home, consts.AGENTS_DIR, boss, consts.SETTINGS_FILE);
      await waitFor(settings, () => existsSync(settings), { timeoutMs: 10_000 });
      const probe = await mkdtemp(join(tmp, 'probe-'));
      await mkdir(join(probe, '.claude'));
      await copyFile(settings, join(probe, '.claude', 'settings.json'));
      const problems = doctorProblems(await runDoctor(probe, baseEnv), probe);
      if (problems.length) throw new Error(`\n${problems.map((p) => `       ${p}`).join('\n')}`);
      findings.push('O6: yes, `claude doctor` reports nothing wrong with the generated settings.json');
      findings.push('O5: `claude doctor` does not flag permissions.deny or crossSessionInbound (that does not prove they take effect)');
      return 'no problem reported for settings.json';
    });

    await step('1', 'the boss reaches idle and runs haiku', async () => {
      await idle(primary, boss, 30_000);
      const screen = await primary.watcher.attach(boss);
      const model = /\b(haiku|sonnet|opus)\b[^\n]{0,24}/i.exec(screen.text)?.[0];
      if (!/haiku/i.test(screen.text) && /opus|sonnet/i.test(screen.text)) throw new Error(`the boss screen shows "${model}", not haiku: ANTHROPIC_MODEL was not applied, nothing was sent`);
      findings.push('O17: claude accepted the first-start argv, --system-prompt-snapshot off included (the boss started); whether the role text applied is not checked');
      return model ? `screen shows "${model.trim()}"` : 'the model name is not on the boss screen';
    });

    await step('2', 'hire ana in a fresh subfolder of the trusted folder, default mode', async () => {
      await mkdir(anaDir, { recursive: true });
      const res = await api(primary, 'POST', '/api/agents', { name: 'ana', role: ROLE, dir: anaDir, mode: 'default' });
      if (res.status !== 201) throw new Error(`POST /api/agents answered ${res.status}: ${cut(res.text, 200)}`);
      await idle(primary, 'ana', 60_000);
      return `ana is idle in ${anaDir}`;
    });

    await step('3', 'brief the boss, get a message back for you', async () => {
      const sent = await send(primary, 'boss', READY_PROMPT);
      const [reply] = await waitFor(`a message from ${boss} to you`, atLeast(1, primary, boss, sent.id), { timeoutMs: 90_000, describe: describe(primary) });
      return `"${cut(reply.body.trim(), 60)}"; the brief went ${trail(primary, sent.id)}`;
    });

    let followUp = null;
    await step('4', 'message ana, get a message back (typed pointer)', async () => {
      const first = await send(primary, 'ana', READY_PROMPT);
      // The next message is sent while ana is still in the turn that read this one: it then waits for her Stop hook.
      await waitFor('ana to read the first message', () => primary.watcher.items.get(first.id)?.status === 'read', { timeoutMs: 60_000, describe: describe(primary) });
      const during = primary.watcher.agents.get('ana')?.state;
      followUp = { first, during, sent: await send(primary, 'ana', AGAIN_PROMPT) };
      const [reply] = await waitFor('a message from ana to you', atLeast(1, primary, 'ana', first.id), { timeoutMs: 90_000, describe: describe(primary) });
      return `"${cut(reply.body.trim(), 60)}"; the first message went ${trail(primary, first.id)}`;
    });

    await step(
      '4b',
      'a second message, sent while ana was still working, is handed over by the Stop hook',
      async () => {
        const sentTrail = () => trail(primary, followUp.sent.id);
        const handedOver = () => /handed over when its turn ended/.test(sentTrail());
        const replies = await waitFor('a second message from ana to you', atLeast(2, primary, 'ana', followUp.first.id), { timeoutMs: 90_000, describe: describe(primary) }).catch((e) => {
          findings.push(
            handedOver()
              ? `O15 and O21: NO, the Stop block was answered (${sentTrail()}) and the model did not act on it`
              : `O15 and O21: not exercised, the second message went ${sentTrail()} (ana was ${followUp.during} when it was sent)`,
          );
          throw new Error(`${e.message}; the second message went ${sentTrail()}`);
        });
        findings.push(
          handedOver()
            ? 'O15 and O21: yes, in this run the interactive TUI continued the turn after the Stop block and the model read its mail'
            : `O15 and O21: not exercised, the second message went ${sentTrail()} (ana was ${followUp.during} when it was sent)`,
        );
        return `"${cut(replies[1].body.trim(), 60)}"; the second message went ${sentTrail()}`;
      },
      { fatal: false },
    );

    await step(
      '4c',
      'a permission prompt raises needs-you, GO (the answer route) lets the turn finish',
      async () => {
        await idle(primary, 'ana', 60_000);
        const marker = `gonogo-permission-${process.pid}.txt`;
        const sent = await send(primary, 'ana', `Use the Bash tool to run exactly this command: touch ${marker} . Then reply to the user with send_message: "touched". Nothing else.`);
        await waitFor('ana to need you', () => primary.watcher.agents.get('ana')?.state === 'needs_you', { timeoutMs: 90_000, describe: describe(primary) }).catch((e) => {
          findings.push('O12: not exercised, ana never asked for permission (the owner\'s own settings may allow this command)');
          throw e;
        });
        const asking = primary.watcher.agents.get('ana');
        const screen = await primary.watcher.attach('ana');
        console.log(`     ana needs you: kind ${asking.needsKind}, reason "${cut(asking.needsReason ?? '', 90)}". Last screen lines:`);
        for (const line of screen.text.split('\n').slice(-8)) console.log(`       | ${line}`);
        if (asking.needsKind !== 'permission') throw new Error(`needs-you kind is ${asking.needsKind}, expected permission`);
        // The GO button of the page: the server presses Enter, and the first option, "Yes", is the highlighted one.
        const go = await api(primary, 'POST', '/api/agents/ana/answer', { go: true });
        if (go.status !== 200) throw new Error(`POST /api/agents/ana/answer answered ${go.status}: ${cut(go.text, 200)}`);
        await waitFor('ana to leave needs-you', () => primary.watcher.agents.get('ana')?.state !== 'needs_you', { timeoutMs: 15_000, describe: describe(primary) }).catch((e) => {
          findings.push('O12: NO, ana stayed in needs_you after the permission was allowed');
          throw e;
        });
        const [reply] = await waitFor('a message from ana to you', atLeast(1, primary, 'ana', sent.id), { timeoutMs: 90_000, describe: describe(primary) });
        findings.push('O12: yes, after allowing the permission ana left needs_you and finished the turn');
        return `"${cut(reply.body.trim(), 60)}" after the prompt "${cut(asking.needsReason ?? '', 60)}"`;
      },
      { fatal: false },
    );

    await step(
      '4d',
      'T-minus: a poll reaches ana, she answers with the go_nogo tool',
      async () => {
        await idle(primary, 'ana', 60_000);
        let seen = null;
        const timer = setInterval(() => {
          api(primary, 'GET', '/api/state')
            .then((res) => {
              seen = res.json?.poll ?? null;
            })
            .catch(() => {});
        }, 1000);
        try {
          const started = await api(primary, 'POST', '/api/poll', {});
          if (started.status !== 201) throw new Error(`POST /api/poll answered ${started.status}: ${cut(started.text, 200)}`);
          const poll = await waitFor('the poll to leave open', () => (seen && seen.status !== 'open' ? seen : null), { timeoutMs: 120_000, describe: describe(primary) }).catch((e) => {
            findings.push('T-minus with a real agent: NO, ana never answered the poll with go_nogo');
            throw e;
          });
          const entry = poll.entries.find((e) => e.agent === 'ana');
          findings.push(`T-minus with a real agent: yes, ana called go_nogo (${entry?.vote ?? 'no vote'}) and the poll read ${poll.status}`);
          return `poll ${poll.status}, ana voted ${entry?.vote ?? 'nothing'}: "${cut(entry?.reason ?? '', 70)}"`;
        } finally {
          clearInterval(timer);
          await api(primary, 'DELETE', '/api/poll').catch(() => {});
        }
      },
      { fatal: false },
    );

    await step(
      '4e',
      'Propellant counted the tokens; a 1-token limit trips ana (Redline) and resume clears it',
      async () => {
        const state = await api(primary, 'GET', '/api/state');
        const used = state.json?.propellant?.agents?.ana?.used?.['5h'] ?? 0;
        if (!(used > 0)) {
          findings.push('Propellant with a real transcript: NO, nothing was counted for ana');
          throw new Error(`no tokens counted for ana: ${cut(JSON.stringify(state.json?.propellant ?? null), 200)}`);
        }
        await idle(primary, 'ana', 60_000);
        const set = await api(primary, 'PUT', '/api/propellant', { agents: { ana: { '5h': 1 } } });
        if (set.status !== 200) throw new Error(`PUT /api/propellant answered ${set.status}: ${cut(set.text, 200)}`);
        try {
          await send(primary, 'ana', 'Reply to user with the single word: fuel.');
          await waitFor('ana to trip the redline', () => primary.watcher.agents.get('ana')?.needsKind === 'redline', { timeoutMs: 120_000, describe: describe(primary) });
          const reason = primary.watcher.agents.get('ana')?.needsReason ?? '';
          const resumed = await api(primary, 'POST', '/api/agents/ana/resume');
          if (resumed.status !== 200) throw new Error(`POST resume answered ${resumed.status}: ${cut(resumed.text, 200)}`);
          findings.push(`Propellant with a real transcript: yes, ${used} tokens in 5h; a 1-token limit tripped ana ("${cut(reason, 70)}")`);
          return `${used} tokens counted; tripped with "${cut(reason, 70)}", resumed`;
        } finally {
          await api(primary, 'PUT', '/api/propellant', { agents: { ana: {} } }).catch(() => {});
        }
      },
      { fatal: false },
    );

    await step('5', 'stop both agents, no claude process of this server is left', async () => {
      const mine = () => processes().filter((p) => p.command.includes(`${join(primary.home, consts.AGENTS_DIR)}/`));
      const before = mine();
      if (before.length < 2) throw new Error(`expected 2 claude processes of this server before the stop, found ${before.length}`);
      for (const name of ['ana', boss]) {
        const res = await api(primary, 'POST', `/api/agents/${name}/stop`);
        if (res.status !== 200 || res.json?.state !== 'stopped') throw new Error(`stopping ${name}: HTTP ${res.status}, ${cut(res.text, 160)}`);
      }
      await waitFor('the claude processes to be gone', () => mine().length === 0, { timeoutMs: 5_000, describe: () => `still running: ${mine().map((p) => p.pid).join(', ')}` });
      if (!findings.some((f) => f.startsWith('O4'))) findings.push('O4: no permission prompt about the memory file appeared (the agents are told to read it at start; the model may not have)');
      return `${before.length} processes stopped`;
    });

    await step(
      '6',
      'with HTTP_PROXY set, hook and MCP traffic stays off the proxy (NO_PROXY)',
      async () => {
        proxy = await startProxy();
        const env = { ...baseEnv, HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, http_proxy: proxy.url, https_proxy: proxy.url };
        for (const k of ['NO_PROXY', 'no_proxy', 'ALL_PROXY', 'all_proxy']) delete env[k];
        const proxied = await startServer('proxy', env);
        const hired = await api(proxied, 'POST', '/api/agents', { name: 'pia', role: ROLE, dir: anaDir, mode: 'default' });
        if (hired.status !== 201) throw new Error(`POST /api/agents answered ${hired.status}: ${cut(hired.text, 200)}`);
        await idle(proxied, 'pia', 90_000);
        await proxied.watcher.attach('pia');
        proxied.watcher.type('pia', TYPED_PROMPT);
        await sleep(400); // a chunk that holds text and Enter together may be read as a paste, not as a submit
        proxied.watcher.type('pia', '\r');
        await waitFor('pia to go working', () => proxied.watcher.agents.get('pia')?.state === 'working', { timeoutMs: 30_000, describe: describe(proxied) });
        await sleep(3_000);
        const local = proxy.seen.filter((r) => isLoopbackTarget(r.target));
        const ours = local.filter((r) => r.target.includes(`:${proxied.running.port}`));
        const control = proxy.seen.length - local.length;
        const caveat = control ? '' : ' (nothing else reached the proxy either, so claude may ignore HTTP_PROXY and this proves nothing)';
        findings.push(`O24: ${ours.length ? 'NO' : 'yes'}, ${ours.length} request(s) for gonogo's own port went through the proxy, ${control} other request(s) did${caveat}`);
        if (ours.length) throw new Error(`${ours.length} request(s) for gonogo went through the proxy, e.g. ${ours.slice(0, 3).map((r) => `${r.kind} ${cut(r.target, 80)}`).join('; ')}`);
        return `${control} request(s) reached the proxy, none for gonogo${caveat}`;
      },
      { fatal: false },
    );
  } catch (e) {
    if (!(e instanceof Abort)) {
      failed = true;
      console.log(`FAIL unexpected: ${e.stack ?? e.message}`);
    }
  } finally {
    if (!interrupted) {
      const strip = servers[0]?.watcher?.items;
      if (strip?.size) {
        console.log('\nActivity strip of the main run, oldest first:');
        for (const i of [...strip.values()].sort((a, b) => a.at - b.at)) {
          const time = new Date(i.at).toTimeString().slice(0, 8);
          console.log(`  ${time} ${i.from} -> ${i.to}  ${i.status}${i.note ? ` (${i.note})` : ''}  ${cut(`${i.subject ? `${i.subject}: ` : ''}${i.body}`.replace(/\s+/g, ' '), 70)}`);
        }
      }
      if (findings.length) console.log(`\nWhat this run says about the open items:\n${findings.map((f) => `  ${f}`).join('\n')}`);
      console.log(`\nclaude: ${version}`);
      console.log(failed ? 'smoke-real: FAILED' : 'smoke-real: all steps passed');
      await cleanup();
    }
  }
  return interrupted ? null : failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main(parseArgs(process.argv.slice(2))).then(
    (code) => {
      if (code !== null) process.exit(code); // null: an interrupt is cleaning up and exits by itself
    },
    (e) => {
      console.error(`smoke-real: ${e.stack ?? e.message}`);
      process.exit(1);
    },
  );
}
