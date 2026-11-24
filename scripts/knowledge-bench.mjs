#!/usr/bin/env node
/**
 * node scripts/knowledge-bench.mjs [--files N] [--keep]
 *
 * A harness for the anchor engine on BIG repositories (docs/features/knowledge-anchors.md, RSO's M1 and M2): it generates a git repository of about
 * 100,000 tracked files (a few with very long paths) and one of 19,000 (just under the engine's 20,000-file cap), runs the BUILT engine
 * (dist/server/anchorengine.js: `pnpm build:server` first) on them, and checks the bounds that keep a regex from freezing a room:
 *
 *   1. a repository over 20,000 tracked files is refused at once, saying so, and never reads "ok";
 *   2. a normal run over a repository just under the cap finishes in time or says "too slow", and the small claims are right either way;
 *   3. a pattern that takes for ever is ended at the 5 s limit (worker killed), the event loop of this process keeps turning, and the next run works;
 *   4. a file list over the byte cap reads "could not check", never "ok";
 *   5. 20 runs at once never have more than 2 workers on a thread (and the rest wait, or are told "busy");
 *   6. the process RSS stays bounded through all of it.
 *
 * It prints the numbers, PASS or FAIL for each, and exits 1 if any failed. It is not part of `pnpm test` (it makes 100,000 files and takes a minute or two):
 * the bench job of .github/workflows/ci.yml runs it by hand or weekly. `--files 5000` is a quick look. It writes only in a temp folder, which it removes
 * (`--keep` leaves it and prints the path).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIB = 1024 * 1024;

export function parseArgs(argv) {
  const out = { files: 100_000, keep: false, help: false, error: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--keep') out.keep = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--files' || a.startsWith('--files=')) {
      const value = Number(a === '--files' ? argv[(i += 1)] : a.slice('--files='.length));
      if (Number.isInteger(value) && value >= 100 && value <= 1_000_000) out.files = value;
      else out.error = '--files is a whole number from 100 to 1000000';
    } else out.error = `unknown option ${a}`;
  }
  return out;
}

const CAP = 20_000;
const USAGE = `usage: node scripts/knowledge-bench.mjs [--files N] [--keep]

  --files N   tracked files of the big repository (default 100000; the second one has at most 19000)
  --keep      leave the generated repositories in the temp folder and print where
  -h, --help  this text

Needs dist/server (pnpm build:server).`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (bytes) => Math.round(bytes / MIB);
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } };

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=bench', '-c', 'user.email=bench@example.com', '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8', maxBuffer: 256 * MIB });
}

/** A repository of `count` small tracked files in many folders, a few with very long paths, one with a needle, one with a long line for a bad pattern. */
function makeRepo(dir, count) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  const perDir = 100;
  for (let i = 0; i < count; i += 1) {
    const folder = join(dir, `pkg-${String(Math.floor(i / perDir)).padStart(5, '0')}`, 'src');
    if (i % perDir === 0) mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `file-${i}.ts`), `// file ${i}\nexport const n${i} = ${i};\nexport function f${i}() {\n  return n${i} + 1; // TODO ${i % 7}\n}\n`);
  }
  // a few long paths: components of 200 characters, a path of about 700
  for (let k = 0; k < 5; k += 1) {
    const deep = join(dir, 'long', `${'a'.repeat(200)}${k}`, `${'b'.repeat(200)}`, `${'c'.repeat(200)}`);
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'x.md'), `long path ${k}\n`);
  }
  mkdirSync(join(dir, 'special'), { recursive: true });
  writeFileSync(join(dir, 'special', 'needle.txt'), 'the NEEDLE is here\n');
  mkdirSync(join(dir, 'slow'), { recursive: true });
  writeFileSync(join(dir, 'slow', 'line.txt'), `${'a'.repeat(400)}\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'bench');
}

const claimOf = (parse, id, line) => {
  const { anchors, diagnostics } = parse(`<!-- @anchor ${id} brain:${line} -->`);
  return { id, statement: id, authority: 'bench', state: 'active', date: '2026-11-21', source: 'store', legs: anchors.map((a) => a.leg), diagnostics };
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return void console.log(USAGE);
  if (args.error) {
    console.error(`${args.error}\n${USAGE}`);
    process.exit(1);
  }
  const engineFile = join(ROOT, 'dist', 'server', 'anchorengine.js');
  if (!existsSync(engineFile)) {
    console.error('dist/server is not built: run `pnpm build:server` first');
    process.exit(1);
  }
  const { createAnchorEngine } = await import(pathToFileURL(engineFile).href);
  const { parseAnchors } = await import(pathToFileURL(join(ROOT, 'dist', 'server', 'anchorgrammar.js')).href);
  const claim = (id, line) => claimOf(parseAnchors, id, line);

  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
  };
  const numbers = {};

  const work = mkdtempSync(join(tmpdir(), 'gonogo-knowledge-bench-'));
  const rss = { baseline: process.memoryUsage().rss, peak: 0 };
  const sampler = setInterval(() => (rss.peak = Math.max(rss.peak, process.memoryUsage().rss)), 50);
  let lagMax = 0;
  let last = Date.now();
  const lag = setInterval(() => {
    const now = Date.now();
    lagMax = Math.max(lagMax, now - last - 20);
    last = now;
  }, 20);
  try {
    console.log(`generating ${args.files} files in ${work} ...`);
    const t0 = Date.now();
    const bigRepo = join(work, 'big');
    makeRepo(bigRepo, args.files);
    numbers.generateMs = Date.now() - t0;
    numbers.trackedFiles = git(bigRepo, 'ls-files').split('\n').filter(Boolean).length;
    // the repository the engine can work on: the big one when it is under the cap, else one just under it
    let big = bigRepo;
    if (numbers.trackedFiles > CAP) {
      big = join(work, 'mid');
      makeRepo(big, Math.min(args.files, 19_000));
    }
    const listed = git(big, 'ls-files', '-z').length;
    numbers.workingFiles = git(big, 'ls-files').split('\n').filter(Boolean).length;
    numbers.listBytes = listed;
    console.log(`  ${numbers.trackedFiles} tracked files (list ${mb(git(bigRepo, 'ls-files', '-z').length)} MiB), made in ${(numbers.generateMs / 1000).toFixed(1)} s; the engine works on ${numbers.workingFiles}`);
    rss.baseline = process.memoryUsage().rss;

    /* ---- 0. over the file cap ---- */
    if (bigRepo !== big) {
      const engine = createAnchorEngine({ now: Date.now, log: quiet });
      const t = Date.now();
      const out = await engine.run(bigRepo, [claim('O-1', '**/*.ts "FORBIDDENWORD" absent'), claim('O-2', 'special/*.txt "NEEDLE"')]);
      numbers.overCapMs = Date.now() - t;
      const note = out[0]?.legs[0]?.note ?? '';
      check(`a repository of ${numbers.trackedFiles} files (over ${CAP}) is refused at once, never "ok"`, out.every((r) => r.worst === 'unevaluated') && /more than 20000 tracked files/.test(note) && numbers.overCapMs < 8000, `${numbers.overCapMs} ms, ${note}`);
    }

    /* ---- 1. a normal run over everything ---- */
    {
      const engine = createAnchorEngine({ now: Date.now, log: quiet });
      const t = Date.now();
      const out = await engine.run(big, [
        // the small claims first: what a run finished before its time is kept
        claim('B-1', 'special/*.txt "NEEDLE"'),
        claim('B-4', 'long/**/*.md /^long path/ each'),
        claim('B-2', '**/*.ts /export (const|function) [a-z]+[0-9]+/ present'),
        claim('B-3', '**/*.ts "FORBIDDENWORD" absent'),
      ]);
      numbers.normalMs = Date.now() - t;
      numbers.normalStates = out.map((r) => `${r.id}:${r.worst}`).join(' ');
      const sane = out.every((r) => ['ok', 'stale', 'vacuous', 'unevaluated'].includes(r.worst));
      const needle = out[0]?.worst === 'ok';
      const longPaths = out[1]?.worst === 'ok';
      check(`a run over ${numbers.workingFiles} files ends in time with an answer for each claim`, sane && numbers.normalMs < 8000, `${numbers.normalMs} ms, ${numbers.normalStates}`);
      check('the small claim and the long paths are read right even in a big repository', needle && longPaths, `needle ${out[0]?.worst}, long paths ${out[1]?.worst}`);
    }

    /* ---- 2. the 5 s kill ---- */
    {
      const engine = createAnchorEngine({ now: Date.now, log: quiet });
      lagMax = 0;
      const slow = ['(.*)(.*)(.*)', '(.*)(.*)(.*)x'].join('');
      const t = Date.now();
      const out = await engine.run(big, [claim('S-1', `slow/*.txt /${slow}/`)]);
      numbers.killMs = Date.now() - t;
      numbers.lagMaxMs = lagMax;
      const killed = out[0]?.legs[0]?.state === 'unevaluated' && /^too slow/.test(out[0]?.legs[0]?.note ?? '');
      check('a pattern that never ends is ended at the 5 s limit', killed && numbers.killMs >= 4500 && numbers.killMs <= 8500, `${numbers.killMs} ms, ${out[0]?.legs[0]?.note}`);
      check('this process kept turning while the worker spun', numbers.lagMaxMs < 500, `longest event-loop stall ${numbers.lagMaxMs} ms`);
      const after = await engine.run(big, [claim('S-2', 'special/*.txt "NEEDLE"')]);
      // the window of 30 s answers from the last run for a claim that was in it; a new claim is "not checked yet": run a fresh engine for the proof
      const again = await createAnchorEngine({ now: Date.now, log: quiet }).run(big, [claim('S-3', 'special/*.txt "NEEDLE"')]);
      check('the next run works', again[0]?.worst === 'ok', `${again[0]?.worst} (the same engine inside its 30 s window says: ${after[0]?.legs[0]?.note?.slice(0, 40) ?? after[0]?.worst})`);
      check('no worker is left running', engine.load().running === 0, JSON.stringify(engine.load()));
    }

    /* ---- 2b. the largest claim set: 500 legs over every file, and this process must not stall (RETRO: the glob work runs in the worker) ---- */
    {
      const engine = createAnchorEngine({ now: Date.now, log: quiet });
      const lines = Array.from({ length: 500 }, (_, i) => `**/*.ts "ABSENT${i}" present`);
      // 100 claims of 5 legs each: the cap is 200 claims and 500 legs
      const many = Array.from({ length: 100 }, (_, c) => {
        const text = lines.slice(c * 5, c * 5 + 5).map((l) => `<!-- @anchor L-${c} brain:${l} -->`).join('\n');
        const { anchors, diagnostics } = parseAnchors(text);
        return { id: `L-${c}`, statement: 'x', authority: 'bench', state: 'active', date: '2026-11-21', source: 'store', legs: anchors.map((a) => a.leg), diagnostics };
      });
      lagMax = 0;
      const t = Date.now();
      const out = await engine.run(big, many);
      numbers.largeSetMs = Date.now() - t;
      numbers.largeSetLagMs = lagMax;
      check('500 legs over every file: the run ends at its time and this process does not stall', out.length === 100 && numbers.largeSetMs < 9000 && numbers.largeSetLagMs < 500, `${numbers.largeSetMs} ms, longest event-loop stall ${numbers.largeSetLagMs} ms, ${out.filter((r) => r.worst === 'unevaluated').length} of 100 claims cut`);
    }

    /* ---- 3. the file list over the cap ---- */
    {
      const engine = createAnchorEngine({ now: Date.now, log: quiet, listCap: Math.max(1024, Math.floor(listed / 2)) });
      const out = await engine.run(big, [claim('C-1', '**/*.ts "FORBIDDENWORD" absent'), claim('C-2', '**/*.ts /export/ each'), claim('C-3', 'special/*.txt "NEEDLE"')]);
      const states = out.map((r) => r.worst);
      check('a file list over the cap reads "could not check", never "ok"', states.every((s) => s === 'unevaluated'), `${states.join(', ')}; ${out[0]?.legs[0]?.note}`);
    }

    /* ---- 4. 20 runs at once, at most 2 workers ---- */
    {
      const roots = [];
      const smallCount = Math.min(3000, Math.max(500, Math.floor(args.files / 20)));
      for (let i = 0; i < 20; i += 1) {
        const dir = join(work, `small-${i}`);
        makeRepo(dir, smallCount);
        roots.push(dir);
      }
      const engine = createAnchorEngine({ now: Date.now, log: quiet });
      let most = 0;
      let queuedMost = 0;
      const poll = setInterval(() => {
        const l = engine.load();
        most = Math.max(most, l.running);
        queuedMost = Math.max(queuedMost, l.queued);
      }, 2);
      const t = Date.now();
      const out = await Promise.all(roots.map((dir, i) => engine.run(dir, [claim(`P-${i}`, '**/*.ts /export (const|function) [a-z]+[0-9]+/ present'), claim(`Q-${i}`, '**/*.ts "FORBIDDENWORD" absent')])));
      clearInterval(poll);
      numbers.parallelMs = Date.now() - t;
      numbers.maxWorkers = most;
      numbers.maxQueued = queuedMost;
      const busy = out.filter((r) => r.every((c) => c.legs.every((l) => l.state === 'unevaluated' && /^busy/.test(l.note)))).length;
      const done = out.filter((r) => r.every((c) => c.worst === 'ok')).length;
      numbers.parallelDone = done;
      numbers.parallelBusy = busy;
      check('20 runs at once never have more than 2 workers', most >= 1 && most <= 2, `${most} at most at once, ${queuedMost} waiting at most, ${done} done, ${busy} told busy, in ${numbers.parallelMs} ms`);
      check('every one of the 20 got an answer', done + busy + out.filter((r) => r.some((c) => c.legs.some((l) => l.state === 'unevaluated'))).length >= 20 && engine.load().running === 0 && engine.load().queued === 0, JSON.stringify(engine.load()));
    }

    /* ---- 5. memory ---- */
    clearInterval(sampler);
    rss.peak = Math.max(rss.peak, process.memoryUsage().rss);
    numbers.rssBaselineMiB = mb(rss.baseline);
    numbers.rssPeakMiB = mb(rss.peak);
    numbers.rssGrowthMiB = mb(rss.peak - rss.baseline);
    // 2 workers of 128 MiB of old space plus the buffers they read and the file lists: well under this
    check('the process RSS stays bounded', numbers.rssGrowthMiB < 900, `${numbers.rssBaselineMiB} MiB before, ${numbers.rssPeakMiB} MiB at the peak (+${numbers.rssGrowthMiB} MiB)`);
  } finally {
    clearInterval(sampler);
    clearInterval(lag);
    if (args.keep) console.log(`kept: ${work}`);
    else rmSync(work, { recursive: true, force: true });
  }

  console.log(`\nnumbers: ${JSON.stringify(numbers)}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = results.map((r) => `| ${r.ok ? 'PASS' : 'FAIL'} | ${r.name} | ${String(r.detail).replace(/\|/g, '/')} |`).join('\n');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Knowledge engine on ${numbers.trackedFiles} files\n\n| | check | numbers |\n|---|---|---|\n${rows}\n\n\`${JSON.stringify(numbers)}\`\n`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length === 0 ? `\nall ${results.length} checks passed` : `\n${failed.length} of ${results.length} checks FAILED`);
  process.exit(failed.length === 0 ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
