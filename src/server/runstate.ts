/**
 * Run state (docs/autostart-spec.md): which agents were running when the server last stopped, in `<home>/run-state.json`
 * `{ version: 1, at, running: [{ name, working }] }` (0600, written whole through a temporary file and a rename). The hub tells
 * it of every start and stop except those of a shutdown, so a graceful stop and a crash both leave the set as it was; a Hold, a
 * Redline trip, the Director's STOP and a Remove take a name out. A file older than RUN_STATE_MAX_AGE_MS is ignored.
 */
import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger, RunEntry } from '../shared/protocol.js';
import { FILE_MODE, nullLogger, RUN_STATE_FILE, RUN_STATE_MAX_AGE_MS } from './constants.js';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export interface RunState {
  /** What the file said at load: the set, or null when there was no file, it could not be read or it was too old. Fixed after `load`. */
  previous(): RunEntry[] | null;
  /** Records one agent as running (and whether it is in a turn) or as not running. Never throws, never waits. */
  mark(name: string, running: boolean, working: boolean): void;
  /** Waits for the writes that were asked for. */
  close(): Promise<void>;
}

export function createRunState(options: { dir: string; now(): number; log?: Logger }): RunState & { load(): Promise<void> } {
  const log = options.log ?? nullLogger;
  const path = join(options.dir, RUN_STATE_FILE);
  let before: RunEntry[] | null = null;
  /** The set as it is now, by name, in the order the agents started. */
  const current = new Map<string, boolean>();
  let loaded = false;
  let writing = false;
  let dirty = false;
  let chain: Promise<unknown> = Promise.resolve();

  const write = (): void => {
    // the set is the old one until the first change: nothing is written before the hub has started, so a crash in the boot keeps the file
    if (!loaded) return;
    if (writing) {
      dirty = true;
      return;
    }
    writing = true;
    chain = (async () => {
      do {
        dirty = false;
        const json = JSON.stringify({ version: 1, at: options.now(), running: [...current].map(([name, working]) => ({ name, working })) }, null, 2);
        const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
        try {
          await writeFile(temp, json, { flag: 'wx', mode: FILE_MODE });
          await rename(temp, path);
        } catch (error) {
          await rm(temp, { force: true }).catch(() => undefined);
          log.warn('run-state.json could not be written', error instanceof Error ? error.message : String(error));
        }
      } while (dirty);
      writing = false;
    })();
  };

  return {
    async load() {
      try {
        const saved: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!isRecord(saved) || saved.version !== 1 || typeof saved.at !== 'number' || !Array.isArray(saved.running)) throw new Error('not a version 1 run-state file');
        if (options.now() - saved.at <= RUN_STATE_MAX_AGE_MS && saved.at <= options.now() + 60_000) {
          before = saved.running.flatMap((entry): RunEntry[] => (isRecord(entry) && typeof entry.name === 'string' ? [{ name: entry.name, working: entry.working === true }] : []));
          // what was running stays in the set until the hub says otherwise: a crash during the boot loses nothing
          for (const entry of before) current.set(entry.name, entry.working);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('run-state.json could not be read; no agent is started again from it', error instanceof Error ? error.message : String(error));
      }
      loaded = true;
    },
    previous: () => (before === null ? null : before.map((entry) => ({ ...entry }))),
    mark(name, running, working) {
      if (running) {
        if (current.get(name) === working) return;
        current.set(name, working);
      } else if (!current.delete(name)) return;
      write();
    },
    close: () => chain.then(() => undefined),
  };
}
