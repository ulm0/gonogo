/**
 * Room keys (docs/features/room-keys.md): environment variables every agent of the room gets, such as the settings of Amazon Bedrock. They are
 * Clearance (clearance.ts) for the whole room: the same names, the same reserved ones, the same stored text, and the same rule that a value is never sent
 * to a browser and never logged. room-keys.json (mode 0600) holds `{ version: 1, keys: { NAME: { value, at, cleanRoom? } } }`.
 *
 * An agent's own key of the same name wins (the launcher puts the room's under the agent's). A Clean Room agent gets only the keys marked `cleanRoom`,
 * and only the ones the Director marked on purpose: the container exists to keep keys out, so the default is none.
 */
import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { KEY_NAME_PATTERN, KEY_VALUE_PATTERN, KEYS_MAX } from '../shared/protocol.js';
import type { Logger, RoomKeysView } from '../shared/protocol.js';
import { keepAside, keyNameProblem, keyNameReserved } from './clearance.js';
import { FILE_MODE, nullLogger, ROOM_KEYS_FILE, ROOM_KEYS_REFUSED_FILE } from './constants.js';
import { HubError } from './hub.js';

const VALUE_RE = new RegExp(KEY_VALUE_PATTERN);
const NAME_RE = new RegExp(KEY_NAME_PATTERN);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

interface Entry {
  value: string;
  at: number;
  cleanRoom: boolean;
}

export interface RoomKeys {
  load(): Promise<void>;
  /** The stored keys that load refused because their name is reserved now. Names only. */
  refused(): string[];
  /** What the page may see: the names, when each was set and whether a Clean Room agent gets it. Never a value. */
  view(): RoomKeysView;
  /** The values an agent gets: all of them, or for a Clean Room agent only the marked ones. For the launcher only. */
  values(cleanRoom: boolean): Record<string, string>;
  /** Adds or changes a key. `value` is needed for a new name; left out, it keeps the saved one (to change only `cleanRoom`). A bad one throws a HubError (field name, value or cleanRoom). */
  set(name: unknown, body: unknown): Promise<RoomKeysView>;
  remove(name: unknown): Promise<RoomKeysView>;
  close(): Promise<void>;
}

export function createRoomKeys(options: { dir: string; now?: () => number; log?: Logger }): RoomKeys {
  const log = options.log ?? nullLogger;
  const now = options.now ?? Date.now;
  const path = join(options.dir, ROOM_KEYS_FILE);
  let keys = new Map<string, Entry>();
  let refused: string[] = [];
  const aside: Array<[name: string, entry: unknown]> = [];
  let chain: Promise<unknown> = Promise.resolve();

  const view = (): RoomKeysView => ({ keys: [...keys].map(([name, e]) => ({ name, at: e.at, cleanRoom: e.cleanRoom })) });

  /** One write after the other; a failed one leaves the old keys and rejects to its caller. */
  const write = (build: () => Map<string, Entry>): Promise<RoomKeysView> => {
    const run = chain.then(async () => {
      const before = keys;
      keys = build();
      const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      try {
        await writeFile(temp, JSON.stringify({ version: 1, keys: Object.fromEntries([...keys].map(([name, e]) => [name, { value: e.value, at: e.at, ...(e.cleanRoom ? { cleanRoom: true } : {}) }])) }, null, 2), { flag: 'wx', mode: FILE_MODE });
        await rename(temp, path);
      } catch (error) {
        keys = before;
        await rm(temp, { force: true }).catch(() => undefined);
        // the message of a file error holds a path, not a value
        throw new Error(`could not save the room keys: ${error instanceof Error ? error.message : String(error)}`);
      }
      return view();
    });
    chain = run.catch(() => undefined);
    return run;
  };

  return {
    async load() {
      try {
        const saved: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!isRecord(saved) || saved.version !== 1 || !isRecord(saved.keys)) throw new Error('not a version 1 room keys file');
        const skipped: string[] = [];
        for (const [name, entry] of Object.entries(saved.keys)) {
          if (keyNameProblem(name) !== null || !isRecord(entry) || typeof entry.value !== 'string' || !VALUE_RE.test(entry.value)) {
            // the name only, and only when it has the shape of one: a value pasted in the name field must not reach the log
            skipped.push(NAME_RE.test(name) ? name : '(an entry whose name is not usable)');
            if (keyNameReserved(name)) {
              refused.push(name);
              aside.push([name, entry]);
            }
            continue;
          }
          keys.set(name, { value: entry.value, at: typeof entry.at === 'number' ? entry.at : 0, cleanRoom: entry.cleanRoom === true });
        }
        if (skipped.length > 0) log.warn(`${ROOM_KEYS_FILE}: skipped ${skipped.length} entr${skipped.length === 1 ? 'y' : 'ies'} that cannot be a room key (a reserved or unusable name, or a value that is not printable text without a space): ${skipped.join(', ')}. The next change to the keys writes the file without them.`);
        // a refused key is kept aside in room-keys.refused.json (0600, merged), then the file is written without it: nothing is deleted, and the Downlink note is made once
        if (refused.length > 0) {
          try {
            await keepAside(join(options.dir, ROOM_KEYS_REFUSED_FILE), (saved) => {
              saved.keys = { ...(isRecord(saved.keys) ? saved.keys : {}), ...Object.fromEntries(aside) };
            });
            await write(() => new Map(keys));
          } catch (error) {
            log.error(`${ROOM_KEYS_FILE}: could not keep the refused keys aside in ${ROOM_KEYS_REFUSED_FILE} and rewrite the file; it is left as it was`, error instanceof Error ? error.message : 'error');
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        // kept aside, so that the next save cannot overwrite the keys; a SyntaxError quotes the text around the fault, which can be a key
        log.error(`${ROOM_KEYS_FILE} could not be read; the room has no keys and the file is kept as ${ROOM_KEYS_FILE}.bad`, error instanceof SyntaxError ? 'not valid JSON' : error);
        await rename(path, `${path}.bad`).catch(() => undefined);
      }
    },
    refused: () => [...refused],
    view,
    values: (cleanRoom) => Object.fromEntries([...keys].filter(([, e]) => !cleanRoom || e.cleanRoom).map(([name, e]) => [name, e.value])),
    set: async (name, body) => {
      if (typeof name !== 'string') throw new HubError('bad_request', 'name must be text', 'name');
      const problem = keyNameProblem(name);
      if (problem !== null) throw new HubError('bad_request', problem, 'name');
      if (!isRecord(body)) throw new HubError('bad_request', 'the body must be an object', 'value');
      for (const field of Object.keys(body)) if (field !== 'value' && field !== 'cleanRoom') throw new HubError('bad_request', `a room key has no field "${field}"`, field);
      if (body.cleanRoom !== undefined && typeof body.cleanRoom !== 'boolean') throw new HubError('bad_request', 'cleanRoom must be true or false', 'cleanRoom');
      // not echoed: a value pasted in the wrong field must not come back in an error
      if (body.value !== undefined && (typeof body.value !== 'string' || !VALUE_RE.test(body.value))) throw new HubError('bad_request', 'value must be text of 1 to 4096 printable characters without a space', 'value');
      return write(() => {
        const was = keys.get(name);
        if (was === undefined && body.value === undefined) throw new HubError('bad_request', 'a new key needs a value', 'value');
        if (was === undefined && keys.size >= KEYS_MAX) throw new HubError('bad_request', `at most ${KEYS_MAX} room keys`, 'name');
        const next = new Map(keys);
        next.set(name, { value: (body.value as string | undefined) ?? (was as Entry).value, at: body.value === undefined ? (was as Entry).at : now(), cleanRoom: (body.cleanRoom as boolean | undefined) ?? was?.cleanRoom ?? false });
        return next;
      });
    },
    remove: async (name) => {
      if (typeof name !== 'string' || !keys.has(name)) throw new HubError('not_found', 'no such room key', 'name');
      return write(() => {
        const next = new Map(keys);
        next.delete(String(name));
        return next;
      });
    },
    close: () => chain.then(() => undefined),
  };
}
