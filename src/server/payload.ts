/**
 * Payload (docs/payload-spec.md): the one reader of an agent's MCP servers and skill folders. The hub uses it for hire
 * and edit, home.ts for the roster file. It looks at the shape only; whether a skill folder exists is the hub's and the
 * launcher's to check.
 */
import { isAbsolute, basename, resolve } from 'node:path';
import { MCP_SERVER_NAME, providerInfo } from '../shared/protocol.js';
import type { McpServer, Payload, PayloadDefaults, PayloadOff, Provider } from '../shared/protocol.js';
import {
  DIR_MAX_CHARS,
  PAYLOAD_MAX_CHARS,
  PAYLOAD_MAX_ITEMS,
  PAYLOAD_MAX_SERVERS,
  PAYLOAD_MAX_SKILLS,
  PAYLOAD_SERVER_NAME_PATTERN,
  PAYLOAD_STRING_MAX_CHARS,
} from './constants.js';

export type PayloadField = 'payload' | 'payload.mcpServers' | 'payload.skills';
export type PayloadCheck = { ok: true; payload: Payload | undefined } | { ok: false; field: PayloadField; error: string };

const NAME_RE = new RegExp(PAYLOAD_SERVER_NAME_PATTERN);
const GLOBAL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME_RE = /^[A-Za-z0-9-]+$/;
const SERVER_TYPES = ['stdio', 'http', 'sse'] as const;
const FIELDS_OF = { stdio: ['type', 'command', 'args', 'env'], http: ['type', 'url', 'headers'], sse: ['type', 'url', 'headers'] } as const;

class Fault extends Error {
  constructor(
    readonly field: PayloadField,
    message: string,
  ) {
    super(message);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A string within the limits; a NUL would end a C string, so it never passes. */
function text(value: unknown, what: string, min: number, max = PAYLOAD_STRING_MAX_CHARS): string {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new Fault('payload.mcpServers', `${what} must be text of ${min === 0 ? 'at most' : `1 to`} ${max} characters`);
  }
  if (value.includes('\u0000')) throw new Fault('payload.mcpServers', `${what} cannot contain a NUL character`);
  return value;
}

/** env or headers: names by `nameRe`, values text. Built with fromEntries so that a name like __proto__ stays a plain key. */
function table(value: unknown, what: string, nameRe: RegExp, valueRe: RegExp | null): Record<string, string> {
  if (!isRecord(value)) throw new Fault('payload.mcpServers', `${what} must be an object of text values`);
  const entries = Object.entries(value);
  if (entries.length > PAYLOAD_MAX_ITEMS) throw new Fault('payload.mcpServers', `${what} can hold at most ${PAYLOAD_MAX_ITEMS} entries`);
  return Object.fromEntries(
    entries.map(([key, item]) => {
      if (!nameRe.test(key)) throw new Fault('payload.mcpServers', `${what}: "${key}" is not a usable name`);
      const checked = text(item, `${what}.${key}`, 0);
      if (valueRe?.test(checked)) throw new Fault('payload.mcpServers', `${what}.${key} cannot contain a line break`);
      return [key, checked];
    }),
  );
}

function server(name: string, value: unknown): McpServer {
  const where = `server "${name}"`;
  if (!isRecord(value)) throw new Fault('payload.mcpServers', `${where} must be an object`);
  const type = value.type ?? 'stdio';
  if (!(SERVER_TYPES as readonly unknown[]).includes(type)) {
    throw new Fault('payload.mcpServers', `${where}: type must be one of ${SERVER_TYPES.join(', ')}`);
  }
  const kind = type as (typeof SERVER_TYPES)[number];
  for (const key of Object.keys(value)) {
    if (!(FIELDS_OF[kind] as readonly string[]).includes(key)) {
      throw new Fault('payload.mcpServers', `${where}: "${key}" is not a field of a ${kind} server (a server with a url needs "type": "http" or "sse")`);
    }
  }
  const out: McpServer = {};
  if (value.type !== undefined) out.type = kind;
  if (kind === 'stdio') {
    out.command = text(value.command, `${where}: command`, 1);
    if (value.args !== undefined) {
      if (!Array.isArray(value.args) || value.args.length > PAYLOAD_MAX_ITEMS) {
        throw new Fault('payload.mcpServers', `${where}: args must be a list of at most ${PAYLOAD_MAX_ITEMS} texts`);
      }
      out.args = value.args.map((arg: unknown, i) => text(arg, `${where}: args[${i}]`, 0));
    }
    if (value.env !== undefined) out.env = table(value.env, `${where}: env`, ENV_NAME_RE, null);
    return out;
  }
  out.url = text(value.url, `${where}: url`, 1);
  let parsed: URL | null = null;
  try {
    parsed = new URL(out.url);
  } catch {
    // reported below
  }
  if (parsed === null || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    throw new Fault('payload.mcpServers', `${where}: url must be an http or https address`);
  }
  if (value.headers !== undefined) out.headers = table(value.headers, `${where}: headers`, HEADER_NAME_RE, /[\r\n]/);
  return out;
}

function servers(value: unknown): Record<string, McpServer> {
  if (!isRecord(value)) throw new Fault('payload.mcpServers', 'mcpServers must be an object of servers');
  const entries = Object.entries(value);
  if (entries.length > PAYLOAD_MAX_SERVERS) throw new Fault('payload.mcpServers', `at most ${PAYLOAD_MAX_SERVERS} servers`);
  return Object.fromEntries(
    entries.map(([name, config]) => {
      if (name === MCP_SERVER_NAME) throw new Fault('payload.mcpServers', `"${MCP_SERVER_NAME}" is reserved for the gonogo tools`);
      if (!NAME_RE.test(name)) {
        throw new Fault('payload.mcpServers', `server name "${name}": use lowercase letters, digits, - and _, starting with a letter or digit (at most 32 characters)`);
      }
      return [name, server(name, config)];
    }),
  );
}

function skills(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > PAYLOAD_MAX_SKILLS) {
    throw new Fault('payload.skills', `skills must be a list of at most ${PAYLOAD_MAX_SKILLS} folders`);
  }
  const paths = new Set<string>();
  const names = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item.length > DIR_MAX_CHARS || item.includes('\u0000')) {
      throw new Fault('payload.skills', `a skill folder must be a path of 1 to ${DIR_MAX_CHARS} characters`);
    }
    if (!isAbsolute(item)) throw new Fault('payload.skills', `a skill folder must be an absolute path: ${item}`);
    const path = resolve(item);
    // The folder's own name is the skill's name in the plugin, so two folders with one name would collide.
    if (paths.has(path) || names.has(basename(path))) throw new Fault('payload.skills', `skill folders must differ in name: ${path}`);
    paths.add(path);
    names.add(basename(path));
  }
  return [...paths];
}

/** The room defaults an agent switches off: server names and skill folder names, nothing else. */
function offOf(value: unknown): PayloadOff {
  if (!isRecord(value)) throw new Fault('payload', 'payloadOff must be an object');
  for (const key of Object.keys(value)) if (key !== 'mcpServers' && key !== 'skills') throw new Fault('payload', `payloadOff has no field "${key}"`);
  const out: PayloadOff = {};
  for (const [key, max, ok] of [
    // a server of the person's own Claude Code config may have capitals or dots, and must be switchable off by that name
    ['mcpServers', PAYLOAD_MAX_SERVERS, (n: string) => NAME_RE.test(n) || GLOBAL_NAME_RE.test(n)],
    ['skills', PAYLOAD_MAX_SKILLS, (n: string) => n.length <= 255 && !n.includes('/') && !n.includes('\u0000')],
  ] as const) {
    const list = value[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > max || !list.every((n) => typeof n === 'string' && n !== '' && ok(n))) throw new Fault('payload', `payloadOff.${key} must be a list of at most ${max} names`);
    if (list.length > 0) out[key] = [...new Set(list as string[])];
  }
  return out;
}

/** One server of somebody else's config (the user-scope servers of Claude Code), by the reader that judges a Payload server. */
export function parseServer(config: unknown): { ok: true; server: McpServer } | { ok: false; error: string } {
  try {
    return { ok: true, server: server('server', config) };
  } catch (error) {
    if (error instanceof Fault) return { ok: false, error: error.message };
    throw error;
  }
}

/** `undefined` and `null` are no payload; an empty `mcpServers` or `skills` is dropped, and a payload left empty is none. */
export function parsePayload(value: unknown): PayloadCheck {
  try {
    if (value === undefined || value === null) return { ok: true, payload: undefined };
    if (!isRecord(value)) throw new Fault('payload', 'payload must be an object');
    for (const key of Object.keys(value)) {
      if (key !== 'mcpServers' && key !== 'skills') throw new Fault('payload', `payload has no field "${key}"`);
    }
    const payload: Payload = {};
    if (value.mcpServers !== undefined) {
      const found = servers(value.mcpServers);
      if (Object.keys(found).length > 0) payload.mcpServers = found;
    }
    if (value.skills !== undefined) {
      const found = skills(value.skills);
      if (found.length > 0) payload.skills = found;
    }
    if (JSON.stringify(payload).length > PAYLOAD_MAX_CHARS) throw new Fault('payload', `payload must be at most ${PAYLOAD_MAX_CHARS} characters of JSON`);
    return { ok: true, payload: Object.keys(payload).length === 0 ? undefined : payload };
  } catch (error) {
    if (error instanceof Fault) return { ok: false, field: error.field, error: error.message };
    throw error;
  }
}

export type PayloadOffCheck = { ok: true; off: PayloadOff | undefined } | { ok: false; error: string };

/** `undefined` and `null` switch nothing off; an empty list is dropped, and an object left empty is none. */
export function parsePayloadOff(value: unknown): PayloadOffCheck {
  try {
    if (value === undefined || value === null) return { ok: true, off: undefined };
    const off = offOf(value);
    return { ok: true, off: Object.keys(off).length === 0 ? undefined : off };
  } catch (error) {
    if (error instanceof Fault) return { ok: false, error: error.message };
    throw error;
  }
}

/** Why `provider` cannot take `payload` (PROVIDER_INFO.payload), or null. */
export function payloadRefusal(provider: Provider | undefined, payload: Payload): { field: PayloadField; error: string } | null {
  const info = providerInfo(provider);
  if (info.payload === null) return { field: 'payload', error: `${info.label} takes no payload` };
  if (payload.skills !== undefined && info.payload !== 'all') {
    return { field: 'payload.skills', error: `skills need Claude Code, pi or opencode; ${info.label} takes MCP servers only` };
  }
  return null;
}

const skillName = (path: string): string => basename(path);

/**
 * What an agent starts with: the room's defaults (`room`), then the agent's own payload on top. The agent wins: a server or a skill folder of the same name
 * replaces the room's, and the names in the agent's `off` leave the room's out. A skill takes only an engine of kind `all`. Never merged inside a server:
 * the agent's server of that name is used whole. Pass no `room` for a Clean Room agent (the room's defaults never reach it).
 */
export function mergePayload(room: Payload | undefined, own: Payload | undefined, off: PayloadOff | undefined, kind: 'all' | 'servers' | null): Payload | undefined {
  if (kind === null) return undefined;
  const servers = { ...Object.fromEntries(Object.entries(room?.mcpServers ?? {}).filter(([name]) => !off?.mcpServers?.includes(name))), ...own?.mcpServers };
  const mine = new Set((own?.skills ?? []).map(skillName));
  const skills = kind === 'all' ? [...(room?.skills ?? []).filter((path) => !off?.skills?.includes(skillName(path)) && !mine.has(skillName(path))), ...(own?.skills ?? [])] : [];
  const out: Payload = {};
  if (Object.keys(servers).length > 0) out.mcpServers = servers;
  if (skills.length > 0) out.skills = skills;
  return Object.keys(out).length === 0 ? undefined : out;
}

/** The defaults as the page may show them: what each server is, never an argument, a value or a query (they can hold a token). */
export function defaultsView(payload: Payload | undefined): PayloadDefaults {
  return {
    mcpServers: Object.entries(payload?.mcpServers ?? {}).map(([name, s]) => {
      let target = s.command ?? '';
      if (s.url !== undefined) {
        try {
          target = new URL(s.url).origin;
        } catch {
          target = '';
        }
      }
      return { name, type: s.type ?? 'stdio', target, args: s.args?.length ?? 0, names: Object.keys(s.env ?? s.headers ?? {}) };
    }),
    skills: (payload?.skills ?? []).map((path) => ({ name: skillName(path), path })),
  };
}
