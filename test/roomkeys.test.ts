/** Room keys (docs/features/room-keys.md): environment variables every agent of the room gets; values never leave the server. */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROOM_KEYS_FILE } from '../src/server/constants.js';
import { HubError } from '../src/server/hub.js';
import { createRoomKeys } from '../src/server/roomkeys.js';
import { stepUpReason } from '../src/server/stepup.js';
import { KEYS_MAX } from '../src/shared/protocol.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gng-rk-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const SECRET = 'AKIA-room-secret-value';
const refused = async (run: Promise<unknown>): Promise<HubError> => {
  try {
    await run;
  } catch (error) {
    if (error instanceof HubError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('the store', () => {
  it('saves in a file only the owner reads, and the page is told names, times and the Clean Room switch, never a value', async () => {
    const a = createRoomKeys({ dir, now: () => 1234 });
    await a.load();
    expect(a.view()).toEqual({ keys: [] });
    await a.set('AWS_REGION', { value: 'us-east-1' });
    const view = await a.set('AWS_SECRET_ACCESS_KEY', { value: SECRET, cleanRoom: true });
    expect(view).toEqual({ keys: [{ name: 'AWS_REGION', at: 1234, cleanRoom: false }, { name: 'AWS_SECRET_ACCESS_KEY', at: 1234, cleanRoom: true }] });
    expect(JSON.stringify(view)).not.toContain(SECRET);
    expect(statSync(join(dir, ROOM_KEYS_FILE)).mode & 0o777).toBe(0o600);
    await a.close();
    const b = createRoomKeys({ dir });
    await b.load();
    expect(b.values(false)).toEqual({ AWS_REGION: 'us-east-1', AWS_SECRET_ACCESS_KEY: SECRET });
  });

  it('an agent in a Clean Room is given only the keys marked for it', async () => {
    const a = createRoomKeys({ dir });
    await a.set('AWS_REGION', { value: 'us-east-1' });
    await a.set('AWS_BEARER_TOKEN_BEDROCK', { value: SECRET, cleanRoom: true });
    expect(a.values(true)).toEqual({ AWS_BEARER_TOKEN_BEDROCK: SECRET });
    expect(Object.keys(a.values(false))).toEqual(['AWS_REGION', 'AWS_BEARER_TOKEN_BEDROCK']);
  });

  it('the switch alone changes a saved key and keeps its value and its time; a new key needs a value', async () => {
    let t = 1;
    const a = createRoomKeys({ dir, now: () => t++ });
    await a.set('AWS_REGION', { value: 'us-east-1' });
    await a.set('AWS_REGION', { cleanRoom: true });
    expect(a.view().keys).toEqual([{ name: 'AWS_REGION', at: 1, cleanRoom: true }]);
    expect(a.values(true)).toEqual({ AWS_REGION: 'us-east-1' });
    expect(await refused(a.set('NEW_ONE', { cleanRoom: true }))).toMatchObject({ field: 'value' });
    await a.set('AWS_REGION', { value: 'eu-west-1' });
    expect(a.view().keys[0]).toMatchObject({ at: 2, cleanRoom: true });
  });

  it('judges names by the rules of Clearance and values by its shape, and never echoes a value', async () => {
    const a = createRoomKeys({ dir });
    for (const name of ['lower', 'GONOGO_TOKEN', 'PATH', 'LD_PRELOAD', 'DOCKER_HOST', '1A']) expect(await refused(a.set(name, { value: 'x' })), name).toMatchObject({ code: 'bad_request', field: 'name' });
    for (const value of ['', 'with space', 'a'.repeat(4097), 5, null]) {
      const error = await refused(a.set('OK_KEY', { value }));
      expect(error).toMatchObject({ field: 'value' });
      expect(error.message).not.toContain('with space');
    }
    expect(await refused(a.set('OK_KEY', { value: 'x', extra: 1 }))).toMatchObject({ field: 'extra' });
    expect(await refused(a.set('OK_KEY', { value: 'x', cleanRoom: 'yes' }))).toMatchObject({ field: 'cleanRoom' });
    expect(await refused(a.set('OK_KEY', 'x'))).toMatchObject({ code: 'bad_request' });
    expect(a.view().keys).toEqual([]);
  });

  it('at most KEYS_MAX keys; remove takes one out and a missing one is not found', async () => {
    const a = createRoomKeys({ dir });
    for (let i = 0; i < KEYS_MAX; i += 1) await a.set(`KEY_${i}`, { value: 'x' });
    expect(await refused(a.set('ONE_MORE', { value: 'x' }))).toMatchObject({ field: 'name' });
    await a.set('KEY_0', { value: 'y' });
    expect((await a.remove('KEY_0')).keys).toHaveLength(KEYS_MAX - 1);
    expect(await refused(a.remove('KEY_0'))).toMatchObject({ code: 'not_found' });
  });

  it('a file it cannot read is kept as .bad and the room has no keys', async () => {
    for (const text of ['not json with AKIA-secret', JSON.stringify({ version: 2, keys: {} })]) {
      writeFileSync(join(dir, ROOM_KEYS_FILE), text);
      const a = createRoomKeys({ dir });
      await a.load();
      expect(a.values(false)).toEqual({});
      expect(readFileSync(join(dir, `${ROOM_KEYS_FILE}.bad`), 'utf8')).toBe(text);
    }
  });

  it('a hand-edited entry with a reserved name or a bad value is skipped and its name logged (never a value), the rest kept', async () => {
    writeFileSync(join(dir, ROOM_KEYS_FILE), JSON.stringify({ version: 1, keys: { PATH: { value: 'x' }, GOOD_ONE: { value: 'v', at: 3, cleanRoom: true }, BAD_VALUE: { value: 'secret value with spaces' }, 'AKIA pasted secret': { value: 'x' } } }));
    const warned: string[] = [];
    const log = { debug() {}, info() {}, error() {}, warn: (m: string) => void warned.push(m), child() { return log; } };
    const a = createRoomKeys({ dir, log });
    await a.load();
    expect(a.view().keys).toEqual([{ name: 'GOOD_ONE', at: 3, cleanRoom: true }]);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('PATH, BAD_VALUE, (an entry whose name is not usable)');
    expect(warned[0]).not.toMatch(/secret|AKIA|spaces/);
  });

  it('a stored key whose name is reserved now is refused at load and listed by name', async () => {
    writeFileSync(join(dir, ROOM_KEYS_FILE), JSON.stringify({ version: 1, keys: { EDITOR: { value: SECRET }, OK_KEY: { value: 'v' } } }));
    const a = createRoomKeys({ dir });
    await a.load();
    expect(a.refused()).toEqual(['EDITOR']);
    expect(a.values(false)).toEqual({ OK_KEY: 'v' });
    // rewritten at once: the value is off the disk and the next start refuses nothing
    expect(readFileSync(join(dir, ROOM_KEYS_FILE), 'utf8')).not.toContain(SECRET);
    expect(statSync(join(dir, ROOM_KEYS_FILE)).mode & 0o777).toBe(0o600);
    const b = createRoomKeys({ dir });
    await b.load();
    expect(b.refused()).toEqual([]);
    expect(b.values(false)).toEqual({ OK_KEY: 'v' });
  });

  it('a change asks for the password again; a read does not', () => {
    for (const method of ['PUT', 'DELETE']) expect(stepUpReason(method, '/api/room-keys/AWS_REGION', {}), method).toBe('the keys of the room');
    expect(stepUpReason('GET', '/api/room-keys', null)).toBeNull();
  });
});
