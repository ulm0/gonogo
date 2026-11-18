import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_TEXT_MAX_CHARS } from '../src/shared/protocol.js';
import type { Logger } from '../src/shared/protocol.js';
import { createBlackBox, execGit, shellWord } from '../src/server/blackbox.js';
import type { BlackBox, GitRun } from '../src/server/blackbox.js';
import { BLACKBOX_COMMIT_MS, BLACKBOX_DIR, BLACKBOX_RATE_MAX, BLACKBOX_RECENT_MAX } from '../src/server/constants.js';

let dir: string;
let repo: string;
let now: number;
let logs: string[];
let timers: Array<{ fn: () => void; ms: number; cleared: boolean }>;

const quiet = (sink: string[]): Logger => {
  const log: Logger = {
    debug: () => undefined,
    info: (message) => void sink.push(`info ${message}`),
    warn: (message, ...extra) => void sink.push([`warn ${message}`, ...extra.map(String)].join(' ')),
    error: (message) => void sink.push(`error ${message}`),
    child: () => log,
  };
  return log;
};

/** A git that answers from a script: by default every call is fine and `diff --cached --quiet` says there is something to commit. */
function fakeGit(script?: (args: string[]) => { code: number; stderr?: string } | Error | undefined): { run: GitRun; calls: string[][] } {
  const calls: string[][] = [];
  const run: GitRun = async (args) => {
    calls.push(args);
    const scripted = script?.(args);
    if (scripted instanceof Error) throw scripted;
    const code = scripted?.code ?? (args[0] === 'diff' ? 1 : 0);
    return { code, stdout: '', stderr: scripted?.stderr ?? '' };
  };
  return { run, calls };
}

const make = (git: GitRun | undefined): BlackBox =>
  createBlackBox({
    dir,
    now: () => now,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => void ((handle as { cleared: boolean }).cleared = true),
    git,
    log: quiet(logs),
  });

/** Fires the batch timer that is armed, the way the clock would. */
const fire = (): void => {
  const timer = timers.filter((t) => !t.cleared).pop();
  if (!timer) throw new Error('no timer is armed');
  timer.cleared = true;
  timer.fn();
};
const armed = (): number => timers.filter((t) => !t.cleared).length;
const dayFile = async (name = '2026-11-18.jsonl'): Promise<string> => readFile(join(repo, name), 'utf8');
const lines = async (): Promise<unknown[]> => (await dayFile()).trim().split('\n').map((line) => JSON.parse(line) as unknown);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gonogo-box-'));
  repo = join(dir, BLACKBOX_DIR);
  now = Date.UTC(2026, 10, 18, 9, 30, 0);
  logs = [];
  timers = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the Black Box with a git that is scripted', () => {
  it('makes its folder (mode 0700), checks git, makes the repository and arms one batch', async () => {
    const git = fakeGit();
    const box = make(git.run);
    await box.load();
    expect((await stat(repo)).mode & 0o777).toBe(0o700);
    expect(git.calls).toEqual([['--version'], ['init', '-q']]);
    expect(box.view()).toMatchObject({ git: 'ok', note: '', dir: repo, events: [] });
    // whatever a crash left uncommitted goes in the first batch
    expect(armed()).toBe(1);
  });

  it('does not make a repository where one is', async () => {
    await mkdir(join(repo, '.git'), { recursive: true });
    const git = fakeGit();
    await make(git.run).load();
    expect(git.calls).toEqual([['--version']]);
  });

  it('appends each event at once as a line of a file for the UTC day, mode 0600, newest first in the view', async () => {
    const box = make(fakeGit().run);
    await box.load();
    box.record('crew', 'Director hired ana');
    now += 1000;
    box.record('poll', 'T-minus poll GO: all go');
    await box.close();
    expect(await lines()).toEqual([
      { at: '2026-11-18T09:30:00.000Z', kind: 'crew', text: 'Director hired ana' },
      { at: '2026-11-18T09:30:01.000Z', kind: 'poll', text: 'T-minus poll GO: all go' },
    ]);
    expect((await stat(join(repo, '2026-11-18.jsonl'))).mode & 0o777).toBe(0o600);
    expect(box.view().events.map((e) => e.text)).toEqual(['T-minus poll GO: all go', 'Director hired ana']);
  });

  it('starts a file for the next day at midnight UTC', async () => {
    const box = make(fakeGit().run);
    await box.load();
    now = Date.UTC(2026, 10, 18, 23, 59, 59);
    box.record('crew', 'before');
    now = Date.UTC(2026, 10, 19, 0, 0, 1);
    box.record('crew', 'after');
    await box.close();
    expect((await readdir(repo)).filter((n) => n.endsWith('.jsonl')).sort()).toEqual(['2026-11-18.jsonl', '2026-11-19.jsonl']);
  });

  it('commits a batch once, after the delay, with the identity and the count in the message', async () => {
    const git = fakeGit();
    const box = make(git.run);
    await box.load();
    git.calls.length = 0;
    box.record('crew', 'one');
    box.record('crew', 'two');
    box.record('crew', 'three');
    // the batch that load armed takes them: events that come while a batch waits join it, so there is one timer
    expect(timers.map((t) => t.ms)).toEqual([BLACKBOX_COMMIT_MS]);
    expect(git.calls).toEqual([]);
    fire();
    await vi.waitFor(() => expect(git.calls).toHaveLength(3));
    expect(git.calls).toEqual([['add', '-A', '--', '.'], ['diff', '--cached', '--quiet'], ['commit', '-q', '-m', 'audit: 3 events']]);
    // the next event starts the next batch
    box.record('crew', 'four');
    expect(armed()).toBe(1);
    fire();
    await vi.waitFor(() => expect(git.calls).toHaveLength(6));
    expect(git.calls[5]).toEqual(['commit', '-q', '-m', 'audit: 1 event']);
  });

  it('commits nothing when nothing changed', async () => {
    const git = fakeGit((args) => (args[0] === 'diff' ? { code: 0 } : undefined));
    const box = make(git.run);
    await box.load();
    git.calls.length = 0;
    fire();
    await vi.waitFor(() => expect(git.calls).toHaveLength(2));
    expect(git.calls.map((c) => c[0])).toEqual(['add', 'diff']);
  });

  it('commits at close, once, and takes no event after it', async () => {
    const git = fakeGit();
    const box = make(git.run);
    await box.load();
    git.calls.length = 0;
    box.record('crew', 'last');
    await box.close();
    expect(git.calls.at(-1)).toEqual(['commit', '-q', '-m', 'audit: 1 event']);
    expect(timers.every((t) => t.cleared)).toBe(true);
    box.record('crew', 'too late');
    expect(box.view().events.map((e) => e.text)).toEqual(['last']);
    expect(await dayFile()).not.toContain('too late');
  });

  it('is told that git is missing, and the room goes on: the events are written and shown, nothing is committed', async () => {
    const calls: string[][] = [];
    const missing: GitRun = async (args) => {
      calls.push(args);
      throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
    };
    const box = make(missing);
    await box.load();
    expect(box.view()).toMatchObject({ git: 'missing', note: 'git was not found on the PATH' });
    box.record('crew', 'hired');
    await box.close();
    expect(calls).toEqual([['--version']]);
    expect(armed()).toBe(0);
    expect(await lines()).toHaveLength(1);
    expect(box.view().events).toHaveLength(1);
  });

  it('says why a commit failed, keeps the events, and commits them with the next batch', async () => {
    let failing = true;
    const git = fakeGit((args) => (failing && args[0] === 'commit' ? { code: 128, stderr: 'fatal: unable to write new index file\nmore text' } : undefined));
    const box = make(git.run);
    await box.load();
    box.record('crew', 'one');
    fire();
    await vi.waitFor(() => expect(box.view().git).toBe('error'));
    expect(box.view().note).toBe('fatal: unable to write new index file');
    expect(logs.some((l) => l.startsWith('warn the Black Box does not commit: fatal: unable'))).toBe(true);
    // it tries again by itself, with the count of what is still waiting
    expect(armed()).toBe(1);
    box.record('crew', 'two');
    failing = false;
    fire();
    await vi.waitFor(() => expect(box.view().git).toBe('ok'));
    expect(git.calls.filter((c) => c[0] === 'commit').map((c) => c[3])).toEqual(['audit: 1 event', 'audit: 2 events']);
    expect(await lines()).toHaveLength(2);
  });

  it('says that git took too long when it was killed for it', async () => {
    const git = fakeGit((args) => (args[0] === 'add' ? Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGKILL', code: null }) : undefined));
    const box = make(git.run);
    await box.load();
    box.record('crew', 'one');
    fire();
    await vi.waitFor(() => expect(box.view().git).toBe('error'));
    expect(box.view().note).toBe('git took more than 10 seconds');
  });

  it('does not make a repository when git cannot, and does not try to commit', async () => {
    const git = fakeGit((args) => (args[0] === 'init' ? { code: 1, stderr: 'fatal: cannot mkdir' } : undefined));
    const box = make(git.run);
    await box.load();
    expect(box.view()).toMatchObject({ git: 'error', note: 'fatal: cannot mkdir' });
    box.record('crew', 'one');
    await box.close();
    expect(git.calls.map((c) => c[0])).toEqual(['--version', 'init']);
    expect(await lines()).toHaveLength(1);
  });

  it('refuses a folder that is a link: nothing is written through it', async () => {
    const elsewhere = join(dir, 'elsewhere');
    await mkdir(elsewhere);
    await symlink(elsewhere, repo);
    const git = fakeGit();
    const box = make(git.run);
    await box.load();
    expect(box.view()).toMatchObject({ git: 'error', note: `${BLACKBOX_DIR} is not a plain folder` });
    box.record('crew', 'one');
    await box.close();
    expect(git.calls).toEqual([]);
    expect(await readdir(elsewhere)).toEqual([]);
    // still shown
    expect(box.view().events).toHaveLength(1);
  });

  describe('what an event may say', () => {
    it('is one clean line: controls and bidi marks become spaces, white space is collapsed, and it is cut', async () => {
      const box = make(fakeGit().run);
      await box.load();
      box.record('crew', ' a\nb\u0000c\u202ed\t\te ');
      box.record('crew', 'x'.repeat(AUDIT_TEXT_MAX_CHARS + 50));
      box.record('crew', '   \n ');
      box.record('nope' as never, 'unknown kind');
      await box.close();
      const written = (await lines()) as Array<{ text: string }>;
      expect(written.map((l) => l.text)).toEqual(['a b c d e', 'x'.repeat(AUDIT_TEXT_MAX_CHARS)]);
      expect(box.view().events).toHaveLength(2);
    });

    it('is cut where a surrogate pair would be split', async () => {
      const box = make(fakeGit().run);
      await box.load();
      box.record('crew', `${'x'.repeat(AUDIT_TEXT_MAX_CHARS - 1)}😀`);
      await box.close();
      const [only] = (await lines()) as Array<{ text: string }>;
      expect(only?.text).toBe('x'.repeat(AUDIT_TEXT_MAX_CHARS - 1));
    });
  });

  describe('a burst', () => {
    it('is cut at the limit of a minute, and the next minute says how many were not recorded', async () => {
      const box = make(fakeGit().run);
      await box.load();
      for (let i = 0; i < BLACKBOX_RATE_MAX + 25; i += 1) box.record('crew', `event ${i}`);
      expect(box.view().events.length).toBe(BLACKBOX_RECENT_MAX);
      now += 60_000;
      box.record('crew', 'after the minute');
      await box.close();
      const written = (await lines()) as Array<{ kind: string; text: string }>;
      expect(written).toHaveLength(BLACKBOX_RATE_MAX + 2);
      expect(written.at(-2)).toMatchObject({ kind: 'audit', text: `25 events were not recorded: more than ${BLACKBOX_RATE_MAX} in a minute` });
      expect(written.at(-1)?.text).toBe('after the minute');
    });

    it('says so at close when the minute never came', async () => {
      const box = make(fakeGit().run);
      await box.load();
      for (let i = 0; i < BLACKBOX_RATE_MAX + 3; i += 1) box.record('crew', `event ${i}`);
      await box.close();
      expect(((await lines()) as Array<{ text: string }>).at(-1)?.text).toBe(`3 events were not recorded: more than ${BLACKBOX_RATE_MAX} in a minute`);
    });
  });

  describe('the newest events at start', () => {
    const line = (at: number, text: string, kind = 'crew'): string => `${JSON.stringify({ at: new Date(at).toISOString(), kind, text })}\n`;

    it('are read from the day files, newest first, and a line that is not an event is skipped', async () => {
      await mkdir(repo, { recursive: true });
      await writeFile(join(repo, '2026-11-17.jsonl'), line(Date.UTC(2026, 10, 17, 8), 'old') + 'not json\n' + '{"at":"x","kind":"crew","text":"bad time"}\n');
      await writeFile(join(repo, '2026-11-18.jsonl'), line(Date.UTC(2026, 10, 18, 8), 'first') + line(Date.UTC(2026, 10, 18, 9), 'second') + '{"at":"2026-11-18T09:00:00.000Z","kind":"nope","text":"bad kind"}\n');
      await writeFile(join(repo, 'notes.txt'), 'not a day file');
      const box = make(fakeGit().run);
      await box.load();
      expect(box.view().events.map((e) => e.text)).toEqual(['second', 'first', 'old']);
    });

    it('are at most 200, and a big day costs the end of its file only', async () => {
      await mkdir(repo, { recursive: true });
      const big = Array.from({ length: 5000 }, (_, i) => line(Date.UTC(2026, 10, 18, 8) + i, `event ${i}`)).join('');
      await writeFile(join(repo, '2026-11-18.jsonl'), big);
      const box = make(fakeGit().run);
      await box.load();
      const events = box.view().events;
      expect(events).toHaveLength(BLACKBOX_RECENT_MAX);
      expect(events[0]?.text).toBe('event 4999');
      expect(events.at(-1)?.text).toBe('event 4800');
    });

    it('go on into the file of the day before when today has few', async () => {
      await mkdir(repo, { recursive: true });
      await writeFile(join(repo, '2026-11-17.jsonl'), line(Date.UTC(2026, 10, 17), 'yesterday'));
      await writeFile(join(repo, '2026-11-18.jsonl'), line(Date.UTC(2026, 10, 18), 'today'));
      const box = make(fakeGit().run);
      await box.load();
      expect(box.view().events.map((e) => e.text)).toEqual(['today', 'yesterday']);
    });
  });

  describe('the command that reads the log', () => {
    it('is git -C with the folder as one word, and survives a space and a quote in the path', async () => {
      const box = make(fakeGit().run);
      await box.load();
      expect(box.view().command).toBe(`git -C '${repo}' log -p`);
      expect(shellWord("/home/o'neil/my home/.gonogo")).toBe(`'/home/o'\\''neil/my home/.gonogo'`);
      expect(shellWord('/a$(rm -rf ~)`b`')).toBe(`'/a$(rm -rf ~)\`b\`'`);
    });
  });
});

const hasGit = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** What the repository says about its commits, read with the git of the machine. */
const gitOut = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();

describe.skipIf(!hasGit)('the Black Box with the git of this machine', () => {
  let saved: Record<string, string | undefined>;
  const ENV = ['HOME', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'];

  beforeEach(() => {
    saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
  });
  afterEach(() => {
    for (const name of ENV) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  const real = (): BlackBox => make(execGit(repo));

  it('makes a repository and commits the events with the identity gonogo, in batches', async () => {
    const box = real();
    await box.load();
    expect(box.view().git).toBe('ok');
    box.record('crew', 'Director hired ana');
    box.record('redline', 'ana tripped the Redline: loop');
    await box.close();
    expect(gitOut(repo, 'log', '--format=%an <%ae> | %cn <%ce> | %s')).toBe('gonogo <gonogo@localhost> | gonogo <gonogo@localhost> | audit: 2 events');
    expect(gitOut(repo, 'status', '--porcelain')).toBe('');
    expect(gitOut(repo, 'show', 'HEAD:2026-11-18.jsonl').split('\n')).toHaveLength(2);
    expect(box.view()).toMatchObject({ git: 'ok', note: '' });
  });

  it('commits what an earlier run left, and goes on from an existing repository', async () => {
    const first = real();
    await first.load();
    first.record('crew', 'one');
    await first.close();
    // a crash: a line written, no commit
    await writeFile(join(repo, '2026-11-18.jsonl'), `${await dayFile()}${JSON.stringify({ at: '2026-11-18T09:31:00.000Z', kind: 'crew', text: 'two' })}\n`);
    const second = real();
    await second.load();
    expect(second.view().events.map((e) => e.text)).toEqual(['two', 'one']);
    await second.close();
    expect(gitOut(repo, 'log', '--format=%s')).toBe('audit: earlier events\naudit: 1 event');
    expect(gitOut(repo, 'status', '--porcelain')).toBe('');
  });

  it('does not read or use the git setup of the user or of the process: another identity, hooks, signing and a git directory in the environment', async () => {
    const home = join(dir, 'home');
    const hooks = join(dir, 'hooks');
    await mkdir(home);
    await mkdir(hooks);
    const marker = join(dir, 'a-hook-ran');
    await writeFile(join(hooks, 'pre-commit'), `#!/bin/sh\ntouch '${marker}'\n`);
    await chmod(join(hooks, 'pre-commit'), 0o755);
    await writeFile(join(home, '.gitconfig'), `[user]\n  name = Somebody Else\n  email = else@example.com\n[core]\n  hooksPath = ${hooks}\n[commit]\n  gpgsign = true\n[gpg]\n  program = /nonexistent/gpg\n`);
    process.env.HOME = home;
    process.env.GIT_AUTHOR_NAME = 'Env Author';
    process.env.GIT_COMMITTER_NAME = 'Env Committer';
    process.env.GIT_DIR = join(dir, 'not-this-one');
    process.env.GIT_WORK_TREE = dir;
    const box = real();
    await box.load();
    box.record('crew', 'one');
    await box.close();
    expect(box.view().git).toBe('ok');
    expect(gitOut(repo, 'log', '--format=%an <%ae> | %cn | %s')).toBe('gonogo <gonogo@localhost> | gonogo | audit: 1 event');
    await expect(stat(marker)).rejects.toThrow();
    // and what it touched is its own folder
    await expect(stat(join(dir, 'not-this-one'))).rejects.toThrow();
    expect((await readdir(dir)).sort()).toEqual(['black-box', 'home', 'hooks']);
    // the config of the user was not written
    expect(await readFile(join(home, '.gitconfig'), 'utf8')).toContain('Somebody Else');
    expect(await readdir(home)).toEqual(['.gitconfig']);
  });

  it('does not run the hooks or the fsmonitor that the repository itself names', async () => {
    const box = real();
    await box.load();
    const marker = join(dir, 'a-hook-ran');
    const hooks = join(repo, '.git', 'evil');
    await mkdir(hooks);
    await writeFile(join(hooks, 'pre-commit'), `#!/bin/sh\ntouch '${marker}'\n`);
    await chmod(join(hooks, 'pre-commit'), 0o755);
    await writeFile(join(hooks, 'fsm'), `#!/bin/sh\ntouch '${marker}'\n`);
    await chmod(join(hooks, 'fsm'), 0o755);
    await writeFile(join(repo, '.git', 'config'), `${await readFile(join(repo, '.git', 'config'), 'utf8')}[core]\n\thooksPath = ${hooks}\n\tfsmonitor = ${join(hooks, 'fsm')}\n`);
    box.record('crew', 'one');
    await box.close();
    expect(gitOut(repo, 'log', '--format=%s')).toBe('audit: 1 event');
    await expect(stat(marker)).rejects.toThrow();
  });

  it('is told that git is missing when no program is on the PATH', async () => {
    const box = make(execGit(repo, join(dir, 'nowhere')));
    await box.load();
    expect(box.view()).toMatchObject({ git: 'missing', note: 'git was not found on the PATH' });
    box.record('crew', 'one');
    await box.close();
    expect(((await lines()) as unknown[]).length).toBe(1);
    await expect(stat(join(repo, '.git'))).rejects.toThrow();
  });

  it('says what git said when it fails, and recovers', async () => {
    const box = real();
    await box.load();
    // a file where git wants a folder
    await rm(join(repo, '.git', 'objects'), { recursive: true });
    await writeFile(join(repo, '.git', 'objects'), 'not a folder');
    box.record('crew', 'one');
    await box.close();
    expect(box.view().git).toBe('error');
    expect(box.view().note).not.toBe('');
    expect(box.view().note.split('\n')).toHaveLength(1);
  });
});
