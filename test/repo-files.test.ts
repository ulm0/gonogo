/**
 * What the repository itself must keep true besides its code: the licence that ships in the package, the lock, the
 * list `pnpm check:pack` accepts, and nothing private in what is committed (docs, scripts, README, Dockerfile and the
 * recorded fixtures). No private string is written in this file: the login name and the host name are read from the
 * machine that runs the test, everything else is a class of strings (a home path, a volume path, an id).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { listProblems } from '../scripts/check-pack.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (...path: string[]): string => readFileSync(join(root, ...path), 'utf8');

interface PackageJson {
  name: string;
  bin: Record<string, string>;
  publishConfig: Record<string, unknown>;
  license: string;
  os: string[];
  keywords: string[];
  files: string[];
  packageManager: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}
const pkg = JSON.parse(read('package.json')) as PackageJson;

describe('the licence and the package manifest', () => {
  it('has a LICENSE with the MIT text and a copyright line, and package.json names the same licence', () => {
    const text = read('LICENSE');
    expect(text.startsWith('MIT License\n')).toBe(true);
    expect(text).toMatch(/^Copyright \(c\) \d{4} \S.*$/m);
    expect(text).toContain('Permission is hereby granted, free of charge');
    expect(text).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
    expect(pkg.license).toBe('MIT');
  });

  it('restricts the install to the platforms that have a terminal library, and has keywords', () => {
    expect(pkg.os).toStrictEqual(['darwin', 'linux']);
    expect(pkg.keywords).toEqual(expect.arrayContaining(['claude-code', 'agents', 'mcp']));
  });

  it('publishes under a scope, publicly and with provenance, and keeps the command gonogo', () => {
    expect(pkg.name).toMatch(/^@[a-z0-9-]+\/gonogo$/);
    expect(pkg.publishConfig).toStrictEqual({ access: 'public', provenance: true });
    expect(Object.keys(pkg.bin)).toStrictEqual(['gonogo']);
  });

  it('asks the client build for the notices of the libraries it bundles', () => {
    expect(read('vite.config.ts')).toMatch(/license:\s*\{\s*fileName:\s*'THIRD-PARTY-NOTICES\.md'\s*\}/);
  });
});

describe('pnpm-lock.yaml', () => {
  const lock = read('pnpm-lock.yaml');

  it('is made by the pnpm that package.json pins, with its checksum', () => {
    expect(pkg.packageManager).toMatch(/^pnpm@12\.\d+\.\d+\+sha512\.[0-9a-f]{128}$/);
    // pnpm 12 writes two documents: the pinned pnpm itself, then the project's dependencies.
    expect(lock.startsWith("---\nlockfileVersion: '9.0'\n")).toBe(true);
    expect(lock).toContain(`packageManagerDependencies:\n      pnpm:\n        specifier: ${pkg.packageManager.slice(5).split('+')[0]}\n`);
  });

  it('describes the dependencies of package.json exactly, so `pnpm install --frozen-lockfile` agrees with the tests', () => {
    for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      const key = name.startsWith('@') ? `'${name}'` : name;
      expect(lock, name).toContain(`\n      ${key}:\n        specifier: ${version}\n        version: ${version}`);
    }
  });

  it('pins every package with a checksum', () => {
    const resolutions = lock.split('\n').filter((line) => /^\s+resolution:/.test(line));
    expect(resolutions.length).toBeGreaterThan(100);
    for (const line of resolutions) expect(line).toMatch(/^\s+resolution: \{integrity: sha512-[A-Za-z0-9+/=]+\}$/);
  });

  it('is the only lock, and it is committed', () => {
    for (const other of ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock']) expect(existsSync(join(root, other)), other).toBe(false);
    expect(read('.gitignore').split('\n')).not.toContain('pnpm-lock.yaml');
  });
});

describe('Dockerfile', () => {
  // The image has never been built here, so what a build would trip over has to be checked in the text
  const text = read('Dockerfile');

  it('copies the lock that exists, because the build stage runs `pnpm install --frozen-lockfile` from it', () => {
    const lock = /^COPY package\.json (\S+) \.\/$/m.exec(text)?.[1];
    expect(lock).toBe('pnpm-lock.yaml');
    expect(existsSync(join(root, lock ?? 'missing'))).toBe(true);
  });

  it('installs Claude Code with the pnpm release that package.json pins', () => {
    expect(/^ARG PNPM_VERSION=(\S+)$/m.exec(text)?.[1]).toBe(/^pnpm@([^+]+)/.exec(pkg.packageManager)?.[1]);
  });

  it('has a healthcheck on the port of CMD, and scopes git\'s safe.directory to /projects', () => {
    expect(text).toMatch(/^HEALTHCHECK .*\\\n\s+CMD \["node", "-e", "fetch\('http:\/\/127\.0\.0\.1:7777\/'\)/m);
    expect(text).toMatch(/^CMD \["--host", "0\.0\.0\.0", "--port", "7777"\]$/m);
    expect(text).not.toMatch(/safe\.directory\s+'\*'/);
    expect(text).toMatch(/safe\.directory '\/projects\/\*'/);
  });
});

describe('scripts/check-pack.mjs file list', () => {
  const server = ['cli', 'hub'];
  const complete = [
    'package/bin/gonogo.js',
    'package/package.json',
    'package/README.md',
    'package/LICENSE',
    'package/dist/shared/protocol.js',
    'package/dist/shared/positions.js',
    'package/dist/shared/fuel.js',
    'package/dist/shared/cron.js',
    'package/dist/shared/livery.js',
    'package/dist/shared/prices.js',
    'package/dist/client/index.html',
    'package/dist/client/THIRD-PARTY-NOTICES.md',
    'package/dist/client/assets/index-abc.js',
    'package/dist/server/cli.js',
    'package/dist/server/hub.js',
  ];

  it('accepts the files of a complete package', () => {
    expect(listProblems(complete, server)).toStrictEqual([]);
  });

  it.each(['package/LICENSE', 'package/dist/client/THIRD-PARTY-NOTICES.md', 'package/dist/shared/positions.js', 'package/dist/shared/fuel.js', 'package/dist/shared/cron.js', 'package/dist/shared/livery.js', 'package/dist/shared/prices.js'])('fails when %s is not packed', (gone) => {
    expect(listProblems(complete.filter((entry) => entry !== gone), server)).toStrictEqual([`missing ${gone}`]);
  });

  it('still fails on a file that does not belong', () => {
    expect(listProblems([...complete, 'package/package-lock.json', 'package/docs/contract.md'], server)).toStrictEqual([
      'unexpected package/package-lock.json',
      'unexpected package/docs/contract.md',
    ]);
  });
});

/* ---- nothing of the owner's machine in what is committed (contract 0.5 item 11) ---- */

const files = (dir: string): string[] =>
  (readdirSync(join(root, dir), { recursive: true }) as string[]).map((name) => join(dir, name)).filter((path) => statSync(join(root, path)).isFile());
const committed = [
  ...files('docs'),
  ...files('scripts'),
  ...files('.github'),
  '.vitepress/config.mts',
  ...files('.vitepress/theme'),
  'README.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'Dockerfile',
  '.dockerignore',
  'compose.yaml',
];

/** The decoded output and input bytes of a recording as ONE string: a name cut in two by a record boundary or a line wrap is still found. */
function recordedBytes(file: string): string {
  const records = read('test', 'fixtures', file)
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { k: string; b?: string });
  return Buffer.concat(records.filter((r) => r.k === 'd' || r.k === 'in').map((r) => Buffer.from(r.b ?? '', 'base64'))).toString('latin1');
}

/** Names of the machine that runs the test; ordinary words are skipped, as in terminal.test.ts. */
function machineNames(): string[] {
  const generic = new Set(['user', 'root', 'node', 'test', 'runner', 'admin', 'ubuntu', 'debian', 'docker', 'build', 'localhost']);
  const login = ((): string => {
    try {
      return userInfo().username;
    } catch {
      return ''; // an arbitrary uid in a container has no passwd entry
    }
  })();
  return [login, hostname(), hostname().split('.')[0] ?? ''].map((name) => name.toLowerCase()).filter((name) => name.length >= 4 && !generic.has(name));
}

describe('committed files hold nothing private', () => {
  it('lists the files it checks (so that an empty list cannot pass)', () => {
    expect(committed).toEqual(expect.arrayContaining(['README.md', 'Dockerfile', join('docs', 'contract.md'), join('docs', 'facts', 'claude-code-terminal.md')]));
  });

  it.each(committed)('%s has no home path, volume path, scratch folder or name of this machine', (path) => {
    // The project's own public coordinates (its GitHub repository, its image, its npm package, its Pages site and its docs domain) name an account, not this machine.
    const text = read(path).replace(/\b(?:ghcr\.io|github\.com)\/[a-z0-9-]+\/gonogo\b|(?<![\w.-])@[a-z0-9-]+\/gonogo\b|\b[a-z0-9-]+\.github\.io\/gonogo\b|\bgonogo\.[a-z0-9-]+\.[a-z]{2,}\b/gi, '');
    expect(text, 'a home directory with a login name in it').not.toMatch(/\/Users\/[A-Za-z0-9_-]/);
    expect(text, 'a volume name').not.toMatch(/\/Volumes\/[^<`\s]/);
    expect(text, 'the scratch folder of a session').not.toMatch(/\.claude-tmp\b/);
    for (const name of machineNames()) expect(text.toLowerCase().includes(name), 'a name of the machine running this test').toBe(false);
  });

  it.each(['real-fs.stream.jsonl', 'real-classic.stream.jsonl'])('%s has no id, path or name of a machine, also when a record boundary or a wrap cuts it', (file) => {
    const all = recordedBytes(file);
    expect(all, 'a piece of an account, organisation or plugin id').not.toMatch(/[0-9a-f]{4,}-[0-9a-f]{3,}/i);
    expect(all).not.toMatch(/\/Users\/|\/Volumes\/|\/home\/|\.claude-tmp/);
    for (const name of machineNames()) expect(all.toLowerCase().includes(name), 'a name of the machine running this test').toBe(false);
  });
});

describe('the first name of this app is gone', () => {
  // Built from pieces so that this file does not match itself. Only "arc" may come before it ("archive"): any other
  // neighbour fails, a letter too (another product's file names held it inside a word).
  const old = ['h', 'ive'].join('');
  const pattern = new RegExp(`(?<!arc)${old}`, 'i');
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter((path) => path !== '' && existsSync(join(root, path)));

  it('checks every committed file (so that an empty list cannot pass)', () => {
    expect(tracked).toEqual(expect.arrayContaining(['package.json', 'Dockerfile', 'test/repo-files.test.ts', 'docs/contract.md']));
  });

  it('appears in no committed file', () => {
    const hits = tracked.filter((path) => pattern.test(readFileSync(join(root, path)).toString('latin1')));
    expect(hits).toStrictEqual([]);
  });

  it('the pattern catches each form the name took, inside a word too, and lets "archive" through', () => {
    for (const form of [`~/.desk${old}`, `mcp__${old}__send_message`, `${old.toUpperCase()}_ROOT`, `main/${old}.ts`, `Shared ${old} state`, `use${old[0].toUpperCase()}${old.slice(1)}.ts`, `shared/${old}Nudge.ts`, `bee${old}`]) expect(pattern.test(form), form).toBe(true);
    for (const word of ['archive', 'ARCHIVED', 'Archive: Build is green']) expect(pattern.test(word), word).toBe(false);
  });
});
