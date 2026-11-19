/** Payload defaults (docs/payload-spec.md): the room's servers and skills, merged under an agent's own payload. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PAYLOAD_DEFAULTS_FILE } from '../src/server/constants.js';
import { HubError } from '../src/server/hub.js';
import { defaultsView, mergePayload, parsePayload } from '../src/server/payload.js';
import { createPayloadDefaults } from '../src/server/payloaddefaults.js';
import { stepUpReason } from '../src/server/stepup.js';
import type { Payload } from '../src/shared/protocol.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gng-pd-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const SECRET = 'sk-very-secret';
const room: Payload = {
  mcpServers: {
    files: { command: 'npx', args: ['-y', 'srv', `--token=${SECRET}`], env: { ROOT: SECRET } },
    web: { type: 'http', url: `https://mcp.example.test/v1?key=${SECRET}`, headers: { Authorization: `Bearer ${SECRET}` } },
  },
  skills: ['/skills/review', '/skills/triage'],
};
const bad = (value: unknown): string => {
  const checked = parsePayload(value);
  if (checked.ok) throw new Error('expected a refusal');
  return checked.error;
};
const refused = async (run: Promise<unknown>): Promise<HubError> => {
  try {
    await run;
  } catch (error) {
    if (error instanceof HubError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('off: what an agent switches off of the room', () => {
  it('is kept by the reader, deduplicated, after the servers and skills, and a payload may hold only it', () => {
    const own = { off: { mcpServers: ['files', 'files'], skills: ['review'] }, mcpServers: { a: { command: 'x' } } };
    expect(parsePayload(own)).toEqual({ ok: true, payload: { mcpServers: { a: { command: 'x' } }, off: { mcpServers: ['files'], skills: ['review'] } } });
    expect(parsePayload({ off: { mcpServers: ['files'] } })).toEqual({ ok: true, payload: { off: { mcpServers: ['files'] } } });
    expect(parsePayload({ off: {} })).toEqual({ ok: true, payload: undefined });
  });
  it('takes names only', () => {
    for (const off of [[], 'x', { servers: [] }, { mcpServers: 'a' }, { mcpServers: ['A b'] }, { mcpServers: [1] }, { skills: ['a/b'] }, { skills: [''] }]) expect(bad({ off }), JSON.stringify(off)).toMatch(/off/);
  });
});

describe('mergePayload: the agent wins', () => {
  it('adds the room to an agent with nothing', () => {
    expect(mergePayload(room, undefined, 'all')).toEqual(room);
  });
  it('a server of the agent with the room name replaces the room one whole, no field is merged', () => {
    const merged = mergePayload(room, { mcpServers: { files: { command: 'mine' } } }, 'all');
    expect(merged?.mcpServers?.files).toEqual({ command: 'mine' });
    expect(merged?.mcpServers?.web).toEqual(room.mcpServers?.web);
  });
  it('off leaves a room item out, by server name and by skill folder name, and nothing else', () => {
    const merged = mergePayload(room, { off: { mcpServers: ['web'], skills: ['review'] } }, 'all');
    expect(Object.keys(merged?.mcpServers ?? {})).toEqual(['files']);
    expect(merged?.skills).toEqual(['/skills/triage']);
    expect(merged).not.toHaveProperty('off');
  });
  it('an agent skill of the same folder name replaces the room one; another stays', () => {
    expect(mergePayload(room, { skills: ['/mine/review'] }, 'all')?.skills).toEqual(['/skills/triage', '/mine/review']);
  });
  it('off names an agent already has itself do not switch off the agent item', () => {
    expect(mergePayload(room, { mcpServers: { files: { command: 'mine' } }, off: { mcpServers: ['files'] } }, 'all')?.mcpServers?.files).toEqual({ command: 'mine' });
  });
  it('an engine with servers only gets no skills, and one with no payload gets nothing', () => {
    expect(mergePayload(room, undefined, 'servers')?.skills).toBeUndefined();
    expect(mergePayload(room, undefined, 'servers')?.mcpServers).toBeDefined();
    expect(mergePayload(room, { mcpServers: { a: { command: 'x' } } }, null)).toBeUndefined();
  });
  it('nothing at all is no payload; no room is the agent alone', () => {
    expect(mergePayload(undefined, undefined, 'all')).toBeUndefined();
    expect(mergePayload(undefined, { mcpServers: { a: { command: 'x' } }, off: { skills: ['x'] } }, 'all')).toEqual({ mcpServers: { a: { command: 'x' } } });
  });
});

describe('what the page may see', () => {
  it('names the items and never an argument, a value, a query or a header', () => {
    const view = defaultsView(room);
    expect(view).toEqual({
      mcpServers: [
        { name: 'files', type: 'stdio', target: 'npx', args: 3, names: ['ROOT'] },
        { name: 'web', type: 'http', target: 'https://mcp.example.test', args: 0, names: ['Authorization'] },
      ],
      skills: [
        { name: 'review', path: '/skills/review' },
        { name: 'triage', path: '/skills/triage' },
      ],
    });
    expect(JSON.stringify(view)).not.toContain(SECRET);
  });
});

describe('the store', () => {
  const skill = (name: string): string => {
    const path = join(dir, 'skills', name);
    mkdirSync(path, { recursive: true });
    return path;
  };

  it('keeps servers and skills one item at a time, in a file only the owner reads, and is read back at load', async () => {
    const a = createPayloadDefaults({ dir });
    await a.load();
    expect(a.view()).toEqual({ mcpServers: [], skills: [] });
    await a.setServer('files', room.mcpServers?.files);
    const view = await a.setServer('web', room.mcpServers?.web);
    expect(view.mcpServers.map((s) => s.name)).toEqual(['files', 'web']);
    const folder = skill('review');
    await a.addSkill(folder);
    expect(statSync(join(dir, PAYLOAD_DEFAULTS_FILE)).mode & 0o777).toBe(0o600);
    await a.close();
    const b = createPayloadDefaults({ dir });
    await b.load();
    expect(b.get()).toEqual({ mcpServers: room.mcpServers, skills: [folder] });
    const after = await b.removeSkill('review');
    expect(after.skills).toEqual([]);
    expect((await b.removeServer('web')).mcpServers.map((s) => s.name)).toEqual(['files']);
  });

  it('setting a server again replaces it whole', async () => {
    const a = createPayloadDefaults({ dir });
    await a.setServer('files', { command: 'one', args: ['x'] });
    await a.setServer('files', { command: 'two' });
    expect(a.get()?.mcpServers).toEqual({ files: { command: 'two' } });
  });

  it('judges each change by the rules of an agent payload', async () => {
    const a = createPayloadDefaults({ dir });
    expect(await refused(a.setServer('gonogo', { command: 'x' }))).toMatchObject({ code: 'bad_request', field: 'server' });
    expect(await refused(a.setServer('Bad Name', { command: 'x' }))).toMatchObject({ field: 'server' });
    expect(await refused(a.setServer('web', { url: 'https://x.test' }))).toMatchObject({ field: 'server' });
    expect(await refused(a.setServer('x', { command: 'a\u0000b' }))).toMatchObject({ field: 'server' });
    expect(await refused(a.addSkill('relative/dir'))).toMatchObject({ field: 'path' });
    expect(await refused(a.addSkill(join(dir, 'nowhere')))).toMatchObject({ field: 'path' });
    await a.addSkill(skill('one'));
    expect(await refused(a.addSkill(join(skill('one'))))).toMatchObject({ field: 'path' });
    expect(await refused(a.removeServer('nope'))).toMatchObject({ code: 'not_found' });
    expect(await refused(a.removeSkill('nope'))).toMatchObject({ code: 'not_found' });
    expect(a.get()?.mcpServers).toBeUndefined();
  });

  it('a file it cannot read, or one with off in it, is kept as .bad and the room has no defaults', async () => {
    for (const text of ['not json', JSON.stringify({ version: 1, payload: { off: { skills: ['x'] } } }), JSON.stringify({ version: 2, payload: {} }), JSON.stringify({ version: 1, payload: { mcpServers: { gonogo: { command: 'x' } } } })]) {
      writeFileSync(join(dir, PAYLOAD_DEFAULTS_FILE), text);
      const a = createPayloadDefaults({ dir });
      await a.load();
      expect(a.get()).toBeUndefined();
      expect(readFileSync(join(dir, `${PAYLOAD_DEFAULTS_FILE}.bad`), 'utf8')).toBe(text);
    }
  });

  it('a change asks for the password again', () => {
    for (const method of ['PUT', 'DELETE', 'POST']) expect(stepUpReason(method, '/api/payload-defaults/servers/files', {}), method).toBe('the Payload defaults of the room');
    expect(stepUpReason('GET', '/api/payload-defaults', null)).toBeNull();
  });
});
