/**
 * The limits on one agent token (SECPROC-1 and SECPROC-2) through the real MCP edge: the real hub behind the real /mcp
 * handler on a real HTTP port, called by the MCP SDK's own client, so each tool result is the text, the isError flag and
 * the size that Claude Code would receive. The hub's own rules are pinned in hub.test.ts; what only the edge shows is
 * pinned here. The hub's HubIo is a fake with a frozen clock: nothing spawns, nothing types, no timer fires.
 */
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentIdentity, Hub, HubIo, ReadMessagesResult } from '../src/shared/protocol.js';
import {
  BODY_MAX_CHARS,
  MAILBOX_MAX_BODY_CHARS,
  MAILBOX_MAX_MESSAGES,
  POLL_REASON_MAX_CHARS,
  READ_MAX_CHARS,
  SEND_RATE_MAX,
  nullLogger,
} from '../src/server/constants.js';
import { createHub } from '../src/server/hub.js';
import { createMcpHandler } from '../src/server/mcp.js';

const T0 = 1_700_000_000_000;
const MORE = 'More messages are waiting: call read_messages again to read them.';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** 64 hex characters that name the agent, so each agent has its own token. */
const tokenOf = (name: string): string => Buffer.from(name.padEnd(32, '_')).toString('hex');

interface Office {
  hub: Hub;
  client(agent: string): Promise<Client>;
}

async function openOffice(agents: string[]): Promise<Office> {
  let messageSeq = 0;
  let sessionSeq = 0;
  const io: HubIo = {
    now: () => T0,
    setTimer: () => ({}),
    clearTimer: () => undefined,
    newMessageId: () => `m${(messageSeq += 1)}`,
    newSessionId: () => `00000000-0000-4000-8000-${String((sessionSeq += 1)).padStart(12, '0')}`,
    checkDirectory: async (path) => ({ ok: true, path }),
    loadRoster: async () => ({ version: 1, agents: [] }),
    saveRoster: async () => undefined,
    loadHistory: async () => [],
    logMessage: () => undefined,
    renameAgentFiles: async () => undefined,
    spawn: async (req) => ({ generation: req.generation, flag: req.flag ?? 'session-id', pid: 4242 }),
    stop: async () => undefined,
    typePointer: () => false,
    screen: () => null,
    title: () => null,
    outputBytes: () => 0,
    emit: () => undefined,
    log: nullLogger,
  };
  const hub = createHub(io, { maxHops: 8, bossDir: '/work' });
  await hub.start();
  for (const name of agents) await hub.hire({ name, role: `${name} works`, dir: `/work/${name}`, mode: 'default' });
  const identities = new Map<string, AgentIdentity>();
  for (const view of hub.views()) identities.set(tokenOf(view.name), { agent: view.name, generation: view.generation });
  const handler = createMcpHandler({ hub, resolveToken: (token) => identities.get(token) ?? null, log: nullLogger });
  const http = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      }),
  );
  const address = http.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    hub,
    client: async (agent) => {
      const client = new Client({ name: 'mcp-limits-test', version: '1.0.0' });
      const headers = { Authorization: `Bearer ${tokenOf(agent)}` };
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers } }));
      cleanups.push(() => client.close());
      return client;
    },
  };
}

function outcome(result: unknown): { text: string; isError: boolean; json: Record<string, unknown> } {
  const r = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  const text = r.content?.[0]?.type === 'text' ? (r.content[0].text ?? '') : '';
  return { text, isError: r.isError === true, json: JSON.parse(text) as Record<string, unknown> };
}

describe('read_messages through the edge (SECPROC-2)', () => {
  it('hands a full mailbox over in capped results: every message once, in order, every result under the output cap', async () => {
    const office = await openOffice(['ana']);
    const ana = await office.client('ana');
    for (let index = 0; index < MAILBOX_MAX_MESSAGES; index += 1) {
      office.hub.sendFromUser({ to: 'ana', body: `${index}`.padEnd(2_000, 'y') });
    }
    const ids: string[] = [];
    const sizes: number[] = [];
    for (let call = 0; call < MAILBOX_MAX_MESSAGES; call += 1) {
      const out = outcome(await ana.callTool({ name: 'read_messages', arguments: {} }));
      expect(out.isError).toBe(false);
      const result = out.json as unknown as ReadMessagesResult;
      expect(result.count).toBe(result.messages.length);
      ids.push(...result.messages.map((message) => message.id));
      sizes.push(out.text.length);
      if (result.remaining === undefined) {
        expect(out.json).not.toHaveProperty('note');
        break;
      }
      expect(result.remaining).toBe(MAILBOX_MAX_MESSAGES - ids.length);
      expect(result.note).toBe(MORE);
    }
    expect(ids).toEqual(Array.from({ length: MAILBOX_MAX_MESSAGES }, (_, index) => `m${index + 1}`));
    expect(sizes.length).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(READ_MAX_CHARS);
    expect(office.hub.activity().every((item) => item.status === 'read')).toBe(true);
  });

  it('keeps what it did not return unread: the activity says so until the next call', async () => {
    const office = await openOffice(['ana']);
    const ana = await office.client('ana');
    for (let index = 0; index < 25; index += 1) office.hub.sendFromUser({ to: 'ana', body: `message ${index}` });
    const first = outcome(await ana.callTool({ name: 'read_messages', arguments: {} }));
    expect(first.json).toMatchObject({ count: 20, remaining: 5, note: MORE });
    const statuses = office.hub.activity().map((item) => item.status);
    expect(statuses.filter((status) => status === 'read')).toHaveLength(20);
    expect(statuses.filter((status) => status === 'queued')).toHaveLength(5);
    const second = outcome(await ana.callTool({ name: 'read_messages', arguments: {} }));
    expect(second.json).toMatchObject({ count: 5 });
    expect(second.json).not.toHaveProperty('remaining');
  });

  it('says nothing extra when nothing is left: the result of an empty or complete read keeps its exact shape', async () => {
    const office = await openOffice(['ana']);
    const ana = await office.client('ana');
    expect(outcome(await ana.callTool({ name: 'read_messages', arguments: {} })).text).toBe('{"count":0,"messages":[]}');
    office.hub.sendFromUser({ to: 'ana', body: 'one' });
    const out = outcome(await ana.callTool({ name: 'read_messages', arguments: {} }));
    expect(Object.keys(out.json)).toEqual(['count', 'messages']);
  });
});

describe('a flood from one agent token (SECPROC-1)', () => {
  it('is cut off: the mailbox stops at its cap, the rate limit closes after that, and every refusal is an error that says why', async () => {
    const office = await openOffice(['ana', 'ben']);
    const ana = await office.client('ana');
    const body = 'x'.repeat(BODY_MAX_CHARS);
    const outcomes = [];
    for (let index = 0; index < SEND_RATE_MAX + 5; index += 1) {
      outcomes.push(outcome(await ana.callTool({ name: 'send_message', arguments: { to: 'ben', body } })));
    }
    const fits = Math.floor(MAILBOX_MAX_BODY_CHARS / BODY_MAX_CHARS);
    expect(outcomes.slice(0, fits).every((out) => !out.isError && out.json.status === 'queued')).toBe(true);
    const full = 'mailbox full: ben has too many unread messages';
    const limited = 'rate limit: ana sent too many messages this minute';
    expect(outcomes[fits]).toMatchObject({
      isError: true,
      text: `{"ok":false,"id":"m${fits + 1}","to":"ben","status":"undelivered","note":"${full}"}`,
    });
    expect(outcomes.slice(fits, SEND_RATE_MAX).every((out) => out.isError && out.json.note === full)).toBe(true);
    expect(outcomes[SEND_RATE_MAX]).toMatchObject({
      isError: true,
      text: `{"ok":false,"id":"m${SEND_RATE_MAX + 1}","to":"ben","status":"undelivered","note":"${limited}"}`,
    });
    expect(outcomes.slice(SEND_RATE_MAX).every((out) => out.isError && out.json.note === limited)).toBe(true);
    // What the victim holds is the cap, not the flood.
    expect(office.hub.views().find((view) => view.name === 'ben')?.queued).toBe(fits);
    const ben = await office.client('ben');
    const read = outcome(await ben.callTool({ name: 'read_messages', arguments: {} }));
    const counted = (read.json as unknown as ReadMessagesResult).count + ((read.json as unknown as ReadMessagesResult).remaining ?? 0);
    expect(counted).toBe(fits);
  });
});

describe('go_nogo through the edge', () => {
  it('records the vote of the token holder, cuts nothing the schema allows, and says why a vote does not count', async () => {
    const office = await openOffice(['ana', 'ben']);
    const ana = await office.client('ana');
    const none = outcome(await ana.callTool({ name: 'go_nogo', arguments: { vote: 'go', reason: 'ready' } }));
    expect(none).toMatchObject({ isError: true, json: { ok: false, note: 'no poll is open' } });

    office.hub.startPoll({ agents: ['ana'] });
    const ben = await office.client('ben');
    const outsider = outcome(await ben.callTool({ name: 'go_nogo', arguments: { vote: 'go', reason: 'ready' } }));
    expect(outsider).toMatchObject({ isError: true, json: { ok: false, note: 'you are not in this poll' } });

    const reason = 'x'.repeat(POLL_REASON_MAX_CHARS);
    const yes = outcome(await ana.callTool({ name: 'go_nogo', arguments: { vote: 'go', reason } }));
    expect(yes.isError).toBe(false);
    expect(yes.json.ok).toBe(true);
    expect(office.hub.poll()).toMatchObject({ status: 'go', entries: [{ agent: 'ana', vote: 'go', reason }] });
  });
});
