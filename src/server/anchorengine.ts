/**
 * The engine that runs the legs of claims against one checkout (docs/knowledge-spec.md section 0b.3, RSO's M1 and M2). A claim's anchors can hold a regex, and a regex runs in
 * gonogo's own process: a pattern that backtracks for ever would freeze every agent, hook and page of the room. So:
 *
 * - one run of one checkout is one `worker_threads` worker (src/server/anchorgrammar.ts is its entry) with `resourceLimits`, and a timer in this thread ends it at the total
 *   time (5 s, the listing of files included): what it had not finished is `unevaluated: too slow`, and the server never stopped answering;
 * - at most 2 workers at once in this process, the rest queued (10 at most; past that a run answers `unevaluated: busy` and queues nothing); every room is a process, so the
 *   worst case of an install is 2 workers per room, 128 MiB each;
 * - one run per checkout at a time (a trigger that comes while it runs gets that run), and at most one run per checkout every 30 s (a trigger inside the window gets the last
 *   answer); a trial run (a proposal the Director has not accepted) is for other claims, so it is not merged or cached, but it takes a worker slot and a queue place like any;
 * - files are listed here with `git ls-files -z` (the Recorder's arguments: no fsmonitor, no hooks, no GIT_* in a clean environment, a child timeout), sent to the worker, and
 *   read there; at most 20,000 files, 1 MiB per file, 64 MiB per run, 200 claims, 500 legs;
 * - a literal `absent` leg on `**` with no exclusion is answered here by `git grep -F -l -z --no-textconv --no-recurse-submodules -e <text> --`, which is faster than reading
 *   a big repository (the text goes after `-e` and the list ends with `--`; a text that starts with "-" is never given to git, it goes to the worker).
 *
 * The answer carries the branch and short commit it ran on. Notes are written by gonogo. Nothing here writes in a repository.
 */
import { execFile } from 'node:child_process';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { ResourceLimits } from 'node:worker_threads';
import type { Claim, ClaimResult, Leg, LegState, Logger } from '../shared/protocol.js';
import { GIT_BIN } from './constants.js';
import { ANCHOR_CLAIMS_MAX, ANCHOR_FILES_MAX, ANCHOR_LEGS_MAX, legFiles } from './anchorgrammar.js';
import type { AnchorJob, AnchorWorkerMessage } from './anchorgrammar.js';
import { BASE_ARGS, KEEP_ENV } from './recorder.js';

export const ANCHOR_WORKERS_MAX = 2;
export const ANCHOR_QUEUE_LIMIT = 10;
/** The whole run, the listing of files included. */
export const ANCHOR_TOTAL_MS = 5000;
/** At most one run per checkout in this time, whatever asks. */
export const ANCHOR_WINDOW_MS = 30_000;
/** The most a run waits for a thread it has ended to be gone before it gives the slot back. */
const TERMINATE_WAIT_MS = 1000;
const GIT_CAP = 8 * 1024 * 1024;
const GREP_CAP = 64 * 1024;
const BRANCH = /^[\w./-]{1,80}$/;
const COMMIT = /^[0-9a-f]{4,40}$/;
const RANK: Record<LegState | 'unanchored', number> = { ok: 0, unanchored: 0, unevaluated: 1, vacuous: 2, stale: 3, malformed: 4 };

export interface AnchorEngineOptions {
  now(): number;
  log: Logger;
  workers?: number;
  queueMax?: number;
  runMs?: number;
  windowMs?: number;
  gitMs?: number;
  /** The worker's V8 limits. A test may lower them, but never the old space below about 32 MB: V8 then ends the WHOLE process, not just the thread. */
  limits?: ResourceLimits;
  /** For tests: the most bytes `git ls-files -z` may print before the run says it could not list (default 8 MiB). */
  listCap?: number;
  /** For tests: smaller caps for the worker's reading (a file, a whole run). */
  caps?: { fileMax?: number; runMax?: number };
  /** The worker's file; default: anchorgrammar.js next to this file (anchorgrammar.ts when this one is run from source). */
  workerUrl?: URL;
  env?: Record<string, string | undefined>;
  gitBin?: string;
  /** For tests: runs in the worker thread's place (it must post what the worker posts). */
  spawn?: (job: AnchorJob, signal: AbortSignal) => Promise<{ messages: AnchorWorkerMessage[]; ended: 'done' | 'failed' }>;
}

export interface AnchorEngine {
  /**
   * The results of `claims` in the checkout `root` (its git top level), one per claim in order. Never throws and never rejects. `trial` is for claims that are not accepted
   * yet: not merged with a run of the real claims, not kept for the window.
   */
  run(root: string, claims: readonly Claim[], options?: { trial?: boolean }): Promise<ClaimResult[]>;
  /** For the page and the tests: how many runs are on a worker and how many wait. */
  load(): { running: number; queued: number };
}

interface Kept {
  at: number;
  results: ClaimResult[];
}

export function createAnchorEngine(options: AnchorEngineOptions): AnchorEngine {
  const { now, log } = options;
  const maxWorkers = options.workers ?? ANCHOR_WORKERS_MAX;
  const queueMax = options.queueMax ?? ANCHOR_QUEUE_LIMIT;
  const runMs = options.runMs ?? ANCHOR_TOTAL_MS;
  const windowMs = options.windowMs ?? ANCHOR_WINDOW_MS;
  const gitMs = options.gitMs ?? 4000;
  const bin = options.gitBin ?? GIT_BIN;
  const workerUrl = options.workerUrl ?? new URL(`./anchorgrammar${extname(fileURLToPath(import.meta.url)) === '.ts' ? '.ts' : '.js'}`, import.meta.url);
  const limits: ResourceLimits = options.limits ?? { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 };
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
  for (const key of KEEP_ENV) {
    const value = (options.env ?? process.env)[key];
    if (value !== undefined) env[key] = value;
  }

  let running = 0;
  const waiting: Array<() => void> = [];
  const runningOf = new Map<string, Promise<ClaimResult[]>>();
  const kept = new Map<string, Kept>();

  function git(root: string, args: string[], signal: AbortSignal, cap = GIT_CAP): Promise<string | null> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve(null);
      execFile(bin, [...BASE_ARGS, ...args], { cwd: root, env, timeout: gitMs, killSignal: 'SIGTERM', maxBuffer: cap, encoding: 'utf8', signal }, (error, stdout) => {
        // output over the cap is a FAILURE: a list of files cut short would let an `absent` or `each` leg read ok over some of the files (`git grep -l` has its own function, where a hit over its small cap is a hit all the same)
        if (error !== null) return resolve(null);
        resolve(stdout);
      });
    });
  }

  /** `git grep` exits 1 for "no match", which is an answer: so this reports the exit code too. */
  function grep(root: string, text: string, signal: AbortSignal): Promise<{ files: number } | null> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve(null);
      execFile(bin, [...BASE_ARGS, 'grep', '-F', '-l', '-z', '--no-textconv', '--no-recurse-submodules', '-e', text, '--'], { cwd: root, env, timeout: gitMs, killSignal: 'SIGTERM', maxBuffer: GREP_CAP, encoding: 'utf8', signal }, (error, stdout) => {
        if (error === null) return resolve({ files: stdout.split('\0').filter((f) => f !== '').length });
        const code = (error as { code?: unknown }).code;
        if (code === 1) return resolve({ files: 0 });
        if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve({ files: Math.max(1, String(stdout).split('\0').filter((f) => f !== '').length) });
        resolve(null);
      });
    });
  }

  async function stamp(root: string, signal: AbortSignal): Promise<{ branch: string; commit: string }> {
    const branch = ((await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], signal, 4096)) ?? '').trim();
    const commit = ((await git(root, ['rev-parse', '--short', 'HEAD'], signal, 4096)) ?? '').trim();
    return { branch: BRANCH.test(branch) ? branch : 'detached', commit: COMMIT.test(commit) ? commit : '' };
  }

  /** Every claim as `unevaluated` for one reason. */
  function all(claims: readonly Claim[], root: string, at: number, note: string, where: { branch: string; commit: string } = { branch: '', commit: '' }): ClaimResult[] {
    return claims.map((claim) => fixed(claim, root, at, where, () => ({ state: 'unevaluated' as const, note })));
  }

  /** A claim's result when its legs are answered by `verdict`; a claim with diagnostics is malformed whatever the legs say, and one with no legs is unanchored. */
  function fixed(claim: Claim, root: string, at: number, where: { branch: string; commit: string }, verdict: (leg: Leg, n: number) => { state: LegState; note: string }): ClaimResult {
    const base = { id: claim.id, root, branch: where.branch, commit: where.commit, checkedAt: at };
    if (claim.diagnostics.length > 0) {
      return { ...base, worst: 'malformed', legs: claim.diagnostics.slice(0, 20).map((d) => ({ state: 'malformed' as const, note: `line ${d.line}: ${d.message}`.slice(0, 300) })) };
    }
    if (claim.legs.length === 0) return { ...base, worst: 'unanchored', legs: [] };
    const legs = claim.legs.map(verdict);
    return { ...base, worst: legs.reduce<LegState>((w, l) => (RANK[l.state] > RANK[w] ? l.state : w), 'ok'), legs };
  }

  /** The worker in this process's threads: the real one. */
  function spawnWorker(job: AnchorJob, signal: AbortSignal): Promise<{ messages: AnchorWorkerMessage[]; ended: 'done' | 'failed' }> {
    return new Promise((resolve) => {
      const messages: AnchorWorkerMessage[] = [];
      let settled = false;
      const worker = new Worker(workerUrl, { workerData: job, resourceLimits: limits, env: {}, stdout: false, stderr: false });
      const finish = (ended: 'done' | 'failed'): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        // the slot is given back only when the thread is really gone (or after a short cap), so that "2 workers" stays true under a flood of runs
        const gone = worker.terminate().then(() => undefined, () => undefined);
        const cap = new Promise<void>((done) => setTimeout(done, TERMINATE_WAIT_MS).unref());
        void Promise.race([gone, cap]).then(() => resolve({ messages, ended }));
      };
      const onAbort = (): void => finish('failed');
      signal.addEventListener('abort', onAbort, { once: true });
      worker.on('message', (m: AnchorWorkerMessage) => {
        messages.push(m);
        if (m.type === 'done') finish('done');
      });
      worker.on('error', (error) => {
        log.warn(`anchor worker failed: ${(error as NodeJS.ErrnoException).code ?? error.name}`);
        finish('failed');
      });
      worker.on('exit', () => finish(messages.some((m) => m.type === 'done') ? 'done' : 'failed'));
    });
  }

  async function execute(root: string, claims: readonly Claim[]): Promise<ClaimResult[]> {
    const started = now();
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), runMs);
    try {
      if (claims.length > ANCHOR_CLAIMS_MAX || claims.reduce((n, c) => n + c.legs.length, 0) > ANCHOR_LEGS_MAX) {
        return all(claims, root, started, `too many claims or legs in one run (at most ${ANCHOR_CLAIMS_MAX} claims, ${ANCHOR_LEGS_MAX} legs)`);
      }
      const where = await stamp(root, stop.signal);
      const listing = await git(root, ['ls-files', '-z'], stop.signal, options.listCap ?? GIT_CAP);
      if (listing === null) return all(claims, root, started, stop.signal.aborted ? 'too slow' : 'git could not list the files of this checkout', where);
      const files = listing.split('\0').filter((f) => f !== '');
      if (files.length > ANCHOR_FILES_MAX) return all(claims, root, started, `more than ${ANCHOR_FILES_MAX} tracked files: too many to check`, where);
      // the fast path: a literal `absent` leg over everything
      const answered = new Map<string, { state: LegState; note: string }>();
      for (const [index, claim] of claims.entries()) {
        if (claim.diagnostics.length > 0) continue;
        for (const [n, leg] of claim.legs.entries()) {
          if (leg.mode !== 'absent' || leg.glob !== '**' || leg.excludes.length > 0 || leg.pattern.kind !== 'literal' || leg.pattern.text.startsWith('-')) continue;
          const found = await grep(root, leg.pattern.text, stop.signal);
          if (found === null) continue; // the worker does it
          answered.set(`${index}:${n}`, found.files === 0 ? { state: 'ok', note: 'ok' } : { state: 'stale', note: `forbidden text found in ${found.files} ${found.files === 1 ? 'file' : 'files'} (likely real)` });
        }
      }
      const job: AnchorJob = {
        kind: 'gonogo-anchor-run',
        root,
        files,
        // the cheapest first (the fewest files to read): the run ends at its time, and what was finished by then is kept, so the claims that cost little are never lost to one that costs a lot
        claims: claims
          .flatMap((claim, index) => (claim.diagnostics.length > 0 || claim.legs.length === 0 ? [] : [{ index, legs: claim.legs, cost: claim.legs.reduce((n, leg) => n + (leg.glob === '**' && leg.excludes.length === 0 ? files.length : legFiles(leg, files).length), 0) }]))
          .sort((a, b) => a.cost - b.cost || a.index - b.index)
          .map(({ index, legs }) => ({ index, legs })),
        skip: [...answered.keys()],
        ...(options.caps === undefined ? {} : { caps: options.caps }),
      };
      const ran = job.claims.length === 0 ? { messages: [], ended: 'done' as const } : await (options.spawn ?? spawnWorker)(job, stop.signal);
      const byClaim = new Map<number, Array<{ state: LegState; note: string; moved?: string }>>();
      for (const m of ran.messages) if (m.type === 'claim') byClaim.set(m.index, m.legs);
      const why = stop.signal.aborted ? 'too slow: the run was ended at its time' : 'the check could not finish';
      const at = now();
      return claims.map((claim, index) =>
        fixed(claim, root, at, where, (_leg, n) => {
          const fast = answered.get(`${index}:${n}`);
          if (fast !== undefined) return fast;
          const verdict = byClaim.get(index)?.[n];
          if (verdict === undefined) return { state: 'unevaluated', note: why };
          // the one file name a `present` leg may carry: a path of the repository, cleaned, for the Director's page only
          // eslint-disable-next-line no-control-regex
          const moved = verdict.moved === undefined ? '' : ` (found in ${verdict.moved.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩​-‏]/g, '').slice(0, 200)} instead)`;
          return { state: verdict.state, note: `${verdict.note}${moved}` };
        }),
      );
    } catch (error) {
      log.error('anchor run failed', error);
      return all(claims, root, now(), 'the check failed');
    } finally {
      clearTimeout(timer);
    }
  }

  /** A place on a worker: now, or when one is free; null when the queue is full. */
  async function slot(): Promise<(() => void) | null> {
    if (running < maxWorkers) {
      running += 1;
    } else {
      if (waiting.length >= queueMax) return null;
      await new Promise<void>((go) => waiting.push(go));
    }
    return () => {
      const next = waiting.shift();
      if (next === undefined) running -= 1;
      else next();
    };
  }

  async function guarded(root: string, claims: readonly Claim[]): Promise<ClaimResult[]> {
    const release = await slot();
    if (release === null) return all(claims, root, now(), 'busy: other checks are waiting, try again in a moment');
    try {
      return await execute(root, claims);
    } finally {
      release();
    }
  }

  return {
    load: () => ({ running, queued: waiting.length }),
    async run(root, claims, opts = {}) {
      if (opts.trial === true) return guarded(root, claims);
      const merged = runningOf.get(root);
      if (merged !== undefined) return merged.then((results) => reorder(claims, results, root, now()));
      const last = kept.get(root);
      if (last !== undefined && now() >= last.at && now() - last.at < windowMs) return reorder(claims, last.results, root, now());
      const run = guarded(root, claims).then((results) => {
        // a run that did not happen (busy) is not a run: it does not use up the window
        if (!results.every((r) => r.legs.every((l) => l.state === 'unevaluated' && l.note.startsWith('busy')))) kept.set(root, { at: now(), results });
        return results;
      });
      runningOf.set(root, run);
      void run.finally(() => runningOf.delete(root));
      return run;
    },
  };

  /** The answer for these claims out of an answer made for those: a claim that was not in it has not been checked yet. */
  function reorder(claims: readonly Claim[], results: readonly ClaimResult[], root: string, at: number): ClaimResult[] {
    const byId = new Map(results.map((r) => [r.id, r]));
    return claims.map((claim) => byId.get(claim.id) ?? all([claim], root, at, 'not checked yet: the last check was a moment ago, and the next one is soon')[0]!);
  }
}
