import { takesCleanRoom, takesPermissions, AGENT_NAME_PATTERN, DIR_MAX_CHARS, EFFORTS, KEY_NAME_PATTERN, KEY_VALUE_PATTERN, KEYS_MAX, MODEL_PATTERN, modelFormProblem, PROVIDERS, providerInfo, RESERVED_NAMES, ROLE_MAX_CHARS, takesEffort } from '../shared/protocol.js';
import type { AgentView, CleanRoom, PayloadDefaults, GlobalMcpView, PayloadOff, Effort, EditRequest, EngineCheck, HireRequest, CleanRoomFlavor, McpServer, ModelDefaults, Payload, PermissionMode, Provider, RemoteControl, Worktree } from '../shared/protocol.js';
import { parseRulesText, rulesOf, rulesToText } from './permissions.js';
import { positionById } from '../shared/positions.js';
import type { Position } from '../shared/positions.js';

// The rules and request bodies of the hire form, kept out of HireForm.tsx so that they can be tested without a DOM.

/** The server's COMMAND_MAX_CHARS (src/server/constants.ts, which the client build does not include). */
export const COMMAND_MAX_CHARS = 1000;

export type Field = 'name' | 'role' | 'dir' | 'mode' | 'confirmBypass' | 'position' | 'command' | 'cleanRoom' | 'worktree' | 'remoteControl' | 'autostart' | 'coauthor' | 'permissions' | 'payload.mcpServers' | 'payload.skills' | 'model' | 'effort' | 'keys';
export type Problems = Partial<Record<Field, string>>;

/** One key typed in the form: a name and its value, which only ever travels from here to the server. */
export interface KeyRow {
  name: string;
  value: string;
}

export interface Values {
  provider: Provider;
  /** A roster position id; '' is "Custom role". Not for a custom command. */
  position: string;
  name: string;
  role: string;
  dir: string;
  mode: PermissionMode;
  confirm: boolean;
  /** Custom command only. */
  command: string;
  /** Payload: the MCP servers as JSON text ('' is none) and the skill folders, one per line. */
  servers: string;
  skills: string;
  /** The room's Payload defaults this agent switches off, by server name and skill folder name (docs/payload-spec.md). */
  offServers: string[];
  offSkills: string[];
  /** Clean Room: run the agent in a container on its own worktree. Claude Code, pi and opencode. */
  cleanRoom: boolean;
  /** Clean Room sandbox flavor of this agent; '' is the room's default. */
  sandbox: '' | CleanRoomFlavor;
  /** Clean Room: where the Anthropic API key is (docs/features/egress.md): '' follows the room, 'on' keeps it out of the container (a proxy of gonogo's holds it), 'off' leaves it in the container. */
  egress: '' | 'on' | 'off';
  /** Worktree: the agent starts in its own git worktree on the host. Any engine; not with a Clean Room, which has one. */
  worktree: boolean;
  /** Remote Control: start the agent with --remote-control, to approve in the Claude app. Claude Code only, not with a Clean Room. */
  remoteControl: boolean;
  /** Tool permissions: a rule on each line as `allow Bash(git:*)` (src/client/permissions.ts). Claude Code, pi and opencode; '' is none, and the room's rules apply. */
  rules: string;
  /** Start with gonogo: false keeps the room's startup policy from starting this agent again. */
  autostart: boolean;
  /** Co-author line: this console's commits end with `Co-Authored-By: <name> (gonogo)`. Unticked: not for this console, whatever the room says. */
  coauthor: boolean;
  /** Edit of an agent the boss hired by rule: the boss's fire_agent never stops it. */
  protectedAgent: boolean;
  /** Engine Bay: the model for `--model`; '' is the CLI's default. */
  model: string;
  /** An engine that takes effort (takesEffort): a level of EFFORTS; '' is the CLI's own. */
  effort: string;
  /** Clearance: keys typed now (a name that is already set replaces its value), and the names of set keys to remove. */
  keys: KeyRow[];
  keysRemoved: string[];
}

export const FIELDS: readonly string[] = ['name', 'role', 'dir', 'mode', 'confirmBypass', 'position', 'command', 'cleanRoom', 'worktree', 'remoteControl', 'permissions', 'payload.mcpServers', 'payload.skills', 'model', 'effort', 'keys'];

const NAME_PATTERN = new RegExp(AGENT_NAME_PATTERN);

/** The name a position suggests: its id, else `<id>-2`, `<id>-3` while taken. */
export function suggestName(positionId: string, taken: Readonly<Record<string, unknown>>): string {
  if (!Object.hasOwn(taken, positionId)) return positionId;
  for (let n = 2; ; n += 1) {
    const candidate = `${positionId}-${n}`;
    if (!Object.hasOwn(taken, candidate)) return candidate;
  }
}

/** The role a custom command is staffed with: its form has no role field, the server wants one. */
export const CUSTOM_ROLE = 'Custom command';
/** The position of the boss: the room holds it, a hire cannot take it. */
export const BOSS_POSITION = 'flight';

/** Whether the name and role are still what a position (or the custom placeholder) filled in, so that a new choice may replace them. */
function untouched(values: Values, agents: Readonly<Record<string, AgentView>>): { role: boolean; name: boolean } {
  const previous = positionById(values.position);
  return {
    role: values.role.trim() === '' || values.role === CUSTOM_ROLE || (previous !== null && values.role === previous.role),
    name: values.name === '' || (previous !== null && values.name === suggestName(previous.id, agents)),
  };
}

/**
 * Choosing a position makes the agent an agent CLI again (the engine picked before, else Claude Code) and fills the role with its default text and, when hiring, the name, unless the owner
 * typed their own; both stay editable. "No position" ('') drops what the previous position filled in and keeps what was typed. Editing
 * never renames an agent behind the owner's back.
 */
export function choosePosition(
  values: Values,
  positionId: string,
  agents: Readonly<Record<string, AgentView>>,
  hiring: boolean,
): Values {
  const position = positionById(positionId);
  const fresh = untouched(values, agents);
  const provider = values.provider === 'custom' ? 'claude' : values.provider;
  if (position === null) {
    return { ...values, provider, position: '', role: fresh.role ? '' : values.role, name: hiring && fresh.name ? '' : values.name };
  }
  return {
    ...values,
    provider,
    position: position.id,
    role: fresh.role ? position.role : values.role,
    name: hiring && fresh.name ? suggestName(position.id, agents) : values.name,
  };
}

/** The custom command tile: no position, no permissions, and a fixed role (the form shows none for it). */
export function chooseCustom(values: Values, agents: Readonly<Record<string, AgentView>>): Values {
  return { ...values, provider: 'custom', position: '', role: CUSTOM_ROLE, cleanRoom: false, worktree: values.worktree, remoteControl: false, autostart: values.autostart, coauthor: values.coauthor, protectedAgent: values.protectedAgent, rules: '', model: '', effort: '', name: untouched(values, agents).name ? '' : values.name };
}

/** Engine Bay: another agent CLI keeps the position and role; one without permission modes runs in 'default'. Another engine names its models otherwise, so the model starts empty. */
export function chooseEngine(values: Values, provider: Provider): Values {
  return { ...values, provider, model: '', effort: '', mode: providerInfo(provider).modes ? values.mode : 'default', confirm: false, cleanRoom: takesCleanRoom(provider) && values.cleanRoom, worktree: values.worktree && !(takesCleanRoom(provider) && values.cleanRoom), remoteControl: provider === 'claude' && values.remoteControl, rules: takesPermissions(provider) ? values.rules : '' };
}

/** The edit form: picking the engine the console runs on again brings back what the form opened with for it, not a blank model. */
export function chooseEngineAgain(values: Values, provider: Provider, opened: Values): Values {
  if (provider !== opened.provider) return chooseEngine(values, provider);
  const { model, effort, mode, confirm, cleanRoom, worktree, remoteControl, rules } = opened;
  return { ...values, provider, model, effort, mode, confirm, cleanRoom, worktree, remoteControl, rules };
}

/** A new hire as it opens: the room's default engine, then its default permission mode (an engine without modes keeps ask; bypass is preselected but still confirmed in the form). A form the person already touched is left alone. */
export function withRoomDefaults(values: Values, defaults: Pick<ModelDefaults, 'engine' | 'mode'>): Values {
  if (values.provider !== 'claude' || values.name !== '' || values.role !== '') return values;
  const chosen = defaults.engine === undefined ? values : chooseEngine(values, defaults.engine);
  return defaults.mode !== undefined && providerInfo(chosen.provider).modes ? { ...chosen, mode: defaults.mode, confirm: false } : chosen;
}

/** What the form says under the engine select about the program: found (and where, which version) or not, with the vendor's install command. The command is shown, never run. */
export interface EngineNote {
  found: boolean;
  text: string;
  install: string | null;
  docs: string;
}

/** `installed` is what the server saw on its PATH at start; `check` (Pad Check, GET /api/engines) adds the path and the version when it has come. */
export function engineNote(provider: Provider, installed: readonly Provider[], check: EngineCheck | undefined): EngineNote {
  const { label, bin, install, docs } = providerInfo(provider);
  const found = installed.includes(provider) || (check?.path ?? null) !== null;
  const where = check?.path != null ? ` at ${check.path}` : '';
  const version = check?.version != null ? `, ${check.version}` : '';
  return { found, text: found ? `${label} found${where}${version}.` : `${bin} is not on the PATH of the machine gonogo runs on.`, install: found ? null : install, docs };
}

export interface EngineOption {
  provider: Provider;
  text: string;
}

/** The engines of the hire form (every provider but the custom command): installed ones first, each saying what is not known about it. */
export function engineOptions(installed: readonly Provider[]): EngineOption[] {
  const engines = PROVIDERS.filter((p) => p !== 'custom');
  const sorted = [...engines.filter((p) => installed.includes(p)), ...engines.filter((p) => !installed.includes(p))];
  return sorted.map((provider) => {
    const info = providerInfo(provider);
    const notes = [installed.includes(provider) ? '' : 'not installed', info.check === 'docs' ? 'unverified' : '', info.mcp ? '' : 'no mail'];
    return { provider, text: [info.label, ...notes.filter((n) => n !== '')].join(' · ') };
  });
}

const CHECK_WORDS = { run: '', local: 'Checked against the installed program, not run with a model.', docs: 'Written from its docs, not tried here.' } as const;

/** The hint under the engine select: where its state comes from, whether it gets mail, how far it was checked. */
export function engineHint(provider: Provider): string {
  const info = providerInfo(provider);
  const state = info.hooks ? 'Its hooks report working, idle and needs you.' : 'Lit while it prints; no Max Q slot.';
  const mail = info.mcp ? 'Gets mail through the gonogo tools.' : 'No mail and no votes.';
  return [state, mail, CHECK_WORDS[info.check]].filter((t) => t !== '').join(' ');
}

/** What the staffing screen was opened for: a seat, a custom command, or an agent to edit. */
export type FormTarget = { mode: 'hire'; position?: string | null; custom?: boolean } | { mode: 'edit'; name: string };

/** The values the form starts with: the agent being edited, else the seat or the custom command it was opened for. */
export function initialValues(
  target: FormTarget,
  current: AgentView | null,
  agents: Readonly<Record<string, AgentView>>,
  cwd: string,
): Values {
  const base: Values = {
    provider: current?.provider ?? 'claude',
    position: current?.position ?? '',
    command: current?.command ?? '',
    servers: current?.payload?.mcpServers === undefined ? '' : JSON.stringify(current.payload.mcpServers, null, 2),
    skills: (current?.payload?.skills ?? []).join('\n'),
    offServers: current?.payloadOff?.mcpServers ?? [],
    offSkills: current?.payloadOff?.skills ?? [],
    cleanRoom: Boolean(current?.cleanRoom),
    sandbox: current?.cleanRoom?.flavor ?? '',
    egress: current?.cleanRoom?.egress === undefined ? '' : current.cleanRoom.egress ? 'on' : 'off',
    worktree: Boolean(current?.worktree),
    remoteControl: Boolean(current?.remoteControl),
    rules: rulesToText(current?.permissions),
    autostart: current?.autostart !== false,
    coauthor: current?.coauthor !== false,
    protectedAgent: current?.protected === true,
    model: current?.model ?? '',
    effort: current?.effort ?? '',
    keys: [],
    keysRemoved: [],
    name: current?.name ?? '',
    role: current?.role ?? '',
    dir: current?.dir ?? cwd,
    mode: current?.mode ?? 'default',
    confirm: false,
  };
  if (target.mode === 'edit') return base;
  if (target.custom === true) return chooseCustom(base, agents);
  const seat = target.position ?? '';
  return seat !== '' && seat !== BOSS_POSITION ? choosePosition(base, seat, agents, true) : base;
}

/** Whether an agent has anything set in MORE SETTINGS beyond what a new one starts with: the fold opens by itself only then (keyCount: the keys already stored for it). A seated agent whose role was rewritten counts too: its role sits in the fold. */
export const differsFromDefault = (v: Values, keyCount: number): boolean =>
  (positionById(v.position) !== null && v.role !== positionById(v.position)?.role) || v.model !== '' || v.effort !== '' || v.cleanRoom || v.worktree || v.remoteControl || !v.autostart || !v.coauthor || v.rules !== '' || v.mode !== 'default' || v.servers !== '' || v.skills !== '' || v.offServers.length > 0 || v.offSkills.length > 0 || keyCount > 0;

/** The short form of a position's summary for a tile: the words before the first colon or comma. */
export const positionShort = (summary: string): string => summary.split(/[:,]/)[0]?.trim() ?? summary;

/** The tag under a position tile. */
export function positionTag(position: Position, picked: boolean, seated: boolean): string {
  if (position.id === BOSS_POSITION) return 'THE BOSS HOLDS IT';
  if (picked) return 'PICKED';
  return seated ? 'STAFFED · ADD ANOTHER' : 'OPEN';
}

/** Who the big button names: the call sign of the picked position, else the typed name in capitals. */
export function callOf(values: Values): string {
  return positionById(values.position)?.callSign ?? (values.name.trim().toUpperCase() || 'A CONSOLE');
}

/** Bypass needs the owner's tick when it is being chosen, not when an agent that already bypasses is edited. */
export const needsBypassConfirm = (values: Values, original: AgentView | null): boolean =>
  providerInfo(values.provider).modes && values.mode === 'bypassPermissions' && (original?.mode !== 'bypassPermissions' || original.provider !== values.provider);

const FIX_WORDS: ReadonlyArray<readonly [Field, string]> = [
  ['name', 'NAME'],
  ['command', 'COMMAND'],
  ['role', 'ROLE'],
  ['dir', 'DIRECTORY'],
  ['position', 'POSITION'],
  ['mode', 'PERMISSIONS'],
  ['payload.mcpServers', 'PAYLOAD'],
  ['payload.skills', 'PAYLOAD'],
  ['model', 'MODEL'],
  ['effort', 'EFFORT'],
  ['keys', 'KEYS'],
];

/** What the big button says: the action, or, while the form is invalid, the first thing to fix. */
export function submitLabel(problems: Problems, call: string, unguarded: boolean): string {
  const fix = FIX_WORDS.find(([field]) => problems[field] !== undefined);
  if (fix !== undefined) return `FIX THE ${fix[1]} TO STAFF ${call}`;
  if (problems.confirmBypass !== undefined) return `TICK THE BOX TO STAFF ${call}`;
  return unguarded ? `STAFF ${call} UNGUARDED` : `STAFF ${call}`;
}

/** Mirrors parseAgentCmd in src/server/launcher.ts: a command starting with '[' is a JSON array of strings, else words. */
function isStringArray(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) && parsed.length > 0 && parsed.every((item) => typeof item === 'string' && item !== '');
  } catch {
    return false;
  }
}

/** The servers text as an object: null when empty, undefined when it is not a JSON object. The server judges what is in it. */
function readServers(text: string): Record<string, McpServer> | null | undefined {
  if (text.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, McpServer>) : undefined;
  } catch {
    return undefined;
  }
}

const readSkills = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

/** The payload the form describes: only what the engine takes, and null when nothing is left. */
export function payloadOf(values: Values): Payload | null {
  const kind = providerInfo(values.provider).payload;
  if (kind === null) return null;
  const payload: Payload = {};
  const servers = readServers(values.servers);
  if (servers && Object.keys(servers).length > 0) payload.mcpServers = servers;
  const skills = kind === 'all' ? readSkills(values.skills) : [];
  if (skills.length > 0) payload.skills = skills;
  return Object.keys(payload).length === 0 ? null : payload;
}

/** The room defaults the form switches off: only what the engine takes, and null when none is. */
export function payloadOffOf(values: Values): PayloadOff | null {
  const kind = providerInfo(values.provider).payload;
  if (kind === null) return null;
  const off: PayloadOff = {};
  if (values.offServers.length > 0) off.mcpServers = values.offServers;
  if (kind === 'all' && values.offSkills.length > 0) off.skills = values.offSkills;
  return Object.keys(off).length === 0 ? null : off;
}

/** One line of the Payload fold: an item, where it comes from (the room's defaults or this agent's own), and whether it is in effect. */
export interface PayloadRow {
  kind: 'server' | 'skill';
  name: string;
  from: 'global' | 'room' | 'agent';
  on: boolean;
  /** Only a room item that this agent does not replace can be switched off. */
  canSwitch: boolean;
  note: string;
}

/**
 * What the agent starts with, item by item, and where each item comes from (docs/payload-spec.md): the room's defaults, each on, switched off or replaced by an
 * item of the agent's own of the same name, then the agent's own. The agent wins. A Clean Room agent, and an engine with no payload, get none of the room's.
 */
export function payloadRows(defaults: PayloadDefaults | null, values: Values, global: GlobalMcpView | null = null): PayloadRow[] {
  const kind = providerInfo(values.provider).payload;
  if (kind === null) return [];
  const ownServers = Object.keys(readServers(values.servers) ?? {});
  const ownSkills = kind === 'all' ? readSkills(values.skills).map((path) => path.replace(/\/+$/, '').split('/').pop() ?? path) : [];
  const room = takesCleanRoom(values.provider) && values.cleanRoom ? null : defaults;
  const rows: PayloadRow[] = [];
  const roomRow = (item: 'server' | 'skill', name: string, mine: string[], off: string[]): PayloadRow => {
    const replaced = mine.includes(name);
    const switched = off.includes(name);
    return { kind: item, name, from: 'room', on: !replaced && !switched, canSwitch: !replaced, note: replaced ? "replaced by this agent's own" : switched ? 'switched off for this agent' : '' };
  };
  // the user-scope servers of Claude Code, when the room includes them for this kind of agent: first, and replaced by a room default or this agent's own of the same name (every engine that takes servers)
  const globalOn = providerInfo(values.provider).payload !== null && global !== null && (values.cleanRoom ? global.cleanRoom : global.host);
  if (globalOn) {
    for (const s of global.servers) {
      const replacedByRoom = (room?.mcpServers ?? []).some((x) => x.name === s.name);
      const replaced = ownServers.includes(s.name) || replacedByRoom;
      const switched = values.offServers.includes(s.name);
      rows.push({ kind: 'server', name: s.name, from: 'global', on: !replaced && !switched, canSwitch: !replaced, note: ownServers.includes(s.name) ? "replaced by this agent's own" : replacedByRoom ? 'replaced by a room default' : switched ? 'switched off for this agent' : '' });
    }
  }
  for (const s of room?.mcpServers ?? []) rows.push(roomRow('server', s.name, ownServers, values.offServers));
  if (kind === 'all') for (const s of room?.skills ?? []) rows.push(roomRow('skill', s.name, ownSkills, values.offSkills));
  // a name switched off that the room no longer has: shown so that it can be switched back, which drops it
  const gone = (item: 'server' | 'skill', off: string[], there: string[]): void => {
    for (const name of off) if (!there.includes(name)) rows.push({ kind: item, name, from: 'room', on: false, canSwitch: true, note: "switched off, but the room's defaults no longer have it" });
  };
  gone('server', values.offServers, (room?.mcpServers ?? []).map((x) => x.name));
  if (kind === 'all') gone('skill', values.offSkills, (room?.skills ?? []).map((x) => x.name));
  for (const name of ownServers) rows.push({ kind: 'server', name, from: 'agent', on: true, canSwitch: false, note: '' });
  for (const name of ownSkills) rows.push({ kind: 'skill', name, from: 'agent', on: true, canSwitch: false, note: '' });
  return rows;
}

/** The Clean Room the form describes: only for Claude Code, and a setting made through the API (an image) stays when the box stays ticked; the flavor is the form's (empty: the room's default). */
export function cleanRoomOf(values: Values, original: AgentView | null): CleanRoom | null {
  if (!takesCleanRoom(values.provider) || !values.cleanRoom) return null;
  const { flavor: _flavor, egress: _egress, ...kept } = original?.cleanRoom ?? {};
  // what the page does not edit (an image set through the API) stays; the sandbox and the key's place are the form's own
  return { ...kept, ...(values.sandbox === '' ? {} : { flavor: values.sandbox }), ...(values.egress === '' ? {} : { egress: values.egress === 'on' }) };
}

/** The Remote Control the form describes: Claude Code only, and a Clean Room has no claude.ai login. */
export function remoteControlOf(values: Values): RemoteControl | null {
  return values.provider === 'claude' && values.remoteControl && !values.cleanRoom ? {} : null;
}

/** The worktree the form describes: a Clean Room has its own, so the box is off then. */
export function worktreeOf(values: Values): Worktree | null {
  return values.worktree && !(takesCleanRoom(values.provider) && values.cleanRoom) ? {} : null;
}

const MODEL_RE = new RegExp(MODEL_PATTERN);
const KEY_NAME_RE = new RegExp(KEY_NAME_PATTERN);
const KEY_VALUE_RE = new RegExp(KEY_VALUE_PATTERN);

/** The rows that were filled in, trimmed (a row with neither a name nor a value is an empty line and counts for nothing). */
const typedKeys = (values: Values): KeyRow[] =>
  values.keys.map((row) => ({ name: row.name.trim(), value: row.value.trim() })).filter((row) => row.name !== '' || row.value !== '');

/** The effort: only for an engine that takes one, a level of EFFORTS or null. */
export const effortOf = (values: Values): Effort | null => (takesEffort(values.provider) && (EFFORTS as readonly string[]).includes(values.effort) ? (values.effort as Effort) : null);

/** The Engine Bay model: only for an engine that takes one, trimmed, '' for none. */
export const modelOf = (values: Values): string => (providerInfo(values.provider).model === null ? '' : values.model.trim());

/**
 * What is wrong with the keys, or null. Names and values are looked at here and never quoted back: the text of a problem is
 * about the row, so a secret typed in the wrong box does not come up in an error. `stored` is the names already set.
 */
export function keysProblem(values: Values, stored: readonly string[]): string | null {
  const rows = typedKeys(values);
  const names = new Set<string>();
  for (const [i, row] of rows.entries()) {
    const { name } = row;
    if (!KEY_NAME_RE.test(name)) return `Key ${i + 1}: use a name of capital letters, digits and _, starting with a letter, such as OPENAI_API_KEY.`;
    if (!KEY_VALUE_RE.test(row.value)) return `Key ${i + 1}: the value must be 1 to 4096 printable characters without a space.`;
    if (names.has(name)) return `Key ${i + 1}: the name is used twice.`;
    names.add(name);
  }
  const kept = stored.filter((name) => !values.keysRemoved.includes(name) && !names.has(name));
  return kept.length + names.size > KEYS_MAX ? `At most ${KEYS_MAX} keys.` : null;
}

/** The keys of a request: name to value for a typed row, name to null for a set key marked for removal; undefined when nothing is asked. */
function keysOf(values: Values, stored: readonly string[]): Record<string, string | null> | undefined {
  const patch: Record<string, string | null> = {};
  for (const name of values.keysRemoved) if (stored.includes(name)) patch[name] = null;
  for (const row of typedKeys(values)) patch[row.name] = row.value;
  return Object.keys(patch).length === 0 ? undefined : patch;
}

/** The rules of contract 8.6. `original` is the agent being edited, `nameLocked` is true while it runs. */
export function validate(
  values: Values,
  agents: Record<string, AgentView>,
  original: AgentView | null,
  nameLocked: boolean,
): Problems {
  const problems: Problems = {};
  if (takesPermissions(values.provider)) {
    const problem = parseRulesText(values.rules).problem;
    if (problem !== null) problems.permissions = problem;
  }
  if (!nameLocked) {
    if (values.name === '') problems.name = 'A name is required.';
    else if (!NAME_PATTERN.test(values.name)) {
      problems.name = 'Use lowercase letters, digits and hyphens, starting with a letter or digit (at most 32 characters).';
    } else if ((RESERVED_NAMES as readonly string[]).includes(values.name)) problems.name = `"${values.name}" is reserved.`;
    else if (values.name !== original?.name && Object.hasOwn(agents, values.name)) {
      problems.name = `An agent called "${values.name}" already exists.`;
    }
  }
  const role = values.role.trim();
  if (role === '') problems.role = 'A role is required.';
  else if (role.length > ROLE_MAX_CHARS) problems.role = `At most ${ROLE_MAX_CHARS} characters.`;
  const dir = values.dir.trim();
  if (dir === '') problems.dir = 'A working directory is required.';
  else if (dir.length > DIR_MAX_CHARS) problems.dir = `At most ${DIR_MAX_CHARS} characters.`;
  else if (!dir.startsWith('/')) problems.dir = 'Use an absolute path: it starts with /.';
  if (values.provider === 'custom') {
    const command = values.command.trim();
    if (command === '') problems.command = 'A command is required.';
    else if (command.length > COMMAND_MAX_CHARS) problems.command = `At most ${COMMAND_MAX_CHARS} characters.`;
    else if (command.includes('\0')) problems.command = 'The command cannot contain a NUL character.';
    else if (command.startsWith('[') && !isStringArray(command)) problems.command = 'Not a valid JSON array of strings.';
  } else if (needsBypassConfirm(values, original) && !values.confirm) problems.confirmBypass = 'Tick the box to confirm.';
  const kind = providerInfo(values.provider).payload;
  if (kind !== null && readServers(values.servers) === undefined) problems['payload.mcpServers'] = 'Not a JSON object of servers.';
  if (kind === 'all' && readSkills(values.skills).some((path) => !path.startsWith('/'))) problems['payload.skills'] = 'Use absolute paths: each starts with /.';
  const model = modelOf(values);
  if (model !== '' && !MODEL_RE.test(model)) problems.model = 'Use letters, digits and . _ : / @ + -, starting with a letter or digit (at most 100 characters).';
  else if (model !== '') {
    const problem = modelFormProblem(values.provider, model);
    if (problem !== null) problems.model = `${problem[0]?.toUpperCase() ?? ''}${problem.slice(1)}.`;
  }
  const keys = keysProblem(values, Object.keys(original?.keys ?? {}));
  if (keys !== null) problems.keys = keys;
  return problems;
}

/** The body of POST /api/agents. A custom agent has no permission mode (the server stores `default`) and no position. */
export function hireRequest(values: Values): HireRequest {
  const base = { name: values.name, role: values.role.trim(), dir: values.dir.trim() };
  const keys = keysOf(values, []) as Record<string, string> | undefined;
  if (values.provider === 'custom') {
    return { ...base, mode: 'default', provider: 'custom', command: values.command.trim(), ...(keys && { keys }) };
  }
  const modes = providerInfo(values.provider).modes;
  const request: HireRequest = { ...base, mode: modes ? values.mode : 'default', provider: values.provider };
  if (modelOf(values) !== '') request.model = modelOf(values);
  const effort = effortOf(values);
  if (effort !== null) request.effort = effort;
  if (keys) request.keys = keys;
  if (modes && values.mode === 'bypassPermissions' && values.confirm) request.confirmBypass = true;
  if (values.position !== '') request.position = values.position;
  const payload = payloadOf(values);
  if (payload !== null) request.payload = payload;
  const payloadOff = payloadOffOf(values);
  if (payloadOff !== null) request.payloadOff = payloadOff;
  const cleanRoom = cleanRoomOf(values, null);
  if (cleanRoom !== null) request.cleanRoom = cleanRoom;
  if (worktreeOf(values) !== null) request.worktree = {};
  if (remoteControlOf(values) !== null) request.remoteControl = {};
  const rules = takesPermissions(values.provider) ? rulesOf(values.rules) : null;
  if (rules !== null) request.permissions = rules;
  if (!values.autostart) request.autostart = false;
  if (!values.coauthor) request.coauthor = false;
  return request;
}

/**
 * The body of PATCH /api/agents/:name with only what changed (the server answers 400 to an edit with nothing in it), or null
 * when nothing changed. A new engine (never to or from custom) is sent as `provider`; what it does not take is not sent, and the server drops it.
 */
export function editRequest(values: Values, original: AgentView, nameLocked: boolean): EditRequest | null {
  const changes: EditRequest = {};
  const role = values.role.trim();
  const dir = values.dir.trim();
  if (!nameLocked && values.name !== original.name) changes.name = values.name;
  if (role !== original.role) changes.role = role;
  if (dir !== original.dir) changes.dir = dir;
  if (original.provider === 'custom') {
    const command = values.command.trim();
    if (command !== (original.command ?? '')) changes.command = command;
  } else {
    if (values.provider !== original.provider && values.provider !== 'custom') changes.provider = values.provider;
    if (providerInfo(values.provider).modes && values.mode !== original.mode) changes.mode = values.mode;
    if (values.position !== (original.position ?? '')) changes.position = values.position === '' ? null : values.position;
    const payload = payloadOf(values);
    if (JSON.stringify(payload) !== JSON.stringify(original.payload ?? null)) changes.payload = payload;
    const payloadOff = payloadOffOf(values);
    if (JSON.stringify(payloadOff) !== JSON.stringify(original.payloadOff ?? null)) changes.payloadOff = payloadOff;
    const cleanRoom = cleanRoomOf(values, original);
    if (JSON.stringify(cleanRoom) !== JSON.stringify(original.cleanRoom ?? null)) changes.cleanRoom = cleanRoom;
    const model = modelOf(values);
    if (model !== (original.model ?? '')) changes.model = model === '' ? null : model;
    // the text itself, not effortOf(): a level this page does not know (a newer server) is kept as it is, never cleared by a save that did not touch it
    if ((values.effort ?? '') !== (original.effort ?? '')) changes.effort = effortOf(values);
  }
  if (takesPermissions(values.provider)) {
    const rules = rulesOf(values.rules);
    if (JSON.stringify(rules) !== JSON.stringify(original.permissions ?? null)) changes.permissions = rules;
  }
  if (values.autostart !== (original.autostart !== false)) changes.autostart = values.autostart;
  if (values.coauthor !== (original.coauthor !== false)) changes.coauthor = values.coauthor;
  if (!original.boss && Boolean(values.protectedAgent) !== (original.protected === true)) changes.protected = Boolean(values.protectedAgent);
  if (JSON.stringify(remoteControlOf(values)) !== JSON.stringify(original.remoteControl ?? null)) changes.remoteControl = remoteControlOf(values);
  if (JSON.stringify(worktreeOf(values)) !== JSON.stringify(original.worktree ?? null)) changes.worktree = worktreeOf(values);
  const keys = keysOf(values, Object.keys(original.keys ?? {}));
  if (keys) changes.keys = keys;
  if (Object.keys(changes).length === 0) return null;
  if (needsBypassConfirm(values, original) && values.confirm && original.provider !== 'custom') changes.confirmBypass = true;
  return changes;
}
