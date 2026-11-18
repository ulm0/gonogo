import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentView, Logger, SendResult, UserMessageRequest } from '../src/shared/protocol.js';
import { HubError } from '../src/server/hub.js';
import { createMassBudget, MEMORY_READ_MAX, MEMORY_SOFT_BYTES, MEMORY_SOFT_LINES, MEMORY_TARGET_LINES, reflectBody } from '../src/server/massbudget.js';
import type { MassBudget } from '../src/server/massbudget.js';

let dir: string;
let path: string;
let sent: UserMessageRequest[];
let answer: (request: UserMessageRequest) => SendResult;
let warnings: string[];

const quiet = (): Logger => {
  const log: Logger = { debug: () => undefined, info: () => undefined, warn: (m) => void warnings.push(m), error: () => undefined, child: () => log };
  return log;
};
const delivered = (request: UserMessageRequest): SendResult => ({ ok: true, id: 'm1', to: request.to, status: 'queued', note: null });
const agent = (provider: AgentView['provider']): AgentView => ({ name: 'ana', provider }) as AgentView;
const make = (provider: AgentView['provider'] = 'claude'): MassBudget =>
  createMassBudget({
    memoryPath: () => path,
    agent: (name) => (name === 'ana' ? agent(provider) : undefined),
    send: (request) => {
      sent.push(request);
      return answer(request);
    },
    log: quiet(),
  });
const refused = async (run: () => Promise<unknown>): Promise<{ code: string; message: string }> => {
  try {
    await run();
  } catch (e) {
    if (e instanceof HubError) return { code: e.code, message: e.message };
    throw e;
  }
  throw new Error('it was not refused');
};
const names = async (): Promise<string[]> => (await readdir(dir)).sort();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gonogo-mass-'));
  path = join(dir, 'memory.md');
  sent = [];
  warnings = [];
  answer = delivered;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the view', () => {
  it('counts the bytes and the lines, with or without a last newline', async () => {
    const mass = make();
    await writeFile(path, 'one\ntwo\nthree\n');
    expect(await mass.view('ana')).toMatchObject({ exists: true, bytes: 14, lines: 3, over: false, softLines: MEMORY_SOFT_LINES, softBytes: MEMORY_SOFT_BYTES, backup: null });
    await writeFile(path, 'one\ntwo');
    expect((await mass.view('ana')).lines).toBe(2);
    await writeFile(path, '');
    expect(await mass.view('ana')).toMatchObject({ exists: true, bytes: 0, lines: 0, over: false });
  });

  it('says a file that is not there yet is not there, without making it', async () => {
    expect(await make().view('ana')).toMatchObject({ exists: false, bytes: 0, lines: 0, over: false, changedAt: null, backup: null });
    expect(await names()).toEqual([]);
  });

  it('warns over either soft limit and not at the limit itself', async () => {
    const mass = make();
    await writeFile(path, 'x\n'.repeat(MEMORY_SOFT_LINES));
    expect((await mass.view('ana')).over).toBe(false);
    await writeFile(path, 'x\n'.repeat(MEMORY_SOFT_LINES + 1));
    expect((await mass.view('ana')).over).toBe(true);
    await writeFile(path, 'y'.repeat(MEMORY_SOFT_BYTES));
    expect((await mass.view('ana')).over).toBe(false);
    await writeFile(path, 'y'.repeat(MEMORY_SOFT_BYTES + 1));
    expect((await mass.view('ana')).over).toBe(true);
  });

  it('does not read a file past the read limit: it has no line count and is over', async () => {
    await writeFile(path, 'z'.repeat(MEMORY_READ_MAX + 1));
    expect(await make().view('ana')).toMatchObject({ exists: true, bytes: MEMORY_READ_MAX + 1, lines: null, over: true });
  });

  it('knows only agents that have a memory file', async () => {
    expect(await refused(() => make().view('bob'))).toEqual({ code: 'not_found', message: 'unknown agent' });
    expect(await refused(() => make('custom').view('ana'))).toMatchObject({ code: 'not_found' });
    expect(await refused(() => make('custom').reflect('ana'))).toMatchObject({ code: 'not_found' });
    expect(sent).toEqual([]);
  });

  it('refuses a link, a folder and a named pipe in place of the file', async () => {
    await writeFile(join(dir, 'secret.txt'), 'private');
    await symlink(join(dir, 'secret.txt'), path);
    expect(await refused(() => make().view('ana'))).toMatchObject({ code: 'conflict', message: expect.stringContaining('symbolic link') });
    await rm(path);
    await mkdir(path);
    expect(await refused(() => make().view('ana'))).toMatchObject({ code: 'conflict', message: expect.stringContaining('not a regular file') });
    await rm(path, { recursive: true });
    // opened for reading, a pipe with no writer would wait for ever
    execFileSync('mkfifo', [path]);
    expect(await refused(() => make().reflect('ana'))).toMatchObject({ code: 'conflict', message: expect.stringContaining('not a regular file') });
  });
});

describe('a request to condense', () => {
  const NOTES = '# Memory of ana\n\n- the cache key has the node version\n- bytes éè stay as they are\n';

  it('sends one message to the agent, copies the file after it and never writes memory.md', async () => {
    await writeFile(path, NOTES);
    const before = await stat(path);
    const result = await make().reflect('ana');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'ana', subject: 'Mass Budget: condense your memory file' });
    expect(sent[0]?.body).toBe(reflectBody({ name: 'ana', path, bytes: Buffer.byteLength(NOTES), lines: 4 }));
    expect(await readFile(`${path}.bak`, 'utf8')).toBe(NOTES);
    expect(((await stat(`${path}.bak`)).mode & 0o777).toString(8)).toBe('600');
    // gonogo never wrote the file the agent may be writing
    expect(await readFile(path, 'utf8')).toBe(NOTES);
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
    expect(result.send.ok).toBe(true);
    expect(result.memory).toMatchObject({ exists: true, backup: { bytes: Buffer.byteLength(NOTES) } });
    expect(await names()).toEqual(['memory.md', 'memory.md.bak']);
  });

  it('writes an instruction that names the file, the size, the target, the Mission Log and the answer', () => {
    const body = reflectBody({ name: 'ana', path: '/h/agents/ana/memory.md', bytes: 3000, lines: 70 });
    for (const part of ['/h/agents/ana/memory.md (3000 bytes, 70 lines)', 'memory.md.bak', `at most ${MEMORY_TARGET_LINES} lines`, 'log_write', '"# Memory of ana"', 'send_message to "user"', 'Memory condensed']) {
      expect(body).toContain(part);
    }
    expect(body.length).toBeLessThan(2000);
  });

  it('keeps one copy: the next request replaces it with the file as it is then', async () => {
    const mass = make();
    await writeFile(path, 'first\n');
    await mass.reflect('ana');
    await writeFile(path, 'second\n');
    await mass.reflect('ana');
    expect(await readFile(`${path}.bak`, 'utf8')).toBe('second\n');
    expect(await names()).toEqual(['memory.md', 'memory.md.bak']);
    expect(sent).toHaveLength(2);
  });

  it('keeps the older copy and leaves no temporary file when the hub does not deliver', async () => {
    const mass = make();
    await writeFile(path, 'old\n');
    await mass.reflect('ana');
    await writeFile(path, 'newer notes\n');
    answer = (request) => ({ ok: false, id: 'm2', to: request.to, status: 'undelivered', note: 'ana is stopped; the message went to the user' });
    const result = await mass.reflect('ana');
    expect(result.send).toMatchObject({ ok: false, note: 'ana is stopped; the message went to the user' });
    expect(await readFile(`${path}.bak`, 'utf8')).toBe('old\n');
    expect(await names()).toEqual(['memory.md', 'memory.md.bak']);
  });

  it('keeps no copy at all when the hub refuses, and passes the refusal on', async () => {
    await writeFile(path, 'notes\n');
    answer = () => {
      throw new HubError('rate_limited', 'too many messages');
    };
    expect(await refused(() => make().reflect('ana'))).toEqual({ code: 'rate_limited', message: 'too many messages' });
    expect(await names()).toEqual(['memory.md']);
  });

  it('refuses a missing file, a file past the read limit and a link, and sends nothing', async () => {
    const mass = make();
    expect(await refused(() => mass.reflect('ana'))).toMatchObject({ code: 'conflict', message: expect.stringContaining('no memory file yet') });
    await writeFile(path, 'w'.repeat(MEMORY_READ_MAX + 1));
    expect(await refused(() => mass.reflect('ana'))).toMatchObject({ code: 'conflict', message: expect.stringContaining('trim it by hand') });
    await rm(path);
    await writeFile(join(dir, 'secret.txt'), 'private');
    await symlink(join(dir, 'secret.txt'), path);
    expect(await refused(() => mass.reflect('ana'))).toMatchObject({ code: 'conflict' });
    expect(sent).toEqual([]);
    expect(await names()).toEqual(['memory.md', 'secret.txt']);
  });

  it('puts the copy in place of a link that stands where the copy goes, never through it', async () => {
    await writeFile(path, 'notes\n');
    await writeFile(join(dir, 'victim.txt'), 'untouched');
    await symlink(join(dir, 'victim.txt'), `${path}.bak`);
    await make().reflect('ana');
    expect(await readFile(join(dir, 'victim.txt'), 'utf8')).toBe('untouched');
    expect(await readFile(`${path}.bak`, 'utf8')).toBe('notes\n');
  });

  it('sends the message and leaves no temporary file when a folder stands where the copy goes', async () => {
    await writeFile(path, 'notes\n');
    await mkdir(`${path}.bak`);
    const result = await make().reflect('ana');
    expect(result.send.ok).toBe(true);
    // no copy is reported, so the page does not claim one
    expect(result.memory.backup).toBeNull();
    expect(warnings).toEqual(['could not write memory.md.bak of ana']);
    expect(await names()).toEqual(['memory.md', 'memory.md.bak']);
  });

  it('sends once when it is asked twice at the same time', async () => {
    await writeFile(path, 'notes\n');
    const mass = make();
    const results = await Promise.allSettled([mass.reflect('ana'), mass.reflect('ana')]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(sent).toHaveLength(1);
    // and it can be asked again after
    await mass.reflect('ana');
    expect(sent).toHaveLength(2);
  });

  it('tells the copy from a rewrite by the times of the two files', async () => {
    const mass = make();
    await writeFile(path, 'a long file\n'.repeat(5));
    const asked = await mass.reflect('ana');
    expect(asked.memory.changedAt).toBeLessThanOrEqual(asked.memory.backup?.at ?? 0);
    const later = new Date(Date.now() + 60_000);
    await writeFile(path, 'short\n');
    await utimes(path, later, later);
    const view = await mass.view('ana');
    expect(view.changedAt).toBeGreaterThan(view.backup?.at ?? Infinity);
    expect(view).toMatchObject({ bytes: 6, lines: 1, backup: { bytes: 60 } });
  });

  it('does not take the file when the folder cannot be written, and says so', async () => {
    await writeFile(path, 'notes\n');
    await chmod(dir, 0o500);
    try {
      if ((await stat(dir)).uid === 0) return; // root writes anywhere
      await expect(make().reflect('ana')).rejects.toThrow();
      expect(sent).toEqual([]);
    } finally {
      await chmod(dir, 0o700);
    }
  });
});
