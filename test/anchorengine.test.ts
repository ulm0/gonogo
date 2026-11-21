// The engine of the anchors (src/server/anchorengine.ts): a real git checkout, a real worker thread, and the bounds that keep a regex from freezing the room.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Claim, Leg, Logger } from '../src/shared/protocol.js';
import { parseAnchors } from '../src/server/anchorgrammar.js';
import type { AnchorJob, AnchorWorkerMessage } from '../src/server/anchorgrammar.js';
import { createAnchorEngine } from '../src/server/anchorengine.js';
import type { AnchorEngine, AnchorEngineOptions } from '../src/server/anchorengine.js';

/** The pattern the gate allows and that never ends on a long line, put together at run time (no regex-looking constant for static analysis to flag). */
const SLOW = ['(.*)(.*)(.*)', '(.*)(.*)(.*)x'].join('');
const quiet: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined, child: () => quiet };
let root: string;
let clock: number;
let engines: AnchorEngine[] = [];

const git = (...args: string[]): string => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });
function repo(files: Record<string, string>): void {
  git('init', '-q', '-b', 'main');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  git('add', '.');
  git('commit', '-q', '-m', 'one');
}
const claim = (id: string, anchors: string): Claim => {
  const { anchors: found, diagnostics } = parseAnchors(anchors.split('\n').map((a) => `<!-- @anchor ${id} brain:${a} -->`).join('\n'));
  return { id, statement: `statement of ${id}`, authority: 'director', state: 'active', date: '2026-11-21', source: 'store', legs: found.map((a) => a.leg), diagnostics };
};
function make(over: Partial<AnchorEngineOptions> = {}): AnchorEngine {
  const engine = createAnchorEngine({ now: () => clock, log: quiet, ...over });
  engines.push(engine);
  return engine;
}
/** A hash of every file under the root (not .git), to say a run changed nothing. */
function snapshot(): string {
  const h = createHash('sha256');
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === '.git') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else h.update(`${p}\0${readFileSync(p, 'utf8')}\0${statSync(p).mtimeMs}`);
    }
  };
  walk(root);
  return h.digest('hex');
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'gng-anchor-engine-')));
  clock = 1_000_000;
});
afterEach(() => {
  engines = [];
  rmSync(root, { recursive: true, force: true });
});

describe('a run on a real checkout, in a real worker', () => {
  it('evaluates each mode and says branch, commit and counts; the checkout is byte-identical afterwards', async () => {
    repo({ 'src/a.ts': 'export const VERSION = 1;\nimport x from "y";\n', 'src/b.ts': 'import z from "w";\nconsole.log("hi");\n', 'docs/readme.md': 'say hello\n' });
    const before = snapshot();
    const engine = make();
    const results = await engine.run(root, [
      claim('K-1', 'src/**/*.ts /export const VERSION/ unique'),
      claim('K-2', 'src/**/*.ts /^import / each'),
      claim('K-3', 'src/**/*.ts /console\\.log/ each!'),
      claim('K-4', 'docs/*.md "say hello"\ndocs/*.md "goodbye" absent'),
      claim('K-5', 'src/**/*.ts /VERSION/ count=1\nnone/*.ts /x/'),
    ]);
    expect(results.map((r) => [r.id, r.worst])).toEqual([['K-1', 'ok'], ['K-2', 'ok'], ['K-3', 'stale'], ['K-4', 'ok'], ['K-5', 'vacuous']]);
    expect(results[2]?.legs[0]?.note).toBe('forbidden text in 1 file of 2 (likely real)');
    expect(results[4]?.legs.map((l) => l.state)).toEqual(['ok', 'vacuous']);
    for (const r of results) {
      expect(r).toMatchObject({ root, branch: 'main', checkedAt: clock });
      expect(r.commit).toMatch(/^[0-9a-f]{4,40}$/);
    }
    expect(snapshot()).toBe(before);
    expect(git('status', '--porcelain')).toBe('');
  });

  it('a malformed claim is malformed with its line and defect, one with no legs is unanchored, and neither stops the others', async () => {
    repo({ 'a.txt': 'x\n' });
    const bad = claim('K-1', `a.txt /${['(a', '+)+$'].join('')}/`);
    const none: Claim = { ...claim('K-2', 'a.txt "x"'), legs: [], diagnostics: [] };
    const ok = claim('K-3', 'a.txt "x"');
    const results = await make().run(root, [bad, none, ok]);
    expect(results.map((r) => r.worst)).toEqual(['malformed', 'unanchored', 'ok']);
    expect(results[0]?.legs[0]).toMatchObject({ state: 'malformed', note: expect.stringMatching(/^line 1: a repeated group/) });
  });

  it('a file name in a note: one, for a present leg that moved, and no text of the repository anywhere else', async () => {
    repo({ 'src/a.ts': 'nothing here\n', 'src/b.ts': 'the SECRETPHRASE lives here\n', 'notes.md': 'SECRETPHRASE\n' });
    const results = await make().run(root, [claim('K-1', 'src/a.ts "SECRETPHRASE"'), claim('K-2', 'src/*.ts "SECRETPHRASE" absent')]);
    expect(results[0]?.legs[0]?.state).toBe('stale');
    expect(results[0]?.legs[0]?.note).toBe('no match in 1 file (may have moved) (found in src/b.ts instead)');
    expect(results[1]?.legs[0]?.note).toBe('forbidden text found: 1 match in 1 file of 2 (likely real)');
    expect(JSON.stringify(results)).not.toContain('lives here');
  });

  it('reads only tracked files: an untracked file and a link to a secret outside the repository are never read', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'gng-anchor-secret-'));
    try {
      writeFileSync(join(outside, 'secret.txt'), 'TOPSECRET\n');
      repo({ 'a.txt': 'x\n' });
      writeFileSync(join(root, '.env'), 'TOPSECRET=1\n'); // untracked
      symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));
      git('add', 'link.txt');
      git('commit', '-q', '-m', 'a link');
      const results = await make().run(root, [claim('K-1', '** "TOPSECRET" absent'), claim('K-2', '*.txt "TOPSECRET" absent')]);
      expect(results.map((r) => r.worst)).toEqual(['ok', 'ok']); // never read, so "absent" holds; it is a hint, not an audit of the whole tree
      expect(results[1]?.legs[0]?.note).toMatch(/1 file was not read/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('a literal absent leg over everything goes through git grep -F (the fast path), and a text that starts with a dash is never given to git', async () => {
    repo({ 'a.txt': 'forbidden word\n', 'b.txt': '-Oid is only text\n' });
    const jobs: AnchorJob[] = [];
    const real = make({
      spawn: async (job) => {
        jobs.push(job);
        return { messages: [{ type: 'done', bytes: 0 }], ended: 'done' };
      },
    });
    const results = await real.run(root, [claim('K-1', '** "forbidden" absent'), claim('K-2', '** "nothing at all" absent'), claim('K-3', '** "-Oid" absent'), claim('K-4', '** "forbidden" absent\n!b.txt'.replace('\n!b.txt', ''))]);
    // answered here: K-1 (found: stale), K-2 (ok), K-4 (found); not given to the worker: K-3, whose text starts with "-"
    expect(results[0]).toMatchObject({ worst: 'stale' });
    expect(results[0]?.legs[0]?.note).toBe('forbidden text found in 1 file (likely real)');
    expect(results[1]?.worst).toBe('ok');
    expect(jobs[0]?.skip?.sort()).toEqual(['0:0', '1:0', '3:0']);
    expect(results[2]?.legs[0]?.state).toBe('unevaluated');
  });
});

describe('the bounds', () => {
  it('a pattern the gate lets through (six `(.*)` in a row, polynomial of high degree) that takes for ever is ended at the total time, and the process keeps answering', async () => {
    repo({ 'a.txt': `${'a'.repeat(400)}\n` });
    const engine = make({ runMs: 2500 });
    // the event loop must keep turning while the worker spins
    let ticks = 0;
    const ticker = setInterval(() => (ticks += 1), 20);
    const started = Date.now();
    const results = await engine.run(root, [claim('K-1', `a.txt /${SLOW}/`), claim('K-2', 'a.txt "aaa"')]);
    clearInterval(ticker);
    expect(Date.now() - started).toBeLessThan(6000);
    expect(ticks).toBeGreaterThan(10);
    // the claim that was being worked on has no answer; none of them is a crash
    expect(results[0]?.legs[0]).toMatchObject({ state: 'unevaluated', note: expect.stringMatching(/^too slow/) });
    expect(results.every((r) => r.checkedAt > 0)).toBe(true);
    expect(engine.load()).toEqual({ running: 0, queued: 0 });
  });

  it('what a worker finished before the time was up is kept, and the rest says it was too slow', async () => {
    repo({ 'a.txt': `${'a'.repeat(400)}\n` });
    const results = await make({ runMs: 2500 }).run(root, [claim('K-1', 'a.txt "aaa"'), claim('K-2', `a.txt /${SLOW}/`), claim('K-3', 'a.txt "zzz"')]);
    expect(results[0]?.worst).toBe('ok');
    expect(results[1]?.legs[0]?.note).toMatch(/^too slow/);
    expect(results[2]?.legs[0]?.note).toMatch(/^too slow/);
  });

  it('too many claims or legs, and too many files, are refused whole, with the reason', async () => {
    repo({ 'a.txt': 'x\n' });
    const many = Array.from({ length: 201 }, (_, i) => claim(`K-${i}`, 'a.txt "x"'));
    const refused = await make().run(root, many);
    expect(refused).toHaveLength(201);
    expect(refused[0]?.legs[0]?.note).toMatch(/too many claims or legs/);
    const legs = await make().run(root, [claim('K-1', Array.from({ length: 501 }, () => 'a.txt "x"').join('\n'))]);
    expect(legs[0]?.legs[0]?.note).toMatch(/too many claims or legs/);
  });

  it('a file over 1 MiB and a run over 64 MiB (here smaller caps) are skipped, and the leg that cannot read more says so', async () => {
    repo({ 'big.txt': `${'x'.repeat(5000)}NEEDLE\n`, 'a.txt': `${'a'.repeat(900)}\n`, 'b.txt': `${'b'.repeat(900)}\n` });
    const results = await make({ caps: { fileMax: 2000, runMax: 1500 } }).run(root, [claim('K-1', 'big.txt "NEEDLE" absent'), claim('K-2', '{a,b}.txt "zzz" absent')]);
    expect(results[0]?.legs[0]?.note).toMatch(/not read/);
    expect(results[1]?.legs[0]).toMatchObject({ state: 'unevaluated', note: 'too much to read in one run' });
  });

  it('a worker that fails is `the check could not finish`, not a hang; a git that cannot list is said', async () => {
    repo({ 'a.txt': 'x\n' });
    const failing = make({ spawn: async () => ({ messages: [], ended: 'failed' }) });
    const results = await failing.run(root, [claim('K-1', 'a.txt "x"')]);
    expect(results[0]?.legs[0]).toMatchObject({ state: 'unevaluated', note: 'the check could not finish' });
    const nowhere = await make().run(join(root, 'nothing-here'), [claim('K-1', 'a.txt "x"')]);
    expect(nowhere[0]?.legs[0]?.state).toBe('unevaluated');
  });
});

describe('at most 2 workers, a queue of 10, and the window', () => {
  /** A worker stand-in that finishes when the test says so, and counts how many are alive at once. */
  function held() {
    const open: Array<() => void> = [];
    let alive = 0;
    let most = 0;
    const jobs: AnchorJob[] = [];
    const spawn: NonNullable<AnchorEngineOptions['spawn']> = (job) => {
      jobs.push(job);
      alive += 1;
      most = Math.max(most, alive);
      return new Promise((resolve) => {
        open.push(() => {
          alive -= 1;
          const messages: AnchorWorkerMessage[] = job.claims.map((c) => ({ type: 'claim', index: c.index, legs: c.legs.map(() => ({ state: 'ok' as const, note: 'ok' })) }));
          resolve({ messages: [...messages, { type: 'done', bytes: 0 }], ended: 'done' });
        });
      });
    };
    return { spawn, release: () => void open.shift()?.(), jobs, most: () => most, alive: () => alive, waiting: () => open.length };
  }
  const until = async (check: () => boolean): Promise<void> => {
    for (let i = 0; i < 400 && !check(); i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(check()).toBe(true);
  };

  it('never more than 2 at once: the third waits, the queue is 10, the 13th is busy and queues nothing, and trial runs count', async () => {
    repo({ 'a.txt': 'x\n' });
    const h = held();
    const engine = make({ spawn: h.spawn });
    // different roots: one run per checkout is a different rule
    const roots = Array.from({ length: 14 }, (_, i) => {
      const dir = join(root, `r${i}`);
      mkdirSync(dir);
      execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main']);
      writeFileSync(join(dir, 'a.txt'), 'x\n');
      return dir;
    });
    const runs = roots.slice(0, 12).map((dir, i) => engine.run(dir, [claim('K-1', 'a.txt "x"')], { trial: i % 2 === 0 }));
    await until(() => h.alive() === 2);
    expect(engine.load()).toEqual({ running: 2, queued: 10 });
    const busy = await engine.run(roots[12] as string, [claim('K-1', 'a.txt "x"')]);
    expect(busy[0]?.legs[0]).toMatchObject({ state: 'unevaluated', note: expect.stringMatching(/^busy/) });
    expect(engine.load()).toEqual({ running: 2, queued: 10 });
    for (let i = 0; i < 12; i += 1) {
      await until(() => h.waiting() > 0);
      h.release();
    }
    const done = await Promise.all(runs);
    expect(done.every((r) => r[0]?.worst === 'ok')).toBe(true);
    expect(h.most()).toBe(2);
    expect(engine.load()).toEqual({ running: 0, queued: 0 });
  });

  it('one run per checkout at a time (a second trigger gets that run), and at most one every 30 s (inside it the last answer; after it a new run)', async () => {
    repo({ 'a.txt': 'x\n' });
    const h = held();
    const engine = make({ spawn: h.spawn });
    const claims = [claim('K-1', 'a.txt "x"')];
    const a = engine.run(root, claims);
    const b = engine.run(root, claims);
    await until(() => h.waiting() === 1);
    expect(h.jobs).toHaveLength(1);
    h.release();
    expect((await Promise.all([a, b])).map((r) => r[0]?.worst)).toEqual(['ok', 'ok']);
    clock += 29_000;
    expect((await engine.run(root, claims))[0]?.worst).toBe('ok');
    expect(h.jobs).toHaveLength(1); // RECHECK twice in 30 s runs once
    // claims that were not in the last run have not been checked yet
    const other = await engine.run(root, [claim('K-9', 'a.txt "x"')]);
    expect(other[0]?.legs[0]?.note).toMatch(/not checked yet/);
    clock += 2_000;
    const again = engine.run(root, claims);
    await until(() => h.waiting() === 1);
    h.release();
    await again;
    expect(h.jobs).toHaveLength(2);
  });

  it('a trial run is not merged with a real one and not kept for the window', async () => {
    repo({ 'a.txt': 'x\n' });
    const h = held();
    const engine = make({ spawn: h.spawn });
    const trial = engine.run(root, [claim('P-1', 'a.txt "x"')], { trial: true });
    const real = engine.run(root, [claim('K-1', 'a.txt "x"')]);
    await until(() => h.alive() === 2);
    h.release();
    h.release();
    await Promise.all([trial, real]);
    expect(h.jobs).toHaveLength(2);
    const second = engine.run(root, [claim('P-2', 'a.txt "x"')], { trial: true });
    await until(() => h.waiting() === 1);
    h.release();
    await second;
    expect(h.jobs).toHaveLength(3);
  });

  it('a run that was only busy does not use up the window', async () => {
    repo({ 'a.txt': 'x\n' });
    const h = held();
    const engine = make({ spawn: h.spawn, workers: 1, queueMax: 0 });
    const first = engine.run(root, [claim('K-1', 'a.txt "x"')]);
    await until(() => h.alive() === 1);
    const other = join(root, 'other');
    mkdirSync(other);
    execFileSync('git', ['-C', other, 'init', '-q', '-b', 'main']);
    writeFileSync(join(other, 'a.txt'), 'x\n');
    expect((await engine.run(other, [claim('K-1', 'a.txt "x"')]))[0]?.legs[0]?.note).toMatch(/^busy/);
    h.release();
    await first;
    const retry = engine.run(other, [claim('K-1', 'a.txt "x"')]);
    await until(() => h.waiting() === 1);
    h.release();
    expect((await retry)[0]?.worst).toBe('ok');
  });
});
