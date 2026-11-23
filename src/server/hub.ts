/**
 * The hub: the one place that knows every agent's state, every message and every pending delivery.
 *
 * It is pure logic behind HubIo (clock, timers, ids, spawn, stop, typing, screen and title probes, persistence, emit), so
 * a test drives it with a fake clock and scripted probes. Contract sections 2.1, 4 and 5 say what each rule is; the
 * comments here say why the code is shaped the way it is.
 *
 * Shape of the code: one `rt` object per agent holds everything that agent owns (record, state, queue, latches, timers,
 * the lifecycle queue), keyed by name in one map. Every entry point (hook, terminal event, timer, input, send, read,
 * lifecycle step) changes `rt` synchronously and then calls `flush(rt)`, which emits the AgentView only when it differs
 * from the one sent last. That makes "one frame per change, none for a no-op write" a property of the design instead
 * of a rule to remember at every call site.
 */
import type {
  ActivityItem,
  ActivityStatus,
  AgentRecord,
  AgentSendRequest,
  AgentState,
  AgentView,
  AnswerRequest,
  SubagentsView,
  ApiErrorCode,
  CleanRoom,
  RunEntry,
  HoldAllResult,
  ResumeAllResult,
  Worktree,
  RemoteControl,
  PermissionRules,
  Effort,
  EditRequest,
  ExitInfo,
  ExitSummary,
  GovernorRequest,
  GovernorView,
  HeldInfo,
  HireRequest,
  HookEvent,
  HookInput,
  HookReply,
  Hub,
  HubEvent,
  HubIo,
  HubOptions,
  InputEffect,
  MessageRecord,
  NeedsKind,
  Payload,
  PayloadOff,
  PermissionMode,
  PollEntry,
  PollRequest,
  PollVote,
  PollView,
  Provider,
  ReadMessage,
  ReadMessagesResult,
  RosterEntry,
  RosterFile,
  RosterResult,
  ScreenProbe,
  SendResult,
  SessionFlag,
  StateChange,
  StationMessage,
  TerminalEvent,
  TimerHandle,
  TitleInfo,
  Transition,
  UserMessageRequest,
  DirectorChannel,
  VoteResult,
} from '../shared/protocol.js';
import {
  DOING_MAX_CHARS,
  EFFORTS,
  HISTORY_MAX,
  HISTORY_WINDOW_MS,
  HOLD_REASON,
  isHoldReason,
  HOOK_EVENTS,
  MODEL_PATTERN,
  PERMISSION_MODES,
  POLL_VOTES,
  PROVIDERS,
  providerInfo,
  RESERVED_NAMES,
  takesEffort,
  STATIC_FIRE_POSITIONS,
  STATION_NAME_PATTERN,
} from '../shared/protocol.js';
import { POSITION_IDS } from '../shared/positions.js';
import {
  ACTIVITY_BACKLOG,
  ACTIVITY_HUB_MAX,
  ACTIVITY_WIRE_BODY_CHARS,
  AGENT_NAME_PATTERN,
  BODY_MAX_CHARS,
  BOSS_DEFAULT_NAME,
  BOSS_ROLE,
  COMMAND_MAX_CHARS,
  CUSTOM_ACTIVE_MS,
  CUSTOM_START_MS,
  DELIVERY_COALESCE_MS,
  DELIVERY_SETTLE_MS,
  DIR_MAX_CHARS,
  DRAFT_EXPIRY_MS,
  DRAFT_SCREEN_CLEAR_MS,
  MAILBOX_MAX_BODY_CHARS,
  MAILBOX_MAX_MESSAGES,
  MAX_AGENTS,
  MAX_STOP_BLOCKS,
  METER_INTERVAL_MS,
  NEEDS_YOU_CLEAR_MS,
  PASTE_END,
  PERMISSION_SUMMARY_CHARS,
  DIRECTOR_REPLY_TAIL,
  DIRECTOR_TURN_CHARS,
  DIRECTOR_STUCK_ALERT_MS,
  DIRECTOR_STUCK_FORCE_MS,
  TITLE_STALE_MS,
  LEGACY_POINTER_MAX_CHARS,
  DIRECTOR_TURNS_TOTAL_CHARS,
  POINTER_MAX_ATTEMPTS,
  POINTER_MAX_SENDERS,
  POLL_REASON_MAX_CHARS,
  PROMPT_SUBMIT_CONFIRM_MS,
  READ_MAX_CHARS,
  READ_MAX_MESSAGES,
  RECONCILE_TICK_MS,
  REDLINE_API_ERROR_WINDOW_MS,
  REDLINE_API_ERRORS,
  REDLINE_REPEATS,
  REDLINE_SEND_WINDOW_MS,
  REDLINE_SENDS_TO_ONE,
  REDLINE_TOOL_FAILURE_WINDOW_MS,
  REDLINE_TOOL_FAILURES,
  ROLE_MAX_CHARS,
  ROSTER_ROLE_CHARS,
  SCREEN_DIALOG_REASON,
  SEND_RATE_MAX,
  SEND_RATE_WINDOW_MS,
  SESSION_FLIP_WINDOW_MS,
  SESSION_IN_USE_TEXT,
  SESSION_MISSING_TEXT,
  STARTUP_DIALOG_REASON,
  SIGNED_OUT_REASON,
  AUTH_REJECTED_REASON,
  STARTUP_READY_TIMEOUT_MS,
  STARTUP_WAVE,
  STARTUP_WAVE_TIMEOUT_MS,
  CARRY_ON_NOTE,
  STARTUP_RECHECK_MS,
  SUBJECT_MAX_CHARS,
  TITLE_IDLE_RECONCILE_MS,
  TITLE_WORKING_CONFIRM_MS,
} from './constants.js';
import { parseCleanRoom } from './cleanroom.js';
import { parseWorktree } from './worktree.js';
import { parseRemoteControl } from './remotecontrol.js';
import { parsePermissions } from './permissions.js';
import { checkKeys } from './clearance.js';
import { parsePayload, parsePayloadOff, payloadRefusal } from './payload.js';

export type { InputEffect };

/** Every request the hub rejects is one of these; web.ts maps `code` to the HTTP status (contract 3.3). */
export class HubError extends Error {
  readonly code: ApiErrorCode;
  readonly field?: string;
  /** For rate_limited: the seconds until it may be asked again. */
  retryAfter?: number;
  /** For a request with text to parse: what is wrong, with the line. */
  diagnostics?: Array<{ line: number; message: string }>;

  constructor(code: ApiErrorCode, message: string, field?: string) {
    super(message);
    this.name = 'HubError';
    this.code = code;
    if (field !== undefined) this.field = field;
  }
}

/* ------------------------------------------------------------------------------------------------------------
 * Pure helpers (exported ones are what the unit tests call directly)
 * ---------------------------------------------------------------------------------------------------------- */

const NAME_RE = new RegExp(AGENT_NAME_PATTERN);
const STATION_RE = new RegExp(STATION_NAME_PATTERN);
/** The payload of a record as text, for comparing: null when it has none. */
const payloadKey = (record: AgentRecord): string | null => (record.payload === undefined && record.payloadOff === undefined ? null : JSON.stringify([record.payload, record.payloadOff]));
/** The tool rules of a record as text, for comparing. */
/** The co-author setting of a record as text, for comparing (it applies at the next start). */
const coauthorKey = (record: AgentRecord): string => (record.coauthor === false ? 'off' : 'follows');
const rulesKey = (record: AgentRecord): string | null => (record.permissions === undefined ? null : JSON.stringify(record.permissions));
/** The Remote Control setting of a record as text, for comparing. */
const remoteKey = (record: AgentRecord): string | null => (record.remoteControl === undefined ? null : JSON.stringify(record.remoteControl));
/** The Clean Room setting of a record as text, for comparing: null when the agent runs on the host. */
const cleanRoomKey = (record: AgentRecord): string | null => (record.cleanRoom === undefined ? null : JSON.stringify(record.cleanRoom));
/** The worktree setting of a record as text, for comparing: null when the agent starts in its own folder. */
const worktreeKey = (record: AgentRecord): string | null => (record.worktree === undefined ? null : JSON.stringify(record.worktree));
/** The model and the keys (names and times) of a record as text, for comparing: a key set again has a new time, so a changed value shows as dirty too. */
const engineKey = (record: AgentRecord): string => JSON.stringify([record.model ?? null, record.effort ?? null, record.keys ?? null]);
const MODEL_RE = new RegExp(MODEL_PATTERN);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPLY_ID_RE = /^m\d+$/;
const REPLY_ID_MAX_CHARS = 40;
const RECIPIENT_MAX_CHARS = 64;
const ESC = '\x1b';
const PERMISSION_INPUT_KEYS = ['command', 'file_path', 'path', 'url'] as const;
/** `input requested: <message>` shows at most this much of the message (contract 4.2). */
const INPUT_REASON_CHARS = 100;
const UNREAD_STATUSES: ReadonlySet<ActivityStatus> = new Set<ActivityStatus>(['queued', 'held', 'delivered']);
/** Waiting to be read. A message to another station that it accepted is `delivered` for good: nobody here will read it. */
const waiting = (record: MessageRecord): boolean => UNREAD_STATUSES.has(record.status) && !(record.status === 'delivered' && record.to.includes('@'));
const SERVER_RESTARTED_NOTE = 'server restarted before it was read; the message went to the user';
const LOAD_LIMIT_NOTE = 'waiting: load limit';
const READ_MORE_NOTE = 'More messages are waiting: call read_messages again to read them.';
/** A tool call's input is compared up to this many characters for the loop detector. */
const REPEAT_SIG_CHARS = 2000;

/** Drops the times older than `windowMs`, adds `now`, and says how many are left. */
/** Who a tool hook is about: the agent itself, or one of its subagents (Claude Code puts `agent_id` on a tool event inside one). */
function whoOf(payload: Record<string, unknown>): string {
  const id = payload.agent_id;
  return typeof id === 'string' && id !== '' && id.length <= 64 ? id : 'main';
}

/** A subagent that no hook has mentioned for this long is gone (its Stop was lost). */
const SUBAGENT_STALE_MS = 30 * 60_000;
/** Subagent ids kept for one agent: more is a flood, not a team. */
const SUBAGENTS_MAX = 64;

function countRecent(times: number[], now: number, windowMs: number): number {
  while (times.length > 0 && now - (times[0] ?? now) >= windowMs) times.shift();
  times.push(now);
  return times.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Cuts to `max` UTF-16 units without leaving half of a surrogate pair at the end. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max);
}

// C0, DEL, C1 and bidi controls: a vote reason is shown to the Director and typed nowhere, but must stay one clean line.
const UNSAFE_IN_REASON = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// Escape sequences whole (CSI, OSC, DCS/PM/APC/SOS strings, two-byte escapes of the C1 kind), and any other ESC alone, so that none is left to begin one inside the paste.
const ESCAPE_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[PX^_][^\u001b]*(?:\u001b\\)?|[@-Z\\-_])?/g;
// Line breaks and tabs become a space; the rest of C0, DEL, C1, zero-width, bidi, line and paragraph separators, tags and lone surrogates go.
const BREAKS = /[\u0000-\u0020\u007f-\u009f\u2028\u2029]+/g;
const INVISIBLE = /[\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufff9-\ufffb\ufeff\u{e0000}-\u{e007f}]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/gu;

/**
 * The Director's words as ONE clean line for the pointer (docs/features/relay.md): no escape sequence (so no paste end, no key, no title), no control or
 * invisible character, no line break (nothing submits early), runs of white space as one space, cut to `max` with an ellipsis. Empty when nothing is left.
 */
export function directorLine(text: string, max: number = DIRECTOR_TURN_CHARS): string {
  const line = text.replace(ESCAPE_SEQUENCE, '').replace(INVISIBLE, '').replace(BREAKS, ' ').trim();
  return line.length <= max ? line : `${cutText(line, max - 1).trimEnd()}…`;
}

/**
 * The only text gonogo types into a terminal or hands to a Stop hook (contract 5.1). Callers pass at least one message.
 */
export function pointerText(messages: ReadonlyArray<{ from: string }>): string {
  const senders: string[] = [];
  for (const message of messages) {
    if (!senders.includes(message.from)) senders.push(message.from);
  }
  const names =
    senders.slice(0, POINTER_MAX_SENDERS).join(', ') + (senders.length > POINTER_MAX_SENDERS ? ' and others' : '');
  const count = messages.length;
  return `gonogo: ${count} new message${count === 1 ? '' : 's'} from ${names}. Call read_messages.`;
}

/**
 * The `needs_you` reason of a permission request (contract 4.2): the tool, then the first of command, file_path, path and
 * url from the tool input with whitespace collapsed. A summary longer than PERMISSION_SUMMARY_CHARS is cut and ends in `…`.
 */
export function describePermission(toolName: unknown, toolInput: unknown): string {
  const named = typeof toolName === 'string' ? collapseWhitespace(toolName) : '';
  const tool = named === '' ? 'unknown tool' : cutText(named, PERMISSION_SUMMARY_CHARS);
  if (isRecord(toolInput)) {
    for (const key of PERMISSION_INPUT_KEYS) {
      const value = toolInput[key];
      if (typeof value !== 'string') continue;
      const summary = collapseWhitespace(value);
      if (summary === '') continue;
      const shown =
        summary.length > PERMISSION_SUMMARY_CHARS ? `${cutText(summary, PERMISSION_SUMMARY_CHARS)}…` : summary;
      return `permission request: ${tool}: ${shown}`;
    }
  }
  return `permission request: ${tool}`;
}

const PERMISSION_PREFIX = 'permission request: ';

/** `AgentView.doing`: the permission text of a tool call without its prefix, on one clean line of at most DOING_MAX_CHARS. */
export function describeDoing(toolName: unknown, toolInput: unknown): string {
  const text = describePermission(toolName, toolInput).slice(PERMISSION_PREFIX.length);
  return cutText(collapseWhitespace(text.replace(UNSAFE_IN_REASON, ' ')), DOING_MAX_CHARS);
}

/** The changes of the last HISTORY_WINDOW_MS plus the one before them, at most HISTORY_MAX (the newest), as a copy. */
function trimHistory(history: readonly StateChange[], now: number): StateChange[] {
  const cutoff = now - HISTORY_WINDOW_MS;
  const inside = history.findIndex((change) => change.at >= cutoff);
  // Nothing inside the window: the last entry is the state at its left edge.
  const first = inside === -1 ? history.length - 1 : Math.max(0, inside - 1);
  return history.slice(Math.max(first, history.length - HISTORY_MAX)).map((change) => ({ ...change }));
}

function isParameterOrIntermediate(code: number): boolean {
  return code >= 0x20 && code <= 0x3f;
}

/**
 * Reads one escape sequence that starts at `start` (a data[start] === ESC). `effect` is non-null only for a bracketed
 * paste that carried text; every other sequence is something a terminal sends on its own or a key that edits nothing.
 */
function scanEscape(data: string, start: number): { next: number; effect: InputEffect | null } {
  const length = data.length;
  if (start + 1 >= length) return { next: length, effect: null };
  const kind = data[start + 1];
  if (kind === '[') {
    let index = start + 2;
    // X10 mouse report: ESC [ M followed by three raw bytes, which may be any printable-looking characters.
    if (data[index] === 'M') return { next: Math.min(length, index + 4), effect: null };
    while (index < length && isParameterOrIntermediate(data.charCodeAt(index))) index += 1;
    if (index >= length) return { next: length, effect: null };
    const final = data.charCodeAt(index);
    // A malformed sequence ends where it went wrong; the next character is read as a normal one.
    if (final < 0x40 || final > 0x7e) return { next: index, effect: null };
    if (data[index] === '~' && data.slice(start + 2, index) === '200') {
      const end = data.indexOf(PASTE_END, index + 1);
      const content = data.slice(index + 1, end < 0 ? length : end);
      return { next: end < 0 ? length : end + PASTE_END.length, effect: /\S/.test(content) ? 'set' : null };
    }
    return { next: index + 1, effect: null };
  }
  if (kind === 'O') return { next: Math.min(length, start + 3), effect: null };
  if (kind === ']') {
    const bell = data.indexOf('\x07', start + 2);
    const terminator = data.indexOf(`${ESC}\\`, start + 2);
    if (bell >= 0 && (terminator < 0 || bell < terminator)) return { next: bell + 1, effect: null };
    return { next: terminator < 0 ? length : terminator + 2, effect: null };
  }
  if (kind === 'P' || kind === '_' || kind === '^' || kind === 'X') {
    const terminator = data.indexOf(`${ESC}\\`, start + 2);
    return { next: terminator < 0 ? length : terminator + 2, effect: null };
  }
  // Alt-key, or ESC CR (a newline in some terminals): the pair is skipped. An astral character is one unit of input.
  const code = data.codePointAt(start + 1) ?? 0;
  return { next: start + 1 + (code > 0xffff ? 2 : 1), effect: null };
}

/**
 * What one chunk of browser input does to the draft latch (contract 4.6): `set` for text, `clear` for Enter or Ctrl-C,
 * `none` for everything a terminal or a navigation key sends. A lone Escape is `none` on purpose: it leaves the text in
 * claude's box.
 */
export function classifyInput(data: string): InputEffect {
  let effect: InputEffect = 'none';
  let index = 0;
  while (index < data.length) {
    const char = data[index];
    if (char === ESC) {
      const scanned = scanEscape(data, index);
      if (scanned.effect !== null) effect = scanned.effect;
      index = scanned.next;
      continue;
    }
    const code = data.codePointAt(index) ?? 0;
    index += code > 0xffff ? 2 : 1;
    if (code === 0x0d || code === 0x03) effect = 'clear';
    else if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) effect = 'set';
  }
  return effect;
}

/* ------------------------------------------------------------------------------------------------------------
 * The hub
 * ---------------------------------------------------------------------------------------------------------- */

interface TimerBox {
  handle: TimerHandle;
}
interface DeliveryTimer extends TimerBox {
  due: number;
}
/** A pointer that was typed and waits for its UserPromptSubmit (contract 5.3 step 8, 5.4). */
interface PendingConfirm {
  text: string;
  ids: string[];
  at: number;
  timer: TimerBox;
}
/** The pointer was typed but never confirmed: nothing more is typed until a person acts (contract 5.4). */
interface Unconfirmed {
  text: string;
  ids: string[];
  since: number;
  note: string;
}
type OpKind = 'hire' | 'edit' | 'restart' | 'stop' | 'remove' | 'flip' | 'shutdown';
interface Op {
  kind: OpKind;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  promise: Promise<unknown>;
}

/** Everything one agent owns (contract 4.1). It never leaves memory except as the roster record. */
interface Rt {
  record: AgentRecord;
  state: AgentState;
  stateSince: number;
  /** State changes for the sequence chart, oldest first; memory only (AgentView.history). */
  history: StateChange[];
  /** The tool call of the last PreToolUse hook of this process (AgentView.doing). */
  doing: string | null;
  needsKind: NeedsKind | null;
  needsReason: string | null;
  /** How many PermissionRequest hooks this agent has made (the dialog that is open is the last one). */
  needSeq: number;
  generation: number;
  ready: boolean;
  transition: Transition | null;
  /** When a Stop block was last answered: R1 waits for the title to catch up (contract 4.7). */
  lastBlockAt: number | null;
  /** role, dir, mode, command and payload (as JSON text) as of the last spawn, for the `dirty` flag. */
  running: { role: string; dir: string; mode: PermissionMode; command: string | null; payload: string | null; cleanRoom: string | null; worktree: string | null; remoteControl: string | null; permissions: string | null; coauthor: string; engine: string } | null;
  /** Custom provider only: the output counter at the last sweep, when it last grew, and when the process was spawned. */
  custom: { bytes: number; activeAt: number | null; since: number };
  /** The flag the last start used, null until the launcher answered. */
  flag: SessionFlag | null;
  flipAvailable: boolean;
  draft: { lastKeyAt: number } | null;
  unconfirmed: Unconfirmed | null;
  pendingConfirm: PendingConfirm | null;
  stopBlocks: number;
  trigger: { ids: string[]; maxHops: number } | null;
  screenClearSince: number | null;
  hooksSeen: boolean;
  lastInputAt: number;
  /** Message id to the number of times it became `delivered` (contract 5.5). */
  pointed: Map<string, number>;
  exit: ExitSummary | null;
  /** The generation whose exit was already processed: a second exit event of it (or a synthesised one) is ignored. */
  exitSeen: number;
  /** Ids of messages addressed to this agent with status queued or held, oldest first. */
  queue: string[];
  /** When this agent sent the messages of the last SEND_RATE_WINDOW_MS (at most SEND_RATE_MAX entries, oldest first). */
  sentAt: number[];
  /** A rate-limit refusal of this agent is on record already; cleared when it is allowed to send again. */
  limitNoted: boolean;
  startupTimer: TimerBox | null;
  deliveryTimer: DeliveryTimer | null;
  /** The lifecycle queue: operations of one agent run one at a time, in call order (contract 2.1 rule 2). */
  ops: Op[];
  current: Op | null;
  draining: boolean;
  /** While true no AgentFrame is emitted: a restart or a spawn shows one frame, when the new process exists (4.9). */
  frameHold: boolean;
  lastSig: string | null;
  removed: boolean;
  /** Redline: why the circuit breaker tripped, null when it did not. Held mail and needs_you until the Director resumes. */
  redline: string | null;
  /** The id of the Director's message the Director was told is waiting (once per message). */
  stuckAlerted: string | null;
  /** The id of the oldest message whose wait on a not-ready screen was written to the log (once per episode). */
  stuckLogged: string | null;
  /** The screen says Claude Code is not signed in: the agent is held at needs_you and its mail waits for the login. */
  signedOut: boolean;
  /** The credential Claude Code has was refused: the same hold as no login, with its own words. */
  authRejected: boolean;
  /** The last tool call (name and input) and how many times in a row it came, for the agent itself ('main') and for each subagent by its agent_id (docs/subagents-spec.md). */
  repeat: Map<string, { sig: string; count: number }>;
  /** Times of failed tool calls (the same keys) and of API errors in their windows, oldest first. */
  toolFailAt: Map<string, number[]>;
  apiErrorAt: number[];
  /** Running subagents by agent_id: their type, when the hook last spoke of them; and how many started in this process. */
  subagents: Map<string, { type: string; seen: number }>;
  subagentsStarted: number;
  /** Recipient to the times this agent sent it a message within REDLINE_SEND_WINDOW_MS. */
  sentTo: Map<string, number[]>;
  /** When Propellant last read this agent's transcript on a tool hook. */
  meteredAt: number;
}

export function createHub(io: HubIo, options: HubOptions): Hub {
  const log = io.log;
  const agents = new Map<string, Rt>();
  /** Every message the hub still needs: the unread ones always, the newest ACTIVITY_HUB_MAX in any case. */
  const messages = new Map<string, MessageRecord>();
  /** Message ids, oldest first: what activity() shows. */
  const order: string[] = [];
  /** Names that a hire or a rename has claimed but not yet stored (their checks await the file system). */
  const claimedNames = new Set<string>();
  /** Hires in flight; the record exists once the directory was checked and is saved with the roster from then on. */
  const hiring = new Map<string, AgentRecord | null>();
  let closing = false;
  let started: Promise<void> | null = null;
  let shutdownPromise: Promise<void> | null = null;
  let sweepTimer: TimerBox | null = null;
  /** T-minus and Max Q live in memory only; the signatures make a frame go out once per change. */
  let pollState: PollView | null = null;
  // Why the poll is on hold: only a hold by vote follows later votes.
  let holdBy: 'director' | 'vote' = 'vote';
  let pollSeq = 0;
  let pollSig = 'null';
  let pollResult = '';
  let limit: number | null = options.maxWorking ?? null;
  let maxHops = options.maxHops;
  let governorSig = JSON.stringify(governorView());

  /* ---- small utilities ---- */

  function guarded(what: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      log.error(`${what} failed`, error);
    }
  }

  function isCustom(rt: Rt): boolean {
    return rt.record.provider === 'custom';
  }

  /** Engine Bay: working, idle and needs_you come from hooks (Claude Code, Gemini CLI); the rest are read from output activity. */
  /** Live reload: the hold or redline text of each agent, saved after every change so that a restart of the hub never releases one. */
  // A hold whose process ended without the Director asking (a pty host that stalled, a crash) stays in the file: the process may
  // still be alive in the host, and the next hub that adopts it must find it held. A start, a resume or a requested stop clears it.
  const lostHolds = new Map<string, string>();
  let holdsSaved = true;

  function saveHolds(): void {
    if (!io.saveHolds) return;
    const holds: Record<string, string> = {};
    for (const [name, reason] of lostHolds) if (agents.has(name)) holds[name] = reason;
    for (const [name, rt] of agents) if (rt.redline !== null) holds[name] = rt.redline;
    try {
      io.saveHolds(holds);
      holdsSaved = true;
    } catch (error) {
      holdsSaved = false;
      log.error('could not save the holds: a reload is refused until they are saved', error);
    }
  }

  /** Live reload fails closed: with the holds not on disk, a new hub would release held agents. Saves again and throws when it cannot. */
  function saveHoldsNow(): void {
    if (!io.saveHolds) return;
    saveHolds();
    if (!holdsSaved) throw new HubError('conflict', 'the holds could not be saved, so a reload would release held agents: not reloading');
  }

  function hooked(rt: Rt): boolean {
    return providerInfo(rt.record.provider).hooks;
  }

  /** Has the gonogo MCP tools, so it can be handed mail and asked to vote. */
  function mailable(rt: Rt): boolean {
    return providerInfo(rt.record.provider).mcp;
  }

  /** The screen and title rules (prompt box, dialogs, title glyphs) are Claude Code's own. */
  function isClaude(rt: Rt): boolean {
    return (rt.record.provider ?? 'claude') === 'claude';
  }

  function assertOpen(): void {
    if (closing) throw new HubError('conflict', 'the server is shutting down');
  }

  function screenOf(rt: Rt): ScreenProbe | null {
    try {
      return io.screen(rt.record.name) ?? null;
    } catch (error) {
      log.debug('screen probe failed', error);
      return null;
    }
  }

  function titleOf(rt: Rt): TitleInfo | null {
    try {
      return io.title(rt.record.name) ?? null;
    } catch (error) {
      log.debug('title probe failed', error);
      return null;
    }
  }

  function outputBytesOf(rt: Rt): number {
    try {
      return io.outputBytes(rt.record.name);
    } catch (error) {
      log.debug('output probe failed', error);
      return 0;
    }
  }

  function lookup(name: unknown): Rt {
    const rt = typeof name === 'string' ? agents.get(name) : undefined;
    if (!rt || rt.removed) throw new HubError('not_found', 'unknown agent');
    return rt;
  }

  function bossRt(): Rt | null {
    let boss: Rt | null = null;
    for (const rt of agents.values()) {
      if (rt.record.boss && (boss === null || rt.record.desk < boss.record.desk)) boss = rt;
    }
    return boss;
  }

  function sortedAgents(): Rt[] {
    return [...agents.values()].sort(
      (a, b) => a.record.desk - b.record.desk || (a.record.name < b.record.name ? -1 : 1),
    );
  }

  function makeRt(record: AgentRecord): Rt {
    const now = io.now();
    return {
      record,
      state: 'stopped',
      stateSince: now,
      history: [{ state: 'stopped', at: now }],
      doing: null,
      needsKind: null,
      needsReason: null,
      needSeq: 0,
      generation: 0,
      ready: false,
      transition: null,
      lastBlockAt: null,
      running: null,
      custom: { bytes: 0, activeAt: null, since: io.now() },
      flag: null,
      flipAvailable: false,
      draft: null,
      unconfirmed: null,
      pendingConfirm: null,
      stopBlocks: 0,
      trigger: null,
      screenClearSince: null,
      hooksSeen: false,
      lastInputAt: 0,
      pointed: new Map(),
      exit: null,
      exitSeen: 0,
      queue: [],
      sentAt: [],
      limitNoted: false,
      startupTimer: null,
      deliveryTimer: null,
      ops: [],
      current: null,
      draining: false,
      frameHold: false,
      lastSig: null,
      removed: false,
      redline: null,
      stuckAlerted: null,
      stuckLogged: null,
      signedOut: false,
      authRejected: false,
      repeat: new Map(),
      toolFailAt: new Map(),
      subagents: new Map(),
      subagentsStarted: 0,
      apiErrorAt: [],
      sentTo: new Map(),
      meteredAt: 0,
    };
  }

  /* ---- frames ---- */

  function emit(event: HubEvent): void {
    try {
      io.emit(event);
    } catch (error) {
      log.warn('emit failed', error);
    }
  }

  function heldInfo(rt: Rt): HeldInfo | null {
    if (rt.queue.length === 0) return null;
    if (rt.redline !== null) return { kind: 'redline', text: redlineNote(rt) };
    if (rt.draft) return { kind: 'draft', text: draftNote(rt) };
    if (rt.unconfirmed) return { kind: 'unconfirmed', text: rt.unconfirmed.note };
    return null;
  }

  function buildView(rt: Rt): AgentView {
    const { record, running } = rt;
    return {
      name: record.name,
      role: record.role,
      dir: record.dir,
      mode: record.mode,
      desk: record.desk,
      boss: record.boss,
      state: rt.state,
      stateSince: rt.stateSince,
      needsKind: rt.needsKind,
      needsReason: rt.needsReason,
      needSeq: rt.needsKind === 'permission' ? rt.needSeq : null,
      transition: rt.transition,
      draft: rt.draft !== null,
      held: heldInfo(rt),
      queued: rt.queue.length,
      dirty:
        rt.state !== 'stopped' &&
        running !== null &&
        (running.role !== record.role ||
          running.dir !== record.dir ||
          running.mode !== record.mode ||
          running.command !== (record.command ?? null) ||
          running.payload !== payloadKey(record) ||
          running.cleanRoom !== cleanRoomKey(record) ||
          running.worktree !== worktreeKey(record) ||
          running.remoteControl !== remoteKey(record) ||
          running.permissions !== rulesKey(record) ||
          running.coauthor !== coauthorKey(record) ||
          running.engine !== engineKey(record)),
      generation: rt.generation,
      exit: rt.exit ? { ...rt.exit } : null,
      position: record.position ?? null,
      provider: record.provider ?? 'claude',
      command: record.command ?? null,
      payload: record.payload ?? null,
      payloadOff: record.payloadOff ?? null,
      cleanRoom: record.cleanRoom ?? null,
      worktree: record.worktree ?? null,
      remoteControl: record.remoteControl ?? null,
      permissions: record.permissions ?? null,
      autostart: record.autostart !== false,
      coauthor: record.coauthor !== false,
      model: record.model ?? null,
      effort: record.effort ?? null,
      keys: { ...record.keys },
      doing: rt.doing,
      subagents: subagentsOf(rt),
      history: trimHistory(rt.history, io.now()),
    };
  }

  /** Emits the agent's view when it changed since the last frame, unless a restart or spawn holds the frames back. */
  function flush(rt: Rt): void {
    publishGovernor();
    if (rt.removed || rt.frameHold) return;
    const view = buildView(rt);
    const signature = JSON.stringify(view);
    if (signature === rt.lastSig) return;
    rt.lastSig = signature;
    emit({ t: 'agent', agent: view });
  }

  function toItem(record: MessageRecord): ActivityItem {
    const body = cutText(record.body, ACTIVITY_WIRE_BODY_CHARS);
    return { ...record, body, truncated: body.length < record.body.length };
  }

  function persistMessage(record: MessageRecord): void {
    try {
      io.logMessage({ ...record });
    } catch (error) {
      log.warn('could not log a message', error);
    }
  }

  function announce(record: MessageRecord): void {
    persistMessage(record);
    emit({ t: 'activity', item: toItem(record) });
  }

  /** Changes a message's status and note; a write that changes nothing is neither logged nor emitted (contract 5.8). */
  function setMessage(record: MessageRecord, status: ActivityStatus, note: string | null): void {
    if (record.status === status && record.note === note) return;
    record.status = status;
    record.note = note;
    record.updatedAt = io.now();
    announce(record);
  }

  function remember(record: MessageRecord): void {
    messages.set(record.id, record);
    order.push(record.id);
    if (order.length <= ACTIVITY_HUB_MAX * 2) return;
    // Older terminal messages stay in the log only. Unread ones stay listed, because a read still needs them and, once it
    // has happened, this is the only place that drops them from the map (an id that left `order` was never looked at again).
    const unread: string[] = [];
    for (const id of order.splice(0, order.length - ACTIVITY_HUB_MAX)) {
      const old = messages.get(id);
      if (old && waiting(old)) unread.push(id);
      else messages.delete(id);
    }
    order.unshift(...unread);
  }

  function sanitizeHistory(value: unknown): MessageRecord | null {
    if (!isRecord(value)) return null;
    const { id, from, to, subject, body, inReplyTo, hops, at, status, note, updatedAt } = value;
    if (typeof id !== 'string' || typeof from !== 'string' || typeof to !== 'string') return null;
    if (typeof body !== 'string' || typeof status !== 'string') return null;
    const known: readonly string[] = ['queued', 'held', 'delivered', 'read', 'undelivered', 'to_user'];
    if (!known.includes(status)) return null;
    const time = typeof at === 'number' && Number.isFinite(at) ? at : 0;
    return {
      id,
      from,
      to,
      subject: typeof subject === 'string' ? subject : '',
      body,
      inReplyTo: typeof inReplyTo === 'string' ? inReplyTo : null,
      hops: typeof hops === 'number' && Number.isFinite(hops) ? hops : 0,
      at: time,
      status: status as ActivityStatus,
      note: typeof note === 'string' ? note : null,
      updatedAt: typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : time,
    };
  }

  /* ---- roster persistence ---- */

  /**
   * Every record, hires in flight included: two hires that overlap each save the roster, and the one saved last must not
   * drop the other's agent.
   */
  function rosterRecords(): AgentRecord[] {
    const records = new Map<string, AgentRecord>();
    for (const rt of agents.values()) records.set(rt.record.name, { ...rt.record });
    for (const [name, record] of hiring) {
      if (record && !records.has(name)) records.set(name, { ...record });
    }
    return [...records.values()].sort((a, b) => a.desk - b.desk || (a.name < b.name ? -1 : 1));
  }

  async function saveRecords(records: AgentRecord[]): Promise<void> {
    const file: RosterFile = { version: 1, agents: records.map((record) => ({ ...record })) };
    try {
      await io.saveRoster(file);
    } catch (error) {
      log.error('could not save the roster', error);
      throw new HubError('internal', `could not save the roster: ${errorMessage(error)}`);
    }
  }

  /* ---- timers ---- */

  /** A timer that does nothing once the agent has a newer generation or is gone (contract 2.1 rule 4). */
  function armTimer(rt: Rt, ms: number, fn: () => void): TimerBox {
    const generation = rt.generation;
    const box: TimerBox = { handle: undefined };
    box.handle = io.setTimer(() => {
      if (rt.removed || rt.generation !== generation) return;
      guarded('timer callback', () => {
        fn();
        flush(rt);
      });
    }, ms);
    return box;
  }

  function disarm(box: TimerBox | null): void {
    if (box) io.clearTimer(box.handle);
  }

  function armStartup(rt: Rt, ms: number): void {
    disarm(rt.startupTimer);
    rt.startupTimer = armTimer(rt, ms, () => {
      rt.startupTimer = null;
      if (rt.ready || rt.state !== 'starting') return;
      if (outputBytesOf(rt) > 0) {
        setState(rt, 'needs_you', { kind: 'startup_dialog', reason: STARTUP_DIALOG_REASON });
      } else {
        armStartup(rt, STARTUP_RECHECK_MS);
      }
    });
  }

  /** The delivery check runs no later than `ms` from now; an earlier pending one is kept (contract 4.10 rule 3). */
  function scheduleDelivery(rt: Rt, ms: number): void {
    const due = io.now() + ms;
    if (rt.deliveryTimer && rt.deliveryTimer.due <= due) return;
    disarm(rt.deliveryTimer);
    const box = armTimer(rt, ms, () => {
      rt.deliveryTimer = null;
      deliveryCheck(rt);
    });
    rt.deliveryTimer = { handle: box.handle, due };
  }

  function cancelConfirm(rt: Rt): void {
    if (rt.pendingConfirm) disarm(rt.pendingConfirm.timer);
    rt.pendingConfirm = null;
  }

  function cancelTimers(rt: Rt): void {
    disarm(rt.startupTimer);
    rt.startupTimer = null;
    disarm(rt.deliveryTimer);
    rt.deliveryTimer = null;
    cancelConfirm(rt);
  }

  /* ---- state ---- */

  /** The one way a state changes: `stateSince` moves only when the state value does (contract 4.4). */
  function setState(rt: Rt, state: AgentState, needs?: { kind: NeedsKind; reason: string }): void {
    // A trip outlives whatever the hooks and the screen say, until the Director resumes or the process ends.
    if (rt.redline !== null && state === 'stopped') {
      rt.redline = null;
      saveHolds();
    }
    if (rt.redline !== null) {
      state = 'needs_you';
      needs = { kind: 'redline', reason: rt.redline };
    }
    if (rt.state !== state) {
      rt.state = state;
      rt.stateSince = io.now();
      rt.history = trimHistory([...rt.history, { state, at: rt.stateSince }], rt.stateSince);
      rt.screenClearSince = null;
    }
    rt.needsKind = state === 'needs_you' && needs ? needs.kind : null;
    rt.needsReason = state === 'needs_you' && needs ? needs.reason : null;
    markRun(rt);
  }

  /**
   * Autostart: the run state holds the agents whose process is up and that are not held or tripped (a Hold and a trip keep the state
   * `needs_you` with a process alive, and a cold restart must leave them stopped). Nothing is written during a shutdown: the set stays as it was.
   */
  function markRun(rt: Rt): void {
    if (closing) return;
    const running = !rt.removed && rt.state !== 'stopped' && rt.redline === null;
    const working = running && (rt.state === 'working' || (rt.state === 'needs_you' && rt.needsKind === 'permission'));
    try {
      io.markRun?.(rt.record.name, running, working);
    } catch (error) {
      log.warn('run state failed', error);
    }
  }

  function markReady(rt: Rt): void {
    rt.ready = true;
    disarm(rt.startupTimer);
    rt.startupTimer = null;
    setState(rt, 'idle');
    if (rt.queue.length > 0) scheduleDelivery(rt, DELIVERY_SETTLE_MS);
  }

  /* ---- queue, notes and latches ---- */

  function draftNote(rt: Rt): string {
    return `held: text in ${rt.record.name}'s input`;
  }

  function redlineNote(rt: Rt): string {
    return isHoldReason(rt.redline) ? `held: ${rt.record.name} is on hold` : `held: redline on ${rt.record.name}`;
  }

  function holdNote(rt: Rt): string | null {
    if (rt.redline !== null) return redlineNote(rt);
    if (rt.draft) return draftNote(rt);
    if (rt.unconfirmed) return rt.unconfirmed.note;
    return null;
  }

  /** The note of a queued message for the recipient's state (contract 5.8). */
  function waitNote(rt: Rt): string {
    const name = rt.record.name;
    if (rt.transition === 'restarting') return `waiting: ${name} is restarting`;
    switch (rt.state) {
      case 'working':
        return `waiting: ${name} is working`;
      case 'needs_you':
        return rt.authRejected ? `waiting: ${name}'s credential was rejected` : rt.signedOut ? `waiting: ${name} isn't signed in` : `waiting: ${name} needs you`;
      case 'idle':
        return 'waiting: about to type the pointer';
      case 'starting':
      case 'stopped':
        return `waiting: ${name} is starting`;
    }
  }

  function inFlight(rt: Rt, id: string): boolean {
    return rt.pendingConfirm !== null && rt.pendingConfirm.ids.includes(id);
  }

  function queued(rt: Rt): MessageRecord[] {
    const records: MessageRecord[] = [];
    for (const id of rt.queue) {
      const record = messages.get(id);
      if (record) records.push(record);
    }
    return records;
  }

  function unreadFor(name: string): MessageRecord[] {
    const records: MessageRecord[] = [];
    for (const record of messages.values()) {
      if (record.to === name && UNREAD_STATUSES.has(record.status)) records.push(record);
    }
    return records;
  }

  /**
   * Brings the queued messages in line with the latches: held while a latch is set, back to queued with the wait note when
   * none is (contract 4.6: at once, not at the next delivery check). Messages whose pointer is already in the box are left
   * alone, their pointer is on its way.
   */
  function syncHolds(rt: Rt): void {
    const hold = holdNote(rt);
    for (const record of queued(rt)) {
      if (inFlight(rt, record.id)) continue;
      if (hold !== null) setMessage(record, 'held', hold);
      else if (record.status === 'held') setMessage(record, 'queued', waitNote(rt));
    }
  }

  function setWaitNotes(rt: Rt, note: string): void {
    for (const record of queued(rt)) {
      if (!inFlight(rt, record.id) && record.status === 'queued') setMessage(record, 'queued', note);
    }
  }

  function endDraft(rt: Rt): void {
    rt.draft = null;
    syncHolds(rt);
    if (rt.queue.length > 0) scheduleDelivery(rt, DELIVERY_SETTLE_MS);
  }

  function expireDraft(rt: Rt, now: number): void {
    if (rt.draft && now - rt.draft.lastKeyAt >= DRAFT_EXPIRY_MS) endDraft(rt);
  }

  /** The screen may end a draft latch (an emptied box) but never start one (contract 4.6). */
  function screenProof(rt: Rt, now: number, probe: ScreenProbe | null): void {
    if (!rt.draft || !probe || !probe.promptBox || probe.promptText !== '') return;
    if (now - Math.max(rt.draft.lastKeyAt, rt.lastInputAt) >= DRAFT_SCREEN_CLEAR_MS) endDraft(rt);
  }

  function undeliverUnread(rt: Rt, note: string): void {
    for (const record of unreadFor(rt.record.name)) setMessage(record, 'undelivered', note);
    rt.queue = [];
    rt.pointed.clear();
  }

  /** `delivered` messages whose turn ended unread: one more pointer, then a visible `not read` note (contract 5.5). */
  function redeliver(rt: Rt): void {
    const name = rt.record.name;
    const again: string[] = [];
    for (const record of unreadFor(name)) {
      if (record.status !== 'delivered') continue;
      if ((rt.pointed.get(record.id) ?? 0) < POINTER_MAX_ATTEMPTS) {
        setMessage(record, 'queued', `waiting: ${name} has not read it yet`);
        again.push(record.id);
      } else {
        setMessage(record, 'delivered', `not read: ${name} did not read it after two pointers`);
      }
    }
    if (again.length > 0) rt.queue = [...again, ...rt.queue.filter((id) => !again.includes(id))];
    syncHolds(rt);
  }

  function markDelivered(rt: Rt, ids: readonly string[], note: string): void {
    for (const id of ids) {
      const index = rt.queue.indexOf(id);
      const record = messages.get(id);
      if (index < 0 || !record) continue;
      rt.queue.splice(index, 1);
      rt.pointed.set(id, (rt.pointed.get(id) ?? 0) + 1);
      directorTurns.delete(id); // typed once
      directorDeferred.delete(id);
      setMessage(record, 'delivered', note);
    }
  }

  /* ---- Max Q ---- */

  function workingCount(): number {
    let working = 0;
    for (const rt of agents.values()) {
      // An unconfirmed pointer is a slot taken; an agent without hooks never takes one (its output says too little).
      if (!hooked(rt) || rt.state === 'stopped') continue;
      if (rt.state === 'working' || rt.pendingConfirm) working += 1;
    }
    return working;
  }

  /** Messages that wait only for the limit: their note is the one loadLimitNote wrote. */
  function holdingCount(): number {
    let holding = 0;
    for (const rt of agents.values()) {
      for (const record of queued(rt)) {
        if (record.status === 'queued' && record.note?.startsWith(LOAD_LIMIT_NOTE)) holding += 1;
      }
    }
    return holding;
  }

  function governorView(): GovernorView {
    return { limit, working: workingCount(), holding: holdingCount() };
  }

  function publishGovernor(): void {
    const view = governorView();
    const signature = JSON.stringify(view);
    if (signature === governorSig) return;
    governorSig = signature;
    emit({ t: 'governor', governor: view });
  }

  /** The wait note when the load limit keeps this idle recipient's pointer back; Director messages (and polls) always pass. */
  function loadLimitNote(rt: Rt): string | null {
    if (limit === null || io.featureOn?.('maxq') === false) return null;
    const working = workingCount();
    if (working < limit || queued(rt).some((record) => record.from === 'user')) return null;
    return `${LOAD_LIMIT_NOTE} (${working} of ${limit} agents working)`;
  }

  function setGovernor(request: GovernorRequest): GovernorView {
    assertOpen();
    const req = asObject(request, 'the request');
    const value = req.limit;
    if (value !== null && !(typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_AGENTS)) {
      throw new HubError('bad_request', `limit must be a whole number from 1 to ${MAX_AGENTS}, or null`, 'limit');
    }
    limit = value;
    // Held messages re-read the new limit now instead of at the next sweep.
    for (const rt of agents.values()) {
      if (rt.queue.length > 0) scheduleDelivery(rt, DELIVERY_COALESCE_MS);
    }
    publishGovernor();
    return governorView();
  }

  /** Hub.answer: the Director's go or no-go for an open permission dialog, typed as Enter or Escape; the hooks move the state. */
  function answer(name: string, request: AnswerRequest): AgentView {
    assertOpen();
    const rt = lookup(name);
    const asked = asObject(request, 'the request');
    const go = asked.go;
    if (typeof go !== 'boolean') throw new HubError('bad_request', 'go must be true or false', 'go');
    const { needSeq } = asked;
    if (needSeq !== undefined && (typeof needSeq !== 'number' || !Number.isSafeInteger(needSeq) || needSeq < 0)) {
      throw new HubError('bad_request', 'needSeq must be a whole number', 'needSeq');
    }
    if (rt.state !== 'needs_you' || rt.needsKind !== 'permission' || rt.transition !== null) {
      throw new HubError('conflict', `${rt.record.name} is not asking for a go`);
    }
    // an answer from a phone for a dialog that was answered or replaced since: nothing is typed
    if (needSeq !== undefined && needSeq !== rt.needSeq) {
      throw new HubError('conflict', `${rt.record.name} is asking about something else now: that dialog was answered or replaced`, 'needSeq');
    }
    if (!io.press?.(rt.record.name, rt.generation, go ? '\r' : '\x1b')) {
      throw new HubError('conflict', `could not reach the terminal of ${rt.record.name}`);
    }
    if (!go && !isClaude(rt)) {
      // Gemini CLI ends the turn on Escape and no hook says so, and its screen is not read (Claude has R2 for this).
      // shortcut: an Escape typed in the terminal itself still leaves needs_you until the next prompt, upgrade when its screen is read.
      setState(rt, 'idle');
      endTurnUnseen(rt);
      if (rt.queue.length > 0) scheduleDelivery(rt, DELIVERY_SETTLE_MS);
      flush(rt);
    }
    return buildView(rt);
  }

  /* ---- Redline ---- */

  function clearRedline(rt: Rt): void {
    const had = rt.redline !== null || lostHolds.delete(rt.record.name);
    rt.redline = null;
    if (had) saveHolds();
    rt.repeat.clear();
    rt.toolFailAt.clear();
    rt.apiErrorAt = [];
    rt.sentTo.clear();
  }

  /** Trips the breaker: Escape interrupts a turn in progress, the state reads needs_you and the mail waits. A Hold is a trip the Director asked for. */
  function tripRt(rt: Rt, reason: string, byHand = false, detail?: string): void {
    if (rt.redline !== null || rt.removed || !hooked(rt) || rt.state === 'stopped' || rt.transition !== null) return;
    const wasWorking = rt.state === 'working';
    rt.redline = byHand ? (detail === undefined ? HOLD_REASON : `${HOLD_REASON}: ${detail.replace(/\s+/g, ' ').slice(0, 200)}`) : `redline: ${reason}`;
    saveHolds();
    if (byHand) log.info(`${rt.record.name} is on hold`);
    else log.warn(`${rt.record.name} tripped the redline: ${reason}`);
    if (wasWorking && !io.press?.(rt.record.name, rt.generation, ESC)) {
      log.warn(`could not interrupt ${rt.record.name}`);
    }
    setState(rt, 'needs_you');
    syncHolds(rt);
    if (!byHand) io.notify?.('redline', `${rt.record.name}: ${reason}`);
  }

  /** The automatic detectors trip only when they are on; a Propellant limit trips through Hub.trip either way. */
  function detect(rt: Rt, reason: string | null): void {
    if (reason !== null && options.redline !== false) tripRt(rt, reason);
  }

  /** The running subagents of an agent, without the ones silent for too long. */
  function subagentsOf(rt: Rt): SubagentsView {
    const types: Record<string, number> = {};
    for (const [id, one] of rt.subagents) {
      if (io.now() - one.seen >= SUBAGENT_STALE_MS) rt.subagents.delete(id);
      else types[one.type] = (types[one.type] ?? 0) + 1;
    }
    return { running: rt.subagents.size, started: rt.subagentsStarted, types };
  }

  function repeatReason(rt: Rt, payload: Record<string, unknown>): string | null {
    let input = '';
    try {
      input = JSON.stringify(payload.tool_input) ?? '';
    } catch {
      input = '';
    }
    const sig = `${String(payload.tool_name)}\n${input.slice(0, REPEAT_SIG_CHARS)}`;
    // a loop is the same call over and over by the same agent: the calls of parallel subagents do not break or make one
    const key = whoOf(payload);
    const before = rt.repeat.get(key);
    const now: { sig: string; count: number } = before?.sig === sig ? { sig, count: before.count + 1 } : { sig, count: 1 };
    rt.repeat.set(key, now);
    if (rt.repeat.size > SUBAGENTS_MAX) rt.repeat.delete(rt.repeat.keys().next().value as string);
    return now.count >= REDLINE_REPEATS ? `loop: ${rt.doing ?? 'the same tool'} ${now.count} times in a row${key === 'main' ? '' : ' (a subagent)'}` : null;
  }

  function trip(name: string, reason: string): void {
    const rt = lookup(name);
    tripRt(rt, reason);
    flush(rt);
  }

  function hold(name: string, reason?: string): AgentView {
    assertOpen();
    const rt = lookup(name);
    const who = rt.record.name;
    if (!hooked(rt)) throw new HubError('conflict', `${who} reports no hooks, so gonogo cannot hold it`);
    if (rt.redline !== null) throw new HubError('conflict', isHoldReason(rt.redline) ? `${who} is already on hold` : `${who} has tripped the redline: resume or stop it`);
    if (rt.state === 'needs_you' && rt.transition === null) throw new HubError('conflict', `${who} needs you: answer it first`);
    if ((rt.state !== 'idle' && rt.state !== 'working') || rt.transition !== null) throw new HubError('conflict', `${who} is not running`);
    tripRt(rt, HOLD_REASON, true, reason);
    flush(rt);
    return buildView(rt);
  }

  function resume(name: string): AgentView {
    assertOpen();
    const rt = lookup(name);
    if (rt.redline === null) throw new HubError('conflict', `${rt.record.name} has not tripped the redline`);
    clearRedline(rt);
    // Escape left claude at its prompt; the hooks and the sweep correct this if it is not.
    setState(rt, 'idle');
    syncHolds(rt);
    if (rt.queue.length > 0) scheduleDelivery(rt, DELIVERY_SETTLE_MS);
    flush(rt);
    return buildView(rt);
  }

  function holdAll(): HoldAllResult {
    assertOpen();
    const out: HoldAllResult = { held: [], skipped: [] };
    for (const rt of sortedAgents()) {
      try {
        hold(rt.record.name);
        out.held.push(rt.record.name);
      } catch {
        // stopped, already held, at a dialog or without hooks: left as it is
        if (rt.state !== 'stopped' && !isHoldReason(rt.redline)) out.skipped.push(rt.record.name);
      }
    }
    return out;
  }

  function resumeAll(): ResumeAllResult {
    assertOpen();
    const resumed: string[] = [];
    for (const rt of sortedAgents()) {
      if (!isHoldReason(rt.redline)) continue;
      resume(rt.record.name);
      resumed.push(rt.record.name);
    }
    return { resumed };
  }

  function refreshLimits(): void {
    for (const rt of agents.values()) {
      if (rt.queue.length > 0) scheduleDelivery(rt, DELIVERY_COALESCE_MS);
    }
    publishGovernor();
  }

  /** Telemetry: every tool hook goes to the recorder; a failure there never touches the hub's own handling. */
  function toolHook(rt: Rt, event: HookEvent, payload: Record<string, unknown>): void {
    // a tool event of a subagent says it is alive
    const who = whoOf(payload);
    const one = who === 'main' ? undefined : rt.subagents.get(who);
    if (one !== undefined) one.seen = io.now();
    try {
      if (io.featureOn?.('telemetry') !== false) io.toolHook?.(rt.record.name, event, payload);
    } catch (error) {
      log.warn('telemetry failed', error);
    }
  }

  /** Propellant reads the transcript at most every METER_INTERVAL_MS on a tool hook, and at every Stop. */
  function meter(rt: Rt, payload: Record<string, unknown>, force: boolean): void {
    const path = payload.transcript_path;
    // Propellant reads Claude Code transcripts only.
    if (!io.meter || !isClaude(rt) || typeof path !== 'string' || path === '') return;
    const now = io.now();
    if (!force && now - rt.meteredAt < METER_INTERVAL_MS) return;
    rt.meteredAt = now;
    try {
      io.meter(rt.record.name, rt.generation, path);
    } catch (error) {
      log.warn('meter failed', error);
    }
  }

  /* ---- the delivery check (contract 5.3) ---- */

  function deliveryCheck(rt: Rt): void {
    if (rt.removed || rt.transition !== null || rt.state === 'stopped' || rt.queue.length === 0) return;
    const name = rt.record.name;
    expireDraft(rt, io.now());
    // Latches first, whatever the state: a working recipient with a draft must read `held`, not `is working`.
    if (holdNote(rt) !== null) {
      syncHolds(rt);
      return;
    }
    if (rt.state === 'starting' || rt.state === 'needs_you' || rt.state === 'working') {
      setWaitNotes(rt, waitNote(rt));
      return;
    }
    if (rt.pendingConfirm) return;
    const loadNote = loadLimitNote(rt);
    if (loadNote !== null) {
      setWaitNotes(rt, loadNote);
      return;
    }
    // Another CLI's screen is not read: its idle state (from a hook, or from quiet output) is the only gate.
    if (isClaude(rt)) {
      const probe = screenOf(rt);
      if (probe === null) return;
      // a pointer typed into a console with no login answers nothing: the mail waits for the Director's /login
      if (!rt.hooksSeen && (probe.signedOut === true || probe.authRejected === true)) {
        setWaitNotes(rt, probe.authRejected === true ? `waiting: ${name}'s credential was rejected` : `waiting: ${name} isn't signed in`);
        return;
      }
      const notReady = `waiting: ${name} is not ready for input`;
      // the hooks are the authority: idle by the Stop hook for TITLE_STALE_MS, a title that still says working is a spinner Claude Code left behind
      // and a title that is still changing is a spinner that is alive (another plugin's Stop hook can start a turn the hooks never announce): only one that has not changed its text for as long is stale
      const live = titleOf(rt);
      const glyph = live?.glyph === 'working' && rt.state === 'idle' && io.now() - rt.stateSince >= TITLE_STALE_MS && io.now() - (live.textSince ?? live.since) >= TITLE_STALE_MS ? 'stale' : live?.glyph;
      if (!probe.promptBox || probe.dialog !== null || glyph === 'working') {
        // Nobody's mail waits unseen on a screen that shows nothing wrong, and the Director is told when his own words do: a screen gonogo cannot read (no prompt box where claude's input is) would hold them for ever.
        const first = queued(rt).find((record) => record.from === 'user');
        const waited = first === undefined ? 0 : io.now() - first.at;
        if (first !== undefined && waited >= DIRECTOR_STUCK_ALERT_MS && rt.stuckAlerted !== first.id) {
          rt.stuckAlerted = first.id;
          const why = probe.dialog !== null ? `a ${probe.dialog} dialog is on its screen` : !probe.promptBox ? 'gonogo cannot see its input box' : 'its window title says it is working';
          log.warn(`the Director's message ${first.id} has waited ${Math.round(waited / 1000)} s for ${name}: ${why}`);
          io.notify?.('redline', `Your message to ${name} has waited ${Math.round(waited / 60_000)} min: ${why}. Open its terminal.`);
        }
        // Only a screen that shows nothing wrong is forced: no dialog, no working glyph, and the hooks say idle.
        const oldest = queued(rt)[0];
        if (oldest !== undefined && io.now() - oldest.at >= DIRECTOR_STUCK_FORCE_MS && rt.stuckLogged !== oldest.id) {
          rt.stuckLogged = oldest.id;
          // which of the three checks failed, once per wait (the screen's own lines are not here: the probe is a summary, the pty host keeps the rest)
          log.warn(`mail for ${name} has waited ${Math.round((io.now() - oldest.at) / 1000)} s on a screen that is not ready: promptBox=${String(probe.promptBox)} dialog=${String(probe.dialog)} titleGlyph=${String(glyph)} state=${rt.state} screen=${String(probe.cols)}x${String(probe.rows)} promptText=${JSON.stringify((probe.promptText ?? '').slice(0, 80))}`);
        }
        const force = oldest !== undefined && io.now() - oldest.at >= DIRECTOR_STUCK_FORCE_MS && probe.dialog === null && probe.modal !== true && glyph !== 'working' && rt.state === 'idle';
        if (!force) {
          setWaitNotes(rt, notReady);
          return;
        }
        log.warn(`typing the pointer for the Director's message into ${name} although no input box is on its screen (idle by its hooks for ${Math.round(waited / 1000)} s)`);
      }
    }
    const records = queued(rt);
    if (records.length === 0) return;
    const text = typedText(rt, records);
    let typed = false;
    try {
      typed = io.typePointer(name, rt.generation, text);
    } catch (error) {
      log.warn(`could not type the pointer into ${name}`, error);
    }
    if (!typed) {
      // A pty host that outlived a reload may still cap a pointer at the old 500 characters: a line with the Director's words over that is refused for ever. Those words are dropped, so the next sweep types the plain pointer.
      if (text.length > LEGACY_POINTER_MAX_CHARS && text !== pointerText(records)) {
        for (const record of records) directorTurns.delete(record.id);
        log.warn(`the pointer with the Director's words for ${name} was refused (${text.length} characters; a pty host from before may take only ${LEGACY_POINTER_MAX_CHARS}): typing the pointer alone`);
      }
      log.debug(`the pointer for ${name} was not written; the next sweep tries again`);
      return;
    }
    if (!hooked(rt)) {
      // No hook can confirm it: typed is delivered. shortcut: an unread pointer is not typed again, upgrade when such a CLI gets hooks.
      markDelivered(rt, [...rt.queue], 'pointer typed');
      return;
    }
    const confirm: PendingConfirm = { text, ids: [...rt.queue], at: io.now(), timer: { handle: undefined } };
    confirm.timer = armTimer(rt, PROMPT_SUBMIT_CONFIRM_MS, () => confirmTimedOut(rt, confirm));
    rt.pendingConfirm = confirm;
    for (const id of confirm.ids) {
      const record = messages.get(id);
      if (record) setMessage(record, 'queued', 'waiting: confirming the pointer');
    }
  }

  /** The 2 s rule: no UserPromptSubmit for the typed pointer. The message is held and nothing is typed again (5.4). */
  function confirmTimedOut(rt: Rt, confirm: PendingConfirm): void {
    if (rt.pendingConfirm !== confirm) return;
    rt.pendingConfirm = null;
    const ids = confirm.ids.filter((id) => rt.queue.includes(id));
    if (ids.length === 0) return;
    const name = rt.record.name;
    const info = titleOf(rt);
    let note = 'held: pointer not confirmed within 2 s';
    if (!rt.hooksSeen && info !== null && info.glyph === 'working' && info.since >= confirm.at) {
      note = `held: no hook has reached gonogo from ${name}; is its folder trusted?`;
      log.warn(`no hook has reached gonogo from ${name}; is its folder trusted?`);
    }
    rt.unconfirmed = { text: confirm.text, ids, since: io.now(), note };
    syncHolds(rt);
  }

  /** The UserPromptSubmit of the typed pointer (or of a late one): its messages are delivered (contract 5.4). */
  function confirmPointer(rt: Rt, ids: readonly string[]): void {
    cancelConfirm(rt);
    rt.unconfirmed = null;
    markDelivered(rt, ids, 'pointer typed');
  }

  /* ---- hooks (contract 4.4, 5.5) ---- */

  function onHook(input: HookInput): HookReply {
    try {
      return handleHook(input);
    } catch (error) {
      log.error('hook handler failed', error);
      return {};
    }
  }

  function handleHook(input: HookInput): HookReply {
    const rt = agents.get(input.agent);
    if (!rt || input.generation !== rt.generation || !hooked(rt)) return {};
    if (!(HOOK_EVENTS as readonly string[]).includes(input.event)) return {};
    rt.hooksSeen = true;
    // P1 and P2: a process that is going away, or gone, says nothing that matters.
    if (rt.transition !== null || rt.state === 'stopped') return {};
    // P3: a hook proves the REPL is up (claude holds hooks back until the dialogs are answered).
    if (rt.state === 'starting' || (rt.state === 'needs_you' && rt.needsKind === 'startup_dialog')) markReady(rt);
    const payload = isRecord(input.payload) ? input.payload : {};
    let reply: HookReply = {};
    switch (input.event) {
      case 'UserPromptSubmit':
        onPromptSubmit(rt, payload);
        break;
      case 'PreToolUse':
        toolHook(rt, input.event, payload);
        rt.doing = describeDoing(payload.tool_name, payload.tool_input);
        onToolHook(rt);
        detect(rt, repeatReason(rt, payload));
        meter(rt, payload, false);
        break;
      case 'PostToolUse':
        toolHook(rt, input.event, payload);
        onToolHook(rt);
        break;
      case 'PostToolUseFailure':
        toolHook(rt, input.event, payload);
        onToolHook(rt);
        {
          const key = whoOf(payload);
          const failed = rt.toolFailAt.get(key) ?? [];
          rt.toolFailAt.set(key, failed);
          if (rt.toolFailAt.size > SUBAGENTS_MAX) rt.toolFailAt.delete(rt.toolFailAt.keys().next().value as string);
          if (countRecent(failed, io.now(), REDLINE_TOOL_FAILURE_WINDOW_MS) >= REDLINE_TOOL_FAILURES) {
            detect(rt, `error storm: ${failed.length} failed tool calls in 2 min${key === 'main' ? '' : ' (a subagent)'}`);
          }
        }
        break;
      case 'PermissionRequest': {
        // a dialog a subagent opened is the parent's to answer: the reason says who asked
        // agent_type also comes on a main session started with --agent: only a hook with an agent_id is a helper's
        const asker = whoOf(payload) !== 'main' && typeof payload.agent_type === 'string' && payload.agent_type !== '' ? ` (subagent ${cutText(collapseWhitespace(payload.agent_type), 40)})` : '';
        const reason = describePermission(payload.tool_name, payload.tool_input) + asker;
        // the same dialog twice (a repeated hook) is one dialog: no new number, no new event
        const repeated = rt.state === 'needs_you' && rt.needsKind === 'permission' && rt.needsReason === reason;
        if (!repeated) rt.needSeq += 1;
        setState(rt, 'needs_you', { kind: 'permission', reason });
        // one event for each dialog, unless a Hold or a trip has taken over the state (that one is not a dialog the Director can answer)
        if (!repeated && rt.needsKind === 'permission') io.notify?.('permission', `${rt.record.name} asks: ${reason.slice(PERMISSION_PREFIX.length)}`, { kind: 'permission', agent: rt.record.name, seq: rt.needSeq });
        break;
      }
      case 'Notification':
        onNotification(rt, payload);
        break;
      case 'SubagentStart': {
        const id = typeof payload.agent_id === 'string' && payload.agent_id !== '' && payload.agent_id.length <= 64 ? payload.agent_id : null;
        if (id !== null && (rt.subagents.size < SUBAGENTS_MAX || rt.subagents.has(id))) {
          // a second start of an id (a resume of the subagent) is the same subagent
          if (!rt.subagents.has(id)) rt.subagentsStarted += 1;
          const type = typeof payload.agent_type === 'string' && payload.agent_type !== '' ? cutText(collapseWhitespace(payload.agent_type), 40) : 'agent';
          rt.subagents.set(id, { type, seen: io.now() });
        }
        break;
      }
      case 'SubagentStop':
        // a stop with no start is normal: Claude Code's own helpers (prompt suggestions, /btw) stop without one
        if (typeof payload.agent_id === 'string') rt.subagents.delete(payload.agent_id);
        meter(rt, payload, true);
        break;
      case 'Stop':
        reply = onStop(rt);
        meter(rt, payload, true);
        try {
          io.stopped?.(rt.record.name);
        } catch (error) {
          log.warn('stopped hook failed', error);
        }
        break;
      case 'StopFailure':
        onStopFailure(rt);
        if (countRecent(rt.apiErrorAt, io.now(), REDLINE_API_ERROR_WINDOW_MS) >= REDLINE_API_ERRORS) {
          detect(rt, `error storm: ${rt.apiErrorAt.length} API errors in 10 min`);
        }
        meter(rt, payload, true);
        break;
    }
    flush(rt);
    return reply;
  }

  function onPromptSubmit(rt: Rt, payload: Record<string, unknown>): void {
    const prompt = (typeof payload.prompt === 'string' ? payload.prompt : '').replace(/\r\n?/g, '\n').trim();
    let ours = false;
    // `ends with`, not `equals`: a pointer pasted after text that was still in the box is delivered all the same.
    if (rt.pendingConfirm && prompt.endsWith(rt.pendingConfirm.text)) {
      confirmPointer(rt, rt.pendingConfirm.ids);
      ours = true;
    } else if (rt.unconfirmed && prompt.endsWith(rt.unconfirmed.text)) {
      confirmPointer(rt, rt.unconfirmed.ids);
      ours = true;
    }
    if (!ours) {
      // The Director typed into the terminal of a tripped agent: they took over, so the trip is over.
      if (rt.redline !== null) clearRedline(rt);
      // A person submitted something else: the old trigger no longer says what this turn is about, and a pointer
      // that sat in the box was either submitted with it or is gone.
      rt.trigger = null;
      rt.unconfirmed = null;
    }
    setState(rt, 'working');
    rt.stopBlocks = 0;
    // After the state change, so a released message gets the wait note of the state it will really wait in.
    syncHolds(rt);
    if (rt.queue.length > 0) scheduleDelivery(rt, DELIVERY_SETTLE_MS);
    const session = payload.session_id;
    if (isClaude(rt) && typeof session === 'string' && UUID_RE.test(session) && session !== rt.record.sessionId) {
      // claude started a new session (/clear): the next resume must name it.
      rt.record.sessionId = session;
      void saveRecords(rosterRecords()).catch((error: unknown) => log.error('could not save the new session id', error));
    }
  }

  function onToolHook(rt: Rt): void {
    rt.stopBlocks = 0;
    if (rt.state === 'idle' || rt.state === 'working') {
      setState(rt, 'working');
    } else if (rt.state === 'needs_you') {
      // A sibling tool of the same batch ended while the dialog is still open: stay. A tool the user allowed shows no
      // hook until it ends, so R4 is the way out for that case.
      const probe = isClaude(rt) ? screenOf(rt) : null;
      if (probe === null || probe.dialog === null) setState(rt, 'working');
    }
  }

  function onNotification(rt: Rt, payload: Record<string, unknown>): void {
    const type = payload.notification_type;
    if (type === 'permission_prompt') {
      // The Notification comes about 6 s after the dialog opened: one that arrives after the user answered it, or while
      // the screen cannot be read, must not bring needs_you back.
      if (rt.state !== 'needs_you' && screenOf(rt)?.dialog) {
        setState(rt, 'needs_you', { kind: 'permission', reason: 'permission request: waiting for approval' });
      }
    } else if (type === 'ToolPermission') {
      // Gemini CLI sends this when its confirmation opens, with a message instead of the tool call.
      const message = typeof payload.message === 'string' ? cutText(collapseWhitespace(payload.message), PERMISSION_SUMMARY_CHARS) : '';
      setState(rt, 'needs_you', { kind: 'permission', reason: message === '' ? 'permission request: waiting for approval' : `permission request: ${message}` });
    } else if (type === 'elicitation_dialog' || type === 'agent_needs_input') {
      const message = typeof payload.message === 'string' ? cutText(payload.message, INPUT_REASON_CHARS) : '';
      setState(rt, 'needs_you', {
        kind: 'input',
        reason: message === '' ? 'input requested' : `input requested: ${message}`,
      });
    }
  }

  function onStop(rt: Rt): HookReply {
    const now = io.now();
    rt.trigger = null;
    redeliver(rt);
    // The state is written once, at the end, so a block never shows a transient idle.
    const candidates = rt.queue.filter((id) => !inFlight(rt, id));
    if (candidates.length === 0 || rt.redline !== null) {
      syncHolds(rt);
      setState(rt, 'idle');
      return {};
    }
    expireDraft(rt, now);
    if (rt.draft) {
      syncHolds(rt);
      setState(rt, 'idle');
      scheduleDelivery(rt, DELIVERY_SETTLE_MS);
      return {};
    }
    if (rt.unconfirmed) {
      setState(rt, 'idle');
      return {};
    }
    if (rt.stopBlocks >= MAX_STOP_BLOCKS) {
      // Claude Code ignores the ninth consecutive block: let the agent go idle and type the pointer instead.
      setState(rt, 'idle');
      scheduleDelivery(rt, DELIVERY_SETTLE_MS);
      return {};
    }
    // The Director's own words are only his turn when they are TYPED: a block reason is hook output. So the first Stop lets the agent go idle and the delivery check types them.
    const wanted = candidates.filter((id) => directorTurnOf(rt, id) !== undefined && !directorDeferred.has(id));
    if (wanted.length > 0 && isClaude(rt)) {
      for (const id of wanted) directorDeferred.add(id);
      setState(rt, 'idle');
      scheduleDelivery(rt, DELIVERY_SETTLE_MS);
      return {};
    }
    const records = candidates.map((id) => messages.get(id)).filter((record): record is MessageRecord => !!record);
    const text = pointerText(records);
    markDelivered(rt, candidates, 'handed over when its turn ended');
    rt.stopBlocks += 1;
    rt.lastBlockAt = now;
    setState(rt, 'working');
    return { decision: 'block', reason: text };
  }

  function onStopFailure(rt: Rt): void {
    rt.trigger = null;
    rt.stopBlocks = 0;
    setState(rt, 'idle');
    redeliver(rt);
    if (rt.queue.length > 0) scheduleDelivery(rt, DELIVERY_SETTLE_MS);
  }

  /* ---- reconciliation (contract 4.7) ---- */

  function endTurnUnseen(rt: Rt): void {
    rt.trigger = null;
    rt.stopBlocks = 0;
    redeliver(rt);
  }

  function reconcile(rt: Rt, now: number): void {
    const info = titleOf(rt);
    const probe = screenOf(rt);
    // Claude Code with no login looks idle (a box, a quiet title) and answers nothing: it is the Director's to fix, not a ready agent
    rt.authRejected = !rt.hooksSeen && probe?.authRejected === true;
    rt.signedOut = !rt.hooksSeen && (probe?.signedOut === true || rt.authRejected);
    // a Claude Code with no login, or a refused one, never fires a hook: once any hook has come the words on the screen are the transcript's, not a state
    if (rt.signedOut && (rt.state === 'starting' || rt.state === 'idle')) {
      log.warn(`${rt.record.name} ${rt.authRejected ? 'has a credential that Claude Code rejected' : 'is not signed in to Claude Code'}`);
      setState(rt, 'needs_you', { kind: 'dialog', reason: rt.authRejected ? AUTH_REJECTED_REASON : SIGNED_OUT_REASON });
    }
    // How long the glyph has disagreed with the state, not how long the glyph class has existed: a Stop sets idle at
    // once while the title still shows the working glyph for 10 to 30 ms, and the glyph's age is the whole turn.
    const since = info ? Math.max(info.since, rt.stateSince) : now;
    if (rt.state === 'working') {
      const blockedRecently = rt.lastBlockAt !== null && now - rt.lastBlockAt < TITLE_IDLE_RECONCILE_MS;
      if (probe && info?.glyph === 'idle' && now - since >= TITLE_IDLE_RECONCILE_MS && !blockedRecently) {
        if (probe.dialog !== null) setState(rt, 'needs_you', { kind: 'dialog', reason: SCREEN_DIALOG_REASON });
        else setState(rt, 'idle');
        endTurnUnseen(rt);
      }
    } else if (rt.state === 'idle') {
      if (info?.glyph === 'working' && now - since >= TITLE_WORKING_CONFIRM_MS) setState(rt, 'working');
    } else if (rt.state === 'needs_you' && rt.needsKind !== 'startup_dialog' && !rt.signedOut) {
      if (probe && info && probe.promptBox && probe.dialog === null && info.glyph === 'idle') {
        // R2: the dialog was answered without a hook (denied, Esc). The title alone proves nothing, it shows the idle
        // glyph while a permission dialog is open; the screen says the dialog is gone.
        if (rt.screenClearSince === null) rt.screenClearSince = now;
        if (now - rt.screenClearSince >= NEEDS_YOU_CLEAR_MS) {
          setState(rt, 'idle');
          endTurnUnseen(rt);
        }
      } else {
        rt.screenClearSince = null;
        if (
          rt.needsKind !== 'input' &&
          probe &&
          probe.dialog === null &&
          info?.glyph === 'working' &&
          now - since >= TITLE_WORKING_CONFIRM_MS
        ) {
          // R4: the user allowed the tool. The turn resumes, but no hook fires until the tool ends.
          setState(rt, 'working');
        }
      }
    }
    expireDraft(rt, now);
    screenProof(rt, now, probe);
    if (rt.queue.length > 0) deliveryCheck(rt);
  }

  /** A custom command has no hooks: its output counter is the only sign of life (more output = working, quiet = idle). */
  function reconcileCustom(rt: Rt, now: number): void {
    const bytes = outputBytesOf(rt);
    const sample = rt.custom;
    if (bytes > sample.bytes) sample.activeAt = now;
    sample.bytes = bytes;
    if (sample.activeAt !== null) setState(rt, now - sample.activeAt < CUSTOM_ACTIVE_MS ? 'working' : 'idle');
    else if (now - sample.since >= CUSTOM_START_MS) setState(rt, 'idle');
  }

  function sweep(): void {
    const now = io.now();
    for (const rt of [...agents.values()]) {
      if (rt.removed || rt.transition !== null || rt.state === 'stopped') continue;
      guarded(`sweep of ${rt.record.name}`, () => {
        if (!hooked(rt)) {
          reconcileCustom(rt, now);
          if (mailable(rt) && rt.queue.length > 0) deliveryCheck(rt);
        } else if (isClaude(rt)) reconcile(rt, now);
        else {
          // Gemini CLI: its hooks alone move the state; the sweep ends a stale draft and retries the mail.
          expireDraft(rt, now);
          if (rt.queue.length > 0) deliveryCheck(rt);
        }
        flush(rt);
      });
    }
  }

  function armSweep(): void {
    if (closing) return;
    sweepTimer = { handle: undefined };
    sweepTimer.handle = io.setTimer(() => {
      sweepTimer = null;
      guarded('sweep', sweep);
      armSweep();
    }, RECONCILE_TICK_MS);
  }

  /* ---- terminal events (contract 4.3, 4.9) ---- */

  function onTerminalEvent(event: TerminalEvent): void {
    guarded('terminal event', () => {
      const rt = isRecord(event) ? agents.get(event.name) : undefined;
      if (!rt || event.generation !== rt.generation) return;
      if (event.kind === 'ready') {
        if (!isClaude(rt) || rt.transition !== null || rt.state === 'stopped') return;
        rt.ready = true;
        if (rt.state === 'starting' || (rt.state === 'needs_you' && rt.needsKind === 'startup_dialog')) markReady(rt);
      } else if (event.kind === 'exit') {
        handleExit(rt, event.info);
      }
      // `title` carries nothing the sweep does not read from io.title itself.
      flush(rt);
    });
  }

  function adopt(running: Array<{ name: string; generation: number }>, holds: Record<string, string>): { adopted: string[]; unknown: string[] } {
    const adopted: string[] = [];
    const unknown: string[] = [];
    for (const item of running) {
      const rt = agents.get(item.name);
      if (!rt || rt.removed || rt.state !== 'stopped') {
        unknown.push(item.name);
        continue;
      }
      guarded('adopt', () => {
        rt.generation = item.generation;
        clearRedline(rt);
        rt.exit = null;
        rt.ready = true;
        rt.hooksSeen = false;
        rt.flag = null;
        rt.running = { role: rt.record.role, dir: rt.record.dir, mode: rt.record.mode, command: rt.record.command ?? null, payload: payloadKey(rt.record), cleanRoom: cleanRoomKey(rt.record), worktree: worktreeKey(rt.record), remoteControl: remoteKey(rt.record), permissions: rulesKey(rt.record), coauthor: coauthorKey(rt.record), engine: engineKey(rt.record) };
        const saved = holds[item.name];
        const probe = screenOf(rt);
        // errs toward needs_you, never toward idle by guess: a saved hold or trip, then a dialog, then a screen that cannot be read yet
        if (typeof saved === 'string' && saved !== '') {
          rt.redline = saved;
          setState(rt, 'needs_you');
        } else if (probe?.dialog) {
          setState(rt, 'needs_you', { kind: 'dialog', reason: 'a dialog was open when gonogo reloaded' });
        } else {
          // the input box is drawn during a turn too, so it says nothing; the window title does (an unreadable one counts as working)
          setState(rt, titleOf(rt)?.glyph === 'idle' ? 'idle' : 'working');
        }
        syncHolds(rt);
        if (rt.state === 'idle' && rt.queue.length > 0) scheduleDelivery(rt, DELIVERY_SETTLE_MS);
        flush(rt);
        adopted.push(item.name);
      });
    }
    saveHolds();
    return { adopted, unknown };
  }

  function lastLine(text: string): string {
    const lines = text.split('\n').map((line) => line.trim());
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (lines[index] !== '') return lines[index] ?? '';
    }
    return '';
  }

  function exitText(info: ExitInfo): string {
    if (info.requested) return 'stopped';
    const base =
      info.signal !== null
        ? `killed by signal ${info.signal}`
        : info.code !== null
          ? `exited with code ${info.code}`
          : 'exited';
    const detail = lastLine(info.tail);
    return detail === '' ? base : `${base}: ${detail}`;
  }

  /** The flag to retry with, when this exit is the one wrong-flag failure the hub corrects (contract 4.9 step 1). */
  function flipFlag(rt: Rt, info: ExitInfo): SessionFlag | null {
    if (closing || rt.transition !== null || info.requested || info.code !== 1) return null;
    if (!(info.durationMs < SESSION_FLIP_WINDOW_MS) || !rt.flipAvailable || rt.flag === null) return null;
    // Exit 1 within 3 s is also what a refused flag, root refusing bypassPermissions or a bad cwd look like: only
    // claude's own message for the flag that was used says the session id was the problem.
    const message = rt.flag === 'session-id' ? SESSION_IN_USE_TEXT : SESSION_MISSING_TEXT;
    if (!info.tail.includes(message)) return null;
    return rt.flag === 'session-id' ? 'resume' : 'session-id';
  }

  function handleExit(rt: Rt, raw: ExitInfo): void {
    const generation = rt.generation;
    if (rt.exitSeen === generation) return;
    rt.exitSeen = generation;
    const info: ExitInfo = {
      code: typeof raw?.code === 'number' ? raw.code : null,
      signal: typeof raw?.signal === 'number' ? raw.signal : null,
      durationMs: typeof raw?.durationMs === 'number' ? raw.durationMs : Number.POSITIVE_INFINITY,
      requested: raw?.requested === true,
      tail: typeof raw?.tail === 'string' ? raw.tail : '',
    };
    const name = rt.record.name;
    cancelTimers(rt);
    rt.ready = false;
    rt.draft = null;
    rt.unconfirmed = null;
    rt.trigger = null;
    rt.stopBlocks = 0;
    rt.screenClearSince = null;

    const retry = flipFlag(rt, info);
    if (retry !== null) {
      // Nothing else changes: no stopped flash, the queue stays, the retry runs on the agent's own lifecycle queue.
      rt.flipAvailable = false;
      log.info(`${name}: the session flag was wrong, trying ${retry}`);
      void enqueue(rt, 'flip', () => spawnOp(rt, retry, false)).catch((error: unknown) =>
        log.error(`the flag retry of ${name} failed`, error),
      );
      return;
    }

    // an exit nobody asked for keeps the hold in the file (see lostHolds)
    if (!info.requested && rt.redline !== null) lostHolds.set(rt.record.name, rt.redline);
    setState(rt, 'stopped');
    pollEntryStopped(name);
    rt.subagents.clear();
    rt.exit = { code: info.code, signal: info.signal, at: io.now(), requested: info.requested, text: exitText(info) };
    if (!closing) {
      if (rt.transition === 'restarting') {
        keepQueueForRestart(rt);
      } else {
        const gone = rt.transition === 'removing' ? 'was removed before reading it' : 'stopped before reading it';
        undeliverUnread(rt, `${name} ${gone}; the message went to the user`);
      }
    }
    // The stop operation resolves on this; removing and restarting carry on with their own steps.
    if (rt.transition === 'stopping') rt.transition = null;
  }

  /** A restart keeps every unread message for the new process; the ones it had already pointed at start over. */
  function keepQueueForRestart(rt: Rt): void {
    const name = rt.record.name;
    const unread = unreadFor(name);
    rt.pointed.clear();
    for (const record of unread) {
      if (record.status === 'delivered') setMessage(record, 'queued', 'restarted before it was read');
      else setMessage(record, 'queued', `waiting: ${name} is restarting`);
    }
    rt.queue = unread.map((record) => record.id);
  }

  /* ---- lifecycle: the per-agent queue ---- */

  function enqueue<T>(rt: Rt, kind: OpKind, run: () => Promise<T>, dedupe = false): Promise<T> {
    if (dedupe) {
      // A double-clicked Restart or Stop resolves with the pending one instead of running twice.
      const tail = rt.ops.length > 0 ? rt.ops[rt.ops.length - 1] : rt.current;
      if (tail && tail.kind === kind) return tail.promise as Promise<T>;
    }
    let resolve: (value: unknown) => void = () => undefined;
    let reject: (reason: unknown) => void = () => undefined;
    const promise = new Promise<unknown>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    rt.ops.push({ kind, run, resolve, reject, promise });
    if (!rt.draining) void drain(rt);
    return promise as Promise<T>;
  }

  /** Runs the queue; the first operation of an idle agent starts synchronously, so its first step is visible at once. */
  async function drain(rt: Rt): Promise<void> {
    rt.draining = true;
    try {
      for (let op = rt.ops.shift(); op; op = rt.ops.shift()) {
        rt.current = op;
        try {
          op.resolve(await op.run());
        } catch (error) {
          op.reject(error);
        }
      }
    } finally {
      rt.current = null;
      rt.draining = false;
    }
  }

  /** Prepares the new generation and returns it. Synchronous: routing sees the new state from the first line (4.9). */
  function beginSpawn(rt: Rt, flag: SessionFlag | null, userInitiated: boolean): number {
    rt.generation += 1;
    clearRedline(rt);
    rt.subagents.clear();
    rt.subagentsStarted = 0;
    if (rt.transition === 'restarting') rt.transition = null;
    // The first spawn of an agent that never ran: its history starts at `starting`, not at a `stopped` that lasted no time.
    if (rt.generation === 1) rt.history = [];
    setState(rt, 'starting');
    rt.ready = false;
    rt.draft = null;
    rt.unconfirmed = null;
    cancelConfirm(rt);
    rt.trigger = null;
    rt.stopBlocks = 0;
    rt.doing = null;
    rt.exit = null;
    rt.hooksSeen = false;
    rt.pointed.clear();
    rt.screenClearSince = null;
    rt.lastBlockAt = null;
    rt.running = { role: rt.record.role, dir: rt.record.dir, mode: rt.record.mode, command: rt.record.command ?? null, payload: payloadKey(rt.record), cleanRoom: cleanRoomKey(rt.record), worktree: worktreeKey(rt.record), remoteControl: remoteKey(rt.record), permissions: rulesKey(rt.record), coauthor: coauthorKey(rt.record), engine: engineKey(rt.record) };
    rt.flag = flag;
    // The browser reacts to a new generation by attaching, so the frame waits until the process exists in the terminal host.
    rt.frameHold = true;
    if (!hooked(rt)) {
      // No startup dialog and no session flag to correct: the first output (or CUSTOM_START_MS) ends `starting`.
      // The terminal host counts every spawn from 0.
      rt.custom = { bytes: 0, activeAt: null, since: io.now() };
      return rt.generation;
    }
    if (userInitiated) rt.flipAvailable = true;
    armStartup(rt, STARTUP_READY_TIMEOUT_MS);
    return rt.generation;
  }

  async function spawnOp(rt: Rt, flag: SessionFlag | null, userInitiated: boolean): Promise<void> {
    assertOpen();
    const name = rt.record.name;
    const generation = beginSpawn(rt, flag, userInitiated);
    let failure: string | null = null;
    try {
      const spawned = await io.spawn({ agent: { ...rt.record }, generation, flag });
      rt.flag = spawned.flag;
      log.debug(`${name}: started generation ${generation} (pid ${spawned.pid})`);
    } catch (error) {
      failure = errorMessage(error);
    }
    rt.frameHold = false;
    if (failure !== null && rt.generation === generation) {
      log.warn(`${name} could not start: ${failure}`);
      cancelTimers(rt);
      rt.ready = false;
      setState(rt, 'stopped');
      rt.exit = { code: null, signal: null, at: io.now(), requested: false, text: `could not start: ${failure}` };
      undeliverUnread(rt, `${name} could not start; the message went to the user`);
    }
    flush(rt);
  }

  /** Asks the terminal host to stop the process of the current generation and makes sure the hub has seen it exit. */
  async function stopProcess(rt: Rt): Promise<void> {
    const generation = rt.generation;
    try {
      await io.stop(rt.record.name, generation);
    } catch (error) {
      log.warn(`stopping ${rt.record.name} failed`, error);
    }
    // The host delivers the exit event before stop() resolves; if it did not, the agent must not stay running here.
    if (rt.generation === generation && rt.state !== 'stopped' && rt.exitSeen !== generation) {
      handleExit(rt, { code: null, signal: null, durationMs: 0, requested: true, tail: '' });
    }
  }

  async function restartOp(rt: Rt): Promise<AgentView> {
    assertOpen();
    if (rt.removed) throw new HubError('not_found', 'unknown agent');
    if (rt.record.stoppedBy !== undefined) {
      delete rt.record.stoppedBy;
      await saveRecords(rosterRecords()).catch((error: unknown) => log.warn(`could not save that ${rt.record.name} was started`, error));
    }
    if (rt.state !== 'stopped') {
      rt.transition = 'restarting';
      flush(rt);
      // From here until the new process exists the agent shows no frame: the exit would otherwise flash `stopped`.
      rt.frameHold = true;
      await stopProcess(rt);
      if (closing) {
        if (rt.transition === 'restarting') rt.transition = null;
        rt.frameHold = false;
        flush(rt);
        return buildView(rt);
      }
    }
    await spawnOp(rt, null, true);
    return buildView(rt);
  }

  async function stopOp(rt: Rt): Promise<AgentView> {
    assertOpen();
    if (rt.removed) throw new HubError('not_found', 'unknown agent');
    // remembered across a restart: FLIGHT may bring back an agent, never one the Director stopped (an agent that crashed and is STOPped too)
    const remember = (): Promise<void> => {
      rt.record.stoppedBy = 'director';
      return saveRecords(rosterRecords()).catch((error: unknown) => log.warn(`could not save that ${rt.record.name} was stopped`, error));
    };
    if (rt.state === 'stopped') {
      await remember();
      return buildView(rt);
    }
    rt.transition = 'stopping';
    flush(rt);
    await stopProcess(rt);
    if (rt.transition === 'stopping') rt.transition = null;
    await remember();
    flush(rt);
    return buildView(rt);
  }

  async function removeOp(rt: Rt): Promise<void> {
    assertOpen();
    if (rt.removed) throw new HubError('not_found', 'unknown agent');
    if (rt.state !== 'stopped') {
      rt.transition = 'removing';
      flush(rt);
      await stopProcess(rt);
    }
    try {
      await saveRecords(rosterRecords().filter((record) => record.name !== rt.record.name));
    } catch (error) {
      rt.transition = null;
      flush(rt);
      throw error;
    }
    cancelTimers(rt);
    rt.removed = true;
    markRun(rt);
    agents.delete(rt.record.name);
    emit({ t: 'agent-removed', name: rt.record.name });
    publishGovernor();
    if (pollState !== null) {
      pollState.entries = pollState.entries.filter((entry) => entry.agent !== rt.record.name);
      if (pollState.entries.length === 0) pollState = null;
      else settlePoll();
      publishPoll();
    }
    try {
      await io.keys?.remove(rt.record.name);
    } catch (error) {
      log.warn(`could not remove the keys of ${rt.record.name}`, error);
    }
    // The process is gone (stopped above, or never ran): the terminal's mirror and scrollback can go too.
    try {
      io.forget?.(rt.record.name);
    } catch (error) {
      log.warn(`could not free the terminal of ${rt.record.name}`, error);
    }
  }

  /** Stops what runs when the server shuts down. It queues behind a running operation, so a spawn finishes first. */
  async function terminateOp(rt: Rt): Promise<void> {
    if (rt.removed || rt.state === 'stopped') return;
    rt.transition = 'stopping';
    flush(rt);
    await stopProcess(rt);
    if (rt.transition === 'stopping') rt.transition = null;
    flush(rt);
  }

  /* ---- hire and edit ---- */

  function asObject(value: unknown, what: string): Record<string, unknown> {
    if (!isRecord(value)) throw new HubError('bad_request', `${what} must be a JSON object`);
    return value;
  }

  function checkName(value: unknown): string {
    if (typeof value !== 'string' || !NAME_RE.test(value)) {
      throw new HubError(
        'bad_request',
        'name must be 1 to 32 lowercase letters, digits or hyphens, and start with a letter or digit',
        'name',
      );
    }
    if ((RESERVED_NAMES as readonly string[]).includes(value)) {
      throw new HubError('bad_request', `"${value}" is a reserved name`, 'name');
    }
    return value;
  }

  function checkRole(value: unknown): string {
    const role = typeof value === 'string' ? value.trim() : '';
    if (role.length === 0 || role.length > ROLE_MAX_CHARS) {
      throw new HubError('bad_request', `role must be 1 to ${ROLE_MAX_CHARS} characters`, 'role');
    }
    return role;
  }

  function checkMode(value: unknown): PermissionMode {
    if (typeof value !== 'string' || !(PERMISSION_MODES as readonly string[]).includes(value)) {
      throw new HubError('bad_request', `mode must be one of ${PERMISSION_MODES.join(', ')}`, 'mode');
    }
    return value as PermissionMode;
  }

  function checkPosition(value: unknown): string {
    if (typeof value !== 'string' || !POSITION_IDS.includes(value)) {
      throw new HubError('bad_request', 'unknown position', 'position');
    }
    return value;
  }

  function checkProvider(value: unknown): Provider {
    if (value === undefined) return options.defaultEngine?.() ?? 'claude';
    if (typeof value !== 'string' || !(PROVIDERS as readonly string[]).includes(value)) {
      throw new HubError('bad_request', `provider must be one of ${PROVIDERS.join(', ')}`, 'provider');
    }
    return value as Provider;
  }

  function checkCommand(value: unknown): string {
    const command = typeof value === 'string' ? value.trim() : '';
    if (command.length === 0 || command.length > COMMAND_MAX_CHARS) {
      throw new HubError('bad_request', `command must be 1 to ${COMMAND_MAX_CHARS} characters`, 'command');
    }
    return command;
  }

  /** The optional record fields are removed, not set to undefined, so that the roster file stays as it was for old agents. */
  function setOptional(record: AgentRecord, key: 'position' | 'command', value: string | undefined): void {
    if (value === undefined) delete record[key];
    else record[key] = value;
  }

  function assignFields(target: AgentRecord, from: AgentRecord): void {
    target.name = from.name;
    target.role = from.role;
    target.dir = from.dir;
    target.mode = from.mode;
    setOptional(target, 'position', from.position);
    setOptional(target, 'command', from.command);
    if (from.payload === undefined) delete target.payload;
    else target.payload = from.payload;
    if (from.payloadOff === undefined) delete target.payloadOff;
    else target.payloadOff = from.payloadOff;
    if (from.cleanRoom === undefined) delete target.cleanRoom;
    else target.cleanRoom = from.cleanRoom;
    if (from.worktree === undefined) delete target.worktree;
    else target.worktree = from.worktree;
    if (from.remoteControl === undefined) delete target.remoteControl;
    else target.remoteControl = from.remoteControl;
    if (from.permissions === undefined) delete target.permissions;
    else target.permissions = from.permissions;
    if (from.autostart === undefined) delete target.autostart;
    else target.autostart = from.autostart;
    if (from.coauthor === undefined) delete target.coauthor;
    else target.coauthor = from.coauthor;
    if (from.model === undefined) delete target.model;
    else target.model = from.model;
    if (from.effort === undefined) delete target.effort;
    else target.effort = from.effort;
    if (from.keys === undefined) delete target.keys;
    else target.keys = from.keys;
  }

  /** The effort for `--effort`: a level of EFFORTS, only for an engine that takes one. null or undefined is none. A bad value is 400, field effort. */
  function checkEffort(provider: Provider, value: unknown): Effort | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string' || !(EFFORTS as readonly string[]).includes(value)) throw new HubError('bad_request', `effort must be one of: ${EFFORTS.join(', ')}`, 'effort');
    if (!takesEffort(provider)) throw new HubError('bad_request', `${providerInfo(provider).label} takes no effort setting`, 'effort');
    return value as Effort;
  }

  /** The model for `--model`: empty text is none. Only an engine that takes one (PROVIDER_INFO.model). A bad value is 400, field model. */
  function checkModel(provider: Provider, value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') throw new HubError('bad_request', 'model must be text', 'model');
    const model = value.trim();
    if (model === '') return undefined;
    if (providerInfo(provider).model === null) {
      throw new HubError('bad_request', `${providerInfo(provider).label} takes no model setting`, 'model');
    }
    if (!MODEL_RE.test(model)) {
      throw new HubError('bad_request', 'model must be 1 to 100 letters, digits or . _ : / @ + -, starting with a letter or digit', 'model');
    }
    return model;
  }

  /** The keys of a request: their values to the key store and their names with times for the record. A bad one is 400, field keys. */
  function checkKeysOf(value: unknown, current: AgentRecord['keys'], hireRequest: boolean): { patch: Record<string, string | null>; names: Record<string, number> | undefined } {
    const checked = checkKeys(value, current, io.now(), hireRequest);
    if (!checked.ok) throw new HubError('bad_request', checked.error, 'keys');
    if (io.keys === undefined && Object.keys(checked.patch).length > 0) throw new HubError('bad_request', 'this server cannot keep keys', 'keys');
    return { patch: checked.patch, names: Object.keys(checked.names).length === 0 ? undefined : checked.names };
  }

  /** The shape of a payload and whether the engine takes it (no disk). A bad value is 400 with the field it names. */
  function checkPayload(provider: Provider, value: unknown): Payload | undefined {
    const checked = parsePayload(value);
    if (!checked.ok) throw new HubError('bad_request', checked.error, checked.field);
    const refused = checked.payload && payloadRefusal(provider, checked.payload);
    if (refused) throw new HubError('bad_request', refused.error, refused.field);
    return checked.payload;
  }

  /** The room defaults an agent switches off: names only, and only for an engine that takes a payload. A bad value is 400, field payloadOff. */
  function checkPayloadOff(provider: Provider, value: unknown): PayloadOff | undefined {
    const checked = parsePayloadOff(value);
    if (!checked.ok) throw new HubError('bad_request', checked.error, 'payloadOff');
    if (checked.off && providerInfo(provider).payload === null) throw new HubError('bad_request', `${providerInfo(provider).label} takes no payload`, 'payloadOff');
    return checked.off;
  }

  /** Tool rules: lists of Claude Code rules, Claude Code only. A bad one is 400, field permissions. */
  function checkPermissions(provider: Provider, value: unknown): PermissionRules | undefined {
    const checked = parsePermissions(value, provider);
    if (!checked.ok) throw new HubError('bad_request', checked.error, 'permissions');
    // no rule at all is the same as none: the room's apply
    return Object.keys(checked.permissions).length === 0 ? undefined : checked.permissions;
  }

  /** A Remote Control setting: an object, Claude Code only, not with a Clean Room. A bad one is 400, field remoteControl. */
  function checkRemoteControl(provider: Provider, value: unknown, cleanRoom: boolean): RemoteControl {
    const checked = parseRemoteControl(value, provider, cleanRoom);
    if (!checked.ok) throw new HubError('bad_request', checked.error, 'remoteControl');
    return checked.remoteControl;
  }

  /** A worktree setting: an object, not together with a Clean Room (which has one), and `dir` in a git repository. A bad one is 400, field worktree. */
  async function checkWorktree(value: unknown, dir: string, cleanRoom: unknown): Promise<Worktree> {
    const checked = parseWorktree(value);
    if (!checked.ok) throw new HubError('bad_request', checked.error, 'worktree');
    if (cleanRoom !== undefined && cleanRoom !== null) throw new HubError('bad_request', 'a Clean Room agent has a worktree already: use one of the two', 'worktree');
    let problem: string | null;
    try {
      problem = (await io.checkWorktree?.(dir)) ?? null;
    } catch (error) {
      log.error('worktree check failed', error);
      problem = errorMessage(error);
    }
    if (problem !== null) throw new HubError('bad_request', problem, 'worktree');
    return checked.worktree;
  }

  /** A Clean Room setting: Claude Code only, a good image, and (when the check exists) Docker answers and `dir` is in a git repository. A bad one is 400, field cleanRoom. */
  async function checkCleanRoom(provider: Provider, value: unknown, dir: string): Promise<CleanRoom> {
    const checked = parseCleanRoom(value, provider);
    if (!checked.ok) throw new HubError('bad_request', checked.error, 'cleanRoom');
    let problem: string | null;
    try {
      problem = (await io.checkCleanRoom?.(dir, checked.cleanRoom.flavor)) ?? null;
    } catch (error) {
      log.error('clean room check failed', error);
      problem = errorMessage(error);
    }
    if (problem !== null) throw new HubError('bad_request', problem, 'cleanRoom');
    return checked.cleanRoom;
  }

  /** Every skill folder must exist (the launcher looks for the SKILL.md at the start). */
  async function checkSkills(payload: Payload | undefined): Promise<void> {
    for (const folder of payload?.skills ?? []) {
      let verdict: Awaited<ReturnType<HubIo['checkDirectory']>>;
      try {
        verdict = await io.checkDirectory(folder);
      } catch (error) {
        log.error('skill folder check failed', error);
        throw new HubError('internal', `could not check the skill folder: ${errorMessage(error)}`, 'payload.skills');
      }
      if (!verdict.ok) throw new HubError('bad_request', `skill folder: ${verdict.error}`, 'payload.skills');
    }
  }

  async function checkDir(value: unknown): Promise<string> {
    if (typeof value !== 'string' || value.length === 0 || value.length > DIR_MAX_CHARS) {
      throw new HubError('bad_request', `dir must be a path of 1 to ${DIR_MAX_CHARS} characters`, 'dir');
    }
    let verdict: Awaited<ReturnType<HubIo['checkDirectory']>>;
    try {
      verdict = await io.checkDirectory(value);
    } catch (error) {
      log.error('directory check failed', error);
      throw new HubError('internal', `could not check the directory: ${errorMessage(error)}`, 'dir');
    }
    if (!verdict.ok) throw new HubError('bad_request', verdict.error, 'dir');
    return verdict.path;
  }

  function lowestFreeDesk(): number {
    const used = new Set<number>();
    for (const rt of agents.values()) used.add(rt.record.desk);
    for (const record of hiring.values()) {
      if (record) used.add(record.desk);
    }
    let desk = 1;
    while (used.has(desk)) desk += 1;
    return desk;
  }

  async function hire(request: HireRequest): Promise<AgentView> {
    assertOpen();
    const req = asObject(request, 'the request');
    const name = checkName(req.name);
    if (agents.has(name) || claimedNames.has(name)) {
      throw new HubError('conflict', `an agent named "${name}" already exists`, 'name');
    }
    if (agents.size + hiring.size >= MAX_AGENTS) {
      throw new HubError('conflict', `the operations room is full (${MAX_AGENTS} agents)`);
    }
    const role = checkRole(req.role);
    const provider = checkProvider(req.provider);
    const custom = provider === 'custom';
    const position = req.position === undefined ? undefined : checkPosition(req.position);
    if (!custom && req.command !== undefined) {
      throw new HubError('bad_request', 'only a custom agent has a command', 'command');
    }
    const command = custom ? checkCommand(req.command) : undefined;
    const payload = checkPayload(provider, req.payload);
    const payloadOff = checkPayloadOff(provider, req.payloadOff);
    const model = checkModel(provider, req.model);
    const effort = checkEffort(provider, req.effort);
    const kept = req.keys === undefined ? undefined : checkKeysOf(req.keys, undefined, true);
    // A CLI without permission modes (a custom command among them): the mode and confirmBypass of the request are ignored.
    const mode = providerInfo(provider).modes ? checkMode(req.mode) : 'default';
    // The name is claimed while the checks and the save await, so two hires cannot take the same name or the same desk.
    claimedNames.add(name);
    hiring.set(name, null);
    let hired: Rt;
    try {
      const dir = await checkDir(req.dir);
      if (mode === 'bypassPermissions' && req.confirmBypass !== true) {
        throw new HubError('bad_request', 'bypassPermissions needs confirmBypass: true', 'confirmBypass');
      }
      await checkSkills(payload);
      const cleanRoom = req.cleanRoom === undefined ? undefined : await checkCleanRoom(provider, req.cleanRoom, dir);
      const worktree = req.worktree === undefined ? undefined : await checkWorktree(req.worktree, dir, req.cleanRoom);
      const permissions = req.permissions === undefined ? undefined : checkPermissions(provider, req.permissions);
      if (req.autostart !== undefined && typeof req.autostart !== 'boolean') throw new HubError('bad_request', 'autostart must be true or false', 'autostart');
      if (req.coauthor !== undefined && typeof req.coauthor !== 'boolean') throw new HubError('bad_request', 'coauthor must be true or false', 'coauthor');
      const remoteControl = req.remoteControl === undefined ? undefined : checkRemoteControl(provider, req.remoteControl, cleanRoom !== undefined);
      assertOpen();
      const record: AgentRecord = {
        name,
        role,
        dir,
        mode,
        sessionId: io.newSessionId(),
        desk: lowestFreeDesk(),
        boss: false,
        createdAt: io.now(),
      };
      setOptional(record, 'position', position);
      if (provider !== 'claude') record.provider = provider;
      setOptional(record, 'command', command);
      if (payload) record.payload = payload;
      if (payloadOff) record.payloadOff = payloadOff;
      if (cleanRoom) record.cleanRoom = cleanRoom;
      if (worktree) record.worktree = worktree;
      if (remoteControl) record.remoteControl = remoteControl;
      if (permissions) record.permissions = permissions;
      if (req.autostart === false) record.autostart = false;
      if (req.coauthor === false) record.coauthor = false;
      if (model) record.model = model;
      if (effort) record.effort = effort;
      if (kept?.names) record.keys = kept.names;
      hiring.set(name, record);
      // The values first, from none (a removed agent of this name may have left some), then the roster; a roster that cannot be saved takes them back.
      await io.keys?.apply(name, kept?.patch ?? {}, true);
      try {
        await saveRecords(rosterRecords());
      } catch (error) {
        await io.keys?.remove(name).catch(() => undefined);
        throw error;
      }
      hired = makeRt(record);
      agents.set(name, hired);
    } finally {
      claimedNames.delete(name);
      hiring.delete(name);
    }
    const rt = hired;
    return enqueue(rt, 'hire', async () => {
      await spawnOp(rt, null, true);
      return buildView(rt);
    });
  }

  async function editOp(rt: Rt, request: EditRequest): Promise<AgentView> {
    assertOpen();
    if (rt.removed) throw new HubError('not_found', 'unknown agent');
    const req = asObject(request, 'the request');
    const fields = ['name', 'role', 'dir', 'mode', 'confirmBypass', 'position', 'command', 'payload', 'payloadOff', 'cleanRoom', 'worktree', 'remoteControl', 'permissions', 'autostart', 'coauthor', 'model', 'effort', 'keys'];
    if (!fields.some((field) => req[field] !== undefined)) {
      throw new HubError('bad_request', 'nothing to change: send at least one of name, role, dir, mode, position, command, payload, payloadOff, cleanRoom, worktree, remoteControl, permissions, autostart, coauthor, model, effort, keys');
    }
    const current = rt.record;
    const next: AgentRecord = { ...current };
    let newName: string | null = null;
    let keyPatch: Record<string, string | null> | null = null;
    try {
      if (req.name !== undefined) {
        const name = checkName(req.name);
        if (name !== current.name) {
          if (current.cleanRoom !== undefined && req.cleanRoom !== null) {
            throw new HubError('conflict', 'a Clean Room console cannot be renamed: its worktree and branch carry its name (turn Clean Room off to rename it)', 'name');
          }
          if (current.worktree !== undefined && req.worktree !== null) {
            throw new HubError('conflict', 'a console with a worktree cannot be renamed: its worktree and branch carry its name (turn the worktree off to rename it)', 'name');
          }
          if (agents.has(name) || claimedNames.has(name)) {
            throw new HubError('conflict', `an agent named "${name}" already exists`, 'name');
          }
          // Claimed until the end, so that a hire cannot take the name while the checks below await.
          claimedNames.add(name);
          newName = name;
        }
      }
      if (req.role !== undefined) next.role = checkRole(req.role);
      // A CLI without permission modes keeps mode 'default' whatever the request says.
      if (req.mode !== undefined && providerInfo(rt.record.provider).modes) next.mode = checkMode(req.mode);
      if (req.position !== undefined) setOptional(next, 'position', req.position === null ? undefined : checkPosition(req.position));
      if (req.command !== undefined) {
        if (!isCustom(rt)) throw new HubError('bad_request', 'only a custom agent has a command', 'command');
        next.command = checkCommand(req.command);
      }
      if (req.dir !== undefined) next.dir = await checkDir(req.dir);
      if (req.payload !== undefined) {
        const payload = checkPayload(current.provider ?? 'claude', req.payload);
        await checkSkills(payload);
        if (payload) next.payload = payload;
        else delete next.payload;
      }
      if (req.payloadOff !== undefined) {
        const off = checkPayloadOff(current.provider ?? 'claude', req.payloadOff);
        if (off) next.payloadOff = off;
        else delete next.payloadOff;
      }
      if (req.cleanRoom !== undefined) {
        if (req.cleanRoom === null) delete next.cleanRoom;
        else next.cleanRoom = await checkCleanRoom(current.provider ?? 'claude', req.cleanRoom, next.dir);
      }
      if (req.worktree !== undefined) {
        if (req.worktree === null) delete next.worktree;
        else next.worktree = await checkWorktree(req.worktree, next.dir, next.cleanRoom);
      } else if (next.worktree !== undefined && (req.dir !== undefined || req.cleanRoom !== undefined)) {
        // a new folder must be in a repository, and a Clean Room has a worktree of its own
        next.worktree = await checkWorktree(next.worktree, next.dir, next.cleanRoom);
      }
      if (req.coauthor !== undefined) {
        if (typeof req.coauthor !== 'boolean') throw new HubError('bad_request', 'coauthor must be true or false', 'coauthor');
        if (req.coauthor) delete next.coauthor;
        else next.coauthor = false;
      }
      if (req.autostart !== undefined) {
        if (typeof req.autostart !== 'boolean') throw new HubError('bad_request', 'autostart must be true or false', 'autostart');
        if (req.autostart) delete next.autostart;
        else next.autostart = false;
      }
      if (req.remoteControl !== undefined) {
        if (req.remoteControl === null) delete next.remoteControl;
        else next.remoteControl = checkRemoteControl(current.provider ?? 'claude', req.remoteControl, next.cleanRoom !== undefined);
      } else if (next.remoteControl !== undefined && next.cleanRoom !== undefined && req.cleanRoom !== undefined) {
        throw new HubError('bad_request', 'a Clean Room agent cannot use Remote Control: turn Remote Control off first', 'cleanRoom');
      }
      if (req.permissions !== undefined) {
        const rules = req.permissions === null ? undefined : checkPermissions(current.provider ?? 'claude', req.permissions);
        if (rules) next.permissions = rules;
        else delete next.permissions;
      }
      if (req.model !== undefined) {
        const model = checkModel(current.provider ?? 'claude', req.model);
        if (model) next.model = model;
        else delete next.model;
      }
      if (req.effort !== undefined) {
        const effort = checkEffort(current.provider ?? 'claude', req.effort);
        if (effort) next.effort = effort;
        else delete next.effort;
      }
      if (req.keys !== undefined) {
        const kept = checkKeysOf(req.keys, current.keys, false);
        keyPatch = kept.patch;
        if (kept.names) next.keys = kept.names;
        else delete next.keys;
      }
      if (next.mode === 'bypassPermissions' && next.mode !== current.mode && req.confirmBypass !== true) {
        throw new HubError('bad_request', 'bypassPermissions needs confirmBypass: true', 'confirmBypass');
      }
      if (newName !== null) {
        // The state may have changed during the directory check: look at it now.
        if (rt.state !== 'stopped' || rt.transition !== null) {
          throw new HubError('conflict', 'an agent can only be renamed while it is stopped', 'name');
        }
        next.name = newName;
      }
      const changed =
        next.name !== current.name ||
        next.role !== current.role ||
        next.dir !== current.dir ||
        next.mode !== current.mode ||
        next.position !== current.position ||
        next.command !== current.command ||
        payloadKey(next) !== payloadKey(current) ||
        cleanRoomKey(next) !== cleanRoomKey(current) ||
        worktreeKey(next) !== worktreeKey(current) ||
        remoteKey(next) !== remoteKey(current) ||
        rulesKey(next) !== rulesKey(current) ||
        next.autostart !== current.autostart ||
        next.coauthor !== current.coauthor ||
        engineKey(next) !== engineKey(current);
      if (!changed) return buildView(rt);

      const oldName = current.name;
      const previous: AgentRecord = { ...current };
      if (newName !== null) {
        try {
          await io.renameAgentFiles(oldName, newName);
        } catch (error) {
          throw new HubError('conflict', errorMessage(error), 'name');
        }
      }
      // Apply, then save: an operation queued for the agent from now on finds it under its new name, and the frame
      // waits until the roster is on disk. A failed save puts everything back, the files included.
      assignFields(current, next);
      if (newName !== null) {
        agents.delete(oldName);
        agents.set(newName, rt);
        renamePollEntry(oldName, newName);
      }
      // What the keys the edit touches hold now, as a patch that puts them back: a key that was not there goes again (null).
      const held = io.keys?.values(next.name) ?? {};
      const putBack = Object.fromEntries(Object.keys(keyPatch ?? {}).map((key) => [key, held[key] ?? null]));
      try {
        if (keyPatch !== null && Object.keys(keyPatch).length > 0) await io.keys?.apply(next.name, keyPatch);
        await saveRecords(rosterRecords());
      } catch (error) {
        // The values were written before the roster; they go back first, while the keys are still under the new name.
        // shortcut: when this write fails as well, the new values stay and the log says so; upgrade if disk errors matter.
        if (Object.keys(putBack).length > 0) await io.keys?.apply(next.name, putBack).catch((undo: unknown) => log.error('could not put the keys back', undo));
        assignFields(current, previous);
        if (newName !== null) {
          agents.delete(newName);
          agents.set(oldName, rt);
          renamePollEntry(newName, oldName);
          await io
            .renameAgentFiles(newName, oldName)
            .catch((undo: unknown) => log.error('could not undo the rename', undo));
        }
        throw error;
      }
      if (newName !== null) {
        emit({ t: 'agent-removed', name: oldName });
      }
      flush(rt);
      return buildView(rt);
    } finally {
      if (newName !== null) claimedNames.delete(newName);
    }
  }

  /* ---- messages (contract 5.2, 5.6) ---- */

  type Sender = { kind: 'user' } | { kind: 'agent'; name: string; generation: number } | { kind: 'station'; name: string; hops: number };

  function knownRecipients(): string {
    return [...sortedAgents().map((rt) => rt.record.name), ...['boss', 'user']].join(', ');
  }

  function send(sender: Sender, input: unknown): SendResult {
    const req = asObject(input, 'the message');
    const to = req.to;
    if (typeof to !== 'string' || to.length === 0 || to.length > RECIPIENT_MAX_CHARS) {
      throw new HubError('bad_request', 'to must be an agent name, "boss" or "user"', 'to');
    }
    const subject = req.subject === undefined || req.subject === null ? '' : req.subject;
    if (typeof subject !== 'string' || subject.length > SUBJECT_MAX_CHARS) {
      throw new HubError('bad_request', `subject must be text of at most ${SUBJECT_MAX_CHARS} characters`, 'subject');
    }
    const body = req.body;
    if (typeof body !== 'string' || body.trim() === '') {
      throw new HubError('bad_request', 'body must not be empty', 'body');
    }
    if (body.length > BODY_MAX_CHARS) {
      throw new HubError('bad_request', `body must be at most ${BODY_MAX_CHARS} characters`, 'body');
    }
    const inReplyTo =
      typeof req.inReplyTo === 'string' && req.inReplyTo.length <= REPLY_ID_MAX_CHARS && REPLY_ID_RE.test(req.inReplyTo)
        ? req.inReplyTo
        : null;

    let recipient: Rt | null = null;
    let recipientName = 'user';
    const docked = to.includes('@');
    if (docked) {
      checkStationAddress(sender, to);
      recipientName = to;
    } else if (to === 'user') {
      if (sender.kind === 'user') throw new HubError('bad_request', 'a message from you cannot be addressed to user', 'to');
      if (sender.kind === 'station') throw new HubError('bad_request', 'a message from another station cannot be addressed to user: write to an agent', 'to');
    } else if (to === 'boss') {
      recipient = bossRt();
      if (!recipient) throw new HubError('bad_request', 'there is no boss agent', 'to');
      recipientName = recipient.record.name;
    } else {
      recipient = agents.get(to) ?? null;
      if (!recipient || recipient.removed) {
        throw new HubError('not_found', `unknown recipient "${to}". Known: ${knownRecipients()}`, 'to');
      }
      recipientName = recipient.record.name;
    }

    let senderRt: Rt | null = null;
    if (sender.kind === 'agent') {
      senderRt = agents.get(sender.name) ?? null;
      if (!senderRt || senderRt.removed) throw new HubError('bad_request', 'unknown sender');
      if (sender.generation !== senderRt.generation || senderRt.transition !== null) {
        throw new HubError('conflict', 'this session has ended');
      }
      if (recipient === senderRt) {
        throw new HubError('bad_request', 'you cannot send a message to yourself', 'to');
      }
    }

    const hops = sender.kind === 'station' ? sender.hops : senderRt === null ? 0 : senderRt.trigger ? senderRt.trigger.maxHops + 1 : 1;
    const at = io.now();
    const record: MessageRecord = {
      id: io.newMessageId(),
      from: sender.kind === 'user' ? 'user' : sender.name,
      to: recipientName,
      subject,
      body,
      inReplyTo,
      hops,
      at,
      status: 'to_user',
      note: null,
      updatedAt: at,
    };
    const result = (): SendResult => ({ ok: record.status !== 'undelivered', id: record.id, to: record.to, status: record.status, note: record.note });
    // Before the recipient is looked at: a flood to the user or to a stopped agent grows the log all the same.
    if (senderRt !== null && !takeSendSlot(senderRt, at)) {
      record.status = 'undelivered';
      record.note = `rate limit: ${senderRt.record.name} sent too many messages this minute`;
      // The sender hears it at every send, but the log, the strip and the browsers only once: a refusal that is stored
      // and broadcast as often as the flood sends would be the flood again.
      if (senderRt.limitNoted) return result();
      senderRt.limitNoted = true;
    } else if (docked) {
      routeDocked(record);
    } else {
      route(record, recipient);
    }
    if (senderRt !== null && record.status !== 'undelivered') {
      const times = senderRt.sentTo.get(recipientName) ?? [];
      senderRt.sentTo.set(recipientName, times);
      if (countRecent(times, at, REDLINE_SEND_WINDOW_MS) > REDLINE_SENDS_TO_ONE) {
        detect(senderRt, `ping-pong: ${times.length} messages to ${recipientName} in 10 min`);
        flush(senderRt);
      }
    }
    remember(record);
    announce(record);
    if (recipient) flush(recipient);
    return result();
  }

  /** `name@station` from an agent, to a station that is docked and a name that can be an agent there. Throws a HubError otherwise. */
  function checkStationAddress(sender: Sender, to: string): void {
    const at = to.indexOf('@');
    const name = to.slice(0, at);
    const station = to.slice(at + 1);
    if (sender.kind === 'station') throw new HubError('bad_request', 'a message from another station cannot be passed on to a third one', 'to');
    if (sender.kind === 'user') throw new HubError('bad_request', 'only an agent writes to another station: ask one to', 'to');
    if (!io.dock) throw new HubError('bad_request', 'docking is not available', 'to');
    if (!(name === 'boss' || NAME_RE.test(name)) || !STATION_RE.test(station)) {
      throw new HubError('bad_request', 'to must be name@station, the name of an agent or "boss" and a docked station', 'to');
    }
    const stations = io.dock.stations();
    if (!stations.includes(station)) {
      throw new HubError('not_found', `unknown station "${station}". ${stations.length === 0 ? 'No station is docked' : `Docked: ${stations.join(', ')}`}`, 'to');
    }
  }

  /** The message goes to the other station in the background: it is queued until that answers, then delivered or undelivered with its reason. */
  function routeDocked(record: MessageRecord): void {
    const at = record.to.indexOf('@');
    const station = record.to.slice(at + 1);
    if (record.hops > maxHops) {
      record.status = 'undelivered';
      record.note = `hop limit ${maxHops} reached; the message went to the user`;
      return;
    }
    record.status = 'queued';
    record.note = `sending to ${station}`;
    const message = { from: record.from, to: record.to.slice(0, at), subject: record.subject, body: record.body, hops: record.hops };
    const done = (ok: boolean, note: string | null): void => setMessage(record, ok ? 'delivered' : 'undelivered', note);
    void io.dock?.send(station, message).then(
      (result) => done(result.ok, result.note),
      (error: unknown) => {
        log.warn('a docked send failed', error);
        done(false, `could not send to ${station}`);
      },
    );
  }

  /** One send of an agent against its rolling window. false when the window is full: the message is refused and not counted. */
  function takeSendSlot(rt: Rt, now: number): boolean {
    while (rt.sentAt.length > 0 && now - rt.sentAt[0] >= SEND_RATE_WINDOW_MS) rt.sentAt.shift();
    if (rt.sentAt.length >= SEND_RATE_MAX) return false;
    rt.sentAt.push(now);
    rt.limitNoted = false;
    return true;
  }

  /** Decides where a new message goes and writes the outcome into the record; first match wins (contract 5.2 step 6). */
  function route(record: MessageRecord, recipient: Rt | null): void {
    if (recipient === null) return;
    const name = recipient.record.name;
    if (!mailable(recipient)) {
      record.status = 'undelivered';
      record.note = isCustom(recipient)
        ? `${name} runs a custom command and cannot receive messages`
        : `${name} runs ${providerInfo(recipient.record.provider).label} without the gonogo tools and cannot receive messages`;
      return;
    }
    if (record.hops > maxHops) {
      record.status = 'undelivered';
      record.note = `hop limit ${maxHops} reached; the message went to the user`;
      return;
    }
    // A restarting agent is treated like a running one even though its old process may be gone already: the new
    // process will get the message. This test comes before the `stopped` one (contract 0.5 item 6).
    const restarting = recipient.transition === 'restarting';
    if (!restarting && (recipient.state === 'stopped' || recipient.transition !== null)) {
      record.status = 'undelivered';
      record.note =
        recipient.transition === 'removing'
          ? `${name} is being removed; the message went to the user`
          : `${name} is stopped; the message went to the user`;
      return;
    }
    // Unread mail is the one thing the hub keeps in memory without a bound of its own: cap what one recipient can pile up.
    const unread = unreadFor(name);
    const unreadChars = unread.reduce((total, other) => total + other.body.length, 0);
    if (unread.length >= MAILBOX_MAX_MESSAGES || unreadChars + record.body.length > MAILBOX_MAX_BODY_CHARS) {
      record.status = 'undelivered';
      record.note = `mailbox full: ${name} has too many unread messages`;
      return;
    }
    recipient.queue.push(record.id);
    const hold = holdNote(recipient);
    record.status = hold === null ? 'queued' : 'held';
    record.note = hold ?? waitNote(recipient);
    scheduleDelivery(recipient, DELIVERY_COALESCE_MS);
  }

  function sessionEnded(rt: Rt, generation: number): boolean {
    return generation !== rt.generation || rt.transition !== null;
  }

  function sendFromUser(request: UserMessageRequest): SendResult {
    return send({ kind: 'user' }, request);
  }

  /** The Director's words of a checked message, by message id: kept in memory only, so a restart can only make a message a plain pointer. */
  const directorTurns = new Map<string, { channel: DirectorChannel; text: string }>();
  const DIRECTOR_CHANNELS: readonly string[] = ['web', 'telegram'];

  function sendFromDirector(request: UserMessageRequest, channel: DirectorChannel, said?: string): SendResult {
    const result = send({ kind: 'user' }, request);
    // only a channel this code names, and only a message that is waiting for a pointer
    if (!DIRECTOR_CHANNELS.includes(channel)) return result;
    const record = messages.get(result.id);
    const text = directorLine(said ?? (typeof request.body === 'string' ? request.body : ''));
    if (record !== undefined && text !== '' && (record.status === 'queued' || record.status === 'held')) {
      directorTurns.set(result.id, { channel, text });
      // bounded: the oldest go first (a Map keeps insertion order)
      for (const id of directorTurns.keys()) {
        if (directorTurns.size <= 200) break;
        directorTurns.delete(id);
      }
    }
    return result;
  }

  const CHANNEL_LABEL: Record<DirectorChannel, string> = { web: 'web', telegram: 'Telegram' };
  /** Messages whose Stop was already let go once so that their words could be typed as a turn: the next Stop hands them over the old way, so that nothing waits on a pty that cannot be typed into. */
  const directorDeferred = new Set<string>();

  /** The Director's words of this message, when they would be typed at its next pointer. */
  function directorTurnOf(rt: Rt, id: string): { channel: DirectorChannel; text: string } | undefined {
    if (io.featureOn?.('director-turns') === false || (rt.pointed.get(id) ?? 0) > 0) return undefined;
    return directorTurns.get(id);
  }

  /** What is typed for these messages: the pointer, then the Director's words of those he sent from a checked place, once each (a pointer typed again is only the pointer). */
  function typedText(rt: Rt, records: readonly MessageRecord[]): string {
    const pointer = pointerText(records);
    const parts: string[] = [];
    let total = 0;
    for (const record of records) {
      const turn = directorTurnOf(rt, record.id);
      if (turn === undefined || record.from !== 'user') continue;
      const part = `[Director via ${CHANNEL_LABEL[turn.channel]}] ${turn.text}`;
      if (total + part.length + 1 > DIRECTOR_TURNS_TOTAL_CHARS) break;
      parts.push(part);
      total += part.length + 1;
    }
    return parts.length === 0 ? pointer : `${pointer} ${parts.join(' ')} ${DIRECTOR_REPLY_TAIL}`;
  }

  function sendFromStation(station: string, request: StationMessage): SendResult {
    const req = asObject(request, 'the message');
    if (typeof req.from !== 'string' || !NAME_RE.test(req.from)) throw new HubError('bad_request', 'from must be an agent name', 'from');
    if (typeof req.hops !== 'number' || !Number.isSafeInteger(req.hops) || req.hops < 0) throw new HubError('bad_request', 'hops must be a whole number', 'hops');
    // only these fields cross: an id another station names (inReplyTo) is not one of this station's
    return send({ kind: 'station', name: `${req.from}@${station}`, hops: req.hops }, { to: req.to, subject: req.subject, body: req.body });
  }

  function sendFromAgent(from: string, generation: number, request: AgentSendRequest): SendResult {
    return send({ kind: 'agent', name: from, generation }, request);
  }

  function readMessages(agent: string, generation: number): ReadMessagesResult {
    const rt = agents.get(agent);
    if (!rt || rt.removed) return { count: 0, messages: [] };
    if (sessionEnded(rt, generation)) throw new HubError('conflict', 'this session has ended');
    const unread = unreadFor(agent);
    // Claude Code refuses an MCP result of more than 25,000 tokens, and mail it refused would already be marked read.
    // The first message always goes (a single one is far below the cap); the rest waits for the next call.
    const result: ReadMessage[] = [];
    let chars = 0;
    for (const record of unread) {
      const message: ReadMessage = {
        id: record.id,
        from: record.from,
        subject: record.subject,
        body: record.body,
        inReplyTo: record.inReplyTo,
        at: record.at,
      };
      chars += JSON.stringify(message).length;
      if (result.length >= READ_MAX_MESSAGES || (result.length > 0 && chars > READ_MAX_CHARS)) break;
      result.push(message);
    }
    const returned = unread.slice(0, result.length);
    const left = unread.slice(result.length);
    for (const record of returned) {
      setMessage(record, 'read', null);
      rt.pointed.delete(record.id);
    }
    rt.queue = left.map((record) => record.id);
    // A pointer in flight has nothing left to confirm: the agent is reading. The hook that should have confirmed it may
    // never come (silent hooks, a lost POST), and without this the 2 s timer would then leave a latch that makes every
    // later message wait until the user presses a key.
    if (rt.pendingConfirm || rt.unconfirmed) log.debug(`pointer confirmed by read_messages (${agent})`);
    cancelConfirm(rt);
    rt.unconfirmed = null;
    // What was left over is unread again, even when it had been pointed at or was waiting on the pointer just cancelled:
    // the usual paths (delivery check, Stop hook, draft latch, pointer counters) take it from here.
    for (const record of left) {
      if (record.status !== 'held') setMessage(record, 'queued', waitNote(rt));
    }
    syncHolds(rt);
    if (returned.length > 0) {
      rt.trigger = { ids: result.map((message) => message.id), maxHops: Math.max(...returned.map((record) => record.hops)) };
    }
    flush(rt);
    if (left.length === 0) return { count: result.length, messages: result };
    return { count: result.length, messages: result, remaining: left.length, note: READ_MORE_NOTE };
  }

  function rosterFor(agent: string, generation: number): RosterResult {
    const rt = agents.get(agent);
    if (!rt || rt.removed) throw new HubError('not_found', 'unknown agent');
    if (sessionEnded(rt, generation)) throw new HubError('conflict', 'this session has ended');
    const boss = bossRt();
    const entries: RosterEntry[] = sortedAgents().map((other) => ({
      name: other.record.name,
      role: cutText(other.record.role, ROSTER_ROLE_CHARS),
      state: other.state,
      boss: other.record.boss,
      position: other.record.position ?? null,
    }));
    const docked = io.dock?.rosters() ?? [];
    return { you: agent, boss: boss ? boss.record.name : null, agents: entries, specialRecipients: ['boss', 'user'], ...(docked.length > 0 ? { docked } : {}) };
  }

  /* ---- T-minus ---- */

  function pollView(): PollView | null {
    return pollState === null ? null : { ...pollState, entries: pollState.entries.map((entry) => ({ ...entry })) };
  }

  function pollNote(poll: PollView): string {
    switch (poll.status) {
      case 'open':
        return `waiting for ${poll.entries.filter((entry) => entry.vote === null).map((entry) => entry.agent).join(', ')}`;
      case 'go':
        return 'all go';
      case 'aborted':
        return 'aborted by the Director';
      case 'hold': {
        const refusing = poll.entries.filter((entry) => entry.vote === 'no-go').map((entry) => entry.agent);
        return holdBy === 'vote' && refusing.length > 0 ? `no-go: ${refusing.join(', ')}` : 'held by the Director';
      }
    }
  }

  /** Refreshes the note and emits a PollFrame when anything in the poll changed. */
  function publishPoll(): void {
    if (pollState) pollState.note = pollNote(pollState);
    const signature = JSON.stringify(pollState);
    if (signature === pollSig) return;
    pollSig = signature;
    emit({ t: 'poll', poll: pollView() });
    // The inbox hears each result once: a later vote that leaves the status as it is says nothing new.
    const result = pollState === null || pollState.status === 'open' ? '' : `${pollState.id}:${pollState.status}`;
    if (pollState !== null && result !== '' && result !== pollResult) {
      const line = `${pollState.status.toUpperCase()}: ${pollState.note}`;
      // A static fire is about the answers: they go to the inbox with the result.
      const answers = pollState.entries.flatMap((entry) => (entry.reason !== '' ? [`${entry.agent}: ${entry.reason}`] : []));
      io.notify?.('tminus', pollState.subject === undefined ? line : [`Static fire on ${pollState.subject}: ${line}`, ...answers].join(' · '));
    }
    pollResult = result;
  }

  function tellFromUser(to: string, subject: string, body: string): void {
    sendFromUser({ to, subject, body });
  }

  /**
   * An open poll ends in hold at the first no-go and in go when everybody voted go (and then the boss is told). A static fire
   * waits for every answer (the break report and the rollback plan both matter) and tells nobody: the Director reads the result.
   */
  function settlePoll(): void {
    const poll = pollState;
    if (!poll || (poll.status !== 'open' && !(poll.status === 'hold' && holdBy === 'vote'))) return;
    if (poll.subject !== undefined && poll.entries.some((entry) => entry.vote === null)) {
      poll.status = 'open';
    } else if (poll.entries.some((entry) => entry.vote === 'no-go')) {
      poll.status = 'hold';
      holdBy = 'vote';
    } else if (poll.entries.length > 0 && poll.entries.every((entry) => entry.vote === 'go')) {
      poll.status = 'go';
      const boss = poll.subject === undefined ? bossRt() : undefined;
      if (boss) tellFromUser(boss.record.name, 'T-minus: all go', 'Every polled position is go. Proceed.');
    } else {
      poll.status = 'open';
    }
  }

  /** The process of an entry ended (stop, restart, removal or crash): it counts as no-go for as long as the poll is live. */
  function pollEntryStopped(name: string): void {
    const poll = pollState;
    if (!poll || (poll.status !== 'open' && poll.status !== 'hold')) return;
    const entry = poll.entries.find((candidate) => candidate.agent === name);
    if (!entry || entry.vote === 'no-go') return;
    entry.vote = 'no-go';
    entry.reason = 'stopped';
    entry.at = io.now();
    settlePoll();
    publishPoll();
  }

  function renamePollEntry(from: string, to: string): void {
    const entry = pollState?.entries.find((candidate) => candidate.agent === from);
    if (!entry) return;
    entry.agent = to;
    publishPoll();
  }

  function pollTargets(value: unknown): Rt[] {
    const running = (rt: Rt): boolean => rt.state !== 'stopped' && rt.transition === null && mailable(rt);
    if (value === undefined) return sortedAgents().filter((rt) => running(rt) && !rt.record.boss);
    if (!Array.isArray(value) || value.some((name) => typeof name !== 'string')) {
      throw new HubError('bad_request', 'agents must be a list of agent names', 'agents');
    }
    return [...new Set(value as string[])].map((name) => {
      const rt = agents.get(name);
      if (!rt || rt.removed) throw new HubError('bad_request', `unknown agent "${name}"`, 'agents');
      if (!mailable(rt)) {
        const what = isCustom(rt) ? 'a custom command' : `${providerInfo(rt.record.provider).label} without the gonogo tools`;
        throw new HubError('bad_request', `${name} runs ${what} and cannot vote`, 'agents');
      }
      if (!running(rt)) throw new HubError('bad_request', `${name} is not running`, 'agents');
      return rt;
    });
  }

  function startPoll(request: PollRequest): PollView {
    assertOpen();
    const req = asObject(request, 'the request');
    if (pollState !== null) throw new HubError('conflict', 'clear the poll first');
    const subject = staticFireSubject(req);
    if (subject !== undefined && io.featureOn?.('static-fire') === false) throw new HubError('feature_off', 'Static fire is off', 'subject');
    const targets =
      subject === undefined
        ? pollTargets(req.agents)
        : pollTargets(undefined).filter((rt) => (STATIC_FIRE_POSITIONS as readonly string[]).includes(rt.record.position ?? ''));
    if (targets.length === 0) throw new HubError('bad_request', subject === undefined ? 'nobody to poll' : 'no SIMSUP or RETRO is running');
    pollSeq += 1;
    pollState = {
      id: pollSeq,
      startedAt: io.now(),
      status: 'open',
      entries: targets.map((rt): PollEntry => ({ agent: rt.record.name, vote: null, reason: '', at: null })),
      note: '',
      ...(subject === undefined ? {} : { subject }),
    };
    for (const rt of targets) {
      if (subject === undefined) {
        tellFromUser(
          rt.record.name,
          'T-minus: go/no-go poll',
          'The Director is polling for go or no-go. Call go_nogo with your vote and a one-sentence reason.',
        );
      } else if (rt.record.position === 'simsup') {
        tellFromUser(
          rt.record.name,
          `Static fire: ${subject}`,
          `Before this ships, try to break it: ${subject}. Then call go_nogo: go if it held, no-go with what broke in one sentence (write the steps to reproduce to the Mission Log).`,
        );
      } else {
        tellFromUser(
          rt.record.name,
          `Static fire: ${subject}`,
          `Before this ships, write the rollback plan for: ${subject}. Put the plan in the Mission Log with log_write, then call go_nogo: go when it can be rolled back, no-go if it cannot, with a one-sentence reason.`,
        );
      }
    }
    publishPoll();
    return pollView() as PollView;
  }

  /** The subject of a static fire, one clean line; undefined for a T-minus poll. */
  function staticFireSubject(req: Record<string, unknown>): string | undefined {
    if (req.subject === undefined) return undefined;
    if (req.agents !== undefined) throw new HubError('bad_request', 'a static fire picks SIMSUP and RETRO itself', 'agents');
    const max = SUBJECT_MAX_CHARS - 'Static fire: '.length;
    const subject = typeof req.subject === 'string' ? collapseWhitespace(req.subject.replace(UNSAFE_IN_REASON, ' ')) : '';
    if (subject === '' || subject.length > max) throw new HubError('bad_request', `subject must be text of 1 to ${max} characters`, 'subject');
    return subject;
  }

  function holdPoll(): PollView {
    assertOpen();
    if (pollState !== null && pollState.status === 'hold') throw new HubError('conflict', 'the poll is already on hold');
    if (pollState === null || pollState.status !== 'open') throw new HubError('conflict', 'no poll is open');
    pollState.status = 'hold';
    holdBy = 'director';
    publishPoll();
    return pollView() as PollView;
  }

  function abortPoll(): PollView {
    assertOpen();
    if (pollState === null) throw new HubError('conflict', 'there is no poll');
    if (pollState.status !== 'aborted') {
      pollState.status = 'aborted';
      for (const entry of pollState.entries) {
        if (entry.vote !== 'no-go') {
          if (pollState.subject === undefined) tellFromUser(entry.agent, 'T-minus: aborted', 'The Director aborted the poll. Stand by.');
          else tellFromUser(entry.agent, 'Static fire: aborted', 'The Director aborted the static fire. Stand by.');
        }
      }
      publishPoll();
    }
    return pollView() as PollView;
  }

  function clearPoll(): void {
    pollState = null;
    publishPoll();
  }

  function vote(agent: string, generation: number, choice: PollVote, reason: string): VoteResult {
    const poll = pollState;
    if (!poll || poll.status === 'go' || poll.status === 'aborted') return { ok: false, note: 'no poll is open' };
    const entry = poll.entries.find((candidate) => candidate.agent === agent);
    if (!entry) return { ok: false, note: 'you are not in this poll' };
    const rt = agents.get(agent);
    if (!rt || rt.removed || sessionEnded(rt, generation)) return { ok: false, note: 'this session has ended' };
    if (!(POLL_VOTES as readonly string[]).includes(choice)) return { ok: false, note: 'vote must be go or no-go' };
    if (!takeSendSlot(rt, io.now())) return { ok: false, note: 'too many requests: wait a moment' };
    entry.vote = choice;
    entry.reason = cutText(typeof reason === 'string' ? collapseWhitespace(reason.replace(UNSAFE_IN_REASON, ' ')) : '', POLL_REASON_MAX_CHARS);
    entry.at = io.now();
    settlePoll();
    publishPoll();
    return { ok: true, note: `vote recorded: ${choice}` };
  }

  /* ---- browser input (contract 4.6) ---- */

  function onUserInput(name: string, data: string): InputEffect {
    const effect = classifyInput(typeof data === 'string' ? data : '');
    const rt = typeof name === 'string' ? agents.get(name) : undefined;
    if (!rt || rt.removed || !mailable(rt)) return effect;
    guarded('user input', () => {
      const now = io.now();
      rt.lastInputAt = now;
      if (rt.state === 'stopped') return;
      if (effect === 'set') {
        // Keystrokes that answer a dialog or a permission prompt are not a draft.
        if (rt.state === 'needs_you' || screenOf(rt)?.dialog) return;
        rt.draft = { lastKeyAt: now };
        syncHolds(rt);
      } else if (effect === 'clear') {
        rt.draft = null;
        rt.unconfirmed = null;
        syncHolds(rt);
        if (rt.queue.length > 0) scheduleDelivery(rt, DELIVERY_SETTLE_MS);
      }
      flush(rt);
    });
    return effect;
  }

  /* ---- start and shutdown (contract 4.9) ---- */

  function freeBossName(): string {
    if (!agents.has(BOSS_DEFAULT_NAME)) return BOSS_DEFAULT_NAME;
    for (let suffix = 2; ; suffix += 1) {
      const candidate = `${BOSS_DEFAULT_NAME}-${suffix}`;
      if (!agents.has(candidate)) return candidate;
    }
  }

  async function doStart(): Promise<void> {
    assertOpen();
    const roster = await io.loadRoster();
    for (const record of Array.isArray(roster?.agents) ? roster.agents : []) {
      if (!isRecord(record) || typeof record.name !== 'string' || agents.has(record.name)) {
        log.warn('skipping a roster record that is not usable');
        continue;
      }
      agents.set(record.name, makeRt({ ...record }));
    }
    if (bossRt() === null) {
      const boss: AgentRecord = {
        name: freeBossName(),
        role: BOSS_ROLE,
        dir: typeof options.bossDir === 'function' ? options.bossDir() : options.bossDir,
        mode: 'default',
        sessionId: io.newSessionId(),
        desk: 0,
        boss: true,
        createdAt: io.now(),
        position: 'flight',
      };
      await saveRecords([...rosterRecords(), boss]);
      agents.set(boss.name, makeRt(boss));
    }
    let history: MessageRecord[] = [];
    try {
      const loaded = await io.loadHistory(ACTIVITY_BACKLOG);
      history = loaded.map(sanitizeHistory).filter((record): record is MessageRecord => !!record);
    } catch (error) {
      log.warn('could not load the message history', error);
    }
    for (const record of history) {
      if (messages.has(record.id)) continue;
      remember(record);
      // Queues live in memory only: whatever the log still shows as waiting will never be typed.
      if (waiting(record)) setMessage(record, 'undelivered', SERVER_RESTARTED_NOTE);
    }
    // live reload: agents that kept running in the pty host are taken over before anything is started
    if (io.adoptable) {
      try {
        const found = await io.adoptable();
        const { adopted, unknown } = adopt(found.running, found.holds);
        for (const name of unknown) {
          log.warn(`${name} runs in the pty host but is not in the roster (or is already running): stopping it`);
          const gen = found.running.find((item) => item.name === name)?.generation ?? 0;
          await io.stop(name, gen).catch(() => undefined);
        }
        // a hold of an agent that did not come back with the host (it may still be alive there) stays a hold: nothing starts it again but the Director
        for (const [name, reason] of Object.entries(found.holds)) {
          if (typeof reason === 'string' && reason !== '' && agents.has(name) && !adopted.includes(name)) lostHolds.set(name, reason);
        }
        if (lostHolds.size > 0) saveHolds();
        if (adopted.length > 0) log.info(`took over ${adopted.length} running agent${adopted.length === 1 ? '' : 's'}: ${adopted.join(', ')}`);
      } catch (error) {
        log.warn('could not take over the running agents', error);
      }
    }
    armSweep();
    const boss = bossRt();
    const settings = io.startup?.() ?? { policy: 'boss' as const, carryOn: false, bossMayStart: true };
    // the set the last run left; without it (no file, too old) `running` is the same as `boss`
    const set = settings.policy === 'running' ? (io.runSet?.() ?? null) : null;
    const byName = new Map((set ?? []).map((entry) => [entry.name, entry]));
    const startBoss = settings.policy === 'boss' || (settings.policy === 'running' && (set === null || (boss !== null && byName.has(boss.record.name) && boss.record.autostart !== false)));
    // the set is what the next start will use: an agent that this start leaves stopped (the policy, an opt-out, a removed agent) is not in it
    // an agent that is running already (taken over from the pty host) is not left out
    for (const entry of io.runSet?.() ?? []) if (agents.get(entry.name)?.state === 'stopped' && !(startBoss && entry.name === boss?.record.name) && (settings.policy !== 'running' || set === null)) io.markRun?.(entry.name, false, false);
    let bossFailed: string | null = null;
    // an adopted boss is running already: nothing to start, and it was not cut in the middle of a turn
    if (boss && startBoss && boss.state === 'stopped' && !lostHolds.has(boss.record.name)) {
      // a boss that cannot start must not keep the others from starting
      try {
        await enqueue(boss, 'restart', () => restartOp(boss), true);
        // a start that failed leaves the agent stopped with the reason; it is not thrown
        if (boss.state === 'stopped') bossFailed = `${boss.record.name} (${boss.exit?.text ?? 'did not start'})`;
        else if (settings.carryOn && byName.get(boss.record.name)?.working === true) carryOn(boss);
      } catch (error) {
        bossFailed = `${boss.record.name} (${errorMessage(error)})`;
        log.error('the boss could not start', error);
      }
    }
    if (set !== null) void autostart(set, settings.carryOn, boss, bossFailed).catch((error: unknown) => log.error('autostart failed', error));
  }

  /** One message from the Director to an agent that was in a turn when the server stopped; it goes through the usual door, so Max Q and Redline apply. */
  function carryOn(rt: Rt): void {
    try {
      sendFromUser({ to: rt.record.name, subject: 'Server restarted', body: CARRY_ON_NOTE });
    } catch (error) {
      log.warn(`could not tell ${rt.record.name} to carry on`, error);
    }
  }

  /** Waits until no agent of `list` is `starting`, or `ms` pass, or the server closes. */
  function waitOutOfStarting(list: Rt[], ms: number): Promise<void> {
    return new Promise((done) => {
      let waited = 0;
      const poll = (): void => {
        waited += 500;
        if (closing || waited >= ms || !list.some((rt) => rt.state === 'starting' && !rt.removed)) done();
        else io.setTimer(poll, 500);
      };
      if (closing || !list.some((rt) => rt.state === 'starting' && !rt.removed)) done();
      else io.setTimer(poll, 500);
    });
  }

  /**
   * Autostart (docs/autostart-spec.md): the agents of the saved set start again, a wave of STARTUP_WAVE at a time (fewer when Max Q is
   * lower), each once. A start that fails leaves the agent stopped with the reason; an agent that opted out stays stopped.
   */
  async function autostart(set: RunEntry[], carry: boolean, boss: Rt | null, bossFailed: string | null): Promise<void> {
    const todo: Rt[] = [];
    const skipped: string[] = [];
    for (const entry of set) {
      const rt = agents.get(entry.name);
      if (!rt || (rt === boss && rt.state !== 'stopped')) {
        if (!rt) io.markRun?.(entry.name, false, false);
        continue;
      }
      if (rt === boss) {
        io.markRun?.(entry.name, false, false);
        continue;
      }
      if (rt.state !== 'stopped') continue;
      if (lostHolds.has(rt.record.name)) {
        // held when its process was lost: starting it again would release the hold without the Director
        skipped.push(`${entry.name} (on hold)`);
        continue;
      }
      if (rt.record.autostart === false) {
        skipped.push(`${entry.name} (opted out)`);
        io.markRun?.(entry.name, false, false);
      } else todo.push(rt);
    }
    const failed: string[] = bossFailed === null ? [] : [bossFailed];
    let started = boss !== null && boss.state !== 'stopped' ? 1 : 0;
    const wave = Math.max(1, Math.min(STARTUP_WAVE, limit ?? STARTUP_WAVE));
    for (let at = 0; at < todo.length && !closing; at += wave) {
      const batch = todo.slice(at, at + wave);
      await Promise.all(
        batch.map(async (rt) => {
          try {
            await enqueue(rt, 'restart', () => restartOp(rt), true);
            started += 1;
            if (carry && set.find((entry) => entry.name === rt.record.name)?.working === true) carryOn(rt);
          } catch (error) {
            failed.push(`${rt.record.name} (${error instanceof Error ? error.message : String(error)})`);
          }
        }),
      );
      if (at + wave < todo.length) await waitOutOfStarting(batch, STARTUP_WAVE_TIMEOUT_MS);
    }
    if (closing) return;
    const left = [...skipped, ...failed];
    io.notify?.('startup', `Restarted ${started} ${started === 1 ? 'agent' : 'agents'} after the server start${left.length === 0 ? '' : `; not started: ${left.join(', ')}`}`);
  }

  function start(): Promise<void> {
    started ??= doStart();
    return started;
  }

  /** Live reload: the hub ends and the agents are left running in the pty host. A hold stays in the saved file. */
  function release(): void {
    closing = true;
    disarm(sweepTimer);
    sweepTimer = null;
    for (const rt of agents.values()) cancelTimers(rt);
  }

  function shutdown(): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    closing = true;
    disarm(sweepTimer);
    sweepTimer = null;
    pollState = null;
    // Queued behind a running operation, so a spawn in flight finishes (and has a process to stop) before it is stopped.
    const stops = [...agents.values()].map((rt) =>
      enqueue(rt, 'shutdown', () => terminateOp(rt)).catch((error: unknown) =>
        log.error(`could not stop ${rt.record.name}`, error),
      ),
    );
    shutdownPromise = Promise.all(stops).then(() => {
      for (const rt of agents.values()) cancelTimers(rt);
    });
    return shutdownPromise;
  }

  /* ---- the public API ---- */

  return {
    start,
    shutdown,
    views: () => sortedAgents().map(buildView),
    activity: () => {
      const items: ActivityItem[] = [];
      for (let index = order.length - 1; index >= 0 && items.length < ACTIVITY_HUB_MAX; index -= 1) {
        const record = messages.get(order[index] ?? '');
        if (record) items.push(toItem(record));
      }
      return items;
    },
    hire,
    edit: async (name, request) => {
      assertOpen();
      const rt = lookup(name);
      return enqueue(rt, 'edit', () => editOp(rt, request));
    },
    restart: async (name) => {
      assertOpen();
      const rt = lookup(name);
      return enqueue(rt, 'restart', () => restartOp(rt), true);
    },
    startAgent: async (name, by) => {
      assertOpen();
      const rt = lookup(name);
      if (rt.state !== 'stopped' || rt.transition !== null) {
        throw new HubError('conflict', isHoldReason(rt.redline) ? `${rt.record.name} is on hold: the Director resumes it` : rt.redline !== null ? `${rt.record.name} has tripped the redline: the Director resumes or stops it` : `${rt.record.name} is already running`);
      }
      // its process may still be alive in the pty host, held: only the Director's start or resume lets it go
      if (lostHolds.has(rt.record.name)) throw new HubError('conflict', `${rt.record.name} is on hold: the Director resumes it`);
      if (io.startup?.().bossMayStart === false) throw new HubError('forbidden', 'the Director turned off "FLIGHT may start agents" in Flight Rules');
      if (rt.record.stoppedBy === 'director') throw new HubError('forbidden', `the Director stopped ${rt.record.name}: only he starts it again`);
      log.info(`${by} starts ${rt.record.name}`);
      return enqueue(rt, 'restart', () => restartOp(rt), true);
    },
    stop: async (name) => {
      assertOpen();
      const rt = lookup(name);
      return enqueue(rt, 'stop', () => stopOp(rt), true);
    },
    remove: async (name) => {
      assertOpen();
      const rt = lookup(name);
      if (rt.record.boss) throw new HubError('conflict', 'the boss cannot be removed');
      return enqueue(rt, 'remove', () => removeOp(rt), true);
    },
    sendFromUser,
    sendFromDirector,
    sendFromStation,
    sendFromAgent,
    trip,
    hold,
    resume,
    holdAll,
    resumeAll,
    refreshLimits,
    readMessages,
    rosterFor,
    onHook,
    onUserInput,
    onTerminalEvent,
    adopt,
    release,
    saveHoldsNow,
    startPoll,
    holdPoll,
    abortPoll,
    clearPoll,
    vote,
    setGovernor,
    setMaxHops(value) {
      if (Number.isInteger(value) && value >= 1) maxHops = value;
    },
    answer,
    governor: governorView,
    poll: pollView,
  };
}
