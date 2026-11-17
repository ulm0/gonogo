/** Payload (docs/payload-spec.md): the one reader of an agent's MCP servers and skill folders. */
import { describe, expect, it } from 'vitest';
import { PAYLOAD_MAX_CHARS, PAYLOAD_MAX_ITEMS, PAYLOAD_MAX_SERVERS, PAYLOAD_MAX_SKILLS, PAYLOAD_STRING_MAX_CHARS } from '../src/server/constants.js';
import { parsePayload, payloadRefusal } from '../src/server/payload.js';

const bad = (value: unknown): { field: string; error: string } => {
  const checked = parsePayload(value);
  if (checked.ok) throw new Error(`expected a refusal, got ${JSON.stringify(checked.payload)}`);
  return { field: checked.field, error: checked.error };
};
const servers = (config: unknown, name = 'files'): unknown => ({ mcpServers: { [name]: config } });

describe('parsePayload', () => {
  it('nothing, null and empty lists are no payload', () => {
    for (const value of [undefined, null, {}, { mcpServers: {} }, { skills: [] }, { mcpServers: {}, skills: [] }]) {
      expect(parsePayload(value)).toEqual({ ok: true, payload: undefined });
    }
  });

  it('keeps a stdio server, a url server and the skills as given, and normalises the skill paths', () => {
    const payload = {
      mcpServers: {
        files: { command: 'npx', args: ['-y', ''], env: { ROOT: '/work', _X1: '' } },
        explicit: { type: 'stdio', command: 'node' },
        web: { type: 'http', url: 'https://example.test/mcp?x=1', headers: { Authorization: 'Bearer ${TOKEN}', 'X-Key': 'k' } },
        stream: { type: 'sse', url: 'http://127.0.0.1:9/sse' },
      },
      skills: ['/skills/a/', '/skills/b/../c'],
    };
    expect(parsePayload(payload)).toEqual({ ok: true, payload: { ...payload, skills: ['/skills/a', '/skills/c'] } });
  });

  it('the payload and its servers take only the fields of the shape', () => {
    expect(bad([])).toMatchObject({ field: 'payload' });
    expect(bad('x')).toMatchObject({ field: 'payload' });
    expect(bad({ plugins: [] })).toEqual({ field: 'payload', error: 'payload has no field "plugins"' });
    expect(bad(servers({ command: 'x', cwd: '/' }))).toMatchObject({ field: 'payload.mcpServers', error: expect.stringContaining('"cwd" is not a field of a stdio server') });
    expect(bad(servers({ type: 'http', url: 'https://x.test', command: 'x' }))).toMatchObject({ error: expect.stringContaining('"command" is not a field of a http server') });
    expect(bad(servers({ url: 'https://x.test' }))).toMatchObject({ error: expect.stringContaining('needs "type": "http" or "sse"') });
    expect(bad(servers({ type: 'websocket', url: 'wss://x.test' }))).toMatchObject({ error: expect.stringContaining('type must be one of stdio, http, sse') });
    expect(bad({ mcpServers: [] })).toMatchObject({ field: 'payload.mcpServers' });
    expect(bad(servers('npx'))).toMatchObject({ error: 'server "files" must be an object' });
  });

  it('server names: lowercase, digits, - and _, at most 32, never gonogo', () => {
    for (const name of ['a', '0x', 'my-server_2', 'a'.repeat(32), 'constructor']) {
      expect(parsePayload(servers({ command: 'x' }, name)).ok, name).toBe(true);
    }
    for (const name of ['', 'Files', '-a', '_a', 'a b', 'a.b', 'a'.repeat(33), '__proto__']) {
      expect(bad(servers({ command: 'x' }, name)), name).toMatchObject({ field: 'payload.mcpServers', error: expect.stringContaining('server name') });
    }
    expect(bad(servers({ command: 'x' }, 'gonogo'))).toEqual({ field: 'payload.mcpServers', error: '"gonogo" is reserved for the gonogo tools' });
  });

  it('command, args, env and headers: text of the right size and shape, no NUL, no line break in a header', () => {
    expect(bad(servers({}))).toMatchObject({ error: expect.stringContaining('command must be text of 1 to') });
    expect(bad(servers({ command: 'x'.repeat(PAYLOAD_STRING_MAX_CHARS + 1) }))).toMatchObject({ error: expect.stringContaining('command must be') });
    expect(bad(servers({ command: 'a\u0000b' }))).toMatchObject({ error: expect.stringContaining('NUL') });
    expect(bad(servers({ command: 'x', args: 'a' }))).toMatchObject({ error: expect.stringContaining('args must be a list') });
    expect(bad(servers({ command: 'x', args: ['a', 2] }))).toMatchObject({ error: expect.stringContaining('args[1]') });
    expect(bad(servers({ command: 'x', args: ['a\u0000'] }))).toMatchObject({ error: expect.stringContaining('NUL') });
    expect(bad(servers({ command: 'x', args: Array(PAYLOAD_MAX_ITEMS + 1).fill('a') }))).toMatchObject({ error: expect.stringContaining('args must be a list') });
    expect(bad(servers({ command: 'x', env: ['A=1'] }))).toMatchObject({ error: expect.stringContaining('env must be an object') });
    expect(bad(servers({ command: 'x', env: { '1A': 'x' } }))).toMatchObject({ error: expect.stringContaining('"1A" is not a usable name') });
    expect(bad(servers({ command: 'x', env: { A: 5 } }))).toMatchObject({ error: expect.stringContaining('env.A') });
    const many = Object.fromEntries(Array.from({ length: PAYLOAD_MAX_ITEMS + 1 }, (_, i) => [`K${i}`, 'v']));
    expect(bad(servers({ command: 'x', env: many }))).toMatchObject({ error: expect.stringContaining(`at most ${PAYLOAD_MAX_ITEMS} entries`) });
    const web = { type: 'http', url: 'https://x.test' };
    expect(bad(servers({ ...web, url: 'not a url' }))).toMatchObject({ error: expect.stringContaining('http or https address') });
    expect(bad(servers({ ...web, url: 'file:///etc/passwd' }))).toMatchObject({ error: expect.stringContaining('http or https address') });
    expect(bad(servers({ ...web, headers: { 'Bad Name': 'x' } }))).toMatchObject({ error: expect.stringContaining('not a usable name') });
    expect(bad(servers({ ...web, headers: { H: 'a\r\nInjected: 1' } }))).toMatchObject({ error: expect.stringContaining('line break') });
  });

  it('a name like __proto__ in env stays a plain key and does not touch any prototype', () => {
    const env = JSON.parse('{"__proto__": "x", "A": "1"}') as Record<string, string>;
    const checked = parsePayload(servers({ command: 'x', env }));
    if (!checked.ok) throw new Error(checked.error);
    const out = checked.payload?.mcpServers?.files?.env ?? {};
    expect(Object.keys(out)).toEqual(['__proto__', 'A']);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('counts: at most PAYLOAD_MAX_SERVERS servers and PAYLOAD_MAX_SKILLS skills', () => {
    const many = Object.fromEntries(Array.from({ length: PAYLOAD_MAX_SERVERS + 1 }, (_, i) => [`s${i}`, { command: 'x' }]));
    expect(bad({ mcpServers: many })).toEqual({ field: 'payload.mcpServers', error: `at most ${PAYLOAD_MAX_SERVERS} servers` });
    expect(bad({ skills: Array.from({ length: PAYLOAD_MAX_SKILLS + 1 }, (_, i) => `/s/${i}`) })).toMatchObject({ field: 'payload.skills' });
  });

  it('the whole payload is at most PAYLOAD_MAX_CHARS of JSON, because every agent frame carries it', () => {
    const big = (n: number): unknown => ({ mcpServers: Object.fromEntries(Array.from({ length: n }, (_, i) => [`s${i}`, { command: 'x', args: Array(PAYLOAD_MAX_ITEMS).fill('x'.repeat(PAYLOAD_STRING_MAX_CHARS)) }])) });
    expect(JSON.stringify(big(1)).length).toBeGreaterThan(PAYLOAD_MAX_CHARS);
    expect(parsePayload({ mcpServers: { a: { command: 'x'.repeat(PAYLOAD_STRING_MAX_CHARS) } } }).ok).toBe(true);
    expect(bad(big(1))).toEqual({ field: 'payload', error: `payload must be at most ${PAYLOAD_MAX_CHARS} characters of JSON` });
  });

  it('skill folders: absolute, no NUL, no repeats, and one folder name each (the name is the skill name)', () => {
    expect(bad({ skills: 'a' })).toMatchObject({ field: 'payload.skills' });
    expect(bad({ skills: [''] })).toMatchObject({ field: 'payload.skills' });
    expect(bad({ skills: [5] })).toMatchObject({ field: 'payload.skills' });
    expect(bad({ skills: ['review'] })).toEqual({ field: 'payload.skills', error: 'a skill folder must be an absolute path: review' });
    expect(bad({ skills: ['~/skills/review'] })).toMatchObject({ field: 'payload.skills' });
    expect(bad({ skills: ['/a\u0000/b'] })).toMatchObject({ field: 'payload.skills' });
    expect(bad({ skills: ['/a/review', '/a/review/'] })).toMatchObject({ error: 'skill folders must differ in name: /a/review' });
    expect(bad({ skills: ['/a/review', '/b/review'] })).toMatchObject({ error: 'skill folders must differ in name: /b/review' });
  });
});

describe('payloadRefusal', () => {
  it('claude takes both, gemini and kimi servers only, every other engine and the custom command nothing', () => {
    const both = { mcpServers: { f: { command: 'x' } }, skills: ['/s/a'] };
    expect(payloadRefusal(undefined, both)).toBeNull();
    expect(payloadRefusal('claude', both)).toBeNull();
    for (const provider of ['gemini', 'kimi'] as const) {
      expect(payloadRefusal(provider, { mcpServers: both.mcpServers })).toBeNull();
      expect(payloadRefusal(provider, both)).toMatchObject({ field: 'payload.skills' });
    }
    for (const provider of ['codex', 'opencode', 'copilot', 'pi', 'qwen', 'custom'] as const) {
      expect(payloadRefusal(provider, { mcpServers: both.mcpServers })).toMatchObject({ field: 'payload' });
    }
  });
});
