/**
 * Docking 2, S5: what the Director marked shareable for a docked station (docs/docking-collab-spec.md, I). Nothing is shared by default: an entry of the
 * Mission Log or a claim is readable by a dock only when its id is marked here for that dock, by the Director's own login (an agent cannot mark anything).
 * shares.json: { version: 1, log: { <entry id>: [dock ids] }, claims: { "<repo id>/<claim id>": [dock ids] } }, 0600.
 */
import { readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../shared/protocol.js';
import { HubError } from './hub.js';

export const SHARES_FILE = 'shares.json';
const SHARES_MAX = 500;
const DOCK_ID_RE = /^[0-9a-f]{32}$/;
const LOG_KEY_RE = /^[A-Za-z0-9._-]{1,64}$/;
const CLAIM_KEY_RE = /^[A-Za-z0-9._:-]{1,80}\/[A-Za-z0-9._-]{1,64}$/;

export type ShareKind = 'log' | 'claim';

export interface Shares {
  load(): Promise<void>;
  /** Marks `key` of this kind shareable for exactly these docks (an empty list clears it). Throws a HubError for a bad key or dock id. */
  set(kind: unknown, key: unknown, docks: unknown, known: (dockId: string) => boolean): Promise<{ kind: ShareKind; key: string; docks: string[] }>;
  /** What is marked, for the page: kind, key and the docks. */
  all(): Array<{ kind: ShareKind; key: string; docks: string[] }>;
  /** The keys of this kind that are marked for this dock. */
  keysFor(kind: ShareKind, dockId: string): string[];
  /** A dock was removed: its marks go. */
  forget(dockId: string): Promise<void>;
  close(): Promise<void>;
}

export function createShares(options: { dir: string; write(file: string, text: string): Promise<void>; log: Logger }): Shares {
  const path = join(options.dir, SHARES_FILE);
  const marks: Record<ShareKind, Map<string, string[]>> = { log: new Map(), claim: new Map() };
  let pending: Promise<unknown> = Promise.resolve();
  const save = (): Promise<void> => {
    const text = JSON.stringify({ version: 1, log: Object.fromEntries(marks.log), claims: Object.fromEntries(marks.claim) });
    const run = pending.then(() => options.write(SHARES_FILE, text)).catch((error: unknown) => options.log.error('shares could not write', error));
    pending = run;
    return run;
  };
  const bad = (message: string, field: string): HubError => new HubError('bad_request', message, field);

  return {
    async load() {
      try {
        const saved: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (typeof saved !== 'object' || saved === null) throw new Error('not an object');
        const s = saved as { log?: unknown; claims?: unknown };
        const read = (raw: unknown, kind: ShareKind, ok: RegExp): void => {
          if (typeof raw !== 'object' || raw === null) return;
          for (const [key, docks] of Object.entries(raw)) {
            if (!ok.test(key) || !Array.isArray(docks)) continue;
            const list = [...new Set(docks.filter((d): d is string => typeof d === 'string' && DOCK_ID_RE.test(d)))];
            if (list.length > 0 && marks[kind].size < SHARES_MAX) marks[kind].set(key, list);
          }
        };
        read(s.log, 'log', LOG_KEY_RE);
        read(s.claims, 'claim', CLAIM_KEY_RE);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        options.log.error(`${SHARES_FILE} could not be read: nothing is shared; the file is kept as ${SHARES_FILE}.bad`, error);
        await rename(path, `${path}.bad`).catch(() => undefined);
      }
    },

    async set(kind, key, docks, known) {
      if (kind !== 'log' && kind !== 'claim') throw bad('kind is log or claim', 'kind');
      if (typeof key !== 'string' || !(kind === 'log' ? LOG_KEY_RE : CLAIM_KEY_RE).test(key)) throw bad(kind === 'log' ? 'id is the id of a Mission Log entry' : 'id is <repository id>/<claim id>', 'id');
      if (!Array.isArray(docks) || docks.length > 20) throw bad('docks is a list of up to 20 dock ids', 'docks');
      const list: string[] = [];
      for (const d of docks) {
        if (typeof d !== 'string' || !DOCK_ID_RE.test(d) || !known(d)) throw bad('docks names a station that is not docked', 'docks');
        if (!list.includes(d)) list.push(d);
      }
      if (list.length === 0) marks[kind].delete(key);
      else {
        if (!marks[kind].has(key) && marks[kind].size >= SHARES_MAX) throw new HubError('conflict', `at most ${SHARES_MAX} entries and claims can be shared`, 'id');
        marks[kind].set(key, list);
      }
      await save();
      return { kind, key, docks: list };
    },

    all: () => (['log', 'claim'] as const).flatMap((kind) => [...marks[kind]].map(([key, docks]) => ({ kind, key, docks: [...docks] }))),

    keysFor: (kind, dockId) => [...marks[kind]].filter(([, docks]) => docks.includes(dockId)).map(([key]) => key),

    async forget(dockId) {
      for (const kind of ['log', 'claim'] as const) {
        for (const [key, docks] of marks[kind]) {
          const rest = docks.filter((d) => d !== dockId);
          if (rest.length === 0) marks[kind].delete(key);
          else marks[kind].set(key, rest);
        }
      }
      await save();
    },

    close: () => pending.then(() => undefined),
  };
}
