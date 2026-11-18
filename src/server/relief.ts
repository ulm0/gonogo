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
import { AGENT_NAME_PATTERN, DIR_MAX_CHARS, MAX_AGENTS, PERMISSION_MODES, PROVIDERS, RELIEF_MODES, RESERVED_NAMES, ROLE_MAX_CHARS } from '../shared/protocol.js';
import type { AgentView, DownlinkNotify, Hub, HireRequest, Logger, PermissionMode, Provider, ReliefRequest, ReliefView, ReliefFrame } from '../shared/protocol.js';
import { providerInfo } from '../shared/protocol.js';
import { RELIEF_PENDING_MAX, RELIEF_RATE_MAX, RELIEF_RATE_WINDOW_MS, RELIEF_TTL_MS } from './constants.js';
import { isRecord } from './hooks.js';
import { HubError } from './hub.js';

const NAME_RE = new RegExp(AGENT_NAME_PATTERN);
const ID_RE = /^h[1-9]\d{0,9}$/;
const FIELDS = new Set(['name', 'position', 'role', 'dir', 'engine', 'mode']);
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
  hub: Pick<Hub, 'views' | 'hire' | 'sendFromUser'>;
  /** `HubIo.checkDirectory`: the check of the hire form (absolute, exists, a directory). */
  checkDirectory(path: string): Promise<{ ok: true; path: string } | { ok: false; error: string }>;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  emit(frame: ReliefFrame): void;
  notify?: DownlinkNotify;
  log: Logger;
}

export interface ReliefAsked {
  id: string;
  status: 'pending';
  note: string;
}

export interface Relief {
  /** The boss asks. `by` comes from its token. Throws a HubError that says what to change. */
  request(by: { agent: string; generation: number }, input: unknown): Promise<ReliefAsked>;
  view(): ReliefView;
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

  const view = (): ReliefView => ({ requests: [...pending.values()].map(({ request }) => ({ ...request, cleanRoom: request.cleanRoom === null ? null : { ...request.cleanRoom } })) });
  const changed = (): void => options.emit({ t: 'relief', relief: view() });
  const notify = (text: string): void => options.notify?.('relief', text);

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
    return hire;
  };

  /** Is the boss that asked still the boss, and is `dir` in its box when it is a Clean Room agent? */
  const confine = async (requester: AgentView, dir: string): Promise<void> => {
    if (requester.cleanRoom !== null && !(await insideRealpath(requester.dir, dir))) {
      throw new HubError('forbidden', 'a Clean Room agent can hire only inside its own project folder: leave dir out to use it', 'dir');
    }
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

      const engine = input.engine === undefined ? 'claude' : input.engine;
      if (typeof engine !== 'string' || !(PROVIDERS as readonly string[]).includes(engine)) throw bad(`engine must be one of ${PROVIDERS.filter((p) => p !== 'custom').join(', ')}`, 'engine');
      if (engine === 'custom') throw bad('a custom command cannot be asked for: only the Director can hire one', 'engine');
      const provider = engine as Provider;

      const asked = input.mode === undefined ? 'default' : input.mode;
      if (typeof asked !== 'string' || !(PERMISSION_MODES as readonly string[]).includes(asked)) throw bad(`mode must be one of ${RELIEF_MODES.join(', ')}`, 'mode');
      if (!(RELIEF_MODES as readonly string[]).includes(asked)) throw bad(`a request can ask for ${RELIEF_MODES.join(' or ')} at most, not ${asked}: only the Director can give more`, 'mode');
      // an engine without permission modes is started in default whatever is asked, and the Director is shown what will happen
      const mode: PermissionMode = providerInfo(provider).modes ? (asked as PermissionMode) : 'default';

      const { position, role } = input;
      if (position !== undefined && (typeof position !== 'string' || !POSITION_IDS.includes(position))) throw bad(`position must be one of ${POSITION_IDS.join(', ')}`, 'position');
      if (role !== undefined && (typeof role !== 'string' || role.trim().length === 0 || role.trim().length > ROLE_MAX_CHARS)) throw bad(`role must be 1 to ${ROLE_MAX_CHARS} characters`, 'role');
      // the Director approves the text he reads: nothing in it may be hidden from him
      if (typeof role === 'string' && HIDDEN_RE.test(role)) throw bad('role must not hold control, invisible or direction-changing characters: the Director reads all of it', 'role');
      const roleText = typeof role === 'string' ? role.trim() : typeof position === 'string' ? (positionById(position)?.role ?? '') : '';
      if (roleText === '') throw bad('give a position or a role', 'role');

      const cleanRoom = requester.cleanRoom === null ? null : { ...requester.cleanRoom };
      if (cleanRoom !== null && provider !== 'claude') throw bad('a Clean Room agent hires Clean Room agents, and those run Claude Code only', 'engine');
      const asDir = input.dir === undefined ? (cleanRoom === null ? undefined : requester.dir) : input.dir;
      if (typeof asDir !== 'string' || asDir.length === 0 || asDir.length > DIR_MAX_CHARS) throw bad(`dir must be an absolute path of 1 to ${DIR_MAX_CHARS} characters`, 'dir');

      limits(name);
      const checked = await options.checkDirectory(asDir);
      if (!checked.ok) throw bad(checked.error, 'dir');
      await confine(requester, checked.path);
      // the checks above waited on the disk: another request may have taken the name or the last place meanwhile
      limits(name);

      seq += 1;
      const at = now();
      made.push(at);
      const id = `h${seq}`;
      const request: ReliefRequest = { id, by: requester.name, at, expiresAt: at + RELIEF_TTL_MS, name, position: typeof position === 'string' ? position : null, role: roleText, dir: checked.path, provider, mode, cleanRoom };
      pending.set(id, { request, timer: options.setTimer(sweep, RELIEF_TTL_MS + 1) });
      changed();
      notify(`${requester.name} asks to hire ${name}${request.position === null ? '' : ` as ${request.position.toUpperCase()}`}: ${provider}, ${mode}, ${checked.path}`);
      return { id, status: 'pending', note: `waiting for the Director; you get a message with his answer, and the request expires after ${MINUTES(RELIEF_TTL_MS)} minutes` };
    },

    view,

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
