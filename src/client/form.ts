import { AGENT_NAME_PATTERN, DIR_MAX_CHARS, PROVIDERS, providerInfo, RESERVED_NAMES, ROLE_MAX_CHARS } from '../shared/protocol.js';
import type { AgentView, CleanRoom, EditRequest, HireRequest, McpServer, Payload, PermissionMode, Provider } from '../shared/protocol.js';
import { positionById } from '../shared/positions.js';
import type { Position } from '../shared/positions.js';

// The rules and request bodies of the hire form, kept out of HireForm.tsx so that they can be tested without a DOM.

/** The server's COMMAND_MAX_CHARS (src/server/constants.ts, which the client build does not include). */
export const COMMAND_MAX_CHARS = 1000;

export type Field = 'name' | 'role' | 'dir' | 'mode' | 'confirmBypass' | 'position' | 'command' | 'cleanRoom' | 'payload.mcpServers' | 'payload.skills';
export type Problems = Partial<Record<Field, string>>;

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
  /** Clean Room: run the agent in a container on its own worktree. Claude Code only. */
  cleanRoom: boolean;
}

export const FIELDS: readonly string[] = ['name', 'role', 'dir', 'mode', 'confirmBypass', 'position', 'command', 'cleanRoom', 'payload.mcpServers', 'payload.skills'];

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
  return { ...values, provider: 'custom', position: '', role: CUSTOM_ROLE, cleanRoom: false, name: untouched(values, agents).name ? '' : values.name };
}

/** Engine Bay: another agent CLI keeps the position and role; one without permission modes runs in 'default'. */
export function chooseEngine(values: Values, provider: Provider): Values {
  return { ...values, provider, mode: providerInfo(provider).modes ? values.mode : 'default', confirm: false, cleanRoom: provider === 'claude' && values.cleanRoom };
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
    cleanRoom: Boolean(current?.cleanRoom),
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
  providerInfo(values.provider).modes && values.mode === 'bypassPermissions' && original?.mode !== 'bypassPermissions';

const FIX_WORDS: ReadonlyArray<readonly [Field, string]> = [
  ['name', 'NAME'],
  ['command', 'COMMAND'],
  ['role', 'ROLE'],
  ['dir', 'DIRECTORY'],
  ['position', 'POSITION'],
  ['mode', 'PERMISSIONS'],
  ['payload.mcpServers', 'PAYLOAD'],
  ['payload.skills', 'PAYLOAD'],
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

/** The Clean Room the form describes: only for Claude Code, and a setting made through the API (an image) stays when the box stays ticked. */
export function cleanRoomOf(values: Values, original: AgentView | null): CleanRoom | null {
  if (values.provider !== 'claude' || !values.cleanRoom) return null;
  return original?.cleanRoom ?? {};
}

/** The rules of contract 8.6. `original` is the agent being edited, `nameLocked` is true while it runs. */
export function validate(
  values: Values,
  agents: Record<string, AgentView>,
  original: AgentView | null,
  nameLocked: boolean,
): Problems {
  const problems: Problems = {};
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
  return problems;
}

/** The body of POST /api/agents. A custom agent has no permission mode (the server stores `default`) and no position. */
export function hireRequest(values: Values): HireRequest {
  const base = { name: values.name, role: values.role.trim(), dir: values.dir.trim() };
  if (values.provider === 'custom') {
    return { ...base, mode: 'default', provider: 'custom', command: values.command.trim() };
  }
  const modes = providerInfo(values.provider).modes;
  const request: HireRequest = { ...base, mode: modes ? values.mode : 'default', provider: values.provider };
  if (modes && values.mode === 'bypassPermissions' && values.confirm) request.confirmBypass = true;
  if (values.position !== '') request.position = values.position;
  const payload = payloadOf(values);
  if (payload !== null) request.payload = payload;
  const cleanRoom = cleanRoomOf(values, null);
  if (cleanRoom !== null) request.cleanRoom = cleanRoom;
  return request;
}

/**
 * The body of PATCH /api/agents/:name with only what changed (the server answers 400 to an edit with nothing in it), or null
 * when nothing changed. The provider cannot change, so `values.provider` is the original's.
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
    if (providerInfo(original.provider).modes && values.mode !== original.mode) changes.mode = values.mode;
    if (values.position !== (original.position ?? '')) changes.position = values.position === '' ? null : values.position;
    const payload = payloadOf(values);
    if (JSON.stringify(payload) !== JSON.stringify(original.payload ?? null)) changes.payload = payload;
    const cleanRoom = cleanRoomOf(values, original);
    if (JSON.stringify(cleanRoom) !== JSON.stringify(original.cleanRoom ?? null)) changes.cleanRoom = cleanRoom;
  }
  if (Object.keys(changes).length === 0) return null;
  if (needsBypassConfirm(values, original) && values.confirm && original.provider !== 'custom') changes.confirmBypass = true;
  return changes;
}
