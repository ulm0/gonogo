/** gonogo tui: the loop, with a fake terminal and a fake client: keys to calls, a console passed through, the screen put back on every way out. */
import { EventEmitter } from 'node:events';
import xtermHeadless from '@xterm/headless';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentView, DownlinkItem, ReliefRequest, ServerFrame } from '../src/shared/protocol.js';
import { ENTER_SCREEN, LEAVE_SCREEN, RESET_MODES, runTui } from '../src/server/tui-app.js';
import type { TuiOptions } from '../src/server/tui-app.js';
import type { TuiClient, TuiClientOptions } from '../src/server/tui-client.js';
import type { Link } from '../src/server/tui-state.js';

const { Terminal } = xtermHeadless;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class FakeIn extends EventEmitter {
  raw: boolean | null = null;
  paused = false;
  setRawMode(raw: boolean): void {
    this.raw = raw;
  }
  setEncoding(): void {}
  resume(): void {
    this.paused = false;
  }
  pause(): void {
    this.paused = true;
  }
  type(text: string): void {
    this.emit('data', text);
  }
}
class FakeOut extends EventEmitter {
  columns = 100;
  rows = 24;
  chunks: string[] = [];
  write(data: string | Uint8Array): boolean {
    this.chunks.push(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
    return true;
  }
  /** The screen as a terminal would show it. */
  async screen(): Promise<string[]> {
    const term = new Terminal({ cols: this.columns, rows: this.rows, allowProposedApi: true });
    await new Promise<void>((resolve) => term.write(this.chunks.join(''), resolve));
    const lines: string[] = [];
    for (let i = 0; i < this.rows; i += 1) lines.push(term.buffer.active.getLine(i)?.translateToString(true) ?? '');
    term.dispose();
    return lines;
  }
}

interface Calls {
  list: unknown[][];
}
function fakeClient(calls: Calls): { factory: NonNullable<TuiOptions['client']>; get: () => TuiClientOptions; client: TuiClient; attachSeq: () => number } {
  let seq = 0;
  let attached = 0;
  let opts: TuiClientOptions | null = null;
  const record = (name: string) => (...args: unknown[]): Promise<void> => {
    calls.list.push([name, ...args]);
    return Promise.resolve();
  };
  const client: TuiClient = {
    start: () => void calls.list.push(['start']),
    stop: () => void calls.list.push(['stop']),
    attach: (agent, cols, rows) => {
      seq += 1;
      attached = seq;
      calls.list.push(['attach', agent, cols, rows, seq]);
      return seq;
    },
    detach: () => {
      attached = 0;
      calls.list.push(['detach']);
    },
    input: (agent, data) => void calls.list.push(['input', agent, data]),
    resize: (agent, cols, rows) => void calls.list.push(['resize', agent, cols, rows]),
    sendMessage: record('sendMessage'),
    answer: record('answer'),
    relief: record('relief'),
    hold: record('hold'),
    resume: record('resume'),
    markRead: record('markRead'),
    archive: record('archive'),
    startPoll: record('startPoll'),
    modelDefaults: () => Promise.resolve(null),
    get seq() {
      return attached;
    },
  };
  return {
    factory: (o) => {
      opts = o;
      return client;
    },
    get: () => opts as TuiClientOptions,
    client,
    attachSeq: () => attached,
  };
}

const agent = (name: string, desk: number, patch: Partial<AgentView> = {}): AgentView =>
  ({ name, desk, boss: desk === 0, state: 'idle', stateSince: 1, needsKind: null, needsReason: null, needSeq: null, transition: null, held: null, queued: 0, position: null, provider: 'claude', ...patch }) as AgentView;
const message = (id: string): DownlinkItem => ({ type: 'message', id, at: 1_700_000_000_000, from: 'ana', subject: `subject ${id}`, body: `body ${id}`, truncated: false, inReplyTo: null, read: false, archived: false });
const relief = (id: string): ReliefRequest => ({ id, by: 'flight', at: 1, expiresAt: 2, name: 'ben', position: 'fido', role: 'r', dir: '/work', provider: 'claude', mode: 'default', cleanRoom: null });
const stateFrame = (agents: AgentView[], items: DownlinkItem[] = [], requests: ReliefRequest[] = []): ServerFrame =>
  ({ t: 'state', state: { agents, activity: [], info: { cwd: '/' }, poll: null, governor: { limit: null, working: 0, holding: 0 }, downlink: { unread: items.length, items }, relief: { requests } } }) as unknown as ServerFrame;

interface Rig {
  stdin: FakeIn;
  stdout: FakeOut;
  calls: Calls;
  fake: ReturnType<typeof fakeClient>;
  done: Promise<number>;
  frame(f: ServerFrame): Promise<void>;
  link(l: Link): Promise<void>;
  text(): Promise<string>;
}
const rigs: Rig[] = [];

function start(options: { env?: Record<string, string> } = {}): Rig {
  const stdin = new FakeIn();
  const stdout = new FakeOut();
  const calls: Calls = { list: [] };
  const fake = fakeClient(calls);
  const done = runTui({ url: 'http://x', token: 't', stdin, stdout, env: options.env ?? {}, frameMs: 5, client: fake.factory });
  const rig: Rig = {
    stdin,
    stdout,
    calls,
    fake,
    done,
    frame: async (f) => {
      fake.get().onFrame(f);
      await sleep(25);
    },
    link: async (l) => {
      fake.get().onLink(l);
      await sleep(25);
    },
    text: async () => (await stdout.screen()).join('\n'),
  };
  rigs.push(rig);
  return rig;
}

afterEach(async () => {
  for (const r of rigs.splice(0)) {
    r.stdin.type('q');
    await Promise.race([r.done, sleep(100)]);
  }
});

describe('the loop', () => {
  it('takes the terminal, draws the room from the frames, and puts everything back on q', async () => {
    const r = start();
    expect(r.stdout.chunks[0]).toBe(ENTER_SCREEN);
    expect(r.stdin.raw).toBe(true);
    expect(r.calls.list[0]).toEqual(['start']);
    await r.link('open');
    await r.frame(stateFrame([agent('flight', 0, { state: 'working' }), agent('ana', 1)], [message('m1')]));
    const screen = await r.text();
    expect(screen).toMatch(/\* flight\s+working/);
    expect(screen).toMatch(/\. ana\s+idle/);
    expect(screen).toContain('connected');
    r.stdin.type('q');
    expect(await r.done).toBe(0);
    expect(r.stdout.chunks.at(-1)).toBe(LEAVE_SCREEN);
    expect(LEAVE_SCREEN).toContain('\x1b[?25h');
    expect(LEAVE_SCREEN).toContain('\x1b[?1049l');
    expect(r.stdin.raw).toBe(false);
    expect(r.stdin.paused).toBe(true);
    expect(r.calls.list.at(-1)).toEqual(['stop']);
    expect(r.stdin.listenerCount('data')).toBe(0);
    expect(r.stdout.listenerCount('resize')).toBe(0);
  });

  it('puts the screen back on Ctrl-C, on SIGTERM and on SIGHUP, once', async () => {
    const a = start();
    a.stdin.type('\x03');
    expect(await a.done).toBe(0);
    expect(a.stdout.chunks.filter((c) => c === LEAVE_SCREEN)).toHaveLength(1);
    const b = start();
    process.emit('SIGTERM', 'SIGTERM');
    expect(await b.done).toBe(0);
    expect(b.stdout.chunks.at(-1)).toBe(LEAVE_SCREEN);
    const c = start();
    process.emit('SIGHUP', 'SIGHUP');
    expect(await c.done).toBe(0);
    expect(process.listenerCount('SIGTERM')).toBe(0);
  });

  it('puts the screen back when the client throws on start, and rethrows', async () => {
    const stdin = new FakeIn();
    const stdout = new FakeOut();
    const bad = runTui({
      url: 'http://x',
      token: 't',
      stdin,
      stdout,
      client: () => ({ start: () => { throw new Error('boom'); }, stop: () => undefined }) as unknown as TuiClient,
    });
    await expect(bad).rejects.toThrow('boom');
    expect(stdout.chunks.at(-1)).toBe(LEAVE_SCREEN);
    expect(stdin.raw).toBe(false);
  });

  it('redraws on a resize, and only the lines that changed after that', async () => {
    const r = start();
    await r.link('open');
    await r.frame(stateFrame([agent('flight', 0)]));
    r.stdout.columns = 120;
    r.stdout.rows = 30;
    const before = r.stdout.chunks.length;
    r.stdout.emit('resize');
    await sleep(40);
    expect((await r.stdout.screen())[0]).toContain('gonogo');
    expect(r.stdout.chunks.length).toBeGreaterThan(before);
    const sizeBefore = r.stdout.chunks.join('').length;
    await r.frame({ t: 'agent', agent: agent('flight', 0, { state: 'working' }) });
    const grown = r.stdout.chunks.join('').length - sizeBefore;
    expect(grown).toBeLessThan(800);
  });

  it('honours NO_COLOR', async () => {
    const r = start({ env: { NO_COLOR: '1' } });
    await r.link('open');
    await r.frame(stateFrame([agent('flight', 0)]));
    expect(r.stdout.chunks.slice(1).join('')).not.toMatch(/\x1b\[[0-9;]*m/);
    const c = start();
    await c.link('open');
    await c.frame(stateFrame([agent('flight', 0)]));
    expect(c.stdout.chunks.slice(1).join('')).toMatch(/\x1b\[[0-9;]*m/);
  });

  it('says the token was refused', async () => {
    const r = start();
    await r.link('unauthorized');
    expect(await r.text()).toContain('token refused');
    expect(await r.text()).toContain('The server refused the token.');
  });
});

describe('the actions', () => {
  it('answers a permission dialog with its needSeq and a hire request by its id, and shows the answer', async () => {
    const r = start();
    await r.link('open');
    await r.frame(stateFrame([agent('flight', 0), agent('ana', 1, { state: 'needs_you', needsKind: 'permission', needsReason: 'permission request: Bash: ls', needSeq: 9 })], [], [relief('h1')]));
    expect(await r.text()).toContain('NEEDS 2: ana: permission request: Bash: ls');
    r.stdin.type('g');
    await sleep(20);
    expect(r.calls.list.filter((c) => c[0] === 'answer')).toEqual([]);
    r.stdin.type('3');
    r.stdin.type('g');
    await sleep(30);
    expect(r.calls.list).toContainEqual(['answer', 'ana', true, 9]);
    expect(await r.text()).toContain('GO sent.');
    r.stdin.type('\x1b[B');
    r.stdin.type('x');
    await sleep(20);
    expect(r.calls.list).toContainEqual(['relief', 'h1', false]);
  });

  it('writes to an agent, holds and resumes it, and replies to a message with its id', async () => {
    const r = start();
    await r.link('open');
    await r.frame(stateFrame([agent('flight', 0), agent('ana', 1)], [message('m1')]));
    r.stdin.type('j');
    r.stdin.type('n');
    r.stdin.type('hello');
    await sleep(25);
    expect(await r.text()).toContain('Message to ana> hello_');
    r.stdin.type('\r');
    r.stdin.type('h');
    r.stdin.type('r');
    await sleep(30);
    expect(r.calls.list).toContainEqual(['sendMessage', { to: 'ana', subject: '', body: 'hello' }]);
    expect(r.calls.list).toContainEqual(['hold', 'ana']);
    expect(r.calls.list).toContainEqual(['resume', 'ana']);
    r.stdin.type('2');
    r.stdin.type('r');
    r.stdin.type('ok');
    r.stdin.type('\r');
    await sleep(30);
    expect(r.calls.list).toContainEqual(['markRead', ['m1']]);
    expect(r.calls.list).toContainEqual(['sendMessage', { to: 'ana', subject: 'Re: subject m1', body: 'ok', inReplyTo: 'm1' }]);
    r.stdin.type('4');
    r.stdin.type('t');
    await sleep(20);
    expect(r.calls.list).toContainEqual(['startPoll']);
  });

  it('shows what the server refused', async () => {
    const r = start();
    await r.link('open');
    await r.frame(stateFrame([agent('flight', 0)]));
    r.fake.client.hold = (): Promise<void> => Promise.reject(new Error('flight is stopped'));
    r.stdin.type('h');
    await sleep(40);
    expect(await r.text()).toContain('Could not hold flight: flight is stopped');
  });
});

describe('a console', () => {
  it('attaches at the size of the terminal, draws the snapshot, passes the bytes both ways, and leaves with Ctrl-] q', async () => {
    const r = start();
    await r.link('open');
    await r.frame(stateFrame([agent('flight', 0), agent('ana', 1)]));
    r.stdin.type('j');
    r.stdin.type('\r');
    expect(r.calls.list).toContainEqual(['attach', 'ana', 100, 24, 1]);
    // a snapshot of another attach is not drawn
    await r.frame({ t: 'snapshot', seq: 99, agent: 'ana', generation: 1, cols: 100, rows: 24, running: true, data: 'WRONG' });
    await r.frame({ t: 'snapshot', seq: 1, agent: 'ana', generation: 1, cols: 100, rows: 24, running: true, data: 'claude is ready\r\n> ' });
    r.fake.get().onOutput(Buffer.from('more output'));
    await sleep(20);
    const screen = await r.text();
    expect(screen).toContain('claude is ready');
    expect(screen).toContain('more output');
    expect(screen).not.toContain('WRONG');
    r.stdin.type('hi\r');
    r.stdin.type('\x1b[A');
    expect(r.calls.list).toContainEqual(['input', 'ana', 'hi\r']);
    expect(r.calls.list).toContainEqual(['input', 'ana', '\x1b[A']);
    // q, h and 3 are typed into the console, not read as keys of the room
    r.stdin.type('qh3');
    expect(r.calls.list).toContainEqual(['input', 'ana', 'qh3']);
    r.stdin.type('\x1dq');
    expect(r.calls.list.at(-1)).toEqual(['detach']);
    expect(r.stdout.chunks.join('')).toContain(RESET_MODES);
    await sleep(30);
    expect(await r.text()).toMatch(/\. ana\s+idle/);
    expect(await r.text()).not.toContain('claude is ready');
  });

  it('cuts the clipboard and title sequences out of what a console prints, in the snapshot and in the bytes, even split in two', async () => {
    const r = start();
    await r.link('open');
    await r.frame(stateFrame([agent('flight', 0)]));
    r.stdin.type('\r');
    await r.frame({ t: 'snapshot', seq: 1, agent: 'flight', generation: 1, cols: 100, rows: 24, running: true, data: 'ready\x1b]0;pwned\x07 ok' });
    r.fake.get().onOutput(Buffer.from('a\x1b]52;c;ZGF0YQ=='));
    r.fake.get().onOutput(Buffer.from('\x07b \x1b[31mred\x1b[0m\x1b]2;t\x1b\\c'));
    await sleep(20);
    const written = r.stdout.chunks.join('');
    expect(written).not.toContain('pwned');
    expect(written).not.toContain('ZGF0YQ');
    expect(written).not.toContain('\x1b]');
    expect(await r.text()).toContain('ready ok');
    expect(await r.text()).toContain('ab redc');
  });

  it('sends a Ctrl-] with a second one, and the key after any other', async () => {
    const r = start();
    await r.link('open');
    await r.frame(stateFrame([agent('flight', 0)]));
    r.stdin.type('\r');
    r.stdin.type('\x1d\x1d');
    r.stdin.type('\x1dz');
    expect(r.calls.list.filter((c) => c[0] === 'input')).toEqual([['input', 'flight', '\x1d'], ['input', 'flight', 'z']]);
  });

  it('tells the console about a resize, and attaches again after a reconnect', async () => {
    const r = start();
    await r.link('open');
    await r.frame(stateFrame([agent('flight', 0)]));
    r.stdin.type('\r');
    r.stdout.columns = 90;
    r.stdout.rows = 30;
    r.stdout.emit('resize');
    expect(r.calls.list).toContainEqual(['resize', 'flight', 90, 30]);
    await r.link('reconnecting');
    await r.link('open');
    expect(r.calls.list.filter((c) => c[0] === 'attach')).toEqual([['attach', 'flight', 100, 24, 1], ['attach', 'flight', 90, 30, 2]]);
  });

  it('shows the keys on a line when asked, and leaves the console when its agent is removed', async () => {
    const r = start();
    await r.link('open');
    await r.frame(stateFrame([agent('flight', 0), agent('ana', 1)]));
    r.stdin.type('j');
    r.stdin.type('\r');
    r.stdin.type('\x1d?');
    expect(r.stdout.chunks.at(-1)).toContain('Ctrl-] q: back to the room');
    await r.frame({ t: 'agent-removed', name: 'ana' });
    expect(r.calls.list).toContainEqual(['detach']);
    expect(await r.text()).toContain('ana was removed.');
  });
});
