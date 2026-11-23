import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/** Runs the entrypoint as an ordinary user (not root: the root half is skipped) with a stand-in `gonogo`; what it said on stderr. */
function say(env: Record<string, string>, seed: (home: string) => void = () => undefined): string {
  const root = mkdtempSync(join(tmpdir(), 'gonogo-entry-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gonogo'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'gonogo'), 0o755);
  const data = join(root, 'data');
  const home = join(data, 'state');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, 'home'));
  seed(home);
  const r = spawnSync('sh', [join(import.meta.dirname, '..', 'packaging', 'docker', 'entrypoint.sh')], {
    encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: join(root, 'home'), GONOGO_HOME: home, ...env },
  });
  return r.stderr.replaceAll(data, '<data>');
}

describe('the entrypoint says which data folder it is', () => {
  it('warns when it is the default (not given) and empty, with the way back', () => {
    const text = say({});
    expect(text).toContain('gonogo: data folder <data> is new and empty (the default, GONOGO_DATA is not set)');
    expect(text).toContain('set GONOGO_DATA=<its absolute path> in the .env next to compose.yaml');
  });

  it('only names it when it was given, or when the default already holds a home', () => {
    expect(say({ GONOGO_DATA_GIVEN: 'yes' })).toContain('gonogo: data folder <data>\n');
    expect(say({ GONOGO_DATA_GIVEN: 'yes' })).not.toContain('is new and empty');
    const used = say({}, (home) => writeFileSync(join(home, 'rooms.json'), '{}'));
    expect(used).toContain('gonogo: data folder <data>\n');
    expect(used).not.toContain('is new and empty');
  });

  it('says nothing about a data folder without GONOGO_HOME', () => {
    expect(say({ GONOGO_HOME: '' })).not.toContain('data folder');
  });
});
