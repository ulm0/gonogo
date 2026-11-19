/**
 * Payload defaults (docs/payload-spec.md): the MCP servers and skill folders the room gives every agent, kept in payload-defaults.json (mode 0600: env and
 * header values are in it, in plain text like an agent's own Payload). The page is told what each item is and never a value (`defaultsView`); the launcher
 * asks `get()` at every start and merges it under the agent's own payload (`mergePayload`: the agent wins). It is edited one item at a time, so a value
 * that was saved is never read back into a form: to change a server, set it again under its name.
 */
import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Logger, Payload, PayloadDefaults } from '../shared/protocol.js';
import { FILE_MODE, nullLogger, PAYLOAD_DEFAULTS_FILE } from './constants.js';
import { HubError } from './hub.js';
import { defaultsView, parsePayload } from './payload.js';

export interface PayloadDefaultsStore {
  load(): Promise<void>;
  /** What the page may see: no value of any kind. */
  view(): PayloadDefaults;
  /** The defaults as they are, values included: for the launcher only. */
  get(): Payload | undefined;
  /** Adds the server `name`, or replaces the one of that name whole. A bad one throws a HubError (bad_request, field `name` or `server`). */
  setServer(name: unknown, config: unknown): Promise<PayloadDefaults>;
  removeServer(name: unknown): Promise<PayloadDefaults>;
  /** Adds a skill folder (absolute path, an existing folder). A folder of the same name is a bad request (field `path`). */
  addSkill(path: unknown): Promise<PayloadDefaults>;
  /** By the folder's name. */
  removeSkill(name: unknown): Promise<PayloadDefaults>;
  close(): Promise<void>;
}

export function createPayloadDefaults(options: { dir: string; log?: Logger }): PayloadDefaultsStore {
  const log = options.log ?? nullLogger;
  const path = join(options.dir, PAYLOAD_DEFAULTS_FILE);
  let payload: Payload | undefined;
  let chain: Promise<unknown> = Promise.resolve();

  /** Applies `next` (a payload the same reader accepted) and writes it; a failed write leaves the old one. */
  const save = async (next: Payload | undefined): Promise<void> => {
    const was = payload;
    payload = next;
    const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(temp, JSON.stringify({ version: 1, payload: next ?? {} }, null, 2), { flag: 'wx', mode: FILE_MODE });
      await rename(temp, path);
    } catch (error) {
      payload = was;
      await rm(temp, { force: true }).catch(() => undefined);
      throw new Error(`could not save the payload defaults: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** Runs one change after the ones before it; `build` returns the new payload or throws a HubError. */
  const change = (build: () => Promise<Payload | undefined>): Promise<PayloadDefaults> => {
    const run = chain.then(async () => {
      await save(await build());
      return defaultsView(payload);
    });
    chain = run.catch(() => undefined);
    return run;
  };

  /** The one reader judges the whole set again, so the defaults obey every rule of an agent's own payload. */
  const judged = (next: Payload, field: string): Payload | undefined => {
    const checked = parsePayload(next);
    if (!checked.ok) throw new HubError('bad_request', checked.error, field);
    return checked.payload;
  };

  return {
    async load() {
      try {
        const saved: unknown = JSON.parse(await readFile(path, 'utf8'));
        const checked = typeof saved === 'object' && saved !== null && (saved as { version?: unknown }).version === 1 ? parsePayload((saved as { payload?: unknown }).payload) : null;
        if (checked === null || !checked.ok) throw new Error(checked !== null && !checked.ok ? checked.error : 'not a version 1 payload defaults file');
        payload = checked.payload;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        log.error(`${PAYLOAD_DEFAULTS_FILE} could not be read; the room has no payload defaults and the file is kept as ${PAYLOAD_DEFAULTS_FILE}.bad`, error);
        await rename(path, `${path}.bad`).catch(() => undefined);
      }
    },
    view: () => defaultsView(payload),
    get: () => payload,
    setServer: (name, config) =>
      change(async () => {
        if (typeof name !== 'string') throw new HubError('bad_request', 'name must be text', 'name');
        return judged({ ...payload, mcpServers: { ...payload?.mcpServers, [name]: config as never } }, 'server');
      }),
    removeServer: (name) =>
      change(async () => {
        const { [String(name)]: gone, ...rest } = payload?.mcpServers ?? {};
        if (gone === undefined) throw new HubError('not_found', 'no such server in the defaults', 'name');
        return judged({ ...payload, mcpServers: rest }, 'name');
      }),
    addSkill: (folder) =>
      change(async () => {
        if (typeof folder !== 'string') throw new HubError('bad_request', 'path must be text', 'path');
        if (!(await stat(folder).then((s) => s.isDirectory(), () => false))) throw new HubError('bad_request', `${folder} is not a folder`, 'path');
        return judged({ ...payload, skills: [...(payload?.skills ?? []), folder] }, 'path');
      }),
    removeSkill: (name) =>
      change(async () => {
        const left = (payload?.skills ?? []).filter((p) => basename(p) !== name);
        if (left.length === (payload?.skills ?? []).length) throw new HubError('not_found', 'no such skill in the defaults', 'name');
        return judged({ ...payload, skills: left }, 'name');
      }),
    close: () => chain.then(() => undefined),
  };
}
