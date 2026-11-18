/**
 * The Subagents setting (docs/subagents-spec.md): what a Claude Code agent may do with its own helpers, for the whole room.
 * `<home>/subagents.json` `{ version: 1, mode, limit }`: `allow` (the default, as Claude Code is), `limit` (at most `limit` running at
 * once: CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS in the agent's environment) or `none` (the tools Agent and Task are denied in its settings).
 * Claude Code does not apply the limit while ultracode is active, and gonogo cannot veto one subagent: the page says so.
 */
import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SUBAGENT_LIMIT_MAX, SUBAGENT_MODES } from '../shared/protocol.js';
import type { Logger, SubagentMode, SubagentSettings } from '../shared/protocol.js';
import { FILE_MODE, nullLogger, SUBAGENTS_FILE } from './constants.js';
import { HubError } from './hub.js';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const DEFAULT: SubagentSettings = { mode: 'allow', limit: 4 };
const goodLimit = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= SUBAGENT_LIMIT_MAX;

export interface SubagentStore {
  load(): Promise<void>;
  view(): SubagentSettings;
  /** `{ mode?, limit? }`: what is not named stays. A bad value throws a HubError (bad_request, the field). */
  set(input: unknown): Promise<SubagentSettings>;
  close(): Promise<void>;
}

export function createSubagentStore(options: { dir: string; log?: Logger }): SubagentStore {
  const log = options.log ?? nullLogger;
  const path = join(options.dir, SUBAGENTS_FILE);
  let settings: SubagentSettings = { ...DEFAULT };
  let chain: Promise<unknown> = Promise.resolve();
  return {
    async load() {
      try {
        const saved: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!isRecord(saved) || saved.version !== 1 || !(SUBAGENT_MODES as readonly unknown[]).includes(saved.mode) || (saved.limit !== undefined && !goodLimit(saved.limit))) throw new Error('not a version 1 subagents file');
        settings = { mode: saved.mode as SubagentMode, limit: saved.limit === undefined ? DEFAULT.limit : (saved.limit as number) };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return;
        // moved aside only when its content is wrong; a file that cannot be read stays where it is
        if (code !== undefined) {
          log.error(`${SUBAGENTS_FILE} could not be read; subagents are allowed`, error);
          return;
        }
        log.error(`${SUBAGENTS_FILE} could not be read; subagents are allowed and the file is kept as ${SUBAGENTS_FILE}.bad`, error instanceof SyntaxError ? 'not valid JSON' : error);
        await rename(path, `${path}.bad`).catch(() => undefined);
      }
    },
    view: () => ({ ...settings }),
    async set(input) {
      if (!isRecord(input)) throw new HubError('bad_request', 'request body must be a JSON object');
      for (const key of Object.keys(input)) if (key !== 'mode' && key !== 'limit') throw new HubError('bad_request', `unknown field "${key}"`, key);
      if (input.mode !== undefined && !(SUBAGENT_MODES as readonly unknown[]).includes(input.mode)) throw new HubError('bad_request', `mode must be one of: ${SUBAGENT_MODES.join(', ')}`, 'mode');
      if (input.limit !== undefined && !goodLimit(input.limit)) throw new HubError('bad_request', `limit must be a whole number from 1 to ${SUBAGENT_LIMIT_MAX}`, 'limit');
      const next: SubagentSettings = { mode: (input.mode as SubagentMode | undefined) ?? settings.mode, limit: (input.limit as number | undefined) ?? settings.limit };
      const run = chain.then(async () => {
        if (next.mode === settings.mode && next.limit === settings.limit) return;
        const before = settings;
        settings = next;
        const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
        try {
          await writeFile(temp, JSON.stringify({ version: 1, ...settings }, null, 2), { flag: 'wx', mode: FILE_MODE });
          await rename(temp, path);
        } catch (error) {
          settings = before;
          await rm(temp, { force: true }).catch(() => undefined);
          throw new Error(`could not save the subagent settings: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
      chain = run.catch(() => undefined);
      return run.then(() => ({ ...settings }));
    },
    close: () => chain.then(() => undefined),
  };
}
