/**
 * Room editor (docs/room-editor-spec.md): where the blocks of the Room view are and in what order the consoles sit, kept in
 * <home>/room.json. No file is the default layout, which is today's page. Every save names the `rev` it was made from: a save from
 * an older one is a conflict, so two browsers do not overwrite each other. The file holds no text of anybody's, only numbers and
 * the names of cells.
 */
import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkLayout, DEFAULT_DESKS } from '../shared/layout.js';
import type { RoomView } from '../shared/protocol.js';
import type { Logger } from '../shared/protocol.js';
import { FILE_MODE, ROOM_FILE } from './constants.js';
import { isRecord } from './hooks.js';
import { HubError } from './hub.js';

export interface RoomLayoutOptions {
  /** gonogo's home: room.json lives here. */
  dir: string;
  /** The layout changed (saved or reset). */
  emit(view: RoomView): void;
  log: Logger;
}

export interface RoomLayoutStore {
  load(): Promise<void>;
  view(): RoomView;
  /** The input is a JSON value from the wire: `{ rev, blocks, desks? }`. A bad one is bad_request with the field, a stale `rev` a conflict. */
  save(input: unknown): Promise<RoomView>;
  /** Back to today's page: all of it, or only the order of the desks. `rev` is the revision the Director saw: a stale one is a conflict, as for a save. */
  reset(part: 'all' | 'desks', rev: number): Promise<RoomView>;
  close(): Promise<void>;
}

const NONE: RoomView = { rev: 0, layout: null };

export function createRoomLayout(options: RoomLayoutOptions): RoomLayoutStore {
  const { dir, log } = options;
  const path = join(dir, ROOM_FILE);
  let current: RoomView = NONE;
  let chain: Promise<unknown> = Promise.resolve();

  /** One write after the other; a failed one puts the view back and rejects to its caller. */
  function change(next: RoomView): Promise<RoomView> {
    const run = chain.then(async () => {
      const before = current;
      current = next;
      try {
        if (next.layout === null) await rm(path, { force: true });
        else {
          const temp = join(dir, `.${ROOM_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
          await writeFile(temp, JSON.stringify({ version: 1, rev: next.rev, blocks: next.layout.blocks, desks: next.layout.desks }, null, 2), { mode: FILE_MODE, flag: 'wx' });
          await rename(temp, path);
        }
      } catch (error) {
        current = before;
        throw new HubError('internal', `could not save the room: ${error instanceof Error ? error.message : String(error)}`);
      }
      options.emit(current);
      return current;
    });
    chain = run.catch(() => undefined);
    return run;
  }

  return {
    async load() {
      try {
        const saved: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!isRecord(saved) || saved.version !== 1 || !Number.isSafeInteger(saved.rev)) throw new Error('not a version 1 room file');
        const checked = checkLayout(saved);
        if (!checked.ok) throw new Error(checked.error);
        current = { rev: saved.rev as number, layout: { blocks: checked.blocks, desks: checked.desks } };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return;
        // a file we cannot read (permissions, not a file) is not a bad file: it stays where it is, the default layout is used, and the next save will fail loudly
        if (typeof code === 'string') return void log.error(`${ROOM_FILE} could not be opened (${code}); the room uses the default layout and the file is left as it is`);
        // kept aside, and the default layout is used: the next save cannot overwrite what was there
        log.error(`${ROOM_FILE} could not be read; the room uses the default layout and the file is kept as ${ROOM_FILE}.bad`, error instanceof SyntaxError ? 'not valid JSON' : error);
        await rename(path, `${path}.bad`).catch(() => undefined);
      }
    },

    view: () => current,

    async save(input) {
      if (!isRecord(input)) throw new HubError('bad_request', 'the body must be an object');
      for (const key of Object.keys(input)) if (!['rev', 'blocks', 'desks'].includes(key)) throw new HubError('bad_request', `unknown field "${key}"`, key);
      if (!Number.isSafeInteger(input.rev) || (input.rev as number) < 0) throw new HubError('bad_request', 'rev must be the revision the layout was made from', 'rev');
      const checked = checkLayout(input);
      if (!checked.ok) throw new HubError('bad_request', checked.error, checked.field);
      if (input.rev !== current.rev) throw new HubError('conflict', `the room was saved by another window (revision ${current.rev}, not ${String(input.rev)}): reload it, then edit again`, 'rev');
      return change({ rev: current.rev + 1, layout: { blocks: checked.blocks, desks: checked.desks } });
    },

    async reset(part, rev) {
      if (rev !== current.rev) throw new HubError('conflict', `the room was saved by another window (revision ${current.rev}, not ${String(rev)}): reload it, then reset`, 'rev');
      if (current.layout === null) return current;
      if (part === 'desks') return change({ rev: current.rev + 1, layout: { blocks: current.layout.blocks, desks: { ...DEFAULT_DESKS, order: [] } } });
      return change({ rev: current.rev + 1, layout: null });
    },

    close: () => chain.then(() => undefined),
  };
}
