/**
 * The boss's hires by rule, kept for 24 hours (docs/hire-fire-spec.md H3): `<home>/crew-ledger.json`, 0600. The hourly rate, the crew's dollars for the day and the names that are
 * not used again are counted from this list and not from the agents that exist now, so firing, removing and rehiring does not reset them, and a restart does not either.
 * Written only by the server; the file is read once at start, and the server's own list is the one in force (a hand edit takes effect at the next start, like any file of the home).
 */
import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../shared/protocol.js';
import { FILE_MODE, nullLogger } from './constants.js';

export const CREW_LEDGER_FILE = 'crew-ledger.json';
const KEEP_MS = 24 * 3_600_000;
const HOUR_MS = 3_600_000;
const MAX_ENTRIES = 200;

export interface CrewLedger {
  load(): Promise<void>;
  /** A hire by rule was made. Saved before it resolves. */
  hired(name: string): Promise<void>;
  /** Hires by rule in the last hour, removed ones included. */
  hiresLastHour(): number;
  /** Names hired by rule in the last 24 hours, removed ones included. */
  recentNames(): string[];
  close(): Promise<void>;
}

export function createCrewLedger(options: { dir: string; now(): number; log?: Logger }): CrewLedger {
  const log = options.log ?? nullLogger;
  const path = join(options.dir, CREW_LEDGER_FILE);
  let hires: Array<{ name: string; at: number }> = [];
  let chain: Promise<unknown> = Promise.resolve();
  const fresh = (): Array<{ name: string; at: number }> => hires.filter((h) => options.now() - h.at < KEEP_MS);

  const save = async (): Promise<void> => {
    const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(temp, JSON.stringify({ version: 1, hires }, null, 2), { flag: 'wx', mode: FILE_MODE });
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  };

  return {
    async load() {
      try {
        const saved: unknown = JSON.parse(await readFile(path, 'utf8'));
        const list = (saved as { hires?: unknown }).hires;
        if (!Array.isArray(list)) throw new Error('not a ledger');
        hires = list.filter((h): h is { name: string; at: number } => typeof h?.name === 'string' && typeof h?.at === 'number').slice(-MAX_ENTRIES);
        hires = fresh();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('crew-ledger.json is unreadable: the crew counts start again from now', error);
        hires = [];
      }
    },
    hired(name) {
      const run = chain.then(async () => {
        hires = [...fresh(), { name, at: options.now() }].slice(-MAX_ENTRIES);
        await save().catch((error: unknown) => log.error('could not save crew-ledger.json', error));
      });
      chain = run.catch(() => undefined);
      return run;
    },
    hiresLastHour: () => hires.filter((h) => options.now() - h.at < HOUR_MS).length,
    recentNames: () => [...new Set(fresh().map((h) => h.name))],
    close: () => chain.then(() => undefined),
  };
}
