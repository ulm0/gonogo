/**
 * `gonogo expose` prints and writes; it never starts a process (docs/expose-spec.md). Every way to start one is replaced by a function that fails,
 * and every provider is run with and without --write. Its own file, because the mock would also stop the supervisor tests from starting rooms.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const started: string[] = [];
const fail = (name: string) => (): never => {
  started.push(name);
  throw new Error(`gonogo expose started a process (${name})`);
};
vi.mock('node:child_process', () => ({ spawn: fail('spawn'), spawnSync: fail('spawnSync'), execFile: fail('execFile'), execFileSync: fail('execFileSync'), execSync: fail('execSync'), exec: fail('exec'), fork: fail('fork') }));

const { EXPOSE_PROVIDERS, exposeCommand } = await import('../src/server/exposecli.js');

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gng-expose-nospawn-'));
  started.length = 0;
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('gonogo expose starts nothing', () => {
  it('prints and writes for every provider without a process, and check only asks the address', async () => {
    for (const provider of EXPOSE_PROVIDERS) {
      for (const write of [false, true]) {
        const code = await exposeCommand([provider, '--public-url', 'https://gonogo.example.com', ...(write ? ['--write'] : [])], home, {}, { out: () => undefined, err: () => undefined });
        expect(code, `${provider} ${write}`).toBe(0);
      }
    }
    // check with no account stops before it asks anything
    expect(await exposeCommand(['check', '--public-url', 'https://gonogo.example.com'], home, {}, { out: () => undefined, err: () => undefined })).toBe(1);
    expect(started).toEqual([]);
  });

  it('the module does not even import child_process', async () => {
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(new URL('../src/server/exposecli.ts', import.meta.url), 'utf8');
    expect(text).not.toMatch(/from 'node:child_process'|from 'child_process'|require\(.(node:)?child_process/);
  });
});
