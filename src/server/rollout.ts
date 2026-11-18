/**
 * Rollout (docs/rollout-spec.md): tells the Director when a newer @ulm0/gonogo exists.
 *
 * Once a day (not more) a plain GET asks registry.npmjs.org for the `latest` version of the package. The request has an Accept
 * header and nothing else of ours: no version, no id, no cookie, nothing about the user or the machine. The answer is read
 * up to a limit, must hold a stable `x.y.z`, and is cached in rollout.json (mode 0600, with the time of the try). Nothing is
 * ever installed: `updateCommand` only says which command updates the way this gonogo was installed. Off with
 * GONOGO_UPDATE_CHECK=0 or --no-update-check; then nothing is asked and no note shows. The clock and fetch are injected for tests.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger, RolloutView } from '../shared/protocol.js';
import { FILE_MODE, nullLogger, ROLLOUT_EVERY_MS, ROLLOUT_FILE, ROLLOUT_MAX_BYTES, ROLLOUT_OFF_WORDS, ROLLOUT_TIMEOUT_MS, ROLLOUT_URL } from './constants.js';

const STABLE = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const CHECK_TICK_MS = 60 * 60 * 1000;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** GONOGO_UPDATE_CHECK says no: `0`, `off`, `false` or `no`. */
export const updateCheckOff = (value: string | undefined): boolean => (ROLLOUT_OFF_WORDS as readonly string[]).includes((value ?? '').trim().toLowerCase());

/** `latest` is a stable x.y.z above `current`; a prerelease of the same x.y.z is below it. Anything else is not newer. */
export function isNewer(latest: string, current: string): boolean {
  const next = STABLE.test(latest) ? latest.split('.').map(Number) : null;
  const now = /^(\d+)\.(\d+)\.(\d+)(-|$)/.exec(current);
  if (next === null || now === null) return false;
  for (let i = 0; i < 3; i += 1) {
    const have = Number(now[i + 1]);
    if (next[i] !== have) return (next[i] ?? 0) > have;
  }
  return now[4] === '-';
}

/**
 * The command that updates the way this gonogo was installed, from the path of its own file. `docker`: it runs in a container;
 * `clone`: its folder is a git checkout. Never run by gonogo.
 * shortcut: an install is told from its path (pnpm's global and dlx folders, npm's lib/node_modules); anything else gets the pnpm global command.
 */
export function updateCommand(where: { file: string; docker: boolean; clone: boolean }): string {
  const path = where.file.replace(/\\/g, '/');
  if (where.docker) return 'docker compose pull && docker compose up -d';
  if (where.clone) return 'git pull && pnpm install && pnpm build';
  if (path.includes('/pnpm/dlx/')) return 'pnpm dlx @ulm0/gonogo@latest';
  if (path.includes('/lib/node_modules/@ulm0/gonogo/')) return 'npm install -g @ulm0/gonogo@latest';
  return 'pnpm add -g @ulm0/gonogo@latest';
}

/** What `gonogo update` prints. */
export function updateText(command: string, docker: boolean, view: Pick<RolloutView, 'current' | 'latest' | 'newer'>): string {
  const state = view.newer ? `gonogo ${view.latest} is out; this is ${view.current}.` : `This is gonogo ${view.current}${view.latest === null ? '' : `; the newest the last check saw is ${view.latest}`}.`;
  return [state, 'To update, run:', '', `  ${command}`, '', docker ? 'in the folder of your compose.yaml. gonogo never updates itself.' : 'gonogo never updates itself.'].join('\n') + '\n';
}

/** The last check as `gonogo --version` shows it, from the file alone: no network. */
export function cachedLatest(home: string): string | null {
  try {
    const saved: unknown = JSON.parse(readFileSync(join(home, ROLLOUT_FILE), 'utf8'));
    return isRecord(saved) && typeof saved.latest === 'string' && STABLE.test(saved.latest) ? saved.latest : null;
  } catch {
    return null;
  }
}

/** The body of an answer, or null when it is longer than `max` bytes. */
async function readCapped(res: Response, max: number): Promise<string | null> {
  const reader = res.body?.getReader();
  if (reader === undefined) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface RolloutOptions {
  /** gonogo's home: rollout.json lives here. */
  dir: string;
  now(): number;
  /** The global fetch; a test hands in a fake, so that nothing leaves the machine. */
  fetch: typeof fetch;
  enabled: boolean;
  /** This server's version. */
  current: string;
  /** What `gonogo update` prints, see updateCommand. */
  command: string;
  emit(view: RolloutView): void;
  log?: Logger;
}

export interface Rollout {
  load(): Promise<void>;
  view(): RolloutView;
  /** Asks now when a day has passed since the last try, then looks again every hour. A no-op while off. */
  start(): void;
  /** Asks now, whatever the cache says (one ask at a time); resolves with the view. While off it asks nothing. */
  check(): Promise<RolloutView>;
  close(): Promise<void>;
}

export function createRollout(options: RolloutOptions): Rollout {
  const log = options.log ?? nullLogger;
  const path = join(options.dir, ROLLOUT_FILE);
  let latest: string | null = null;
  let checkedAt: number | null = null;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let running: Promise<RolloutView> | null = null;

  const view = (): RolloutView => ({
    enabled: options.enabled,
    current: options.current,
    latest,
    checkedAt,
    newer: options.enabled && latest !== null && isNewer(latest, options.current),
    command: options.command,
  });

  async function save(): Promise<void> {
    const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(temp, JSON.stringify({ version: 1, checkedAt, latest }, null, 2), { flag: 'wx', mode: FILE_MODE });
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      log.warn(`could not save ${ROLLOUT_FILE}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** One GET. A refusal, a timeout, a long answer or a version that is not x.y.z leaves `latest` as it was; the try still counts. */
  async function ask(): Promise<RolloutView> {
    try {
      const res = await options.fetch(ROLLOUT_URL, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(ROLLOUT_TIMEOUT_MS) });
      const text = res.ok ? await readCapped(res, ROLLOUT_MAX_BYTES) : null;
      const doc: unknown = text === null ? null : JSON.parse(text);
      if (isRecord(doc) && typeof doc.version === 'string' && STABLE.test(doc.version)) latest = doc.version;
    } catch (error) {
      log.debug(`the update check did not get an answer: ${error instanceof Error ? error.name : 'error'}`);
    }
    checkedAt = options.now();
    await save();
    const done = view();
    if (!closed) options.emit(done);
    return done;
  }

  const check = (): Promise<RolloutView> => (options.enabled ? (running ??= ask().finally(() => (running = null))) : Promise.resolve(view()));
  const due = (): boolean => checkedAt === null || options.now() - checkedAt >= ROLLOUT_EVERY_MS || checkedAt > options.now();

  return {
    async load() {
      try {
        const saved: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (isRecord(saved) && saved.version === 1) {
          if (typeof saved.latest === 'string' && STABLE.test(saved.latest)) latest = saved.latest;
          if (typeof saved.checkedAt === 'number' && Number.isFinite(saved.checkedAt)) checkedAt = saved.checkedAt;
        }
      } catch {
        // no file yet, or one that is not ours: the next check makes it. Nothing in it is a secret.
      }
    },
    view,
    check,
    start() {
      if (!options.enabled || closed) return;
      const tick = (): void => {
        if (closed) return;
        if (due()) void check();
        timer = setTimeout(tick, CHECK_TICK_MS);
        timer.unref();
      };
      tick();
    },
    async close() {
      closed = true;
      clearTimeout(timer);
      await running?.catch(() => undefined);
    },
  };
}
