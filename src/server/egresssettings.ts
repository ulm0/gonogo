/**
 * The room's egress setting (docs/features/egress.md): one switch, off by default, `egress.json` in the room's home. On means a Clean Room agent holds no
 * Anthropic API key: its container gets a placeholder and a base URL that points at the proxy (egress.ts). An agent's own `cleanRoom.egress` wins over it.
 * Only a person with a step-up writes it (stepup.ts), and the page shows the setting, never a key.
 */
import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EgressSettings, Logger } from '../shared/protocol.js';
import { EGRESS_FILE, FILE_MODE, nullLogger } from './constants.js';
import { HubError } from './hub.js';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export interface EgressSettingsStore {
  load(): Promise<void>;
  view(): EgressSettings;
  /** `{ anthropic: boolean }`. A bad body throws a HubError (bad_request, field `anthropic`). */
  set(input: unknown): Promise<EgressSettings>;
  close(): Promise<void>;
}

export function createEgressSettings(options: { dir: string; log?: Logger }): EgressSettingsStore {
  const log = options.log ?? nullLogger;
  const path = join(options.dir, EGRESS_FILE);
  let anthropic = false;
  let chain: Promise<unknown> = Promise.resolve();
  return {
    async load() {
      try {
        const saved: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!isRecord(saved) || saved.version !== 1 || typeof saved.anthropic !== 'boolean') throw new Error('not a version 1 egress file');
        anthropic = saved.anthropic;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        // a file that cannot be read leaves the switch off: the safe side of a setting that only ever removes keys from a container is ON, but an unreadable file must not change what runs
        log.error(`${EGRESS_FILE} could not be read; egress is off`, error instanceof SyntaxError ? 'not valid JSON' : error);
      }
    },
    view: () => ({ anthropic }),
    async set(input) {
      if (!isRecord(input)) throw new HubError('bad_request', 'request body must be a JSON object');
      for (const key of Object.keys(input)) if (key !== 'anthropic') throw new HubError('bad_request', `unknown field "${key}"`, key);
      if (typeof input.anthropic !== 'boolean') throw new HubError('bad_request', 'anthropic must be true or false', 'anthropic');
      const next = input.anthropic;
      const run = chain.then(async () => {
        if (next === anthropic) return;
        const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
        try {
          await writeFile(temp, JSON.stringify({ version: 1, anthropic: next }, null, 2), { flag: 'wx', mode: FILE_MODE });
          await rename(temp, path);
        } catch (error) {
          await rm(temp, { force: true }).catch(() => undefined);
          throw new Error(`could not save the egress setting: ${error instanceof Error ? error.message : String(error)}`);
        }
        anthropic = next;
      });
      chain = run.catch(() => undefined);
      return run.then(() => ({ anthropic }));
    },
    close: () => chain.then(() => undefined),
  };
}
