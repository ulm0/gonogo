/**
 * The registry picker (docs/features/registry.md): the pure parts. The entries are shipped with gonogo and checked by hand (src/shared/registry.ts); the page
 * only ever fills a text box with one, which the person can still edit. Nothing here fetches, installs or runs anything.
 */
import { providerInfo } from '../shared/protocol.js';
import type { Provider } from '../shared/protocol.js';
import { checkedDaysAgo, REGISTRY, REGISTRY_STALE_DAYS } from '../shared/registry.js';
import type { RegistryEntry, RegistryServer, RegistrySkill } from '../shared/registry.js';

export type { RegistryEntry, RegistryServer, RegistrySkill };

/** What an engine can be offered: servers where it takes a payload, skills only where it takes skills too (the rule of the Payload fold). */
export function entriesFor(payload: 'all' | 'servers' | null): RegistryEntry[] {
  if (payload === null) return [];
  return REGISTRY.filter((e) => e.kind === 'mcp' || payload === 'all');
}

export const serversOf = (list: readonly RegistryEntry[]): RegistryServer[] => list.filter((e): e is RegistryServer => e.kind === 'mcp');
export const skillsOf = (list: readonly RegistryEntry[]): RegistrySkill[] => list.filter((e): e is RegistrySkill => e.kind === 'skill');

export type Merged = { ok: true; text: string } | { ok: false; why: 'exists' | 'not-object' };

/**
 * Puts `{ [id]: server }` into the servers box: the box is read as JSON (empty is none), the key is added, and the whole is written back pretty-printed. A name
 * already in the box is never overwritten (the person may have edited it): the answer says so. A box that is not a JSON object is left alone, for the person to fix.
 */
export function mergeServer(text: string, entry: RegistryServer): Merged {
  let current: unknown = {};
  if (text.trim() !== '') {
    try {
      current = JSON.parse(text);
    } catch {
      return { ok: false, why: 'not-object' };
    }
  }
  if (typeof current !== 'object' || current === null || Array.isArray(current)) return { ok: false, why: 'not-object' };
  if (Object.hasOwn(current, entry.id)) return { ok: false, why: 'exists' };
  return { ok: true, text: JSON.stringify({ ...current, [entry.id]: entry.server }, null, 2) };
}

/** Whether the box already holds a server of this name (a box that is not JSON holds none). */
export function hasServer(text: string, id: string): boolean {
  try {
    const current: unknown = text.trim() === '' ? {} : JSON.parse(text);
    return typeof current === 'object' && current !== null && !Array.isArray(current) && Object.hasOwn(current, id);
  } catch {
    return false;
  }
}

/** The server as the Payload defaults form wants it: its name and its JSON. */
export const asDefault = (entry: RegistryServer): { name: string; config: string } => ({ name: entry.id, config: JSON.stringify(entry.server, null, 2) });

/** "checked 12 days ago" (the day itself too), and whether that is more than REGISTRY_STALE_DAYS: then the card warns the entry may be out of date. */
export function checkedText(checked: string, now: number): { text: string; old: boolean; days: number } {
  const days = Number.isFinite(Date.parse(`${checked}T00:00:00Z`)) ? checkedDaysAgo(checked, now) : 0;
  const old = days > REGISTRY_STALE_DAYS;
  return { text: `checked ${days === 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`} (${checked})`, old, days };
}

/** A link only to the repository over https: the data is shipped with gonogo, but the page never links to anything else. */
export const safeSource = (entry: RegistryEntry): string | null => (/^https:\/\/[^\s]+$/.test(entry.source) ? entry.source : null);

/** The skill's folder inside the clone, said in words: the Payload wants the absolute path of it. */
export const folderText = (entry: RegistrySkill): string => `Then give the absolute path of ${entry.folder} inside that folder to the box below.`;

export interface SkillRow {
  /** The folder's name: what an agent's own skill replaces and what it switches off. */
  name: string;
  /** Where it is on disk (a room skill's, and the agents' own: one name can be at two paths). */
  paths: string[];
  /** It is one of the room's defaults. */
  room: boolean;
  /** Agents that have a skill of this name of their own. */
  own: string[];
  /** Agents that get the room's skill: an engine that loads skills (Claude Code, pi, opencode), not in a Clean Room, and not switched off. Empty for a skill that is not the room's. */
  gets: string[];
  /** Agents that switched the room's skill off. */
  off: string[];
}

const baseName = (path: string): string => path.replace(/\/+$/, '').split('/').pop() ?? path;

type SkillAgent = { name: string; provider?: string; cleanRoom?: unknown; payload?: { skills?: string[] } | null; payloadOff?: { skills?: string[] } | null };

/** Which skills the room has, and who uses each: the room's defaults, the agents' own, and who switched a room skill off. Names, paths and agent names only. */
export function skillRows(roomSkills: ReadonlyArray<{ name: string; path: string }>, agents: readonly SkillAgent[]): SkillRow[] {
  const rows = new Map<string, SkillRow>();
  const row = (name: string): SkillRow => {
    const found = rows.get(name) ?? { name, paths: [], room: false, own: [], gets: [], off: [] };
    rows.set(name, found);
    return found;
  };
  for (const s of roomSkills) {
    const r = row(s.name);
    r.room = true;
    if (!r.paths.includes(s.path)) r.paths.push(s.path);
  }
  for (const agent of agents) {
    for (const path of agent.payload?.skills ?? []) {
      const r = row(baseName(path));
      r.own.push(agent.name);
      if (!r.paths.includes(path)) r.paths.push(path);
    }
    for (const name of agent.payloadOff?.skills ?? []) if (rows.get(name)?.room === true) row(name).off.push(agent.name);
  }
  for (const r of rows.values()) {
    if (!r.room) continue;
    r.gets = agents.filter((a) => providerInfo((a.provider ?? 'claude') as Provider).payload === 'all' && !a.cleanRoom && !r.off.includes(a.name) && !r.own.includes(a.name)).map((a) => a.name);
  }
  return [...rows.values()].sort((a, b) => Number(b.room) - Number(a.room) || a.name.localeCompare(b.name));
}
