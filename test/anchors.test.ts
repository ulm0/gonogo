import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LogAnchor, Logger } from '../src/shared/protocol.js';
import { ANCHOR_CACHE_MS, createAnchorChecker } from '../src/server/anchors.js';
import type { AnchorChecker, AnchorOptions } from '../src/server/anchors.js';
import { createMissionLog } from '../src/server/missionlog.js';

const quiet: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined, child: () => quiet };
const SECRET = 'TOP-SECRET-OUTSIDE-THE-REPO';

let root: string;
let repo: string;
let outside: string;
let now: number;

const git = (cwd: string, ...args: string[]): void => void execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'ignore' });

async function makeRepo(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  git(path, 'init', '-q', '-b', 'main');
}
const commitAll = (path: string): void => {
  git(path, 'add', '-A');
  git(path, 'commit', '-q', '-m', 'x');
};

const checkerFor = (extra: Partial<AnchorOptions> = {}): AnchorChecker => createAnchorChecker({ dirs: () => [repo], now: () => now, log: quiet, ...extra });
const anchor = (over: Partial<LogAnchor> = {}): LogAnchor => ({ repo, file: 'src/limit.txt', kind: 'present', text: 'the limit is 5', ...over });
const refused = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('it was not refused');
};

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'gonogo-anchors-')));
  repo = join(root, 'repo');
  outside = join(root, 'outside');
  now = 1_000_000;
  await makeRepo(repo);
  await mkdir(join(repo, 'src'));
  await writeFile(join(repo, 'src', 'limit.txt'), 'the limit is 5\nsecond line\n');
  await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), `${SECRET} the limit is 5\n`);
  commitAll(repo);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('the shape of an anchor list', () => {
  it('takes a repository an agent works in, and keeps its real path', async () => {
    const link = join(root, 'link-to-repo');
    await symlink(repo, link);
    const list = await checkerFor().validate([anchor({ repo: link })]);
    expect(list).toEqual([anchor()]);
  });

  it('refuses a repository no agent works in, a subdirectory of one, and a list that is too long or not a list', async () => {
    const c = checkerFor();
    expect(await refused(() => c.validate([anchor({ repo: outside })]))).toMatch(/top of a git repository that an agent/);
    expect(await refused(() => c.validate([anchor({ repo: join(repo, 'src') })]))).toMatch(/top of a git repository/);
    expect(await refused(() => c.validate([anchor({ repo: '/' })]))).toMatch(/top of a git repository/);
    expect(await refused(() => c.validate(Array.from({ length: 6 }, () => anchor())))).toMatch(/at most 5/);
    expect(await refused(() => c.validate('x'))).toMatch(/must be a list/);
    expect(await refused(() => c.validate([{ ...anchor(), extra: 1 }]))).toMatch(/unknown field/);
    expect(await c.validate([])).toEqual([]);
  });

  it('refuses a path that leaves the repository, in each way', async () => {
    const c = checkerFor();
    for (const file of ['../outside/secret.txt', 'src/../../outside/secret.txt', '/etc/passwd', '~/.ssh/id_rsa', 'C:\\x', 'C:/x', 'a\\..\\b', '', 'a\nb', 'x'.repeat(301)]) {
      expect(await refused(() => c.validate([anchor({ file })])), file).toMatch(/file must be/);
    }
  });

  it('refuses a text that is not one literal line, and a kind that is neither', async () => {
    const c = checkerFor();
    for (const text of ['', 'a\nb', 'a\u202eb', 'x'.repeat(201)]) expect(await refused(() => c.validate([anchor({ text })]))).toMatch(/text must be/);
    expect(await refused(() => c.validate([{ ...anchor(), kind: 'regex' }]))).toMatch(/kind must be/);
  });
});

describe('the check', () => {
  it('present: ok when the tracked file holds the text, not confirmed when it does not or the file is not tracked', async () => {
    const c = checkerFor();
    expect(await c.check([anchor()])).toMatchObject({ state: 'ok', note: '' });
    now += ANCHOR_CACHE_MS;
    const gone = await c.check([anchor({ text: 'the limit is 7' })]);
    expect(gone).toMatchObject({ state: 'stale' });
    expect(gone.note).toMatch(/^not confirmed on main@[0-9a-f]{7}$/);
    await writeFile(join(repo, 'src', 'new.txt'), 'the limit is 5');
    expect((await c.check([anchor({ file: 'src/new.txt' })])).state).toBe('stale');
    expect((await c.check([anchor({ file: 'src/none.txt' })])).state).toBe('stale');
  });

  it('absent: ok when the text is nowhere in the file, not confirmed when it is', async () => {
    const c = checkerFor();
    expect(await c.check([anchor({ kind: 'absent', text: 'the limit is 7' })])).toMatchObject({ state: 'ok' });
    expect((await c.check([anchor({ kind: 'absent' })])).note).toMatch(/^not confirmed on main@/);
    // the text is literal: a pattern does not match itself, and a dot is a dot
    expect((await c.check([anchor({ kind: 'absent', text: 'the limit is .' })])).state).toBe('ok');
    expect((await c.check([anchor({ kind: 'present', text: 'the.limit' })])).state).toBe('stale');
  });

  it('a text that starts with a dash is a text, not an option', async () => {
    await writeFile(join(repo, 'src', 'dash.txt'), '--version\n');
    commitAll(repo);
    const c = checkerFor();
    expect((await c.check([anchor({ file: 'src/dash.txt', kind: 'absent', text: '--version' })])).state).toBe('stale');
    expect((await c.check([anchor({ file: 'src/dash.txt', kind: 'absent', text: '-x-not-there' })])).state).toBe('ok');
  });

  it('is stale when any anchor is, and says so once', async () => {
    const c = checkerFor();
    const state = await c.check([anchor(), anchor({ text: 'nope' }), anchor({ kind: 'absent', text: 'second line' })]);
    expect(state.state).toBe('stale');
  });

  it('a symlinked parent or a symlinked file is never read', async () => {
    await symlink(outside, join(repo, 'linkdir'));
    await symlink(join(outside, 'secret.txt'), join(repo, 'linkfile.txt'));
    commitAll(repo);
    const c = checkerFor();
    for (const file of ['linkdir/secret.txt', 'linkfile.txt']) {
      for (const kind of ['present', 'absent'] as const) {
        const state = await c.check([anchor({ file, kind, text: SECRET })]);
        // a `present` is never confirmed through a link; an `absent` of the outside text is true (git does not follow the link) or unknown
        expect(JSON.stringify(state)).not.toContain(SECRET);
        if (kind === 'present') expect(state.state).not.toBe('ok');
      }
    }
  });

  it('is unknown when the repository is no longer one of an agent of this room, or has gone', async () => {
    let dirs = [repo];
    const c = checkerFor({ dirs: () => dirs });
    const list = await c.validate([anchor()]);
    dirs = [];
    expect(await c.check(list)).toMatchObject({ state: 'unknown' });
    dirs = [repo];
    now += ANCHOR_CACHE_MS;
    expect((await c.check(list)).state).toBe('ok');
    await rm(repo, { recursive: true });
    now += ANCHOR_CACHE_MS;
    expect((await c.check(list)).state).toBe('unknown');
  });

  it('a git that does not answer in time is unknown, and the check ends', async () => {
    const bin = join(root, 'slow-git');
    await writeFile(bin, '#!/bin/sh\ncase "$*" in *" grep "*|*" ls-files "*) exec sleep 5;; esac\nexec git "$@"\n');
    await chmod(bin, 0o755);
    const c = checkerFor({ gitBin: bin, gitMs: 200 });
    const started = Date.now();
    const state = await c.check([anchor({ kind: 'absent', text: 'x' })]);
    expect(state).toMatchObject({ state: 'unknown', note: 'git did not answer in time' });
    expect(Date.now() - started).toBeLessThan(3000);
    const present = await c.check([anchor()]);
    expect(present.state).toBe('unknown');
  });

  it('runs git with the safe arguments and a clean environment, and writes nothing in the repository', async () => {
    const bin = join(root, 'logging-git');
    const log = join(root, 'git.log');
    await writeFile(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${log}\nenv | grep '^GIT_' >> ${log}\nexec git "$@"\n`);
    await chmod(bin, 0o755);
    const before = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
    const c = checkerFor({ gitBin: bin, env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_DIR: '/nonexistent', GIT_WORK_TREE: '/nonexistent', GIT_EXTERNAL_DIFF: 'evil' } });
    await c.check([anchor(), anchor({ kind: 'absent', text: 'zzz' })]);
    const text = await readFile(log, 'utf8');
    expect(text).toContain('core.fsmonitor=false');
    expect(text).toContain('core.hooksPath=/dev/null');
    expect(text).toContain('--literal-pathspecs');
    expect(text).not.toMatch(/GIT_DIR|GIT_WORK_TREE|GIT_EXTERNAL_DIFF/);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })).toBe(before);
  });

  it('a repository whose config names a program does not run it', async () => {
    const marker = join(root, 'ran');
    await writeFile(join(root, 'evil.sh'), `#!/bin/sh\ntouch ${marker}\n`);
    await chmod(join(root, 'evil.sh'), 0o755);
    git(repo, 'config', 'core.fsmonitor', join(root, 'evil.sh'));
    git(repo, 'config', 'core.hooksPath', join(root, 'hooks'));
    const c = checkerFor();
    await c.check([anchor(), anchor({ kind: 'absent', text: 'zzz' })]);
    expect(await readFile(marker).catch(() => null)).toBeNull();
  });

  it('runs one check per repository at a time, and does not run again within the cache time', async () => {
    const bin = join(root, 'counting-git');
    const log = join(root, 'count.log');
    await writeFile(bin, `#!/bin/sh\ncase "$*" in *" grep "*) echo start >> ${log}; sleep 0.3; echo end >> ${log};; esac\nexec git "$@"\n`);
    await chmod(bin, 0o755);
    const c = checkerFor({ gitBin: bin });
    const one = [anchor({ kind: 'absent', text: 'aaa' })];
    const two = [anchor({ kind: 'absent', text: 'bbb' })];
    await Promise.all([c.check(one), c.check(two), c.check(one)]);
    expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual(['start', 'end', 'start', 'end']);
    await c.check(one);
    expect((await readFile(log, 'utf8')).trim().split('\n')).toHaveLength(4);
    now += ANCHOR_CACHE_MS;
    await c.check(one);
    expect((await readFile(log, 'utf8')).trim().split('\n')).toHaveLength(6);
  });

  it('peek gives the last answer and runs nothing', async () => {
    const c = checkerFor();
    expect(c.peek([anchor()])).toBeUndefined();
    await c.check([anchor()]);
    expect(c.peek([anchor()])?.state).toBe('ok');
  });
});

describe('on a Mission Log entry', () => {
  let logDir: string;
  let on: boolean;
  beforeEach(async () => {
    logDir = await mkdtemp(join(tmpdir(), 'gonogo-anchors-log-'));
    on = true;
  });
  afterEach(async () => {
    await rm(logDir, { recursive: true, force: true });
  });
  const make = () => createMissionLog({ dir: logDir, now: () => now, emit: () => undefined, log: quiet, anchors: checkerFor(), anchorsOn: () => on });

  it('keeps the anchors in the file, shows the state after a check, and shows it in a search', async () => {
    const log = make();
    await log.load();
    const made = await log.create('ana', { title: 'Limit', body: 'The limit is 5.', anchors: [anchor()] });
    expect(made.anchors).toEqual([anchor()]);
    expect(await readFile(join(logDir, 'mission-log', 'l1.md'), 'utf8')).toContain(`anchors: ${JSON.stringify([anchor()])}`);
    expect(log.get('l1').anchorState).toBeUndefined();
    await log.verify('l1');
    expect(log.get('l1').anchorState).toMatchObject({ state: 'ok' });
    expect(log.search('limit').hits[0]?.anchorState).toMatchObject({ state: 'ok' });
    // a change that does not name anchors keeps them; [] removes them
    await log.update('l1', { body: 'The limit is still 5.' }, 'ana');
    expect(log.get('l1').anchors).toEqual([anchor()]);
    await log.update('l1', { anchors: [] }, 'ana');
    expect(log.get('l1').anchors).toBeUndefined();
    expect(await readFile(join(logDir, 'mission-log', 'l1.md'), 'utf8')).not.toContain('anchors:');
    const again = make();
    await again.load();
    expect(again.get('l1').anchors).toBeUndefined();
  });

  it('reads the anchors back after a restart, and a state of stale says not confirmed', async () => {
    const log = make();
    await log.load();
    await log.create('ana', { title: 'Limit', body: 'b', anchors: [anchor({ text: 'the limit is 9' })] });
    const again = make();
    await again.load();
    expect(again.get('l1').anchors).toEqual([anchor({ text: 'the limit is 9' })]);
    await again.verify('l1');
    expect(again.get('l1').anchorState).toMatchObject({ state: 'stale', note: expect.stringMatching(/^not confirmed on main@/) });
  });

  it('with the switch off takes no anchors, shows no state and runs no check', async () => {
    const log = make();
    await log.load();
    await log.create('ana', { title: 'Limit', body: 'b', anchors: [anchor()] });
    on = false;
    await log.verify('l1');
    expect(log.get('l1').anchorState).toBeUndefined();
    expect(log.search('limit').hits[0]?.anchorState).toBeUndefined();
    await expect(log.create('ana', { title: 'T', body: 'b', anchors: [anchor()] })).rejects.toMatchObject({ code: 'bad_request', field: 'anchors' });
    await expect(log.update('l1', { anchors: [] }, 'ana')).rejects.toMatchObject({ code: 'bad_request', field: 'anchors' });
    // an entry with no anchors is written as before
    await expect(log.create('ana', { title: 'Plain', body: 'b' })).resolves.toMatchObject({ id: 'l2' });
    const calls: string[] = [];
    const spy = createMissionLog({ dir: logDir, now: () => now, emit: () => undefined, log: quiet, anchors: { ...checkerFor(), check: (a) => (calls.push('check'), checkerFor().check(a)), peek: () => undefined }, anchorsOn: () => false });
    await spy.load();
    await spy.verify('l1');
    spy.search('limit');
    expect(calls).toEqual([]);
  });

  it('a repository that no agent works in is refused', async () => {
    const log = make();
    await log.load();
    await expect(log.create('ana', { title: 'T', body: 'b', anchors: [anchor({ repo: outside })] })).rejects.toMatchObject({ code: 'bad_request', field: 'anchors' });
  });

  it('a file with a bad anchor list is skipped like any bad file', async () => {
    const log = make();
    await log.load();
    await log.create('ana', { title: 'Limit', body: 'b', anchors: [anchor()] });
    const path = join(logDir, 'mission-log', 'l1.md');
    await writeFile(path, (await readFile(path, 'utf8')).replace('"kind":"present"', '"kind":"regex"'));
    const again = make();
    await again.load();
    expect(() => again.get('l1')).toThrow(/unknown entry/);
  });
});
