/** gonogo tui: the connection to a server: the WebSocket with the token in the subprotocol, binary frames by attach seq, reconnect, REST. */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { RECONNECT_DELAYS_MS, WS_BINARY_OUTPUT, WS_INPUT_CHUNK_CHARS } from '../src/shared/protocol.js';
import type { ClientFrame, ServerFrame } from '../src/shared/protocol.js';
import { chunksOf, createTuiClient, wsUrl } from '../src/server/tui-client.js';
import type { TuiClient } from '../src/server/tui-client.js';
import type { Link } from '../src/server/tui-state.js';

const TOKEN = 'ab'.repeat(32);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

let server: http.Server;
let wss: WebSocketServer;
let base: string;
let sockets: WebSocket[];
let received: ClientFrame[];
let protocols: string[][];
let requests: Array<{ method: string; url: string; auth: string | undefined; body: unknown }>;
let restAnswer: { status: number; body: unknown };
let acceptToken: string;
let client: TuiClient | null = null;
let links: Link[];
let frames: ServerFrame[];
let output: Buffer[];
let timers: Array<{ fn: () => void; ms: number }>;

function make(): TuiClient {
  client = createTuiClient({
    url: base,
    token: TOKEN,
    onFrame: (f) => void frames.push(f),
    onOutput: (b) => void output.push(Buffer.from(b)),
    onLink: (l) => void links.push(l),
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: () => undefined,
  });
  return client;
}

beforeEach(async () => {
  sockets = [];
  received = [];
  protocols = [];
  requests = [];
  links = [];
  frames = [];
  output = [];
  timers = [];
  restAnswer = { status: 200, body: {} };
  acceptToken = TOKEN;
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, body: text === '' ? undefined : JSON.parse(text) });
      res.writeHead(restAnswer.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(restAnswer.body));
    });
  });
  wss = new WebSocketServer({
    server,
    verifyClient: (info, cb) => {
      const list = String(info.req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim());
      protocols.push(list);
      if (list.includes(`token.${acceptToken}`)) cb(true);
      else cb(false, 401, 'unauthorized');
    },
    handleProtocols: (set) => (set.has('gonogo.v1') ? 'gonogo.v1' : false),
  });
  wss.on('connection', (ws) => {
    sockets.push(ws);
    ws.on('message', (data) => received.push(JSON.parse(data.toString('utf8')) as ClientFrame));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  client?.stop();
  client = null;
  for (const s of sockets) s.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const binary = (seq: number, text: string, kind = WS_BINARY_OUTPUT): Buffer => {
  const head = Buffer.alloc(5);
  head[0] = kind;
  head.writeUInt32BE(seq, 1);
  return Buffer.concat([head, Buffer.from(text)]);
};

describe('addresses and paste', () => {
  it('turns a server address into the address of its WebSocket', () => {
    expect(wsUrl('http://127.0.0.1:7777')).toBe('ws://127.0.0.1:7777/ws');
    expect(wsUrl('https://room.example.test/some/path?x=1#y')).toBe('wss://room.example.test/ws');
  });

  it('cuts a paste into pieces and never between the two halves of an emoji', () => {
    expect(chunksOf('abcdef', 4)).toEqual(['abcd', 'ef']);
    expect(chunksOf('', 4)).toEqual([]);
    const pieces = chunksOf('ab😀cd', 3);
    expect(pieces.join('')).toBe('ab😀cd');
    for (const p of pieces) expect(p).not.toMatch(/[\ud800-\udbff]$/);
    const big = 'x'.repeat(WS_INPUT_CHUNK_CHARS * 2 + 5);
    expect(chunksOf(big).map((p) => p.length)).toEqual([WS_INPUT_CHUNK_CHARS, WS_INPUT_CHUNK_CHARS, 5]);
  });
});

describe('the WebSocket', () => {
  it('connects with the token in the subprotocol, never in the address, and gives the frames to the app', async () => {
    make().start();
    await until(() => links.includes('open'), 'the link');
    expect(protocols[0]).toEqual(['gonogo.v1', `token.${TOKEN}`]);
    sockets[0]!.send(JSON.stringify({ t: 'agent-removed', name: 'ana' }));
    sockets[0]!.send('not json');
    await until(() => frames.length === 1, 'a frame');
    expect(frames).toEqual([{ t: 'agent-removed', name: 'ana' }]);
  });

  it('attaches with a rising seq and the size of the terminal, types, resizes and detaches', async () => {
    const c = make();
    c.start();
    await until(() => links.includes('open'), 'the link');
    expect(c.attach('ana', 100, 30)).toBe(1);
    expect(c.attach('ben', 90, 20)).toBe(2);
    c.input('ben', 'hello');
    c.resize('ben', 80, 24);
    c.detach();
    await until(() => received.length === 5, 'the frames');
    expect(received).toEqual([
      { t: 'attach', seq: 1, agent: 'ana', cols: 100, rows: 30 },
      { t: 'attach', seq: 2, agent: 'ben', cols: 90, rows: 20 },
      { t: 'input', agent: 'ben', data: 'hello' },
      { t: 'resize', agent: 'ben', cols: 80, rows: 24 },
      { t: 'detach' },
    ]);
    expect(c.seq).toBe(0);
  });

  it('splits a long input into frames the server takes', async () => {
    const c = make();
    c.start();
    await until(() => links.includes('open'), 'the link');
    c.input('ana', 'y'.repeat(WS_INPUT_CHUNK_CHARS + 10));
    await until(() => received.length === 2, 'two frames');
    expect(received.map((f) => (f.t === 'input' ? f.data.length : 0))).toEqual([WS_INPUT_CHUNK_CHARS, 10]);
  });

  it('passes the bytes of the attached console on, and drops an older seq, another kind and a short frame', async () => {
    const c = make();
    c.start();
    await until(() => links.includes('open'), 'the link');
    c.attach('ana', 80, 24);
    c.attach('ana', 80, 24);
    sockets[0]!.send(binary(1, 'old'));
    sockets[0]!.send(binary(2, 'now'));
    sockets[0]!.send(binary(2, 'odd', 9));
    sockets[0]!.send(Buffer.from([WS_BINARY_OUTPUT, 0, 0]));
    sockets[0]!.send(binary(2, 'next'));
    await until(() => output.length === 2, 'the output');
    expect(output.map((b) => b.toString())).toEqual(['now', 'next']);
    c.detach();
    sockets[0]!.send(binary(2, 'after'));
    await sleep(60);
    expect(output).toHaveLength(2);
  });

  it('reconnects with the delays of the page when the server goes, and starts the delays again once it is back', async () => {
    make().start();
    await until(() => links.includes('open'), 'the link');
    sockets[0]!.terminate();
    await until(() => links.at(-1) === 'reconnecting', 'reconnecting');
    expect(timers.at(-1)!.ms).toBe(RECONNECT_DELAYS_MS[0]);
    timers.at(-1)!.fn();
    await until(() => links.filter((l) => l === 'open').length === 2, 'the second connection');
    expect(sockets).toHaveLength(2);
    sockets[1]!.terminate();
    await until(() => timers.length === 2, 'the second timer');
    expect(timers.at(-1)!.ms).toBe(RECONNECT_DELAYS_MS[0]);
  });

  it('waits longer each time it fails, up to the last delay', async () => {
    const c = make();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    c.start();
    for (let i = 0; i < RECONNECT_DELAYS_MS.length + 2; i += 1) {
      await until(() => timers.length === i + 1, `timer ${i + 1}`);
      timers[i]!.fn();
    }
    const delays = timers.map((t) => t.ms);
    expect(delays.slice(0, RECONNECT_DELAYS_MS.length)).toEqual([...RECONNECT_DELAYS_MS]);
    expect(delays.at(-1)).toBe(RECONNECT_DELAYS_MS.at(-1));
    // afterEach closes them again: give it something to close
    server = http.createServer();
    wss = new WebSocketServer({ server });
    c.stop();
  });

  it('says the token was refused and does not ask again', async () => {
    acceptToken = 'another';
    make().start();
    await until(() => links.includes('unauthorized'), 'unauthorized');
    await sleep(60);
    expect(timers).toHaveLength(0);
    expect(links).not.toContain('open');
  });

  it('stops for good: no timer and no more connections', async () => {
    const c = make();
    c.start();
    await until(() => links.includes('open'), 'the link');
    c.stop();
    await sleep(60);
    expect(timers).toHaveLength(0);
    expect(sockets).toHaveLength(1);
  });
});

describe('the REST calls', () => {
  it('sends the Bearer token and the body of each action', async () => {
    const c = make();
    await c.sendMessage({ to: 'ana', subject: 'Re: x', body: 'ok', inReplyTo: 'm3' });
    await c.answer('ana', true, 4);
    await c.answer('ben cat', false, null);
    await c.relief('h1', true);
    await c.relief('h2', false);
    await c.hold('ana');
    await c.resume('ana');
    await c.markRead(['m1', 'e2']);
    await c.archive(['m1']);
    await c.startPoll();
    expect(requests.map((r) => [r.method, r.url, r.body])).toEqual([
      ['POST', '/api/messages', { to: 'ana', subject: 'Re: x', body: 'ok', inReplyTo: 'm3' }],
      ['POST', '/api/agents/ana/answer', { go: true, needSeq: 4 }],
      ['POST', '/api/agents/ben%20cat/answer', { go: false }],
      ['POST', '/api/relief/h1/go', undefined],
      ['POST', '/api/relief/h2/no-go', undefined],
      ['POST', '/api/agents/ana/hold', undefined],
      ['POST', '/api/agents/ana/resume', undefined],
      ['POST', '/api/downlink/read', { ids: ['m1', 'e2'] }],
      ['POST', '/api/downlink/archive', { ids: ['m1'] }],
      ['POST', '/api/poll', {}],
    ]);
    for (const r of requests) expect(r.auth).toBe(`Bearer ${TOKEN}`);
  });

  it('turns a refusal into its message, and a server that is not there into one line', async () => {
    const c = make();
    restAnswer = { status: 409, body: { error: 'ana is not asking for a go', code: 'conflict' } };
    await expect(c.answer('ana', true, 1)).rejects.toThrow('ana is not asking for a go');
    restAnswer = { status: 502, body: 'x' };
    await expect(c.hold('ana')).rejects.toThrow('the server answered 502');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(c.hold('ana')).rejects.toThrow('could not reach the server');
    server = http.createServer();
  });
});
