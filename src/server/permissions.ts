/**
 * Tool permissions (docs/features/permissions.md): the rules an agent's harness runs under, as Claude Code's own `permissions`
 * (allow, ask, deny). `parsePermissions` is the one reader (hire, edit, the roster file, the room's rules); the store keeps the
 * room's rules in permissions.json. Names and patterns only, never a secret. gonogo's own tools and denials cannot be undone by them.
 */
import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PERMISSION_LISTS, PERMISSION_RULE_PATTERN, PERMISSION_RULES_MAX, providerInfo } from '../shared/protocol.js';
import type { Logger, PermissionDefaults, PermissionRules, Provider } from '../shared/protocol.js';
import { FILE_MODE, nullLogger, PERMISSIONS_FILE } from './constants.js';
import { HubError } from './hub.js';

const RULE_RE = new RegExp(PERMISSION_RULE_PATTERN);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
/** gonogo's own MCP tools (mail, the roster, votes): an agent that cannot use them cannot be reached. */
const GONOGO_TOOLS = /^mcp__gonogo(__|$|\()/;

export type PermissionsCheck = { ok: true; permissions: PermissionRules } | { ok: false; error: string };

/** Claude Code takes these; the other engines have no rule list gonogo has checked. */
export const takesPermissions = (provider: Provider | undefined): boolean => (provider ?? 'claude') === 'claude';

/** `{ allow?, ask?, deny? }` of rules; a list is trimmed, deduplicated and dropped when empty. `{}` is no rules. */
export function parsePermissions(value: unknown, provider: Provider | undefined): PermissionsCheck {
  if (!isRecord(value)) return { ok: false, error: 'permissions must be an object' };
  if (!takesPermissions(provider)) return { ok: false, error: `tool permissions are not supported for ${providerInfo(provider).label}: only Claude Code has rules gonogo can set` };
  const unknown = Object.keys(value).find((key) => !(PERMISSION_LISTS as readonly string[]).includes(key));
  if (unknown !== undefined) return { ok: false, error: `permissions has no list "${unknown}": use allow, ask or deny` };
  const out: PermissionRules = {};
  for (const list of PERMISSION_LISTS) {
    const given = value[list];
    if (given === undefined) continue;
    if (!Array.isArray(given)) return { ok: false, error: `${list} must be a list of rules` };
    const rules: string[] = [];
    for (const entry of given) {
      const rule = typeof entry === 'string' ? entry.trim() : '';
      if (!RULE_RE.test(rule)) return { ok: false, error: `${list}: ${JSON.stringify(typeof entry === 'string' ? entry.slice(0, 60) : entry)} is not a rule: a tool name, then optionally (a pattern), such as Bash or Bash(git:*)` };
      if (GONOGO_TOOLS.test(rule)) return { ok: false, error: `${list}: gonogo's own tools (${rule}) are not for the Director to change here: an agent without them cannot be reached` };
      if (!rules.includes(rule)) rules.push(rule);
    }
    if (rules.length > PERMISSION_RULES_MAX) return { ok: false, error: `${list}: at most ${PERMISSION_RULES_MAX} rules` };
    if (rules.length > 0) out[list] = rules;
  }
  return { ok: true, permissions: out };
}

/**
 * What the rules of an agent come to: with none of its own, the room's. With its own, its `allow` and `ask` replace the room's,
 * but the room's `deny` always applies too, so that one agent's edit cannot drop a room-wide deny.
 */
export function effectiveRules(own: PermissionRules | undefined, room: PermissionRules | undefined): PermissionRules {
  if (own === undefined) return room ?? {};
  const deny = [...new Set([...(room?.deny ?? []), ...(own.deny ?? [])])];
  return { ...(own.allow ? { allow: own.allow } : {}), ...(own.ask ? { ask: own.ask } : {}), ...(deny.length > 0 ? { deny } : {}) };
}

export interface PermissionDefaultsStore {
  load(): Promise<void>;
  view(): PermissionDefaults;
  get(): PermissionRules | undefined;
  /** Replaces the room's rules; `{}` clears them. A bad rule throws a HubError (bad_request, field permissions). */
  set(input: unknown): Promise<PermissionDefaults>;
  close(): Promise<void>;
}

export function createPermissionDefaults(options: { dir: string; log?: Logger }): PermissionDefaultsStore {
  const log = options.log ?? nullLogger;
  const path = join(options.dir, PERMISSIONS_FILE);
  let rules: PermissionRules = {};
  let chain: Promise<unknown> = Promise.resolve();
  const copy = (): PermissionRules => Object.fromEntries(Object.entries(rules).map(([list, found]) => [list, [...found]]));
  return {
    async load() {
      try {
        const saved: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!isRecord(saved) || saved.version !== 1) throw new Error('not a version 1 permissions file');
        const checked = parsePermissions(saved.permissions ?? {}, 'claude');
        if (!checked.ok) throw new Error(checked.error);
        rules = checked.permissions;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        log.error(`${PERMISSIONS_FILE} could not be read; the room has no default tool rules and the file is kept as ${PERMISSIONS_FILE}.bad`, error);
        await rename(path, `${path}.bad`).catch(() => undefined);
      }
    },
    view: () => ({ permissions: copy() }),
    get: () => (Object.keys(rules).length === 0 ? undefined : copy()),
    async set(input) {
      const checked = parsePermissions(input, 'claude');
      if (!checked.ok) throw new HubError('bad_request', checked.error, 'permissions');
      const run = chain.then(async () => {
        const before = rules;
        if (JSON.stringify(checked.permissions) === JSON.stringify(before)) return;
        rules = checked.permissions;
        const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
        try {
          await writeFile(temp, JSON.stringify({ version: 1, permissions: rules }, null, 2), { flag: 'wx', mode: FILE_MODE });
          await rename(temp, path);
        } catch (error) {
          rules = before;
          await rm(temp, { force: true }).catch(() => undefined);
          throw new Error(`could not save the tool rules: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
      chain = run.catch(() => undefined);
      return run.then(() => ({ permissions: copy() }));
    },
    close: () => chain.then(() => undefined),
  };
}
