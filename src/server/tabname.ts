/**
 * Tab name: a name for this room that the page puts in the title of the browser tab (`<name> · gonogo`), so that several gonogo
 * sessions can be told apart. Kept in <home>/tabname.json for every browser (not in a browser's own storage). With none, the
 * title is the station name when GONOGO_STATION is set, else plain `gonogo`. The name is text from the Director, never run:
 * control and bidi characters go out, and it is at most TAB_NAME_MAX_CHARS long.
 */
import { randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TAB_NAME_MAX_CHARS } from '../shared/protocol.js';
import type { Logger, TabNameView } from '../shared/protocol.js';
import { FILE_MODE, TABNAME_FILE } from './constants.js';
import { isRecord } from './hooks.js';
import { HubError } from './hub.js';

export interface TabNameStore {
  load(): Promise<void>;
  view(): TabNameView;
  /** A name, or null or empty text to go back to the default. Over the length or not text is a HubError (bad_request, field `name`). */
  set(name: unknown): Promise<TabNameView>;
  close(): Promise<void>;
}

/** One clean line: control, C1 and bidi characters out, runs of spaces one. */
export const cleanTabName = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();

export function createTabName(options: { dir: string; fallback: string | null; emit(view: TabNameView): void; log: Logger }): TabNameStore {
  const path = join(options.dir, TABNAME_FILE);
  let name: string | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const view = (): TabNameView => ({ name, fallback: options.fallback });

  return {
    async load() {
      try {
        const saved: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!isRecord(saved) || saved.version !== 1) throw new Error('not a version 1 tab name file');
        const text = typeof saved.name === 'string' ? cleanTabName(saved.name).slice(0, TAB_NAME_MAX_CHARS) : '';
        name = text === '' ? null : text;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return;
        if (typeof code === 'string') return void options.log.error(`${TABNAME_FILE} could not be opened (${code}); the tab has the default name`);
        options.log.error(`${TABNAME_FILE} could not be read; the tab has the default name and the file is kept as ${TABNAME_FILE}.bad`, error instanceof SyntaxError ? 'not valid JSON' : error);
        await rename(path, `${path}.bad`).catch(() => undefined);
      }
    },

    view,

    set(input) {
      if (input !== null && input !== undefined && typeof input !== 'string') return Promise.reject(new HubError('bad_request', 'name must be text or null', 'name'));
      const text = typeof input === 'string' ? cleanTabName(input) : '';
      if (text.length > TAB_NAME_MAX_CHARS) return Promise.reject(new HubError('bad_request', `name must be at most ${TAB_NAME_MAX_CHARS} characters`, 'name'));
      const run = chain.then(async () => {
        const before = name;
        name = text === '' ? null : text;
        if (name === before) return view();
        const temp = join(options.dir, `.${TABNAME_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
        try {
          await writeFile(temp, JSON.stringify({ version: 1, name }, null, 2), { mode: FILE_MODE, flag: 'wx' });
          await rename(temp, path);
        } catch (error) {
          name = before;
          throw new HubError('internal', `could not save the tab name: ${error instanceof Error ? error.message : String(error)}`);
        }
        options.emit(view());
        return view();
      });
      chain = run.catch(() => undefined);
      return run;
    },

    close: () => chain.then(() => undefined),
  };
}
