import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/** Runs the entrypoint as an ordinary user (not root: the root half is skipped) with a stand-in `gonogo`; what it said on stderr. */
function say(env: Record<string, string>, seed: (home: string) => void = () => undefined): string {
  const root = mkdtempSync(join(tmpdir(), 'gonogo-entry-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  // gonogo exits at once; cp is a stand-in too: the script copies /etc/skel into the home, and on a CI runner image /etc/skel holds gigabytes (rust, nvm)
  for (const name of ['gonogo', 'cp']) {
    writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, name), 0o755);
  }
  const data = join(root, 'data');
  const home = join(data, 'state');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, 'home'));
  seed(home);
  const r = spawnSync('sh', [join(import.meta.dirname, '..', 'packaging', 'docker', 'entrypoint.sh')], {
    encoding: 'utf8',
    input: '',
    timeout: 20_000,
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

describe('the root half repairs a bound XDG_CONFIG_HOME like the home', () => {
  // the root half needs root, so it is proved in a container (a root file in a bound XDG_CONFIG_HOME is uid 1000's after the start; a symlink, a hardlink, a nested mount and a folder inside the image are not touched); here only that it stays wired the same way
  const script = readFileSync(join(import.meta.dirname, '..', 'packaging', 'docker', 'entrypoint.sh'), 'utf8');
  it('heals XDG_CONFIG_HOME with the home\'s function, and only on another filesystem than the image\'s', () => {
    expect(script).toContain('heal "$HOME"');
    expect(script).toMatch(/\[ "\$\(stat -c %d "\$XDG_CONFIG_HOME" 2>\/dev\/null\)" != "\$\(stat -c %d \/ 2>\/dev\/null\)" \] && heal "\$XDG_CONFIG_HOME"/);
    expect(script).toContain('fix "${XDG_CONFIG_HOME:-}"');
  });
  it('keeps every guard of the repair: -xdev, mount points pruned, one-link files and directories only, no symlink', () => {
    expect(script).toContain('find "$1" -xdev -mindepth 1 \\( -type d -exec mountpoint -q {} \; -prune \\) -o -user 0 \\( -type f -links 1 -o -type d \\) -execdir chown -h 1000:1000 {} +');
  });
});
