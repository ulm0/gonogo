/**
 * Relief: a boss that asks for more hands (docs/relief-spec.md).
 *
 * The boss calls `hire_agent`; that only makes a request. The request waits in memory, shown to the Director with every
 * parameter, and only his GO makes the hub staff the agent, through `Hub.hire`, the call of the hire form. Everything the
 * boss can ask is capped here, on the server: no mode above acceptEdits, no custom command, no payload, at most
 * RELIEF_PENDING_MAX requests waiting and RELIEF_RATE_MAX in RELIEF_RATE_WINDOW_MS, a request expires after RELIEF_TTL_MS,
 * a name is a valid free name, the folder passes the check of the form, a Clean Room boss hires Clean Room agents inside
 * its own folder only. `hub.hire` checks everything again (name, room cap of MAX_AGENTS, folder, Docker) when the GO comes.
 *
 * shortcut: requests are not saved, so a restart drops them and the boss is not told; the Downlink event of the request stays.
 * shortcut: a Clean Room boss's folder is checked with realpath when asked and again at the GO, not held open between the two.
 */
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { positionById, POSITION_IDS } from '../shared/positions.js';
import { AGENT_NAME_PATTERN, CLEAN_ROOM_FLAVORS, DIR_MAX_CHARS, MAX_AGENTS, PERMISSION_MODES, PROVIDERS, RELIEF_MODES, RESERVED_NAMES, ROLE_MAX_CHARS } from '../shared/protocol.js';
import type { AgentView, CleanRoom, CleanRoomFlavor, DownlinkNotify, DownlinkRef, Hub, HireRequest, Logger, PermissionMode, Provider, ReliefRequest, ReliefView, ReliefFrame } from '../shared/protocol.js';
import { providerInfo, takesCleanRoom } from '../shared/protocol.js';
import type { ReliefRules } from '../shared/protocol.js';
import { RELIEF_PENDING_MAX, RELIEF_RATE_MAX, RELIEF_RATE_WINDOW_MS, RELIEF_TTL_MS } from './constants.js';
import { isRecord } from './hooks.js';
import { HubError } from './hub.js';
import { hireStepUpReason } from './stepup.js';
import { modeRank } from './reliefrules.js';

const NAME_RE = new RegExp(AGENT_NAME_PATTERN);
const ID_RE = /^h[1-9]\d{0,9}$/;
const FIELDS = new Set(['name', 'position', 'role', 'dir', 'engine', 'mode', 'worktree']);
/**
 * What a person cannot see in the block but the new agent reads: control codes (a newline, a return and a tab are fine), format
 * characters (zero width, direction overrides, the Unicode tag block that hides a whole sentence), line and paragraph
 * separators, private-use and unassigned code points, and the variation selectors of the supplement.
 */
const HIDDEN_RE = /[^\P{Cc}\n\r\t]|[\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\u{E0100}-\u{E01EF}]/u;
const MINUTES = (ms: number): number => Math.round(ms / 60_000);

export type ReliefVerdict = 'go' | 'no-go';
/** Who decides. Only the Director can: an agent that asks is refused when it tries to answer. */
export type ReliefActor = { kind: 'user' } | { kind: 'agent'; name: string };

export interface ReliefOptions {
  /** The parts of the hub it uses: the room, the hire of the form, and the message that tells the boss. */
  hub: Pick<Hub, 'views' | 'hire' | 'sendFromUser'> & Partial<Pick<Hub, 'stop'>>;
  /** The room's rules (`relief.json`). Absent: no rule hires, every request waits for the Director, as before. */
  rules?: { view(): ReliefRules; check(): Promise<void>; set?(body: unknown): Promise<ReliefRules>; off?(): Promise<ReliefRules> };
  /** Why a hire in `auto` (or bypass) must not run by rule in a Clean Room now (egress off, the global MCP servers on), or null. */
  cleanRoomUnsafe?(): string | null;
  /** `HubIo.checkDirectory`: the check of the hire form (absolute, exists, a directory). */
  checkDirectory(path: string): Promise<{ ok: true; path: string } | { ok: false; error: string }>;
  /** `HubIo.checkWorktree`: null when `dir` is in a git repository a worktree can be made of, else why not. Without it the hire's own check is the only one. */
  checkWorktree?(dir: string): Promise<string | null>;
  /** The room's default engine, for a request that names none. Default claude. */
  defaultEngine?(): Provider;
  /** The room's default sandbox flavor of the Clean Room (absent: docker). */
  defaultSandbox?(): CleanRoomFlavor | undefined;
  /** The room's default permission mode, for a request that names none. Never bypassPermissions here: the Director reads the mode in the request, but nobody confirmed bypass. */
  defaultMode?(): PermissionMode | undefined;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  emit(frame: ReliefFrame): void;
  notify?: DownlinkNotify;
  log: Logger;
}

export interface ReliefAsked {
  id: string;
  /** `hired`: inside the rules, staffed at once. `pending`: waits for the Director (the note names the rule that sent it there). */
  status: 'pending' | 'hired';
  note: string;
  name?: string;
}

export interface Relief {
  /** The boss asks. `by` comes from its token. Throws a HubError that says what to change. */
  request(by: { agent: string; generation: number }, input: unknown): Promise<ReliefAsked>;
  view(): ReliefView;
  /** The Director's change of the rules (the route asked for the step-up before). Throws a bad_request that names the field. */
  setRules(body: unknown): Promise<ReliefView>;
  /** STOP CREW: every boss-hired agent is stopped (the Director's own stop: the boss cannot start it again) and autoApprove goes off. It only removes power, so it needs no step-up. */
  stopCrew(): Promise<{ stopped: string[]; view: ReliefView }>;
  /** The Director's GO (the agent is hired, as the form does it) or NO-GO. Throws the HubError of the hire when it fails. */
  decide(id: string, verdict: ReliefVerdict, by: ReliefActor): Promise<ReliefView>;
  close(): void;
}

const bad = (message: string, field?: string): HubError => new HubError('bad_request', message, field);

/** `dir` is `root` or inside it, after symbolic links are followed on both. */
export async function insideRealpath(root: string, dir: string): Promise<boolean> {
  try {
    const [r, d] = await Promise.all([realpath(root), realpath(dir)]);
    const rel = relative(r, d);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  } catch {
    return false;
  }
}

export function createRelief(options: ReliefOptions): Relief {
  const { hub, now, log } = options;
  const pending = new Map<string, { request: ReliefRequest; timer: unknown }>();
  /** When each request of the window was made, oldest first. */
  let made: number[] = [];
  let seq = 0;
  /** Names of rule hires being staffed now: they count as crew before the hub has them, so two parallel hires cannot both pass the cap. */
  const staffing = new Set<string>();

  const view = (): ReliefView => ({ ...(options.rules === undefined ? {} : { rules: options.rules.view(), crew: hub.views().filter((a) => a.hiredBy === 'boss').map((a) => a.name) }), requests: [...pending.values()].map(({ request }) => ({ ...request, cleanRoom: request.cleanRoom === null ? null : { ...request.cleanRoom }, ...(request.worktree === undefined || request.worktree === null ? {} : { worktree: { ...request.worktree } }) })) });
  const changed = (): void => options.emit({ t: 'relief', relief: view() });
  const notify = (text: string, ref?: DownlinkRef): void => options.notify?.('relief', text, ref);

  /** The boss hears the answer as a message from the Director's side, as it hears a T-minus result. */
  const tell = (boss: string, subject: string, body: string): void => {
    try {
      hub.sendFromUser({ to: boss, subject, body });
    } catch (error) {
      log.debug(`could not tell ${boss} about a hire request`, error);
    }
  };

  const drop = (id: string): ReliefRequest | null => {
    const found = pending.get(id);
    if (!found) return null;
    pending.delete(id);
    options.clearTimer(found.timer);
    return found.request;
  };

  /** Expires every request whose time is up; run before each request and each answer, and by the timers. */
  const sweep = (): void => {
    for (const [id, { request }] of [...pending]) {
      if (request.expiresAt > now()) continue;
      drop(id);
      notify(`request to hire ${request.name} expired unanswered`);
      tell(request.by, `Relief: request for ${request.name} expired`, `The Director did not answer within ${MINUTES(RELIEF_TTL_MS)} minutes, so the request to hire ${request.name} is gone. Ask again only if it is still needed.`);
      changed();
    }
  };

  /** The limits that do not need the disk. Run before the folder is checked and again right before the request is stored (two calls may overlap). */
  const limits = (name: string): void => {
    sweep();
    const cutoff = now() - RELIEF_RATE_WINDOW_MS;
    made = made.filter((at) => at > cutoff);
    if (made.length >= RELIEF_RATE_MAX) {
      throw new HubError('rate_limited', `at most ${RELIEF_RATE_MAX} hire requests in ${MINUTES(RELIEF_RATE_WINDOW_MS)} minutes: wait, or tell the Director what you need`);
    }
    if (pending.size >= RELIEF_PENDING_MAX) {
      throw new HubError('conflict', `${RELIEF_PENDING_MAX} hire requests already wait for the Director: wait for his answer`);
    }
    if (hub.views().some((agent) => agent.name === name) || [...pending.values()].some(({ request }) => request.name === name)) {
      throw new HubError('conflict', `an agent or a request named "${name}" exists already: choose another name`, 'name');
    }
    if (hub.views().length >= MAX_AGENTS) throw new HubError('conflict', `the operations room is full (${MAX_AGENTS} agents)`);
  };

  /** The request as the hire form would send it. No confirmBypass, no command, no payload: the tool cannot ask for them. */
  const hireOf = (r: ReliefRequest): HireRequest => {
    const hire: HireRequest = { name: r.name, role: r.role, dir: r.dir, mode: r.mode, provider: r.provider };
    if (r.position !== null) hire.position = r.position;
    if (r.cleanRoom !== null) hire.cleanRoom = r.cleanRoom;
    if (r.worktree !== undefined && r.worktree !== null) hire.worktree = { ...r.worktree };
    return hire;
  };

  /** Is the boss that asked still the boss, and is `dir` in its box when it is a Clean Room agent? */
  const confine = async (requester: AgentView, dir: string): Promise<void> => {
    if (requester.cleanRoom !== null && !(await insideRealpath(requester.dir, dir))) {
      throw new HubError('forbidden', 'a Clean Room agent can hire only inside its own project folder: leave dir out to use it', 'dir');
    }
  };

  const HOUR_MS = 3_600_000;
  /**
   * Which rule sends this request to the Director, or null when it fits every rule (docs/hire-fire-spec.md). Synchronous on purpose: the caller reserves the crew slot
   * right after it, with no await between, so parallel hires cannot both pass the cap. Reads the rules from the store, never from the request.
   */
  const ruleAsks = (rules: ReliefRules, requester: AgentView, r: { name: string; position: string | null; free: boolean; dir: string; provider: Provider; mode: PermissionMode; cleanRoom: CleanRoom | null; worktree: boolean; insideBoss: boolean }): string | null => {
    const crew = hub.views().filter((a) => a.hiredBy === 'boss');
    if (crew.length + staffing.size >= rules.maxCrew) return `maxCrew is ${rules.maxCrew}`;
    const since = now() - HOUR_MS;
    if (crew.filter((a) => (a.hiredAt ?? 0) > since).length + [...staffing].length >= rules.ratePerHour) return `ratePerHour is ${rules.ratePerHour}`;
    if (r.free || r.position === null) return 'a role written by the boss is never approved by a rule';
    if (!rules.positions.includes(r.position)) return `the position ${r.position} is not in the rules`;
    const engines = rules.engines.length > 0 ? rules.engines : [options.defaultEngine?.() ?? 'claude'];
    if (!engines.includes(r.provider)) return `the engine ${r.provider} is not in the rules`;
    if (!r.insideBoss) return "the folder is not the boss's own or inside it";
    if (modeRank(r.mode) > modeRank(rules.maxMode)) return `mode ${r.mode} is above maxMode (${rules.maxMode})`;
    if (r.mode === 'auto') {
      if (r.cleanRoom === null && !rules.autoOnHost) return 'mode auto on the host needs autoOnHost';
      const unsafe = r.cleanRoom === null ? null : (options.cleanRoomUnsafe?.() ?? null);
      if (unsafe !== null) return `mode auto needs a safe Clean Room: ${unsafe}`;
    }
    // the one judge of the hire form's step-up: whatever it names is the Director's, whatever the request carries (a request has no keys, payload, command or remote control; the function is asked anyway)
    const body: Record<string, unknown> = { name: r.name, dir: r.dir, mode: r.mode, provider: r.provider, ...(r.cleanRoom === null ? {} : { cleanRoom: r.cleanRoom }), ...(r.worktree ? { worktree: {} } : {}) };
    const judged = hireStepUpReason(body, { roomSandbox: options.defaultSandbox?.() }, true);
    if (judged !== null) return `${judged} needs your GO`;
    void requester;
    return null;
  };

  return {
    async request(by, input) {
      // identity first: the token names the agent, the generation says it is this run of it
      const requester = hub.views().find((agent) => agent.name === by.agent);
      if (!requester) throw new HubError('not_found', 'unknown agent');
      if (requester.generation !== by.generation || requester.transition !== null) throw new HubError('conflict', 'this session has ended');
      if (!requester.boss) throw new HubError('forbidden', 'only the boss can ask for a hire');

      if (!isRecord(input)) throw bad('the request must be an object');
      for (const key of Object.keys(input)) if (!FIELDS.has(key)) throw bad(`unknown field "${key}": a request has name, position, role, dir, engine and mode`, key);

      const { name } = input;
      if (typeof name !== 'string' || !NAME_RE.test(name)) throw bad('name must be 1 to 32 lowercase letters, digits or hyphens, and start with a letter or digit', 'name');
      if ((RESERVED_NAMES as readonly string[]).includes(name)) throw bad(`"${name}" is a reserved name`, 'name');

      const engine = input.engine === undefined ? (options.defaultEngine?.() ?? 'claude') : input.engine;
      if (typeof engine !== 'string' || !(PROVIDERS as readonly string[]).includes(engine)) throw bad(`engine must be one of ${PROVIDERS.filter((p) => p !== 'custom').join(', ')}`, 'engine');
      if (engine === 'custom') throw bad('a custom command cannot be asked for: only the Director can hire one', 'engine');
      const provider = engine as Provider;

      const room = options.defaultMode?.();
      const asked = input.mode === undefined ? (room === undefined || room === 'bypassPermissions' ? 'default' : room) : input.mode;
      if (typeof asked !== 'string' || !(PERMISSION_MODES as readonly string[]).includes(asked)) throw bad(`mode must be one of ${RELIEF_MODES.join(', ')}`, 'mode');
      // the room's own default is the Director's choice; only what the agent asks is held to the most an agent can ask for
      if (input.mode !== undefined && !(RELIEF_MODES as readonly string[]).includes(asked)) throw bad(`a request can ask for ${RELIEF_MODES.join(' or ')} at most, not ${asked}: only the Director can give more`, 'mode');
      // an engine without permission modes is started in default whatever is asked, and the Director is shown what will happen
      const mode: PermissionMode = providerInfo(provider).modes ? (asked as PermissionMode) : 'default';
      // the Director is told when the mode is the room's default and not something the boss asked for
      const modeFromRoom = input.mode === undefined && mode !== 'default' && room === mode;

      const { position, role } = input;
      if (position !== undefined && (typeof position !== 'string' || !POSITION_IDS.includes(position))) throw bad(`position must be one of ${POSITION_IDS.join(', ')}`, 'position');
      if (role !== undefined && (typeof role !== 'string' || role.trim().length === 0 || role.trim().length > ROLE_MAX_CHARS)) throw bad(`role must be 1 to ${ROLE_MAX_CHARS} characters`, 'role');
      // the Director approves the text he reads: nothing in it may be hidden from him
      if (typeof role === 'string' && HIDDEN_RE.test(role)) throw bad('role must not hold control, invisible or direction-changing characters: the Director reads all of it', 'role');
      const roleText = typeof role === 'string' ? role.trim() : typeof position === 'string' ? (positionById(position)?.role ?? '') : '';
      if (roleText === '') throw bad('give a position or a role', 'role');

      const cleanRoom = requester.cleanRoom === null ? null : { ...requester.cleanRoom };
      if (cleanRoom !== null && !takesCleanRoom(provider)) throw bad('a Clean Room agent hires Clean Room agents, and those run Claude Code, pi or opencode only', 'engine');
      const asDir = input.dir === undefined ? (cleanRoom === null ? undefined : requester.dir) : input.dir;
      if (typeof asDir !== 'string' || asDir.length === 0 || asDir.length > DIR_MAX_CHARS) throw bad(`dir must be an absolute path of 1 to ${DIR_MAX_CHARS} characters`, 'dir');

      // the form's "Own git worktree": only true or false; a Clean Room already has its own worktree, so the two do not go together
      if (input.worktree !== undefined && typeof input.worktree !== 'boolean') throw bad('worktree is true or false', 'worktree');
      const wantsWorktree = input.worktree === true;
      if (wantsWorktree && cleanRoom !== null) throw bad('a Clean Room agent has a worktree already: do not ask for another', 'worktree');

      limits(name);
      const checked = await options.checkDirectory(asDir);
      if (!checked.ok) throw bad(checked.error, 'dir');
      await confine(requester, checked.path);
      if (wantsWorktree) {
        // the same check as the form: the folder must be in a git repository (the Director should not be asked for a hire that cannot be made)
        let problem: string | null = null;
        try {
          problem = (await options.checkWorktree?.(checked.path)) ?? null;
        } catch (error) {
          log.error('worktree check failed', error);
          problem = 'the worktree could not be checked';
        }
        if (problem !== null) throw bad(problem, 'worktree');
      }
      // the checks above waited on the disk: another request may have taken the name or the last place meanwhile
      limits(name);
      // the rules: read from the store (its file is checked against the last record first), never from the request
      await options.rules?.check();
      limits(name);
      const rules = options.rules?.view();
      const insideBoss = await insideRealpath(requester.dir, checked.path);
      limits(name);
      // from here to the reservation there is no await: a hire by rule takes its crew slot at once
      const asks = rules?.autoApprove === true ? ruleAsks(rules, requester, { name, position: typeof position === 'string' ? position : null, free: typeof role === 'string', dir: checked.path, provider, mode, cleanRoom, worktree: wantsWorktree, insideBoss }) : undefined;
      if (rules?.autoApprove === true && asks === null) {
        made.push(now());
        staffing.add(name);
        const hire: HireRequest = { name, role: roleText, dir: checked.path, mode, provider, position: position as string };
        if (cleanRoom !== null) hire.cleanRoom = cleanRoom;
        if (wantsWorktree) hire.worktree = {};
        try {
          const hired = await hub.hire(hire, { hiredBy: 'boss' });
          // the line says which rule decided and the counts, never the role text
          notify(`${hired.name} hired by ${requester.name} by rule: ${typeof position === 'string' ? position.toUpperCase() : ''} ${provider}, ${mode}, crew ${hub.views().filter((a) => a.hiredBy === 'boss').length} of ${rules.maxCrew}`.replace('  ', ' '));
          return { id: `hired:${hired.name}`, status: 'hired', name: hired.name, note: `hired at once, inside the Director's rules (crew ${hub.views().filter((a) => a.hiredBy === 'boss').length} of ${rules.maxCrew}); brief it with send_message` };
        } finally {
          staffing.delete(name);
        }
      }

      seq += 1;
      const at = now();
      made.push(at);
      const id = `h${seq}`;
      // the wall the new Clean Room agent will have, shown on the card: the boss's own flavor or the room's default, and whether it is below the room's default
      const roomFlavor = options.defaultSandbox?.() ?? 'docker';
      const flavor = cleanRoom === null ? undefined : (cleanRoom.flavor ?? roomFlavor);
      const flavorBelowRoom = flavor !== undefined && CLEAN_ROOM_FLAVORS.indexOf(flavor) < CLEAN_ROOM_FLAVORS.indexOf(roomFlavor);
      const request: ReliefRequest = { id, by: requester.name, at, expiresAt: at + RELIEF_TTL_MS, name, position: typeof position === 'string' ? position : null, role: roleText, dir: checked.path, provider, mode, ...(modeFromRoom ? { modeFromRoom } : {}), cleanRoom, ...(flavor === undefined ? {} : { flavor }), ...(flavorBelowRoom ? { flavorBelowRoom } : {}), ...(wantsWorktree ? { worktree: {} } : {}), ...(typeof asks === 'string' ? { asks } : {}) };
      pending.set(id, { request, timer: options.setTimer(sweep, RELIEF_TTL_MS + 1) });
      changed();
      if (typeof asks === 'string') notify(`${requester.name}'s hire of ${name} is outside the rules (${asks}): it waits for your GO`);
      notify(`${requester.name} asks to hire ${name}${request.position === null ? '' : ` as ${request.position.toUpperCase()}`}: ${provider}, ${mode}${modeFromRoom ? " (the room's default)" : ''}, ${checked.path}${wantsWorktree ? ', in its own git worktree' : ''}${flavor === undefined ? '' : `, Clean Room sandbox ${flavor}${flavorBelowRoom ? " (below the room's default)" : ''}`}`, { kind: 'relief', id });
      return { id, status: 'pending', note: `${typeof asks === 'string' ? `needs the Director's GO: ${asks}; ` : ''}waiting for the Director; you get a message with his answer, and the request expires after ${MINUTES(RELIEF_TTL_MS)} minutes` };
    },

    view,

    async setRules(body) {
      if (!options.rules?.set) throw new HubError('not_found', 'the Relief rules are not available');
      const before = options.rules.view();
      const after = await options.rules.set(body);
      const moved = Object.keys(after).filter((k) => JSON.stringify(after[k as keyof ReliefRules]) !== JSON.stringify(before[k as keyof ReliefRules]));
      // the line names the rules that moved and their new values (numbers, switches, positions), never any text somebody wrote
      if (moved.length > 0) notify(`Relief rules changed: ${moved.map((k) => `${k} ${JSON.stringify(after[k as keyof ReliefRules])}`).join(', ')}`);
      changed();
      return view();
    },

    async stopCrew() {
      if (!options.rules?.off || !hub.stop) throw new HubError('not_found', 'the Relief rules are not available');
      // off first: whatever happens next, no new rule hire gets through
      await options.rules.off();
      const names = hub.views().filter((a) => a.hiredBy === 'boss').map((a) => a.name);
      const stopped: string[] = [];
      for (const name of names) {
        try {
          await hub.stop(name);
          stopped.push(name);
        } catch (error) {
          log.warn(`STOP CREW could not stop ${name}`, error);
        }
      }
      notify(`STOP CREW: ${stopped.length} of ${names.length} boss-hired agents stopped, automatic hires are off`);
      changed();
      return { stopped, view: view() };
    },

    async decide(idInput, verdict, by) {
      if (!by || by.kind !== 'user') throw new HubError('forbidden', 'only the Director answers a hire request');
      if (verdict !== 'go' && verdict !== 'no-go') throw bad('the answer is go or no-go');
      sweep();
      const id = typeof idInput === 'string' && ID_RE.test(idInput) ? idInput : '';
      // taken out of the list before anything waits, so a second answer to the same request finds nothing
      const request = drop(id);
      if (request === null) throw new HubError('not_found', 'no such hire request: it may have expired or been answered');
      changed();
      if (verdict === 'no-go') {
        notify(`hire of ${request.name} refused`);
        tell(request.by, `Relief: request for ${request.name} refused`, `The Director said no-go to hiring ${request.name}. Do not ask again unless he asks you to.`);
        return view();
      }
      try {
        const requester = hub.views().find((agent) => agent.name === request.by);
        // the boss may have been edited since it asked: a Clean Room boss hires only Clean Room agents, inside its box
        if (requester) {
          if (requester.cleanRoom !== null && request.cleanRoom === null) throw new HubError('forbidden', 'the boss runs in a Clean Room now: the agent it asked for would not, so ask again');
          await confine(requester, request.dir);
        }
        const hired = await hub.hire(hireOf(request));
        notify(`${hired.name} hired (asked by ${request.by})`);
        tell(request.by, `Relief: ${hired.name} is staffed`, `The Director said go. ${hired.name} is hired in ${hired.dir} and starting. Brief it with send_message.`);
      } catch (error) {
        const reason = error instanceof HubError ? error.message : 'an internal error';
        if (!(error instanceof HubError)) log.error('hire after a go failed', error);
        notify(`${request.name} could not be hired: ${reason}`);
        tell(request.by, `Relief: ${request.name} could not be hired`, `The Director said go, but the hire failed: ${reason}.`);
        throw error;
      }
      return view();
    },

    close() {
      for (const { timer } of pending.values()) options.clearTimer(timer);
      pending.clear();
    },
  };
}
