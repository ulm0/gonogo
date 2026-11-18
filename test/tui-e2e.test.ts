/**
 * gonogo tui against a real server: startGonogo with the stand-in agent, the real WebSocket client, and a fake terminal whose
 * output is read back through a terminal emulator. Attach, type, see it on the console's own screen, leave, hold and resume, quit.
 * No real `claude` and no real tty: the pty is the server's, and the terminal here is a pair of streams.
 */
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import xtermHeadless from '@xterm/headless';
import { afterEach, describe, expect, it } from 'vitest';
import { nullLogger } from '../src/server/constants.js';
import { startGonogo } from '../src/server/cli.js';
import type { Running } from '../src/server/cli.js';
import { LEAVE_SCREEN, runTui } from '../src/server/tui-app.js';
import { resolveToken } from '../src/server/tui-cli.js';

const { Terminal } = xtermHeadless;
const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class In extends EventEmitter {
  raw: boolean | null = null;
  setRawMode(raw: boolean): void {
    this.raw = raw;
  }
  setEncoding(): void {}
  resume(): void {}
  pause(): void {}
}
class Out extends EventEmitter {
  columns = 100;
  rows = 30;
  chunks: string[] = [];
  write(data: string | Uint8Array): boolean {
    this.chunks.push(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
    return true;
  }
  async screen(): Promise<string> {
    const term = new Terminal({ cols: this.columns, rows: this.rows, allowProposedApi: true });
    await new Promise<void>((resolve) => term.write(this.chunks.join(''), resolve));
    const lines: string[] = [];
    for (let i = 0; i < this.rows; i += 1) lines.push(term.buffer.active.getLine(i)?.translateToString(true) ?? '');
    term.dispose();
    return lines.join('\n');
  }
}

let tmp = '';
let run: Running | null = null;
afterEach(async () => {
  await run?.stop().catch(() => undefined);
  run = null;
  if (tmp !== '') await rm(tmp, { recursive: true, force: true });
  tmp = '';
});

async function until(out: Out, text: RegExp | string, what: string, ms = 8000): Promise<string> {
  const deadline = Date.now() + ms;
  for (;;) {
    const screen = await out.screen();
    if (typeof text === 'string' ? screen.includes(text) : text.test(screen)) return screen;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; the screen was:\n${screen}`);
    await sleep(50);
  }
}

describe('gonogo tui against a real server', () => {
  it('shows the room, attaches to FLIGHT and types into it, leaves with Ctrl-], holds and resumes, and puts the terminal back', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'gonogo-tui-'));
    await Promise.all([mkdir(join(tmp, 'claude')), mkdir(join(tmp, 'log'))]);
    run = await startGonogo({
      port: 0,
      host: '127.0.0.1',
      home: join(tmp, 'home'),
      cwd: tmp,
      seed: false,
      allowedHosts: [],
      agentCmd: [process.execPath, FAKE],
      staticDir: null,
      env: { ...process.env, CLAUDE_CONFIG_DIR: join(tmp, 'claude'), FAKE_CLAUDE_LOG_DIR: join(tmp, 'log') },
      log: nullLogger,
    });
    // the token is the one in the file of the home: the terminal client finds it the way a user would
    const found = resolveToken(undefined, run.home, {});
    expect(found).toEqual({ token: run.browserToken });

    const stdin = new In();
    const stdout = new Out();
    const done = runTui({ url: `http://127.0.0.1:${run.port}`, token: run.browserToken, stdin, stdout, env: {}, frameMs: 20 });
    const key = (text: string): boolean => stdin.emit('data', text);

    const room = await until(stdout, /flight\s+(idle|working|starting)/, 'FLIGHT in the room');
    expect(room).toContain('connected');
    // a standing wait for the stand-in to be idle: it can ask a startup question first
    await until(stdout, /\. flight\s+idle/, 'FLIGHT idle', 15_000);

    key('\r');
    await until(stdout, '❯', 'the console of FLIGHT');
    key('hello');
    await until(stdout, /❯\s*hello/, 'the typed text on the console');
    // what was typed went to the console, not to the room: no message box opened and nothing quit
    expect(await stdout.screen()).not.toContain('Message to');

    // the pty has one size: this terminal's
    stdout.columns = 90;
    stdout.rows = 26;
    stdout.emit('resize');
    await sleep(300);

    key('\x1dq');
    await until(stdout, /ROOM/, 'the room again');
    await until(stdout, /\. flight\s+idle/, 'FLIGHT in the room again');

    key('h');
    await until(stdout, /! flight\s+on hold/, 'FLIGHT on hold');
    key('r');
    await until(stdout, /\. flight\s+idle/, 'FLIGHT resumed');

    key('q');
    expect(await done).toBe(0);
    expect(stdout.chunks.at(-1)).toBe(LEAVE_SCREEN);
    expect(stdin.raw).toBe(false);
  }, 60_000);

  it('says the token was refused, and leaves with q', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'gonogo-tui-'));
    await Promise.all([mkdir(join(tmp, 'claude')), mkdir(join(tmp, 'log'))]);
    run = await startGonogo({
      port: 0,
      host: '127.0.0.1',
      home: join(tmp, 'home'),
      cwd: tmp,
      seed: false,
      allowedHosts: [],
      agentCmd: [process.execPath, FAKE],
      staticDir: null,
      env: { ...process.env, CLAUDE_CONFIG_DIR: join(tmp, 'claude'), FAKE_CLAUDE_LOG_DIR: join(tmp, 'log') },
      log: nullLogger,
    });
    const stdin = new In();
    const stdout = new Out();
    const done = runTui({ url: `http://127.0.0.1:${run.port}`, token: 'wrong'.repeat(13), stdin, stdout, env: {}, frameMs: 20 });
    await until(stdout, 'The server refused the token.', 'the refusal');
    stdin.emit('data', 'q');
    expect(await done).toBe(0);
  }, 30_000);
});
