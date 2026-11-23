import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/** Runs packaging/docker/drop.sh with stand-ins for id, stat and setpriv: what setpriv was asked, as one line. */
function drop(groupsOfRoot: string, socketGid: string | null): string {
  const bin = mkdtempSync(join(tmpdir(), 'gonogo-drop-'));
  const tool = (name: string, body: string): void => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  tool('id', `echo "${groupsOfRoot}"`);
  tool('stat', socketGid === null ? 'exit 1' : `echo "${socketGid}"`);
  tool('setpriv', 'echo "$@"');
  const r = spawnSync('sh', [join(import.meta.dirname, '..', 'packaging', 'docker', 'drop.sh'), 'gonogo'], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin` } });
  return r.stdout.trim();
}

describe('drop.sh: the groups the server runs with', () => {
  it('adds the Docker socket\'s group to the container\'s own, without root\'s gid 0', () => {
    expect(drop('0 1000 5', '998')).toContain('--groups=1000,5,998 ');
  });

  it('does not repeat a group it already has', () => {
    expect(drop('0 998', '998')).toContain('--groups=998 ');
  });

  it('is the socket\'s group alone when the container has none', () => {
    expect(drop('0', '998')).toContain('--groups=998 ');
  });

  it('leaves a socket owned by gid 0 out of reach, and none at all as before', () => {
    expect(drop('0 5', '0')).toContain('--groups=5 ');
    expect(drop('0 5', null)).toContain('--groups=5 ');
    expect(drop('0', null)).toContain('--clear-groups');
    expect(drop('0', 'garbage')).toContain('--clear-groups');
  });
});
