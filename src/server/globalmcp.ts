/**
 * Global MCP servers (docs/features/global-mcp.md): the servers the person added with `claude mcp add --scope user`, which live in the top-level `mcpServers`
 * of Claude Code's user config (`<CLAUDE_CONFIG_DIR>/.claude.json`, or `~/.claude.json`). gonogo starts an agent with `--strict-mcp-config`, so it sees only the
 * servers gonogo writes into its own mcp.json; this is how the global ones get there, under the room's defaults and the agent's own: the same name, the later wins.
 *
 * The file is the person's and is only READ, at each start. A server is read by the same strict reader as a Payload server (a field it does not know, a bad value,
 * the reserved name `gonogo`, a name that is not usable): that one is skipped with a line in the log that names it and says why, never its values. A missing or
 * damaged file is the same: nothing is added and the start goes on. Names, types and addresses may be shown on the page; headers and env values never are.
 */
import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GlobalMcp, GlobalMcpServer, Logger, McpServer } from '../shared/protocol.js';
import { MCP_SERVER_NAME } from '../shared/protocol.js';
import { FILE_MODE, GLOBAL_MCP_FILE, nullLogger, PAYLOAD_MAX_SERVERS } from './constants.js';
import { HubError } from './hub.js';
import { parseServer } from './payload.js';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
/** What a server of the user's own config may be called here: wider than a Payload name (capitals and dots are common), so it can be named in `payloadOff`. */
export const GLOBAL_NAME_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$';
const NAME_RE = new RegExp(GLOBAL_NAME_PATTERN);
const FILE_MAX_BYTES = 32 * 1024 * 1024;

/** The servers of that file that this version can use, in the order of the file. Never throws. */
export async function readGlobalMcp(path: string, log: Logger = nullLogger): Promise<Record<string, McpServer>> {
  let raw: string;
  try {
    const info = await stat(path);
    if (!info.isFile()) return {};
    if (info.size > FILE_MAX_BYTES) {
      log.warn('global MCP servers: the Claude Code config is too large to read: none are added');
      return {};
    }
    raw = await readFile(path, 'utf8');
  } catch (error) {
    // no file is the usual case (nothing was added with --scope user)
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`global MCP servers: the Claude Code config could not be read (${(error as NodeJS.ErrnoException).code ?? 'error'}): none are added`);
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn('global MCP servers: the Claude Code config is not valid JSON: none are added');
    return {};
  }
  const found = isRecord(parsed) ? parsed.mcpServers : undefined;
  if (found === undefined) return {};
  if (!isRecord(found)) {
    log.warn('global MCP servers: "mcpServers" of the Claude Code config is not an object: none are added');
    return {};
  }
  const out: Record<string, McpServer> = {};
  for (const [name, config] of Object.entries(found)) {
    if (name === MCP_SERVER_NAME) {
      log.warn(`global MCP servers: "${MCP_SERVER_NAME}" is reserved for the gonogo tools: skipped`);
      continue;
    }
    if (!NAME_RE.test(name)) {
      log.warn('global MCP servers: a server with a name that is not usable here was skipped (letters, digits, . - and _, starting with a letter or digit)');
      continue;
    }
    if (Object.keys(out).length >= PAYLOAD_MAX_SERVERS) {
      log.warn(`global MCP servers: only the first ${PAYLOAD_MAX_SERVERS} are used`);
      break;
    }
    const checked = parseServer(config);
    if (!checked.ok) {
      log.warn(`global MCP servers: "${name}" was skipped: ${checked.error}`);
      continue;
    }
    // a plain key, even a name like __proto__
    Object.defineProperty(out, name, { value: checked.server, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** What the page may see of the servers: name, type, and where it connects (the command, or the origin of the address); never an argument, a header or an env value. */
export function globalView(servers: Record<string, McpServer>, overriddenBy: (name: string) => 'room' | null): GlobalMcpServer[] {
  return Object.entries(servers).map(([name, s]) => {
    let target = s.command ?? '';
    if (s.url !== undefined) {
      try {
        target = new URL(s.url).origin;
      } catch {
        target = '';
      }
    }
    return { name, type: s.type ?? 'stdio', target, overriddenBy: overriddenBy(name) };
  });
}

/** The merge, in the one place: global, then the room's defaults, then the agent's own; the same name, the later wins; `off` names are gone from the global ones. */
export function mergeGlobal(globals: Record<string, McpServer>, off: readonly string[] | undefined, payload: Record<string, McpServer> | undefined): Record<string, McpServer> {
  const kept = Object.fromEntries(Object.entries(globals).filter(([name]) => name !== MCP_SERVER_NAME && !off?.includes(name)));
  return { ...kept, ...payload };
}

export interface GlobalMcpStore {
  load(): Promise<void>;
  /** At a start: the servers just read. Returns the ones whose NAME was not there at the last start (none the very first time: that only records what is there). */
  observe(servers: GlobalMcpServer[]): Promise<GlobalMcpServer[]>;
  /** The servers added since the Director last looked, by name and target, for the findings of the banner. */
  added(): Array<{ name: string; target: string }>;
  view(): GlobalMcp;
  /** Whether the globals go into the mcp.json of an agent: `cleanRoom` is whether it is one. */
  enabled(cleanRoom: boolean): boolean;
  /** `{ host?, cleanRoom? }`. A bad body throws a HubError (bad_request, field). */
  set(input: unknown): Promise<GlobalMcp>;
  close(): Promise<void>;
}

/** The room's two switches, `global-mcp.json`: host agents on by default, Clean Room agents off (a global server can carry tokens into the container). */
export function createGlobalMcpStore(options: { dir: string; log?: Logger }): GlobalMcpStore {
  const log = options.log ?? nullLogger;
  const path = join(options.dir, GLOBAL_MCP_FILE);
  let host = true;
  let cleanRoom = false;
  /** The names at the last start (null: never recorded), and the new ones since, with their targets. */
  let seen: string[] | null = null;
  let added: Array<{ name: string; target: string }> = [];
  let chain: Promise<unknown> = Promise.resolve();
  const save = async (): Promise<void> => {
    const temp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(temp, JSON.stringify({ version: 1, host, cleanRoom, seen, added }, null, 2), { flag: 'wx', mode: FILE_MODE });
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw new Error(`could not save the global MCP setting: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  return {
    async load() {
      try {
        const saved: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!isRecord(saved) || saved.version !== 1) throw new Error('not a version 1 file');
        if (typeof saved.host === 'boolean') host = saved.host;
        if (typeof saved.cleanRoom === 'boolean') cleanRoom = saved.cleanRoom;
        if (Array.isArray(saved.seen)) seen = saved.seen.filter((n): n is string => typeof n === 'string').slice(0, 200);
        if (Array.isArray(saved.added)) added = saved.added.filter((a): a is { name: string; target: string } => isRecord(a) && typeof a.name === 'string' && typeof a.target === 'string').slice(0, 50);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        // the defaults: host agents on, Clean Room off
        log.error(`${GLOBAL_MCP_FILE} could not be read; the defaults are used`, error instanceof SyntaxError ? 'not valid JSON' : error);
      }
    },
    view: () => ({ host, cleanRoom }),
    added: () => added,
    async observe(servers) {
      const names = servers.map((s) => s.name);
      const fresh = seen === null ? [] : servers.filter((s) => !seen!.includes(s.name));
      if (seen !== null && fresh.length === 0 && names.length === seen.length) return [];
      seen = names;
      added = [...added.filter((a) => servers.some((s) => s.name === a.name && s.target === a.target)), ...fresh.map((s) => ({ name: s.name, target: s.target }))].slice(-50);
      const run = chain.then(() => save());
      chain = run.catch(() => undefined);
      await run.catch((error: unknown) => log.error('could not save the global MCP names', error));
      return fresh;
    },
    enabled: (isCleanRoom) => (isCleanRoom ? cleanRoom : host),
    async set(input) {
      if (!isRecord(input)) throw new HubError('bad_request', 'request body must be a JSON object');
      for (const key of Object.keys(input)) if (key !== 'host' && key !== 'cleanRoom') throw new HubError('bad_request', `unknown field "${key}"`, key);
      if (input.host === undefined && input.cleanRoom === undefined) throw new HubError('bad_request', 'host or cleanRoom is required', 'host');
      for (const key of ['host', 'cleanRoom'] as const) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new HubError('bad_request', `${key} must be true or false`, key);
      const nextHost = (input.host as boolean | undefined) ?? host;
      const nextCleanRoom = (input.cleanRoom as boolean | undefined) ?? cleanRoom;
      const run = chain.then(async () => {
        if (nextHost === host && nextCleanRoom === cleanRoom) return;
        const before = { host, cleanRoom };
        host = nextHost;
        cleanRoom = nextCleanRoom;
        await save().catch((error: unknown) => {
          ({ host, cleanRoom } = before);
          throw error;
        });
      });
      chain = run.catch(() => undefined);
      return run.then(() => ({ host, cleanRoom }));
    },
    close: () => chain.then(() => undefined),
  };
}
