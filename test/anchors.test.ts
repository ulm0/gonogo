import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
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
/** The top of ana's repository, and of ben's. */
let repo: string;
let other: string;
let outside: string;
let now: number;
/** The hired agents of the room and where their files are. */
let places: Record<string, string>;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

async function makeRepo(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  git(path, 'init', '-q', '-b', 'main');
}
const commitAll = (path: string): void => {
  git(path, 'add', '-A');
  git(path, 'commit', '-q', '-m', 'x');
};

const checkerFor = (extra: Partial<AnchorOptions> = {}): AnchorChecker =>
  createAnchorChecker({ agents: () => Object.keys(places), place: async (name) => places[name] ?? null, now: () => now, log: quiet, ...extra });
const anchor = (over: Partial<LogAnchor> = {}): LogAnchor => ({ root: repo, file: 'src/limit.txt', text: 'the limit is 5', mode: 'present', ...over });
/** An anchor as the server holds it, with the branch it was written on. */
const stamped = (over: Partial<LogAnchor> = {}): LogAnchor => ({ ...anchor(over), branch: 'main' });
const refused = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('it was not refused');
};
const script = async (name: string, body: string): Promise<string> => {
  const bin = join(root, name);
  await writeFile(bin, `#!/bin/sh\n${body}\n`);
  await chmod(bin, 0o755);
  return bin;
};

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'gonogo-anchors-')));
  repo = join(root, 'repo');
  other = join(root, 'other');
  outside = join(root, 'outside');
  now = 1_000_000;
  places = { ana: repo, ben: other };
  await makeRepo(repo);
  await mkdir(join(repo, 'src'));
  await writeFile(join(repo, 'src', 'limit.txt'), 'the limit is 5\nsecond line\n');
  commitAll(repo);
  await makeRepo(other);
  await writeFile(join(other, 'a.txt'), 'x');
  commitAll(other);
  await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), `${SECRET} the limit is 5\n`);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('the shape of an anchor list', () => {
  it('takes the author\'s own repository, keeps its real path, and stamps the branch', async () => {
    const link = join(root, 'link-to-repo');
    await symlink(repo, link);
    expect(await checkerFor().validate([anchor({ root: link })], 'ana')).toEqual([stamped()]);
    // no file: only for `absent`
    expect(await checkerFor().validate([anchor({ file: undefined, mode: 'absent' })], 'ana')).toEqual([{ root: repo, text: 'the limit is 5', mode: 'absent', branch: 'main' }]);
  });

  it('refuses a list that is too long or not a list, a field that is not known, and a branch that the caller names', async () => {
    const c = checkerFor();
    expect(await refused(() => c.validate(Array.from({ length: 6 }, () => anchor()), 'ana'))).toMatch(/at most 5/);
    expect(await refused(() => c.validate('x', 'ana'))).toMatch(/must be a list/);
    expect(await refused(() => c.validate([{ ...anchor(), extra: 1 }], 'ana'))).toMatch(/unknown field/);
    expect(await refused(() => c.validate([stamped()], 'ana'))).toMatch(/unknown field "branch"/);
    expect(await c.validate([], 'ana')).toEqual([]);
  });

  it('refuses a file that leaves the repository, in each way, and a present anchor with no file', async () => {
    const c = checkerFor();
    for (const file of ['../outside/secret.txt', 'src/../../outside/secret.txt', '/etc/passwd', '~/.ssh/id_rsa', 'C:\\x', 'C:/x', 'a\\..\\b', '', 'a//b', 'src/', 'a\nb', 'a\0b', 'x'.repeat(301)]) {
      expect(await refused(() => c.validate([anchor({ file })], 'ana')), JSON.stringify(file)).toMatch(/file must be/);
    }
    expect(await refused(() => c.validate([anchor({ file: undefined })], 'ana'))).toMatch(/needs a file/);
  });

  it('C1: refuses a text that is not one literal line, or that starts with a dash', async () => {
    const c = checkerFor();
    for (const text of ['-Oid', '--no-index', '--open-files-in-pager=sh', '-', '', 'a\nb', 'a\u202eb', 'x'.repeat(201)]) {
      expect(await refused(() => c.validate([anchor({ text, file: undefined, mode: 'absent' })], 'ana')), text).toMatch(/text must/);
    }
    expect(await refused(() => c.validate([{ ...anchor(), mode: 'regex' }], 'ana'))).toMatch(/mode must be/);
    // a dash inside is fine
    await expect(c.validate([anchor({ text: 'a -x b' })], 'ana')).resolves.toHaveLength(1);
  });
});

describe('C2: who may anchor what', () => {
  it('an agent names its own top level only; the Director may name another hired agent\'s; nobody names a folder no agent works in', async () => {
    const c = checkerFor();
    expect(await refused(() => c.validate([anchor({ root: other, file: 'a.txt' })], 'ana'))).toMatch(/your own repository/);
    await expect(c.validate([anchor({ root: other, file: 'a.txt' })], 'user')).resolves.toHaveLength(1);
    await expect(c.validate([anchor()], 'user')).resolves.toHaveLength(1);
    for (const author of ['ana', 'user']) {
      expect(await refused(() => c.validate([anchor({ root: outside, file: 'secret.txt' })], author))).toMatch(/top of/);
      expect(await refused(() => c.validate([anchor({ root: join(repo, 'src') })], author))).toMatch(/top of/);
      expect(await refused(() => c.validate([anchor({ root: '/' })], author))).toMatch(/top of/);
    }
    // an author that is no hired agent has no repository
    expect(await refused(() => c.validate([anchor()], 'ghost'))).toMatch(/your own repository/);
  });

  it('a Clean Room agent anchors its own worktree, never the host checkout', async () => {
    const wt = join(root, 'clean-room-ana');
    git(repo, 'worktree', 'add', '-q', '-b', 'cr', wt);
    places = { ana: repo, cr: wt };
    const c = checkerFor();
    const real = await realpath(wt);
    await expect(c.validate([anchor({ root: wt })], 'cr')).resolves.toEqual([{ ...anchor({ root: real }), branch: 'cr' }]);
    expect(await refused(() => c.validate([anchor({ root: repo })], 'cr'))).toMatch(/your own repository/);
    expect((await c.check([anchor({ root: repo })], 'cr')).note).toBe('unchecked: not the repository of the agent that wrote the entry');
  });

  it('is checked again at every check: a repository that is not the author\'s, or not any agent\'s now, is not read', async () => {
    const c = checkerFor();
    const list = await c.validate([anchor()], 'ana');
    expect(await c.check(list, 'ben')).toMatchObject({ state: 'unchecked', note: 'unchecked: not the repository of the agent that wrote the entry' });
    delete places.ana;
    now += ANCHOR_CACHE_MS;
    expect(await c.check(list, 'user')).toMatchObject({ state: 'unchecked', note: 'unchecked: no hired agent works there' });
    expect((await c.check(list, 'ana')).state).toBe('unchecked');
    places.ana = repo;
    now += ANCHOR_CACHE_MS;
    expect((await c.check(list, 'ana')).state).toBe('ok');
    await rm(repo, { recursive: true });
    now += ANCHOR_CACHE_MS;
    expect((await c.check(list, 'ana')).state).toBe('unchecked');
  });
});

describe('the check', () => {
  it('present: ok when the tracked file holds the text, not confirmed when it does not, not found when the file is gone', async () => {
    const c = checkerFor();
    expect(await c.check([stamped()], 'ana')).toMatchObject({ state: 'ok', note: expect.stringMatching(/^confirmed on main@[0-9a-f]{7}$/) });
    const gone = await c.check([stamped({ text: 'the limit is 7' })], 'ana');
    expect(gone.state).toBe('stale');
    expect(gone.note).toMatch(/^not confirmed on main@[0-9a-f]{7}$/);
    // tracked, then deleted from the tree
    await writeFile(join(repo, 'src', 'again.txt'), 'x');
    commitAll(repo);
    await rm(join(repo, 'src', 'again.txt'));
    expect(await c.check([stamped({ file: 'src/again.txt' })], 'ana')).toMatchObject({ state: 'stale', note: expect.stringMatching(/^file not found here on main@/) });
  });

  it('absent with a file: ok when the text is not in it, not confirmed when it is, vacuous when the file is gone', async () => {
    const c = checkerFor();
    expect(await c.check([stamped({ mode: 'absent', text: 'the limit is 7' })], 'ana')).toMatchObject({ state: 'ok' });
    expect((await c.check([stamped({ mode: 'absent' })], 'ana')).note).toMatch(/^not confirmed on main@/);
    // the text is literal: a pattern does not match itself, a dot is a dot
    expect((await c.check([stamped({ mode: 'absent', text: 'the limit is .' })], 'ana')).state).toBe('ok');
    expect((await c.check([stamped({ text: 'the.limit' })], 'ana')).state).toBe('stale');
    await writeFile(join(repo, 'src', 'later.txt'), 'x');
    commitAll(repo);
    await rm(join(repo, 'src', 'later.txt'));
    expect(await c.check([stamped({ file: 'src/later.txt', mode: 'absent' })], 'ana')).toMatchObject({ state: 'vacuous', note: expect.stringMatching(/^check the path: file not found here on main@/) });
  });

  it('absent with no file: searches the tracked files and says how many hold the text, never which', async () => {
    await writeFile(join(repo, 'src', 'b-secretname.txt'), 'the limit is 5');
    commitAll(repo);
    await writeFile(join(repo, 'untracked.txt'), 'only-in-an-untracked-file');
    const c = checkerFor();
    const hit = await c.check([stamped({ file: undefined, mode: 'absent' })], 'ana');
    expect(hit.state).toBe('stale');
    expect(hit.note).toMatch(/^not confirmed on main@[0-9a-f]{7} \(2 files\)$/);
    expect(hit.note).not.toMatch(/limit\.txt|secretname/);
    expect((await c.check([stamped({ file: undefined, mode: 'absent', text: 'only-in-an-untracked-file' })], 'ana')).state).toBe('ok');
    expect((await c.check([stamped({ file: undefined, mode: 'absent', text: 'in no file at all' })], 'ana')).state).toBe('ok');
  });

  it('C1: git is given the text after -e and a final --, with no textconv and no submodules; a dash inside a text is a text', async () => {
    const log = join(root, 'args.log');
    const bin = await script('logging-git', `printf '%s\\n' "$*" >> ${log}\nexec git "$@"`);
    const c = checkerFor({ gitBin: bin });
    await writeFile(join(repo, 'src', 'dash.txt'), 'a -x b\n');
    commitAll(repo);
    expect((await c.check([stamped({ file: undefined, mode: 'absent', text: 'a -x b' })], 'ana')).state).toBe('stale');
    const grep = (await readFile(log, 'utf8')).split('\n').find((l) => l.includes(' grep '));
    expect(grep).toMatch(/ grep -F -l -z --no-textconv --no-recurse-submodules -e a -x b --$/);
  });

  it('C2: a file that git does not list is never opened or looked for: not tracked', async () => {
    await writeFile(join(repo, '.env'), `${SECRET}\n`);
    let looked = 0;
    const c = checkerFor({ afterLstat: async () => void (looked += 1) });
    for (const mode of ['present', 'absent'] as const) {
      const state = await c.check([stamped({ file: '.env', text: SECRET, mode })], 'ana');
      expect(state).toEqual({ state: 'unchecked', note: 'unchecked: not tracked', checkedAt: now });
    }
    // and one that does not exist at all gives the same answer, so the answer says nothing about the disk
    expect((await c.check([stamped({ file: 'nothing/here.txt', text: 'x' })], 'ana')).note).toBe('unchecked: not tracked');
    expect(looked).toBe(0);
  });

  it('C2: a file swapped between the look and the open is not read', async () => {
    const path = join(repo, 'src', 'limit.txt');
    const swap = checkerFor({
      afterLstat: async () => {
        await writeFile(`${path}.new`, 'the limit is 5');
        await rename(`${path}.new`, path);
      },
    });
    expect((await swap.check([stamped()], 'ana')).note).toBe('unchecked: the file changed during the check');
    await writeFile(path, 'the limit is 5');
    commitAll(repo);
    now += ANCHOR_CACHE_MS;
    const link = checkerFor({
      afterLstat: async () => {
        await rm(path);
        await symlink(join(outside, 'secret.txt'), path);
      },
    });
    const state = await link.check([stamped({ text: SECRET })], 'ana');
    expect(state.state).toBe('unchecked');
    expect(JSON.stringify(state)).not.toContain(SECRET);
  });

  it('a file over 1 MiB is unchecked: too large', async () => {
    await writeFile(join(repo, 'big.txt'), 'x'.repeat(1024 * 1024 + 1));
    commitAll(repo);
    expect((await checkerFor().check([stamped({ file: 'big.txt', text: 'x' })], 'ana')).note).toBe('unchecked: too large');
  });

  it('a symlinked parent directory, or a symlinked file, is never read', async () => {
    await symlink(outside, join(repo, 'linkdir'));
    await symlink(join(outside, 'secret.txt'), join(repo, 'linkfile.txt'));
    commitAll(repo);
    const c = checkerFor();
    for (const file of ['linkdir/secret.txt', 'linkfile.txt']) {
      for (const mode of ['present', 'absent'] as const) {
        const state = await c.check([stamped({ file, mode, text: SECRET })], 'ana');
        expect(JSON.stringify(state), `${file} ${mode}`).not.toContain(SECRET);
        expect(state.state, `${file} ${mode}`).toBe(mode === 'present' ? 'unchecked' : 'unchecked');
      }
    }
  });

  it('a symlinked parent of the root: the root is its real path, and what is outside it is not read', async () => {
    const parent = join(root, 'parent-link');
    await symlink(root, parent);
    const c = checkerFor();
    expect(await c.validate([anchor({ root: join(parent, 'repo') })], 'ana')).toEqual([stamped()]);
    // a hired agent whose folder is a link to the repository of another is that other repository, nothing else
    places = { ana: join(parent, 'repo') };
    expect((await checkerFor().check([stamped()], 'ana')).state).toBe('ok');
  });

  it('says the branch it was written on is not the one it ran on', async () => {
    const list = await checkerFor().validate([anchor()], 'ana');
    git(repo, 'checkout', '-q', '-b', 'feature/x');
    const state = await checkerFor().check(list, 'ana');
    expect(state.note).toMatch(/^confirmed on feature\/x@[0-9a-f]{7}, not the branch it was written on$/);
  });

  it('a git that does not answer in time is unchecked, and a check that takes too long ends', async () => {
    const bin = await script('slow-git', 'case "$*" in *" grep "*|*" ls-files "*) exec sleep 5;; esac\nexec git "$@"');
    const c = checkerFor({ gitBin: bin, gitMs: 200 });
    const started = Date.now();
    expect((await c.check([stamped({ file: undefined, mode: 'absent', text: 'x' })], 'ana')).note).toBe('unchecked: git did not answer in time');
    expect((await c.check([stamped()], 'ana')).note).toBe('unchecked: git did not answer in time');
    expect(Date.now() - started).toBeLessThan(3000);
    const slow = checkerFor({ gitBin: bin, gitMs: 4000, runMs: 300 });
    const t = Date.now();
    expect((await slow.check([stamped({ text: 'other' })], 'ana')).note).toBe('unchecked: too slow');
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it('an output flood is a hit, and ends', async () => {
    const bin = await script('flood-git', 'case "$*" in *" grep "*) head -c 5000000 /dev/zero | tr "\\0" "a"; exit 0;; esac\nexec git "$@"');
    const state = await checkerFor({ gitBin: bin }).check([stamped({ file: undefined, mode: 'absent' })], 'ana');
    expect(state.state).toBe('stale');
    expect(state.note).toMatch(/^not confirmed on main@/);
  });

  it('runs git with the safe arguments and a clean environment, and writes nothing in the repository', async () => {
    const log = join(root, 'git.log');
    const bin = await script('logging-git2', `printf '%s\\n' "$*" >> ${log}\nenv | grep '^GIT_' >> ${log}\nexec git "$@"`);
    const before = git(repo, 'status', '--porcelain');
    const c = checkerFor({ gitBin: bin, env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_DIR: '/nonexistent', GIT_WORK_TREE: '/nonexistent', GIT_EXTERNAL_DIFF: 'evil' } });
    await c.check([stamped(), stamped({ file: undefined, mode: 'absent', text: 'zzz' })], 'ana');
    const text = await readFile(log, 'utf8');
    expect(text).toContain('core.fsmonitor=false');
    expect(text).toContain('core.hooksPath=/dev/null');
    expect(text).toContain('--literal-pathspecs');
    expect(text).not.toMatch(/GIT_DIR|GIT_WORK_TREE|GIT_EXTERNAL_DIFF/);
    expect(git(repo, 'status', '--porcelain')).toBe(before);
  });

  it('a repository whose config names a program does not run it', async () => {
    const marker = join(root, 'ran');
    await writeFile(join(root, 'evil.sh'), `#!/bin/sh\ntouch ${marker}\n`);
    await chmod(join(root, 'evil.sh'), 0o755);
    git(repo, 'config', 'core.fsmonitor', join(root, 'evil.sh'));
    git(repo, 'config', 'core.hooksPath', join(root, 'hooks'));
    await checkerFor().check([stamped(), stamped({ file: undefined, mode: 'absent', text: 'zzz' })], 'ana');
    expect(await readFile(marker).catch(() => null)).toBeNull();
  });

  it('runs one check per root at a time, and does not run the same one again within the cache time', async () => {
    const log = join(root, 'count.log');
    const bin = await script('counting-git', `case "$*" in *" grep "*) echo start >> ${log}; sleep 0.3; echo end >> ${log};; esac\nexec git "$@"`);
    const c = checkerFor({ gitBin: bin });
    const one = [stamped({ file: undefined, mode: 'absent', text: 'aaa' })];
    const two = [stamped({ file: undefined, mode: 'absent', text: 'bbb' })];
    await Promise.all([c.check(one, 'ana'), c.check(two, 'ana'), c.check(one, 'ana')]);
    expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual(['start', 'end', 'start', 'end']);
    await c.check(one, 'ana');
    expect((await readFile(log, 'utf8')).trim().split('\n')).toHaveLength(4);
    now += ANCHOR_CACHE_MS;
    await c.check(one, 'ana');
    expect((await readFile(log, 'utf8')).trim().split('\n')).toHaveLength(6);
  });

  it('peek gives the last answer and runs nothing', async () => {
    const c = checkerFor();
    expect(c.peek([stamped()], 'ana')).toBeUndefined();
    await c.check([stamped()], 'ana');
    expect(c.peek([stamped()], 'ana')?.state).toBe('ok');
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
    expect(made.anchors).toEqual([stamped()]);
    expect(await readFile(join(logDir, 'mission-log', 'l1.md'), 'utf8')).toContain(`anchors: ${JSON.stringify([stamped()])}`);
    expect(log.get('l1').anchorState).toBeUndefined();
    await log.verify('l1');
    expect(log.get('l1').anchorState).toMatchObject({ state: 'ok' });
    expect(log.search('limit').hits[0]?.anchorState).toMatchObject({ state: 'ok' });
    // a change that does not name anchors keeps them; [] removes them
    await log.update('l1', { body: 'The limit is still 5.' }, 'ana');
    expect(log.get('l1').anchors).toEqual([stamped()]);
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
    expect(again.get('l1').anchors).toEqual([stamped({ text: 'the limit is 9' })]);
    await again.verify('l1');
    expect(again.get('l1').anchorState).toMatchObject({ state: 'stale', note: expect.stringMatching(/^not confirmed on main@/) });
  });

  it('an agent anchors its own repository; the Director anchors any on his own entry, and on an agent\'s entry only that agent\'s own', async () => {
    const log = make();
    await log.load();
    await expect(log.create('ana', { title: 'T', body: 'b', anchors: [anchor({ root: other, file: 'a.txt' })] })).rejects.toMatchObject({ code: 'bad_request', field: 'anchors' });
    await expect(log.create('user', { title: 'T', body: 'b', anchors: [anchor({ root: other, file: 'a.txt', text: 'x' })] })).resolves.toMatchObject({ id: 'l1' });
    await log.create('ana', { title: 'U', body: 'b' });
    await expect(log.update('l2', { anchors: [anchor({ root: other, file: 'a.txt' })] }, null)).rejects.toMatchObject({ code: 'bad_request', field: 'anchors' });
    await expect(log.update('l2', { anchors: [anchor()] }, null)).resolves.toMatchObject({ id: 'l2' });
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
    // an entry with no anchors is written as before, and the anchors it has are kept
    await expect(log.create('ana', { title: 'Plain', body: 'b' })).resolves.toMatchObject({ id: 'l2' });
    await log.update('l1', { body: 'changed' }, 'ana');
    expect(log.get('l1').anchors).toEqual([stamped()]);
    const calls: string[] = [];
    const real = checkerFor();
    const spy = createMissionLog({ dir: logDir, now: () => now, emit: () => undefined, log: quiet, anchors: { ...real, check: (a, au) => (calls.push('check'), real.check(a, au)), peek: () => undefined }, anchorsOn: () => false });
    await spy.load();
    await spy.verify('l1');
    spy.search('limit');
    expect(calls).toEqual([]);
  });

  it('a file with a bad anchor list is skipped like any bad file', async () => {
    const log = make();
    await log.load();
    await log.create('ana', { title: 'Limit', body: 'b', anchors: [anchor()] });
    const path = join(logDir, 'mission-log', 'l1.md');
    await writeFile(path, (await readFile(path, 'utf8')).replace('"mode":"present"', '"mode":"regex"'));
    const again = make();
    await again.load();
    expect(() => again.get('l1')).toThrow(/unknown entry/);
  });
});
