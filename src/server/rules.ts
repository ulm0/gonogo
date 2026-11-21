/**
 * Room rules (docs/features/door.md): one text, `<home>/rules.md`, written by the Director in Flight Rules and appended to the role text of every
 * agent at its start (door.ts). It reaches every engine in its role text (the system prompt of claude and pi, the first prompt of the others), so only the API writes it (with a step-up, audited by
 * name and length, never by text), no agent route reads or writes it, and it is at most RULES_MAX_BYTES of plain text.
 */
import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger, RulesView } from '../shared/protocol.js';
import { FILE_MODE, nullLogger, RULES_FILE, RULES_MAX_BYTES } from './constants.js';
import { HubError } from './hub.js';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
/** Control characters (tab and newline stay), and the marks that reorder or hide text: they have no place in a rule an agent obeys. */
const FORBIDDEN = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]');

export interface RulesStore {
  load(): Promise<void>;
  view(): RulesView;
  /** The text for a start (sync, from memory). */
  text(): string;
  /** `{ text }`; an empty text removes the rules. Throws a HubError (bad_request) for a text that is too long or has forbidden characters. */
  set(input: unknown): Promise<RulesView>;
  close(): Promise<void>;
}

export function createRules(options: { dir: string; now(): number; log?: Logger }): RulesStore {
  const log = options.log ?? nullLogger;
  const path = join(options.dir, RULES_FILE);
  let text = '';
  let updatedAt: number | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const view = (): RulesView => ({ text, bytes: Buffer.byteLength(text, 'utf8'), max: RULES_MAX_BYTES, updatedAt });

  return {
    async load() {
      try {
        const raw = await readFile(path, 'utf8');
        // a file edited by hand: the same limits as the API, and a bad one is not used (the first start after it says why)
        if (Buffer.byteLength(raw, 'utf8') > RULES_MAX_BYTES || FORBIDDEN.test(raw)) throw new Error('too long or has forbidden characters');
        text = raw.replace(/\r\n?/g, '\n').trim();
        updatedAt = (await stat(path)).mtimeMs;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        log.error(`${RULES_FILE} could not be used; the room has no rules until it is saved again`, error instanceof Error ? error.message : String(error));
      }
    },
    view,
    text: () => text,
    async set(input) {
      if (!isRecord(input)) throw new HubError('bad_request', 'request body must be a JSON object');
      for (const key of Object.keys(input)) if (key !== 'text') throw new HubError('bad_request', `unknown field "${key}"`, key);
      if (typeof input.text !== 'string') throw new HubError('bad_request', 'text must be a string', 'text');
      const next = input.text.replace(/\r\n?/g, '\n').trim();
      if (FORBIDDEN.test(next)) throw new HubError('bad_request', 'text has control or text-direction characters', 'text');
      if (Buffer.byteLength(next, 'utf8') > RULES_MAX_BYTES) throw new HubError('bad_request', `text is longer than ${RULES_MAX_BYTES} bytes`, 'text');
      const run = chain.then(async () => {
        if (next === text) return;
        if (next === '') {
          await rm(path, { force: true });
          text = '';
          updatedAt = null;
          return;
        }
        const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
        try {
          await writeFile(temp, `${next}\n`, { flag: 'wx', mode: FILE_MODE });
          await rename(temp, path);
        } catch (error) {
          await rm(temp, { force: true }).catch(() => undefined);
          throw new Error(`could not save the room rules: ${error instanceof Error ? error.message : String(error)}`);
        }
        text = next;
        updatedAt = options.now();
      });
      chain = run.catch(() => undefined);
      return run.then(view);
    },
    close: () => chain.then(() => undefined),
  };
}
