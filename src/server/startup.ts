/**
 * The startup policy (docs/autostart-spec.md): what the server starts again after it was stopped. `<home>/startup.json`
 * `{ version: 1, policy, carryOn }`; a file that cannot be read is kept as `.bad` and the default (the boss only, carry-on on) applies.
 */
import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { STARTUP_POLICIES } from '../shared/protocol.js';
import type { Logger, StartupPolicy, StartupSettings } from '../shared/protocol.js';
import { FILE_MODE, nullLogger, STARTUP_FILE } from './constants.js';
import { HubError } from './hub.js';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const DEFAULT: StartupSettings = { policy: 'boss', carryOn: true, bossMayStart: true };

export interface StartupStore {
  load(): Promise<void>;
  view(): StartupSettings;
  /** `{ policy?, carryOn? }`: what is not named stays. A bad value throws a HubError (bad_request, the field). */
  set(input: unknown): Promise<StartupSettings>;
  close(): Promise<void>;
}

export function createStartupStore(options: { dir: string; log?: Logger }): StartupStore {
  const log = options.log ?? nullLogger;
  const path = join(options.dir, STARTUP_FILE);
  let settings: StartupSettings = { ...DEFAULT };
  let chain: Promise<unknown> = Promise.resolve();
  return {
    async load() {
      try {
        const saved: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!isRecord(saved) || saved.version !== 1 || !(STARTUP_POLICIES as readonly unknown[]).includes(saved.policy) || (saved.carryOn !== undefined && typeof saved.carryOn !== 'boolean') || (saved.bossMayStart !== undefined && typeof saved.bossMayStart !== 'boolean')) throw new Error('not a version 1 startup file');
        settings = { policy: saved.policy as StartupPolicy, carryOn: saved.carryOn !== false, bossMayStart: saved.bossMayStart !== false };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return;
        // the file is moved aside only when its content is wrong; one that cannot be read (EACCES, EISDIR) is left where it is
        if (code !== undefined) {
          log.error(`${STARTUP_FILE} could not be read; the room starts the boss only`, error);
          return;
        }
        log.error(`${STARTUP_FILE} could not be read; the room starts the boss only and the file is kept as ${STARTUP_FILE}.bad`, error instanceof SyntaxError ? 'not valid JSON' : error);
        await rename(path, `${path}.bad`).catch(() => undefined);
      }
    },
    view: () => ({ ...settings }),
    async set(input) {
      if (!isRecord(input)) throw new HubError('bad_request', 'request body must be a JSON object');
      for (const key of Object.keys(input)) if (key !== 'policy' && key !== 'carryOn' && key !== 'bossMayStart') throw new HubError('bad_request', `unknown field "${key}"`, key);
      if (input.policy !== undefined && !(STARTUP_POLICIES as readonly unknown[]).includes(input.policy)) throw new HubError('bad_request', `policy must be one of: ${STARTUP_POLICIES.join(', ')}`, 'policy');
      if (input.carryOn !== undefined && typeof input.carryOn !== 'boolean') throw new HubError('bad_request', 'carryOn must be true or false', 'carryOn');
      if (input.bossMayStart !== undefined && typeof input.bossMayStart !== 'boolean') throw new HubError('bad_request', 'bossMayStart must be true or false', 'bossMayStart');
      const next: StartupSettings = { policy: (input.policy as StartupPolicy | undefined) ?? settings.policy, carryOn: (input.carryOn as boolean | undefined) ?? settings.carryOn, bossMayStart: (input.bossMayStart as boolean | undefined) ?? settings.bossMayStart };
      const run = chain.then(async () => {
        if (next.policy === settings.policy && next.carryOn === settings.carryOn && next.bossMayStart === settings.bossMayStart) return;
        const before = settings;
        settings = next;
        const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
        try {
          await writeFile(temp, JSON.stringify({ version: 1, ...settings }, null, 2), { flag: 'wx', mode: FILE_MODE });
          await rename(temp, path);
        } catch (error) {
          settings = before;
          await rm(temp, { force: true }).catch(() => undefined);
          throw new Error(`could not save the startup settings: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
      chain = run.catch(() => undefined);
      return run.then(() => ({ ...settings }));
    },
    close: () => chain.then(() => undefined),
  };
}
