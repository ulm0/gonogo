/** What the Clean Room tests share: a fake `docker` on a PATH of their own, and a real git repository in a temp folder. */
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

const FAKE_DOCKER = join(import.meta.dirname, 'fake-docker.mjs');

/** A folder with a `docker` program that runs test/fake-docker.mjs. Returns the folder; put it in front of PATH. */
export async function fakeDockerBin(parent: string): Promise<string> {
  const bin = join(parent, 'bin');
  await mkdir(bin, { recursive: true });
  const file = join(bin, 'docker');
  await writeFile(file, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_DOCKER}" "$@"\n`);
  await chmod(file, 0o755);
  return bin;
}

/** The environment of the server under test: the fake docker first, the real git after it, and no global git settings. */
export const cleanRoomEnv = (bin: string, extra: Record<string, string> = {}): Record<string, string> => ({
  ...(process.env as Record<string, string>),
  PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  ...extra,
});

/** `git init` with one commit holding a.txt and sub/b.txt. */
export async function makeRepo(dir: string): Promise<void> {
  await mkdir(join(dir, 'sub'), { recursive: true });
  await writeFile(join(dir, 'a.txt'), 'a\n');
  await writeFile(join(dir, 'sub', 'b.txt'), 'b\n');
  const git = (...args: string[]): void => {
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args], {
      stdio: 'ignore',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
  };
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
}
