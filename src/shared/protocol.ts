/**
 * gonogo shared contract. Types and const arrays only: no imports, no runtime dependencies.
 *
 * This file is compiled twice: by the client (DOM lib, bundler resolution, NO @types/node) and by the server
 * (NodeNext). So it must not mention Node types (Buffer, NodeJS.*, http.*) or DOM types. Use Uint8Array and
 * Record<string, string | undefined> instead.
 *
 * Owner: contract author. Builders import from here and never edit it. If a type is wrong or missing, say so in
 * the build report; do not fork a private copy of it.
 *
 * Part 1: const arrays and shared values. Part 2: wire types (browser <-> server). Part 3: server-internal
 * module contracts (hub, launcher, terminal host, home, hooks), so that the parts compile against one definition.
 * docs/contract.md says what each member means and who calls it.
 */

/* ------------------------------------------------------------------------------------------------------------
 * Part 1. Const arrays and shared values
 * ---------------------------------------------------------------------------------------------------------- */

export const PROTOCOL_VERSION = 1;

/** The five states of the design. Wire and code spelling: needs_you (label: "needs you"). */
export const AGENT_STATES = ['starting', 'idle', 'working', 'needs_you', 'stopped'] as const;
export type AgentState = (typeof AGENT_STATES)[number];

/** Passed to `claude --permission-mode` verbatim. `default` is accepted by claude 2.1.325 (alias of `manual`). */
export const PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'bypassPermissions'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** Why an agent is in needs_you. The human text is AgentView.needsReason. */
export const NEEDS_KINDS = ['startup_dialog', 'permission', 'dialog', 'input', 'redline'] as const;
export type NeedsKind = (typeof NEEDS_KINDS)[number];

/** Operation in progress that freezes state changes until it ends. */
export const TRANSITIONS = ['stopping', 'restarting', 'removing'] as const;
export type Transition = (typeof TRANSITIONS)[number];

/** Why delivery to an agent is paused: something the user did, an unconfirmed pointer, or a Redline trip. */
export const HELD_KINDS = ['draft', 'unconfirmed', 'redline'] as const;
export type HeldKind = (typeof HELD_KINDS)[number];

/**
 * What runs in the pty (Engine Bay, docs/engine-bay-spec.md). 'claude' is Claude Code with hooks and the MCP tools;
 * 'custom' is any command (a terminal with a lamp: no messages, no hooks); the rest are other agent CLIs.
 */
export const PROVIDERS = ['claude', 'gemini', 'antigravity', 'codex', 'opencode', 'qwen', 'grok', 'kimi', 'crush', 'pi', 'copilot', 'cursor', 'custom'] as const;
export type Provider = (typeof PROVIDERS)[number];

/** How far an adapter was checked: run against a model, checked against the installed program only, or written from its docs. */
export type ProviderCheck = 'run' | 'local' | 'docs';
export interface ProviderInfo {
  label: string;
  /** The program looked up on PATH; '' for custom (the owner types the command). */
  bin: string;
  /** working, idle and needs_you come from hooks (a Max Q slot, the Redline detectors); otherwise from output activity. */
  hooks: boolean;
  /** Gets the gonogo MCP tools: it can receive mail and vote. Without them it gets no mail. */
  mcp: boolean;
  /** The three permission modes map onto the CLI's own; otherwise the mode stays 'default'. */
  modes: boolean;
  /**
   * Payload (docs/payload-spec.md): 'all' takes MCP servers and skills, 'servers' MCP servers only, null nothing.
   * shortcut: Codex, opencode and Copilot take none (Codex would put env values on its command line, the other two use
   * file shapes not checked), upgrade when one of them is checked against a real run.
   */
  payload: 'all' | 'servers' | null;
  check: ProviderCheck;
  /** The CLI takes `--model <name>` (docs/engine-bay-spec.md says where each was checked): the names it suggests, possibly none. null: no model field. Hints only, never a list to keep up to date. */
  model: readonly string[] | null;
  /** The vendor's documented install command, copied from its page `docs`; null when none was checked. gonogo never runs it. */
  install: string | null;
  /** The vendor's page that says how to install it; '' for the custom command. */
  docs: string;
}
export const PROVIDER_INFO: Readonly<Record<Provider, ProviderInfo>> = {
  claude: { label: 'Claude Code', bin: 'claude', hooks: true, mcp: true, modes: true, payload: 'all', check: 'run', model: ['sonnet', 'opus', 'haiku'], install: 'npm install -g @anthropic-ai/claude-code@latest', docs: 'https://code.claude.com/docs/en/setup' },
  gemini: { label: 'Gemini CLI', bin: 'gemini', hooks: true, mcp: true, modes: true, payload: 'servers', check: 'local', model: ['auto', 'pro', 'flash', 'flash-lite'], install: 'npm install -g @google/gemini-cli', docs: 'https://github.com/google-gemini/gemini-cli' },
  // hooks and mcp are false until a start can load them from the agent's own folder (docs/facts/antigravity.md): agy reads hooks.json and mcp_config.json only from .agents/, ~/.gemini/config/ and plugins.
  antigravity: { label: 'Antigravity CLI', bin: 'agy', hooks: false, mcp: false, modes: true, payload: null, check: 'local', model: [], install: 'curl -fsSL https://antigravity.google/cli/install.sh | bash', docs: 'https://antigravity.google/docs/getting-started' },
  codex: { label: 'Codex', bin: 'codex', hooks: false, mcp: true, modes: true, payload: null, check: 'docs', model: [], install: 'npm install -g @openai/codex', docs: 'https://github.com/openai/codex' },
  opencode: { label: 'opencode', bin: 'opencode', hooks: false, mcp: true, modes: false, payload: null, check: 'docs', model: null, install: 'curl -fsSL https://opencode.ai/v2/install | bash', docs: 'https://opencode.ai/docs/' },
  qwen: { label: 'Qwen Code', bin: 'qwen', hooks: false, mcp: false, modes: false, payload: null, check: 'docs', model: null, install: 'curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash', docs: 'https://github.com/QwenLM/qwen-code' },
  grok: { label: 'Grok CLI', bin: 'grok', hooks: false, mcp: false, modes: false, payload: null, check: 'docs', model: null, install: 'curl -fsSL https://raw.githubusercontent.com/superagent-ai/grok-cli/main/install.sh | bash', docs: 'https://github.com/superagent-ai/grok-cli' },
  kimi: { label: 'Kimi CLI', bin: 'kimi', hooks: false, mcp: true, modes: false, payload: 'servers', check: 'docs', model: [], install: null, docs: 'https://moonshotai.github.io/kimi-cli/' },
  crush: { label: 'Crush', bin: 'crush', hooks: false, mcp: false, modes: false, payload: null, check: 'docs', model: null, install: 'brew install charmbracelet/tap/crush', docs: 'https://github.com/charmbracelet/crush' },
  pi: { label: 'pi', bin: 'pi', hooks: false, mcp: false, modes: false, payload: null, check: 'local', model: ['sonnet', 'haiku'], install: 'curl -fsSL https://pi.dev/install.sh | sh', docs: 'https://pi.dev/' },
  copilot: { label: 'Copilot CLI', bin: 'copilot', hooks: false, mcp: true, modes: false, payload: null, check: 'docs', model: null, install: 'curl -fsSL https://gh.io/copilot-install | bash', docs: 'https://github.com/github/copilot-cli' },
  cursor: { label: 'Cursor Agent', bin: 'cursor-agent', hooks: false, mcp: false, modes: false, payload: null, check: 'docs', model: [], install: 'curl https://cursor.com/install -fsS | bash', docs: 'https://cursor.com/docs/cli/overview' },
  custom: { label: 'Custom command', bin: '', hooks: false, mcp: false, modes: false, payload: null, check: 'run', model: null, install: null, docs: '' },
};

/** Model field of the hire form and the roster: a CLI model name or alias, passed as `--model <name>`. A leading dash would be read as a flag. */
export const MODEL_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}$';
/**
 * Clearance (docs/engine-bay-spec.md): environment variables the Director sets for one agent, usually API keys. Upper case
 * names; a value is printable ASCII without a space. At most KEYS_MAX per agent. The values never leave the server.
 */
export const KEY_NAME_PATTERN = '^[A-Z][A-Z0-9_]{0,63}$';
export const KEY_VALUE_PATTERN = '^[\\x21-\\x7e]{1,4096}$';
export const KEYS_MAX = 16;
/** Names the form suggests for a key: the variables `pi --help` (1.5.2) lists. Hints, not a list. */
export const KEY_SUGGESTIONS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY'] as const;
/** Absent in an old roster record means 'claude'. */
export const providerInfo = (provider: Provider | undefined): ProviderInfo => PROVIDER_INFO[provider ?? 'claude'];

/** T-minus: the Director's pre-flight go/no-go poll. open -> go (all voted go) | hold (any no-go, or the Director holds) | aborted. */
export const POLL_STATUSES = ['open', 'go', 'hold', 'aborted'] as const;
export type PollStatus = (typeof POLL_STATUSES)[number];
export const POLL_VOTES = ['go', 'no-go'] as const;
export type PollVote = (typeof POLL_VOTES)[number];

/**
 * The eight hook events registered in every per-agent settings file, in this order. SessionStart is absent: http hooks
 * cannot use it. PostToolUseFailure is a "working" heartbeat next to PostToolUse (a tool the user allowed may fail).
 */
export const HOOK_EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Name of the MCP server in mcp.json. Tool names seen by claude are mcp__gonogo__<tool>. */
export const MCP_SERVER_NAME = 'gonogo';
/** Clean Room (docs/clean-room-spec.md): the worktrees live in <home>/cleanroom/<name> on the branch gonogo/<name>. */
export const CLEAN_ROOM_DIR = 'cleanroom';
export const cleanRoomBranch = (name: string): string => `gonogo/${name}`;
export const MCP_TOOL_NAMES = ['send_message', 'list_roster', 'read_messages', 'go_nogo', 'task_list', 'task_create', 'task_update', 'log_write', 'log_search', 'log_read', 'board_read', 'board_write', 'livery_submit', 'hire_agent'] as const;

/** Message outcome shown in the activity strip. See contract section 5 for the exact rules and notes. */
export const ACTIVITY_STATUSES = ['queued', 'held', 'delivered', 'read', 'undelivered', 'to_user'] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];

/** Window-title glyph class. idle = U+2733 "✳", working = U+25D0/U+25D1, unknown = anything else or no title yet. */
export const TITLE_GLYPHS = ['idle', 'working', 'unknown'] as const;
export type TitleGlyph = (typeof TITLE_GLYPHS)[number];

/** Dialog kinds the terminal host can recognise on screen. */
export const DIALOG_KINDS = ['theme', 'login', 'trust', 'bypass', 'api_key', 'resume', 'permission', 'menu'] as const;
export type DialogKind = (typeof DIALOG_KINDS)[number];

/** Which flag carries the session id on a start. */
export const SESSION_FLAGS = ['session-id', 'resume'] as const;
export type SessionFlag = (typeof SESSION_FLAGS)[number];

/**
 * Error codes of the REST API and of HubError. HTTP status: 400, 401, 403, 404, 409, 413, 415, 500, and 503 for
 * `unavailable` (the web layer answers it while the hub has not started yet; the hub itself never throws it).
 */
export const API_ERROR_CODES = [
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'too_large',
  'unsupported',
  'internal',
  'unavailable',
  'rate_limited',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** What a chunk of browser input did to the draft latch (contract 4.6). `Hub.onUserInput` returns it; web.ts uses it for size ownership. */
export const INPUT_EFFECTS = ['set', 'clear', 'none'] as const;
export type InputEffect = (typeof INPUT_EFFECTS)[number];

/** Names no agent may use: they are recipient aliases. */
export const RESERVED_NAMES = ['user', 'boss'] as const;

/* ---- limits shared by the hire form and the server ---- */
export const AGENT_NAME_PATTERN = '^[a-z0-9][a-z0-9-]{0,31}$';
export const AGENT_NAME_MAX = 32;
export const ROLE_MAX_CHARS = 4000;
export const DIR_MAX_CHARS = 1024;
export const SUBJECT_MAX_CHARS = 200;
export const BODY_MAX_CHARS = 20000;
export const MAX_AGENTS = 24;
/** Launch Window limits. The name goes into the subject of every message the schedule sends. */
export const SCHEDULE_NAME_MAX_CHARS = 60;
export const SCHEDULES_MAX = 50;
export const CRON_MAX_CHARS = 100;
/** Every message of a schedule has a subject that starts with this and the schedule's name. */
export const scheduleSubject = (name: string, subject: string): string => `Launch Window: ${name}${subject === '' ? '' : `: ${subject}`}`;

/** Uplink limits. The name goes into the subject of every message a delivery makes. */
export const UPLINK_NAME_MAX_CHARS = 60;
export const UPLINKS_MAX = 20;
/** How many recent deliveries an uplink keeps. */
export const UPLINK_DELIVERIES_MAX = 20;

/** Flight Plan limits and words (docs/flight-plan-spec.md). Open means any status but done. */
export const TASK_STATUSES = ['todo', 'doing', 'review', 'done', 'blocked'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_TITLE_MAX_CHARS = 200;
export const TASK_DETAIL_MAX_CHARS = 4000;
/** The text of one note a caller adds; the server adds the time and who. */
export const TASK_NOTE_MAX_CHARS = 200;
export const TASKS_OPEN_MAX = 500;
/** The message an agent gets when a task is assigned to it. */
export const taskSubject = (id: string, title: string): string => `Flight Plan: ${id} assigned to you: ${title}`;
/** Mission Log limits (docs/mission-log-spec.md). A tag is lowercase; the search never returns more than LOG_SEARCH_MAX hits. */
export const LOG_TITLE_MAX_CHARS = 200;
export const LOG_BODY_MAX_CHARS = 20_000;
export const LOG_ENTRIES_MAX = 2000;
export const LOG_TAGS_MAX = 8;
export const LOG_TAG_PATTERN = '^[a-z0-9][a-z0-9._-]{0,29}$';
export const LOG_QUERY_MAX_CHARS = 200;
export const LOG_SEARCH_MAX = 20;
/** Plot Board (docs/plot-board-spec.md): the one plan of the room, `board.md`. At most this many characters. */
export const BOARD_MAX_CHARS = 10_000;
/** Black Box (docs/black-box-spec.md): what an event records, and how long its line is. `audit` is the Black Box's own note. */
export const AUDIT_KINDS = ['crew', 'redline', 'poll', 'answer', 'plan', 'uplink', 'config', 'audit'] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];
export const AUDIT_TEXT_MAX_CHARS = 200;
/** How a part of the server tells the Black Box of an event: names, ids and words of the server, never a text somebody wrote. */
export type AuditRecord = (kind: AuditKind, text: string) => void;
/** Downlink (docs/downlink-spec.md): what besides a message to the Director lands in his inbox. */
export const DOWNLINK_EVENT_KINDS = ['redline', 'tminus', 'launch-window', 'uplink', 'flight-plan', 'livery', 'relief'] as const;
export type DownlinkEventKind = (typeof DOWNLINK_EVENT_KINDS)[number];
/** How a part of the server tells the inbox of something the Director should see (`Downlink.post`). */
export type DownlinkNotify = (kind: DownlinkEventKind, text: string) => void;
/** What an uplink understands: `generic` is any sender that signs its JSON, the others are the services of Relay (docs/relay-spec.md). */
export const UPLINK_KINDS = ['generic', 'github', 'linear', 'slack', 'telegram'] as const;
export type UplinkKind = (typeof UPLINK_KINDS)[number];
/** Slack and Linear make the signing secret themselves: the uplink takes theirs at create (and with Edit), it does not make one. */
export const UPLINK_GIVEN_SECRET_KINDS: readonly UplinkKind[] = ['linear', 'slack'];
/** Relay (docs/relay-spec.md): where Downlink items can be sent, and which of them. `message` is a message to the Director. */
export const RELAY_SERVICES = ['slack', 'telegram'] as const;
export type RelayService = (typeof RELAY_SERVICES)[number];
export const RELAY_FORWARD_KINDS = ['message', 'redline', 'tminus', 'flight-plan'] as const;
export type RelayForwardKind = (typeof RELAY_FORWARD_KINDS)[number];
/** Every message of an uplink has this subject. */
export const uplinkSubject = (name: string): string => `Uplink: ${name}`;
/** Body length sent to browsers inside ActivityItem; the log keeps the whole text. */
export const ACTIVITY_WIRE_BODY_CHARS = 2000;
/** Activity items a browser keeps (newest first). */
export const ACTIVITY_CLIENT_MAX = 200;

/* ---- wire constants ---- */
export const WS_PATH = '/ws';
export const API_PREFIX = '/api';
/**
 * WebSocket auth: the browser token travels in the Sec-WebSocket-Protocol request header, never in the URL (reverse
 * proxies log the request line, query string included, on every connect):
 *   new WebSocket(url, [WS_SUBPROTOCOL, WS_TOKEN_PROTOCOL_PREFIX + token])
 * The server selects WS_SUBPROTOCOL only, so the secret is not echoed. REST auth: Authorization: Bearer <browser token>.
 */
export const WS_SUBPROTOCOL = 'gonogo.v1';
export const WS_TOKEN_PROTOCOL_PREFIX = 'token.';
/**
 * The client splits one terminal input (a big paste) into pieces of at most this many UTF-16 code units, never between
 * the two halves of a surrogate pair, so that no frame comes near WS_MAX_FRAME_BYTES (constants.ts).
 */
export const WS_INPUT_CHUNK_CHARS = 32 * 1024;
/** The printed URL carries the token once, as http://host:port/#token=<64 hex>. The client moves it to storage and removes the fragment. */
export const TOKEN_FRAGMENT_KEY = 'token';
export const TOKEN_STORAGE_KEY = 'gonogo.token';
/**
 * Binary WebSocket frames (server to client) carry terminal bytes:
 *   byte 0      = WS_BINARY_OUTPUT (1)
 *   bytes 1..4  = attach seq, unsigned 32-bit big endian (the seq of the AttachFrame this output belongs to)
 *   bytes 5..   = raw pty output
 * The client drops a binary frame whose seq is not the current attach seq.
 */
export const WS_BINARY_OUTPUT = 1;

/* ---- client behaviour constants (shared so tests and UI agree) ---- */
export const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 10000] as const;
/** After this many failed reconnects in a row the pane says the server is gone (it keeps retrying at the last delay). */
export const RECONNECT_SERVER_GONE_AFTER = 3;
export const RESIZE_DEBOUNCE_MS = 120;
export const ENVELOPE_MS = 1400;
/** The store drops an envelope this long after it started. */
export const ENVELOPE_KEEP_MS = 2000;
/** The sequence chart: how far back an agent's state history reaches, and how many changes it keeps. */
export const HISTORY_WINDOW_MS = 600_000;
export const HISTORY_MAX = 60;
export const DOING_MAX_CHARS = 120;
export const FLOOR_COLUMNS = 4;
export const FLOOR_MIN_DESKS = 8;

/** Colours per state: used by the floor (SVG) and the UI (CSS) so both agree. Each is >= 4.5:1 on #232733 and on #1c1f27. */
export const STATE_COLORS: Record<AgentState, string> = {
  starting: '#8da2ff',
  idle: '#6fd49a',
  working: '#ffc857',
  needs_you: '#ff6b6b',
  stopped: '#8b93a7',
};
export const STATE_LABELS: Record<AgentState, string> = {
  starting: 'starting',
  idle: 'idle',
  working: 'working',
  needs_you: 'needs you',
  stopped: 'stopped',
};

/* ------------------------------------------------------------------------------------------------------------
 * Part 2. Wire types (browser <-> server) and persisted shapes
 * ---------------------------------------------------------------------------------------------------------- */

/** One MCP server of a Payload, in the shape of Claude Code's mcp.json: stdio has command, args and env; http and sse have url and headers. */
export interface McpServer {
  /** Absent means 'stdio'. */
  type?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}
/** Capabilities chosen for one agent (docs/payload-spec.md). Stored in agents.json in plain text, env and header values included. */
export interface Payload {
  /** Server name to config. The name is lowercase letters, digits, - and _ (at most 32); "gonogo" is reserved. */
  mcpServers?: Record<string, McpServer>;
  /** Absolute paths of skill folders (each holds a SKILL.md). Claude Code agents only. */
  skills?: string[];
}
/** Clean Room: the agent runs in a container on its own git worktree. `image` replaces GONOGO_CLEANROOM_IMAGE for this agent. */
export interface CleanRoom {
  image?: string;
}
/** One agent as stored in <home>/agents.json (inside RosterFile). */
export interface AgentRecord {
  name: string;
  role: string;
  /** Absolute path as typed (normalised with path.resolve). Checked on hire and edit, and again at every start. */
  dir: string;
  mode: PermissionMode;
  /** UUID passed to --session-id / --resume. Updated when a UserPromptSubmit hook reports a different session_id (after /clear). */
  sessionId: string;
  /** Desk index on the floor. The boss is always 0. */
  desk: number;
  boss: boolean;
  createdAt: number;
  /** Id of a roster position (src/shared/positions.ts); absent for a custom role. Only sets the accent colour and the call sign shown. */
  position?: string;
  /** Absent means 'claude'. */
  provider?: Provider;
  /** Provider 'custom' only: the command to run, a JSON array of strings or words separated by spaces (same rules as GONOGO_AGENT_CMD). */
  command?: string;
  /** Absent means none. Never an empty object. */
  payload?: Payload;
  /** Absent means the agent runs on the host. Claude Code agents only. */
  cleanRoom?: CleanRoom;
  /** Engine Bay: the model passed as `--model` (MODEL_PATTERN); absent means the CLI's own default. Only for a provider with PROVIDER_INFO.model. */
  model?: string;
  /** Clearance: the names of the keys set for this agent and the ms epoch each was set. The values live in keys.json, never here. Absent means none. */
  keys?: Record<string, number>;
}
export interface RosterFile {
  version: 1;
  agents: AgentRecord[];
}

/** Hold: the needsReason of an agent the Director put on hold (a Redline trip by hand, cleared by resume). */
export const HOLD_REASON = 'on hold';

/** Telemetry: one tool call of an agent, from its PreToolUse and PostToolUse (or PostToolUseFailure) hooks. */
export interface ToolCall {
  /** ms epoch of the PreToolUse hook. */
  at: number;
  /** null while no Post hook came (still running, or interrupted). */
  ms: number | null;
  tool: string;
  /** One line, like AgentView.doing ("Bash: npm test"). */
  summary: string;
  failed: boolean;
}

/** Telemetry keeps this many calls per agent, in memory and in telemetry.jsonl. */
export const TELEMETRY_PER_AGENT = 200;

export interface HeldInfo {
  kind: HeldKind;
  /**
   * Exact text for the floor and the strip: "held: text in ana's input", "held: pointer not confirmed within 2 s", or
   * (unconfirmed, no hook ever reached the hub from this process) "held: no hook has reached gonogo from ana; is its folder trusted?".
   */
  text: string;
}

export interface ExitSummary {
  code: number | null;
  signal: number | null;
  at: number;
  /** true when the user (or shutdown) asked for it. */
  requested: boolean;
  /** One line for the UI: "exited with code 1: No conversation found with session ID: ..." */
  text: string;
}

/** One state change of an agent, for the sequence chart. */
export interface StateChange {
  state: AgentState;
  /** ms epoch (server time). */
  at: number;
}

/** What browsers see of an agent. The hub sends a whole AgentView in every AgentFrame. */
export interface AgentView {
  name: string;
  role: string;
  dir: string;
  mode: PermissionMode;
  desk: number;
  boss: boolean;
  state: AgentState;
  /** ms epoch of the last state change. */
  stateSince: number;
  needsKind: NeedsKind | null;
  /** Exact text, for example "startup dialog: answer it in the terminal" or "permission request: Bash: git push origin main". */
  needsReason: string | null;
  /** Non-null while a stop, restart or remove is running. Routing treats 'stopping' and 'removing' as stopped. */
  transition: Transition | null;
  /** The user typed text into this agent's input and has not pressed Enter or Ctrl-C yet, and the box has not been empty for a second (30 min expiry). A lone Escape does not end it. */
  draft: boolean;
  /** Set when queued mail cannot be delivered because of the draft latch or an unconfirmed pointer. */
  held: HeldInfo | null;
  /** Messages waiting for a pointer (status queued or held). */
  queued: number;
  /** The roster differs from the running configuration (role, dir or mode edited): restart to apply. */
  dirty: boolean;
  /** Counts spawns of this agent in this server run; 0 = never started. A change tells the client to re-attach. */
  generation: number;
  exit: ExitSummary | null;
  /** Roster position id, or null. */
  position: string | null;
  provider: Provider;
  /** The custom command as stored, or null. */
  command: string | null;
  /** The payload as stored (env and header values included), or null. */
  payload: Payload | null;
  /** The Clean Room as stored, or null: the branch and the worktree path follow from the name (cleanRoomBranch, CLEAN_ROOM_DIR). */
  cleanRoom: CleanRoom | null;
  /** The model as stored, or null for the CLI's default. */
  model: string | null;
  /** Clearance: key name to when it was set. Names only: a value is never sent to a browser. */
  keys: Record<string, number>;
  /**
   * What the agent last did, one line for its console tile: the tool call of the latest PreToolUse hook, formatted like
   * the permission reason without its prefix ("Bash: npm test -- export"), at most DOING_MAX_CHARS. null before the
   * first tool call of this process and for a custom agent.
   */
  doing: string | null;
  /**
   * State changes, oldest first: every change of the last HISTORY_WINDOW_MS plus the one before them (so the chart knows the
   * state at the left edge), at most HISTORY_MAX. Memory only; the last entry is the current state.
   */
  history: StateChange[];
}

/** One position's answer in a T-minus poll. */
export interface PollEntry {
  agent: string;
  vote: PollVote | null;
  /** One sentence from the agent, '' until it votes ('stopped' when its process ended during the poll). */
  reason: string;
  /** ms epoch of the vote, or null. */
  at: number | null;
}
/** The one poll the hub keeps in memory (never persisted). */
export interface PollView {
  id: number;
  startedAt: number;
  status: PollStatus;
  entries: PollEntry[];
  /** One line for the wall display, for example "waiting for guido, fido" or "no-go: simsup". */
  note: string;
  /** Static fire: what is under test. Absent on a T-minus poll. */
  subject?: string;
}
/** Max Q: a limit on how many agents work at once. limit null = off. */
export interface GovernorView {
  limit: number | null;
  /** Agents in state working now. */
  working: number;
  /** Messages from agents that wait only because the limit is reached. */
  holding: number;
}

/** Propellant: rolling token windows. day = 24 h, week = 7 days, month = 30 days. */
export const FUEL_WINDOWS = ['5h', 'day', 'week', 'month'] as const;
export type FuelWindow = (typeof FUEL_WINDOWS)[number];
/** A token limit per window; a missing window has no limit. */
export type FuelLimits = Partial<Record<FuelWindow, number>>;
export interface FuelGauge {
  /** Tokens counted in each window: input + cache creation + output (cache reads are not counted). */
  used: Record<FuelWindow, number>;
  limits: FuelLimits;
}
/** Token use of the room and of each agent that used any or has a limit. */
export interface PropellantView {
  room: FuelGauge;
  agents: Record<string, FuelGauge>;
  /** The same use in dollars at list prices (docs/cost-spec.md). */
  cost: CostView;
}
/** A budget in dollars per window; a missing window has none. */
export type Budget = Partial<Record<FuelWindow, number>>;
export interface CostGauge {
  /** Dollars of the priced use in each window (an API-equivalent estimate, not a bill). */
  usd: Record<FuelWindow, number>;
  /** Tokens (input + cache creation + output) in each window that could not be priced: an old ledger line or a model with no price. */
  unpriced: Record<FuelWindow, number>;
  budget: Budget;
}
/** One local calendar day of spend. */
export interface DayCost {
  /** YYYY-MM-DD in the server's local time. */
  date: string;
  usd: number;
  unpriced: number;
  byAgent: Record<string, number>;
}
export interface CostView {
  room: CostGauge;
  agents: Record<string, CostGauge>;
  /** The last 14 local calendar days, oldest first. */
  days: DayCost[];
  /** Epoch ms of the oldest ledger line that carries a model, so it can be priced; null when none does. */
  pricedSince: number | null;
}

/** Launch Window: a message sent by itself on a cron rule (docs/launch-window-spec.md). One entry of schedules.json. */
export interface Schedule {
  /** s1, s2, ... */
  id: string;
  /** At most SCHEDULE_NAME_MAX_CHARS characters on one line. */
  name: string;
  /** Agent name or "boss". */
  to: string;
  /** The text after "Launch Window: <name>: " in the subject of the message; may be empty. */
  subject: string;
  body: string;
  /** Five-field cron rule (src/shared/cron.ts), in the server's local time zone. */
  rule: string;
  enabled: boolean;
  createdAt: number;
  /** ms epoch of the last run (a fire or Run now), or null. */
  lastRunAt: number | null;
  /** What the hub answered at the last run, one line, or null. */
  lastResult: string | null;
}
/** A schedule as browsers get it: with the time of its next fire (null when it is off). */
export interface ScheduleView extends Schedule {
  nextAt: number | null;
}

/** What became of one delivery: the hub's status for a message that was made, `refused` for one that was not, `answered` for a ping or a challenge that got its answer and made no message. */
export interface UplinkDelivery {
  at: number;
  status: ActivityStatus | 'refused' | 'answered';
  /** One line: the message id and what the hub said, or why it was refused. */
  note: string;
}
/** Uplink: a webhook that starts work (docs/uplink-spec.md). One entry of uplinks.json. */
export interface Uplink {
  /** u1, u2, ... */
  id: string;
  /** At most UPLINK_NAME_MAX_CHARS characters on one line. */
  name: string;
  kind: UplinkKind;
  /** Agent name or "boss". */
  to: string;
  /** 32 random bytes in hex, or the signing secret of the service for a slack or linear uplink. Browsers get it only in the answer to create and rotate. */
  secret: string;
  enabled: boolean;
  createdAt: number;
  /** Newest first, at most UPLINK_DELIVERIES_MAX. */
  deliveries: UplinkDelivery[];
}
/** An uplink as browsers get it: without the secret. */
export type UplinkView = Omit<Uplink, 'secret'>;
/** The answer to create and rotate: the one time the secret is shown. */
export interface UplinkCreated extends UplinkView {
  secret: string;
}

/** Relay: how the last send to a target went. */
export interface RelayLast {
  at: number;
  ok: boolean;
  /** One line, never a token. */
  note: string;
}
/** Relay: a target as browsers get it. The token is never sent back. */
export interface RelayTargetView {
  /** The Slack channel id or the Telegram chat id. */
  to: string;
  last: RelayLast | null;
}
export interface RelayView {
  slack: RelayTargetView | null;
  telegram: RelayTargetView | null;
  /** The kinds of item that are sent to every target, in the order of RELAY_FORWARD_KINDS. */
  forward: RelayForwardKind[];
}
/** PUT /api/relay/slack and /api/relay/telegram. `token` may be left out to keep the one saved. */
export interface RelayTargetRequest {
  token?: string;
  to: string;
}
/** PUT /api/relay/forward. */
export interface RelayForwardRequest {
  kinds: RelayForwardKind[];
}

/** Docking (docs/docking-spec.md): the shape of a station name. It is the part of "name@station" after the @, and name@station must fit the 64 characters of `to`. */
export const STATION_NAME_PATTERN = '^[a-z0-9][a-z0-9-]{0,30}$';
export const DOCKS_MAX = 8;
/** One agent of a docked station, as its roster says. */
export interface DockedAgent {
  name: string;
  /** At most ROSTER_ROLE_CHARS characters. */
  role: string;
  state: AgentState;
  boss: boolean;
}
/** One docked station as browsers get it: never the secret. */
export interface DockView {
  /** The station id of the other side. */
  id: string;
  /** What the other side calls itself: the part after the @ in "name@station". */
  name: string;
  url: string;
  since: number;
  /** `new` before the first pull, `ok` when the last pull answered, `down` when it did not. */
  status: 'new' | 'ok' | 'down';
  /** When the last pull answered, or null. */
  seenAt: number | null;
  /** Why the last pull failed, one line, or null. */
  error: string | null;
  agents: DockedAgent[];
}
export interface DockingView {
  /** This station's own name. */
  station: string;
  docks: DockView[];
}
/** POST /api/docking/code: the public address of this station, as the other side will reach it. */
export interface DockCodeRequest {
  url: string;
}
/** The answer to POST /api/docking/code. The code holds a one-time token, so it is shown once. */
export interface DockCode {
  code: string;
  expiresAt: number;
}
/** POST /api/docking/pair: the code from the other side, and the public address of this station. */
export interface DockPairRequest {
  code: string;
  url: string;
}
/** POST /api/docking/:id/handoff: a task of this board, and the agent of that station that gets it (optional). */
export interface DockHandoffRequest {
  task: string;
  assignee?: string | null;
}
/** What crosses a dock as a message: `from` is an agent name of the sending station, `to` an agent name or "boss" of the receiving one. */
export interface StationMessage {
  from: string;
  to: string;
  subject: string;
  body: string;
  /** The hops of the message when it left, which count towards the hop limit of the station that gets it. */
  hops: number;
}

/** Flight Plan: one task of the board (docs/flight-plan-spec.md). One entry of tasks.json. */
export interface Task {
  /** t1, t2, ... */
  id: string;
  /** At most TASK_TITLE_MAX_CHARS characters on one line. */
  title: string;
  /** At most TASK_DETAIL_MAX_CHARS characters; may be empty. */
  detail: string;
  status: TaskStatus;
  /** An agent name, or null. */
  assignee: string | null;
  /** "user" (the Director) or the name of the agent that made it. */
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** The history, oldest first: "2026-11-17 14:03 UTC ana: status doing". */
  notes: string[];
  /** Docking: the name of the station this task was handed off to. The task is then done here. */
  handedOff?: string;
}

/** Downlink: a message to the Director, with what the inbox keeps of it. The log keeps the whole body. */
export interface DownlinkMessage {
  type: 'message';
  /** m1, m2, ...: the id of the message. */
  id: string;
  at: number;
  from: string;
  subject: string;
  /** Cut to ACTIVITY_WIRE_BODY_CHARS. */
  body: string;
  truncated: boolean;
  inReplyTo: string | null;
  read: boolean;
  archived: boolean;
}
/** Downlink: something the server noticed that the Director should see. One short line. */
export interface DownlinkEvent {
  type: 'event';
  /** e1, e2, ...: never used twice, also after a restart. */
  id: string;
  at: number;
  kind: DownlinkEventKind;
  text: string;
  read: boolean;
  archived: boolean;
}
export type DownlinkItem = DownlinkMessage | DownlinkEvent;
/** The inbox as browsers get it, newest first. `unread` counts the items that are neither read nor archived. */
export interface DownlinkView {
  unread: number;
  items: DownlinkItem[];
}
/** POST /api/downlink/read and /api/downlink/archive. An id the inbox no longer holds is skipped. */
export interface DownlinkRequest {
  ids: string[];
}

/** Mission Log: what a `log` frame names of an entry. The text of an entry never travels in a frame. */
export interface LogHead {
  /** l1, l2, ... */
  id: string;
  title: string;
}
/** Mission Log: one entry, one file `mission-log/<id>.md`. */
export interface LogEntry extends LogHead {
  body: string;
  /** Lowercase, at most LOG_TAGS_MAX. */
  tags: string[];
  /** "user" (the Director) or the name of the agent that wrote it. */
  author: string;
  createdAt: number;
  updatedAt: number;
}
/** One result of a search: no body, a piece of it around the best match instead. */
export interface LogHit {
  id: string;
  title: string;
  author: string;
  tags: string[];
  updatedAt: number;
  snippet: string;
}
/** GET /api/log?q=: the ranked hits, or the newest entries when q is empty. `total` is every entry the log holds. */
export interface LogSearch {
  total: number;
  hits: LogHit[];
}
/** POST /api/log needs a title and a body; PUT /api/log/:id changes the fields it carries. */
export interface LogRequest {
  title?: string;
  body?: string;
  tags?: string[];
}
/** Star Chart (docs/star-chart-spec.md): a node is an entry, a tag or an author. `id` is `entry:l1`, `tag:build` or `author:ana`; `ref` is the part after the colon. */
export interface ChartNode {
  id: string;
  kind: 'entry' | 'tag' | 'author';
  ref: string;
  /** The title of an entry, else the tag or the author as written. */
  label: string;
  /** An entry: 1 plus the entries that mention it. A tag or an author: how many entries have it. */
  weight: number;
}
/** `tag` and `author` go from an entry; `mention` from the entry whose text holds the id to the entry it names; `cooccur` joins two tags that share at least two entries. */
export interface ChartEdge {
  from: string;
  to: string;
  kind: 'tag' | 'author' | 'mention' | 'cooccur';
  weight: number;
}
/** GET /api/log/chart: the newest entries with their tags and authors. `total` is every entry the log holds, `shown` how many are drawn. */
export interface LogChart {
  total: number;
  shown: number;
  nodes: ChartNode[];
  edges: ChartEdge[];
}

/** Mass Budget (docs/mass-budget-spec.md): the size of an agent's memory.md against a soft limit, and the one backup made when it is asked to condense it. */
export interface MemoryView {
  /** false before the agent first started: the file is made then. */
  exists: boolean;
  bytes: number;
  /** null for a file too large to count. */
  lines: number | null;
  softLines: number;
  softBytes: number;
  /** Over either soft limit. */
  over: boolean;
  /** When memory.md was last written, ms epoch, or null. */
  changedAt: number | null;
  /** memory.md.bak: the copy made when the last request was sent. */
  backup: { bytes: number; at: number } | null;
}
/** POST /api/agents/:name/reflect: what the hub said of the message (`ok` false when it was not delivered, and then no backup was kept) and the file as it is now. */
export interface ReflectResult {
  send: SendResult;
  memory: MemoryView;
}

/** Plot Board: the plan as it is now. `author` is "user" (the Director) or the boss; null and `updatedAt` null while it was never written. */
export interface BoardView {
  text: string;
  /** Counts the writes; a write must name the revision it read. */
  revision: number;
  author: string | null;
  updatedAt: number | null;
}
/** PUT /api/board: the whole text, and the revision it was written from. */
export interface BoardRequest {
  text: string;
  revision: number;
}

/** Black Box: one recorded event. */
export interface AuditEvent {
  at: number;
  kind: AuditKind;
  text: string;
}
/** `ok`: events are committed to the repository; `missing`: no git program was found; `error`: git failed (`note` says how). */
export type AuditGitState = 'ok' | 'missing' | 'error';
/** GET /api/black-box: the newest events first, and what the Director needs to read the repository with git. */
export interface AuditView {
  git: AuditGitState;
  note: string;
  /** The repository folder. */
  dir: string;
  /** A command to paste in a terminal. */
  command: string;
  events: AuditEvent[];
}

/** Livery (docs/livery-spec.md): one look. `tokens` holds every token of src/shared/livery.ts. `author` is the agent that submitted it. */
export interface LiveryEntry {
  /** Names the file of a custom one: liveries/<slug>.json. */
  slug: string;
  name: string;
  description: string;
  builtin: boolean;
  author: string | null;
  tokens: Record<string, string>;
}
/** `current` is the slug every device shows. The ones that ship come first, then the custom ones by slug. */
export interface LiveryView {
  current: string;
  liveries: LiveryEntry[];
}
/** PUT /api/livery. */
export interface LiverySelectRequest {
  slug: string;
}
/** POST /api/liveries/design: `to` is an agent name or "boss" (the default). */
export interface LiveryDesignRequest {
  to?: string;
  brief: string;
}

/** Complete message record. One line of messages.jsonl (last line per id wins). */
export interface MessageRecord {
  /** m1, m2, ... */
  id: string;
  /** agent name or "user". */
  from: string;
  /** Intended recipient: agent name, or "user". "boss" is resolved to the boss's name before the record is made. */
  to: string;
  subject: string;
  body: string;
  inReplyTo: string | null;
  /** Server-stamped. user = 0, agent without trigger = 1, agent with trigger = max(trigger hops) + 1. */
  hops: number;
  at: number;
  status: ActivityStatus;
  /** Human reason shown next to the status (exact strings in contract section 5.8), or null. */
  note: string | null;
  updatedAt: number;
}
/** MessageRecord as sent to browsers: body cut to ACTIVITY_WIRE_BODY_CHARS. */
export interface ActivityItem extends MessageRecord {
  truncated: boolean;
}

export interface ServerInfo {
  protocol: number;
  version: string;
  /** Directory gonogo was started from: the default working directory in the hire form. */
  cwd: string;
  home: string;
  host: string;
  port: number;
  seed: boolean;
  /** GONOGO_AGENT_CMD as text, or null. */
  agentCmd: string | null;
  maxHops: number;
  startedAt: number;
  /** Providers whose program is on the server's PATH (GONOGO_AGENT_CMD counts for claude); custom is always listed. */
  installed: Provider[];
  /** IANA name of the server's time zone: the one Launch Window rules run in. */
  timeZone: string;
}
export interface StateSnapshot {
  agents: AgentView[];
  /** Newest first, at most ACTIVITY_CLIENT_MAX. */
  activity: ActivityItem[];
  info: ServerInfo;
  poll: PollView | null;
  governor: GovernorView;
  propellant: PropellantView;
  schedules: ScheduleView[];
  uplinks: UplinkView[];
  tasks: Task[];
  downlink: DownlinkView;
  /** Absent from an older server: the page then shows the Instrument look. */
  livery?: LiveryView;
  /** Absent from an older server and from one that runs without Docking: the page then shows no docks. */
  docking?: DockingView;
  /** Absent from an older server and from one that runs without Relief: the page then shows no hire requests. */
  relief?: ReliefView;
  /** Absent from an older server: the page then shows no update note. */
  rollout?: RolloutView;
}

/** Rollout (docs/rollout-spec.md): the newest @ulm0/gonogo the daily check saw. */
export interface RolloutView {
  /** The check is on (GONOGO_UPDATE_CHECK, --no-update-check). When off, `latest` stays what was saved before, or null. */
  enabled: boolean;
  /** This server's version. */
  current: string;
  /** The newest stable version the registry named, or null when none was read yet. */
  latest: string | null;
  /** ms epoch of the last try, or null. */
  checkedAt: number | null;
  /** `latest` is newer than `current`. */
  newer: boolean;
  /** The command that updates the way this gonogo was installed (what `gonogo update` prints). Never run by gonogo. */
  command: string;
}

/** One engine as `gonogo doctor` and GET /api/engines report it (Pad Check, docs/engine-bay-spec.md). */
export interface EngineCheck {
  provider: Provider;
  label: string;
  /** The program name looked up on PATH. */
  bin: string;
  /** Where it was found, or null. */
  path: string | null;
  /** First line of `<bin> --version`, or null (not found, no answer in time, nothing printed). */
  version: string | null;
  /** The vendor's documented install command, or null when none was checked. Shown, never run. */
  install: string | null;
  docs: string;
}

/**
 * A message animation on the floor (client only; here so that store.ts and Floor.tsx import it from one place that has no
 * JSX). `from` and `to` are agent names or "user"; `startedAt` is Date.now() in the browser when the frame arrived.
 */
export interface Envelope {
  id: string;
  from: string;
  to: string;
  startedAt: number;
}

/**
 * Relief (docs/relief-spec.md): a hire that the boss asked for with `hire_agent`. It waits for the Director's GO, and only
 * then does the hub staff the agent, as the hire form does. `mode` is never above acceptEdits.
 */
export const RELIEF_MODES = ['default', 'acceptEdits'] as const;
export interface ReliefRequest {
  /** `h1`, `h2`, ...; never used twice in one run. */
  id: string;
  /** The agent that asked: always the boss. */
  by: string;
  at: number;
  /** After this the request is gone and the boss is told. */
  expiresAt: number;
  name: string;
  /** Roster position id, or null for a role written by the boss. */
  position: string | null;
  /** The whole role text the new agent will get. */
  role: string;
  /** Resolved absolute path. */
  dir: string;
  provider: Provider;
  mode: PermissionMode;
  /** The boss is a Clean Room agent: the new agent is one too. */
  cleanRoom: CleanRoom | null;
}
export interface ReliefView {
  requests: ReliefRequest[];
}

/* ---- REST bodies ---- */
export interface HireRequest {
  name: string;
  role: string;
  dir: string;
  mode: PermissionMode;
  /** Required to be true when mode is bypassPermissions. */
  confirmBypass?: boolean;
  /** Roster position id. Unknown id: 400, field 'position'. */
  position?: string;
  /** Default 'claude'. */
  provider?: Provider;
  /** Required (non-empty, at most COMMAND_MAX_CHARS) when provider is 'custom'; refused otherwise. */
  command?: string;
  /** MCP servers and skills. Bad value: 400, field 'payload', 'payload.mcpServers' or 'payload.skills'. */
  payload?: Payload;
  /** Run the agent in a container on its own worktree. Refused (400, field 'cleanRoom') for another engine, a bad image, no Docker or a directory outside a git repository. */
  cleanRoom?: CleanRoom;
  /** Engine Bay: passed as `--model`. Empty text is no model. Refused (400, field 'model') for an engine without PROVIDER_INFO.model or a bad name. */
  model?: string;
  /** Clearance: key name to value, set for this agent only. Bad name or value: 400, field 'keys'. */
  keys?: Record<string, string>;
}
export interface EditRequest {
  /** Rename only while the agent is stopped (409 otherwise). */
  name?: string;
  role?: string;
  dir?: string;
  mode?: PermissionMode;
  confirmBypass?: boolean;
  /** A roster position id, or null to clear it. */
  position?: string | null;
  /** Custom provider only; the provider itself cannot change after hire. */
  command?: string;
  /** Replaces the whole payload; null removes it. */
  payload?: Payload | null;
  /** Replaces the Clean Room setting; null turns it off. */
  cleanRoom?: CleanRoom | null;
  /** A model name, or null or empty text for the CLI's default. */
  model?: string | null;
  /** Key name to a new value, or to null to remove that key. Keys not named stay as they are. */
  keys?: Record<string, string | null>;
}
/** POST /api/poll. Default agents: every running agent except the boss. With `subject` it is a Static fire: SIMSUP and RETRO are asked, `agents` is refused. */
export interface PollRequest {
  agents?: string[];
  subject?: string;
}
/** Static fire: the positions it briefs. */
export const STATIC_FIRE_POSITIONS = ['simsup', 'retro'] as const;
/** PUT /api/governor. */
export interface GovernorRequest {
  limit: number | null;
}
/** PUT /api/propellant. Each scope given replaces its limits; {} clears them. */
export interface PropellantRequest {
  room?: FuelLimits;
  agents?: Record<string, FuelLimits>;
  /** Dollar budgets; same rules as the limits. */
  budget?: { room?: Budget; agents?: Record<string, Budget> };
}
/** POST /api/schedules. */
export interface ScheduleRequest {
  name: string;
  to: string;
  subject?: string;
  body: string;
  rule: string;
  enabled?: boolean;
}
/** PATCH /api/schedules/:id: only the fields given change. */
export type SchedulePatch = Partial<ScheduleRequest>;
/** POST /api/uplinks. */
export interface UplinkRequest {
  name: string;
  to: string;
  kind?: UplinkKind;
  enabled?: boolean;
  /** Only for the kinds of UPLINK_GIVEN_SECRET_KINDS, where it is required at create: the secret of the service. */
  secret?: string;
}
/** PATCH /api/uplinks/:id: only the fields given change; the kind does not. */
export type UplinkPatch = Partial<Omit<UplinkRequest, 'kind'>>;
/** POST /api/tasks. */
export interface TaskRequest {
  title: string;
  detail?: string;
  assignee?: string | null;
}
/** PATCH /api/tasks/:id: only the fields given change; `note` adds a line to the history. */
export interface TaskPatch {
  status?: TaskStatus;
  assignee?: string | null;
  note?: string;
}
/** The Director's answer to a permission prompt, given outside the terminal (POST /api/agents/:name/answer). */
export interface AnswerRequest {
  go: boolean;
}

export interface VoteResult {
  ok: boolean;
  note: string;
}
export interface UserMessageRequest {
  /** Agent name or "boss". Never "user". */
  to: string;
  subject?: string;
  body: string;
  inReplyTo?: string;
}
export interface SendResult {
  /** false when status is undelivered. */
  ok: boolean;
  id: string;
  /** Resolved recipient ("boss" becomes the boss's name). */
  to: string;
  status: ActivityStatus;
  note: string | null;
}
export interface ApiError {
  error: string;
  code: ApiErrorCode;
  /** Name of the offending request field, when there is one. */
  field?: string;
}

/* ---- WebSocket: browser to server (JSON text frames) ---- */
export interface AttachFrame {
  t: 'attach';
  /** Chosen by the client, increases with every attach; echoed in the snapshot and in every binary frame. */
  seq: number;
  agent: string;
  /** The client's fitted size. When present and valid the pty is resized to it (this client becomes the size owner). */
  cols?: number;
  rows?: number;
}
export interface DetachFrame {
  t: 'detach';
}
export interface InputFrame {
  t: 'input';
  agent: string;
  /** What xterm.js onData gave (UTF-8 text) or, with binary=true, what onBinary gave (a string of 0-255 chars = raw bytes). */
  data: string;
  binary?: boolean;
}
export interface ResizeFrame {
  t: 'resize';
  agent: string;
  cols: number;
  rows: number;
}
export type ClientFrame = AttachFrame | DetachFrame | InputFrame | ResizeFrame;

/* ---- WebSocket: server to browser (JSON text frames; terminal bytes use binary frames, see WS_BINARY_OUTPUT) ---- */
export interface StateFrame {
  t: 'state';
  state: StateSnapshot;
}
export interface AgentFrame {
  t: 'agent';
  agent: AgentView;
}
/** Also sent for the OLD name when an agent is renamed, immediately before the AgentFrame of the new name. */
export interface AgentRemovedFrame {
  t: 'agent-removed';
  name: string;
}
/** New item, or the same id with a new status (replace by id). */
export interface ActivityFrame {
  t: 'activity';
  item: ActivityItem;
}
export interface SnapshotFrame {
  t: 'snapshot';
  seq: number;
  agent: string;
  generation: number;
  cols: number;
  rows: number;
  /** false when no process is running (data is the last screen of the previous process, or empty). */
  running: boolean;
  /** serialize() of the server mirror plus the mode fix-ups. Write it into a fresh xterm of cols x rows. */
  data: string;
}
/**
 * The size of the one pty changed (some browser resized it). Sent to every socket attached to that agent, the one that
 * caused it included (a client ignores a size equal to its own). A window that is not the size owner renders at this size
 * (term.resize) instead of fitting its own pane, so the repaint claude sends for the new size is not drawn into a grid
 * of another size.
 */
export interface SizeFrame {
  t: 'size';
  agent: string;
  cols: number;
  rows: number;
}
export interface ErrorFrame {
  t: 'error';
  message: string;
  ref?: 'attach' | 'input' | 'resize' | 'frame';
}
/** The poll changed (null = cleared). Also inside StateSnapshot. */
export interface PollFrame {
  t: 'poll';
  poll: PollView | null;
}
/** The limit, or the counts, changed. Also inside StateSnapshot. */
export interface GovernorFrame {
  t: 'governor';
  governor: GovernorView;
}
/** Token use or a limit changed. Also inside StateSnapshot. */
export interface PropellantFrame {
  t: 'propellant';
  propellant: PropellantView;
}
/** A schedule was made, changed, removed or ran; carries the whole list. Also inside StateSnapshot. */
export interface SchedulesFrame {
  t: 'schedules';
  schedules: ScheduleView[];
}
/** An uplink was made, changed, removed or received a delivery; carries the whole list. Also inside StateSnapshot. */
export interface UplinksFrame {
  t: 'uplinks';
  uplinks: UplinkView[];
}
/** A task was made, changed or removed; carries the whole list. Also inside StateSnapshot. */
export interface TasksFrame {
  t: 'tasks';
  tasks: Task[];
}
/** The inbox changed (an item came, was read or archived); carries the whole inbox. Also inside StateSnapshot. */
export interface DownlinkFrame {
  t: 'downlink';
  downlink: DownlinkView;
}
/** Entries of the Mission Log were written, changed or removed. Carries ids and titles only; a browser asks for the rest. */
export interface LogFrame {
  t: 'log';
  changed: LogHead[];
  removed: string[];
}
/** A station was docked or undocked, or a pull changed what is known of one; carries the whole view. Also inside StateSnapshot. */
export interface DockingFrame {
  t: 'docking';
  docking: DockingView;
}
/** The livery list or the chosen one changed; carries the whole view. Also inside StateSnapshot. */
export interface LiveryFrame {
  t: 'livery';
  livery: LiveryView;
}
/** The hire requests that wait for the Director changed; carries the whole view. Also inside StateSnapshot. */
export interface ReliefFrame {
  t: 'relief';
  relief: ReliefView;
}

/** The daily update check finished; carries the whole view. Also inside StateSnapshot. */
export interface RolloutFrame {
  t: 'rollout';
  rollout: RolloutView;
}
export type ServerFrame =
  | ReliefFrame
  | RolloutFrame
  | DockingFrame
  | LiveryFrame
  | LogFrame
  | DownlinkFrame
  | TasksFrame
  | UplinksFrame
  | SchedulesFrame
  | PropellantFrame
  | PollFrame
  | GovernorFrame
  | StateFrame
  | AgentFrame
  | AgentRemovedFrame
  | ActivityFrame
  | SnapshotFrame
  | SizeFrame
  | ErrorFrame;
/** What the hub emits to browsers. cli.ts passes it to the web server's broadcast(). */
export type HubEvent = AgentFrame | AgentRemovedFrame | ActivityFrame | PollFrame | GovernorFrame | PropellantFrame | SchedulesFrame | UplinksFrame | TasksFrame | DownlinkFrame | LogFrame | LiveryFrame | DockingFrame | ReliefFrame | RolloutFrame;

/* ------------------------------------------------------------------------------------------------------------
 * Part 3. Server-internal contracts
 * ---------------------------------------------------------------------------------------------------------- */

export interface Logger {
  debug(message: string, ...extra: unknown[]): void;
  info(message: string, ...extra: unknown[]): void;
  warn(message: string, ...extra: unknown[]): void;
  error(message: string, ...extra: unknown[]): void;
  /** Same sink and level, message prefix "[prefix] ". */
  child(prefix: string): Logger;
}

/** An agent identity, derived from a per-start token. generation counts spawns of that agent in this server run. */
export interface AgentIdentity {
  agent: string;
  generation: number;
}

/* ---- terminal host and launcher ---- */

/** Exactly what the terminal host spawns. Produced by the launcher. */
export interface SpawnSpec {
  file: string;
  args: string[];
  /** The complete child environment (nothing else is inherited). */
  env: Record<string, string>;
  cwd: string;
  cols?: number;
  rows?: number;
}
export interface PreparedStart {
  spec: SpawnSpec;
  /** The flag actually used. */
  flag: SessionFlag;
  /** Value of GONOGO_TOKEN in spec.env. */
  token: string;
}
export interface SpawnRequest {
  agent: AgentRecord;
  generation: number;
  /** null = the launcher decides (transcript exists -> resume, else session-id). Non-null forces the flag (flip retry). */
  flag: SessionFlag | null;
}
export interface SpawnInfo {
  generation: number;
  flag: SessionFlag;
  pid: number;
}

/** What the terminal host reads off the mirror screen. */
export interface ScreenProbe {
  cols: number;
  rows: number;
  /** The single-line input box is on screen: a row starting with "❯" + U+00A0 between two rows holding a run of >= 20 "─". */
  promptBox: boolean;
  /** A known dialog or numbered menu is on screen, or null. */
  dialog: DialogKind | null;
  /** Text after the prompt glyph in the box row (trimmed), null when there is no box. May be a grey placeholder. */
  promptText: string | null;
}
export interface TitleInfo {
  glyph: TitleGlyph;
  /** Whole window title as set by OSC 0/2 ("✳ Claude Code"). */
  title: string;
  /** ms epoch when the glyph class last changed. */
  since: number;
}
export interface ExitInfo {
  /** Exit code, or null when killed by a signal. */
  code: number | null;
  signal: number | null;
  /** Spawn to exit, ms. */
  durationMs: number;
  /** stop() was called for this generation before it exited. */
  requested: boolean;
  /** Last <= 20 non-empty screen lines of the mirror, joined with \n, at most 2000 chars (crash reason such as "No conversation found ..."). */
  tail: string;
}
export type TerminalEvent =
  | { kind: 'ready'; name: string; generation: number; at: number }
  | { kind: 'title'; name: string; generation: number; glyph: TitleGlyph; title: string; at: number }
  | { kind: 'exit'; name: string; generation: number; info: ExitInfo; at: number };

export interface Snapshot {
  cols: number;
  rows: number;
  /** serialize() output followed by the remembered mode sequences (?1006, ?25, ?2031). Empty string when there is no mirror. */
  data: string;
  generation: number;
  running: boolean;
}
export type OutputListener = (chunk: Uint8Array) => void;
export interface Attachment {
  snapshot: Snapshot;
  /** The listener receives nothing before start() is called; then it receives exactly the output that came after the snapshot, in order, none missing, none twice. */
  start(): void;
  /** Idempotent. After detach() the listener is never called again. */
  detach(): void;
}
export interface TerminalInfo {
  running: boolean;
  generation: number;
  pid: number | null;
  cols: number;
  rows: number;
}

/** Options of createTerminalHost (owner: builder C; here so that cli.ts is written against one definition). */
export interface TerminalHostOptions {
  log?: Logger;
  /** Default Date.now. */
  now?: () => number;
  /** Default STOP_KILL_AFTER_MS (tests pass small values). */
  killAfterMs?: number;
  /** Default STOP_GIVEUP_AFTER_KILL_MS. */
  giveUpAfterKillMs?: number;
}

/**
 * Pty host with one headless mirror per agent (owner: builder C). Keyed by agent name. No method throws after spawn():
 * a pty call that throws (for example resize on a pty whose child exited: "ioctl(2) failed, EBADF") is caught and the
 * method returns false.
 */
export interface TerminalHost {
  /** Throws Error with a user-facing message when the pty cannot be spawned. A running process of the same name is an error. */
  spawn(name: string, generation: number, spec: SpawnSpec): { pid: number };
  /** SIGTERM to the process group, SIGKILL after STOP_KILL_AFTER_MS. Resolves after the 'exit' event handlers have run. Resolves at once when nothing runs (or the generation is not the running one). */
  stop(name: string, generation?: number): Promise<void>;
  stopAll(): Promise<void>;
  /** Raw write of user input. false when nothing runs, the process has exited or the pty write throws. */
  write(name: string, data: string | Uint8Array): boolean;
  /** Sanitise, then write ESC[200~ text ESC[201~ CR in ONE write. false when the generation is not running or bracketed paste is not enabled. */
  submit(name: string, generation: number, text: string): boolean;
  /** Clamp, resize pty and then mirror in the same tick. false when nothing runs, the process has exited or the pty resize throws (the mirror is then left alone). */
  resize(name: string, cols: number, rows: number): boolean;
  /**
   * Move the finished record of `oldName` (mirror, last screen, size, title) to `newName`, replacing a finished record
   * that `newName` may still have. false when either name has a live process or `oldName` has no record. Called through
   * the glue of HubIo.renameAgentFiles, so a renamed stopped agent keeps its last screen and no mirror is left behind.
   */
  rename(oldName: string, newName: string): boolean;
  /** Always resolves for a known name; with no mirror the snapshot is empty at the default or last size. */
  attach(name: string, listener: OutputListener): Promise<Attachment>;
  /** null when there is no mirror, or while written output is still unparsed (callers treat null as "try again later"). */
  screen(name: string): ScreenProbe | null;
  title(name: string): TitleInfo | null;
  /** Output bytes since the current spawn (0 when none). */
  outputBytes(name: string): number;
  info(name: string): TerminalInfo | null;
  /** Returns the unsubscribe function. Handlers run in order of subscription, synchronously. */
  onEvent(handler: (event: TerminalEvent) => void): () => void;
  /**
   * Drop the finished record of a removed agent (mirror with its scrollback, last screen, attachments), which otherwise
   * stays for the life of the server. A no-op for a name with no record or with a process still running. Never throws.
   * Optional so that fakes of the host need not provide it.
   */
  forget?(name: string): void;
}

/** Options of createLauncher (owner: builder B; here so that cli.ts is written against one definition). */
export interface LauncherOptions {
  /** <home>, absolute. */
  homeDir: string;
  /** "http://127.0.0.1:7777" or "http://[::1]:7777": loopback only, no trailing slash. Read at every prepareStart. */
  hubUrl: () => string;
  /** Seed mode (contract 7.6). */
  seed: boolean;
  /** Environment to derive the child's from; default process.env. */
  env?: Record<string, string | undefined>;
  /** Replaces the claude executable and its leading args (contract 7.7). */
  agentCmd?: string[] | null;
  /** Default CLAUDE_BIN. */
  claudeBin?: string;
  /** Clearance: the values of an agent's keys, put in that agent's environment only. Default none. */
  keys?: (name: string) => Record<string, string>;
  log?: Logger;
}

export interface Launcher {
  /**
   * Writes agents/<name>/{settings.json,mcp.json,token,memory.md}, seeds and verifies trust in seed mode, issues a token for
   * (agent, generation), builds argv and env. Rejects with an Error with a user-facing message on failure (seed mode that
   * cannot record the folder trust rejects with "cannot record folder trust in <path>: <reason>").
   */
  prepareStart(agent: AgentRecord, opts: { generation: number; flag: SessionFlag | null }): Promise<PreparedStart>;
  resolveToken(token: string): AgentIdentity | null;
  /** Forget the token of that start and delete agents/<name>/token. No-op for an unknown or already revoked start. */
  revoke(name: string, generation: number): void;
  /** Rename <home>/agents/<old> to <new>. Rejects when <new> exists. Resolves when <old> does not exist. */
  renameAgentFiles(oldName: string, newName: string): Promise<void>;
  /** Absolute path of agents/<name>/memory.md. */
  memoryPath(name: string): string;
}

/* ---- home ---- */

export interface Home {
  readonly dir: string;
  /** 64 hex chars, read from <dir>/token (created with mode 0600 on first open). */
  readonly browserToken: string;
  /** <dir>/agents/<name> (not created). */
  agentDir(name: string): string;
  /** { version: 1, agents: [] } when the file does not exist. Throws Error (with the path) when it is corrupt. */
  loadRoster(): RosterFile;
  /** Atomic: temp file in the same directory, then rename. Mode 0600. */
  saveRoster(file: RosterFile): Promise<void>;
  /**
   * Appends one JSON line to messages.jsonl: the whole record the first time this process writes that id, afterwards only
   * { id, status, note, updatedAt } (the body is stored once). Writes are queued in order; failures are logged, never thrown.
   */
  appendMessage(record: MessageRecord): void;
  /** The last `limit` distinct ids found in the last MESSAGES_TAIL_BYTES of the file (lines folded by id), ordered by `at` ascending. */
  loadRecentMessages(limit: number): MessageRecord[];
  /** Highest N seen in ids "mN" in the tail of messages.jsonl (and of messages.jsonl.1 when the first has none), 0 when none. */
  lastMessageSeq(): number;
  /** Waits for every queued save and append, then removes <dir>/server.lock. Idempotent. Called last by stop() and on every failed start. */
  close(): Promise<void>;
}

/* ---- hooks ---- */

/** Fields claude 2.1.325 sends (all optional here; the hub reads defensively). */
export interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  prompt_id?: string;
  permission_mode?: string;
  hook_event_name?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: unknown;
  message?: string;
  title?: string;
  notification_type?: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string;
  [key: string]: unknown;
}
export interface HookInput {
  agent: string;
  generation: number;
  event: HookEvent;
  payload: HookPayload;
}
/** Body of the HTTP 200 reply. {} lets claude go on; Stop may answer {decision:'block', reason}. */
export interface HookReply {
  decision?: 'block';
  reason?: string;
}

/* ---- hub ---- */

export type TimerHandle = unknown;
export type DirCheck = { ok: true; path: string } | { ok: false; error: string };

/** Everything the hub needs from the outside world. cli.ts builds the real one; hub tests build a fake. */
export interface HubIo {
  /** ms epoch. */
  now(): number;
  setTimer(fn: () => void, ms: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
  /** "m1", "m2", ... continuing after the highest id in the log. */
  newMessageId(): string;
  /** A random UUID v4. */
  newSessionId(): string;
  /** path must be absolute; ok:true carries the normalised path. */
  checkDirectory(path: string): Promise<DirCheck>;
  /** Clean Room: null when Docker answers and `dir` is inside a git repository, else the reason (one line). Optional for fakes. */
  checkCleanRoom?(dir: string): Promise<string | null>;
  loadRoster(): Promise<RosterFile>;
  saveRoster(file: RosterFile): Promise<void>;
  /** Last `limit` message records, oldest first. */
  loadHistory(limit: number): Promise<MessageRecord[]>;
  /** Append a record (every creation and every status change). */
  logMessage(record: MessageRecord): void;
  /** The launcher renames agents/<old>; the glue in cli.ts also moves the terminal host's finished record (TerminalHost.rename) and the agent's keys. */
  renameAgentFiles(oldName: string, newName: string): Promise<void>;
  /** Clearance: where the values of an agent's keys are kept. The hub holds names only. Optional for fakes: without it keys are refused. */
  keys?: KeyStore;
  /**
   * Prepare files and spawn. Rejects when it cannot. The exit and ready events come back through Hub.onTerminalEvent.
   * Resolves only after the terminal host holds the new process, so a browser that attaches after the hub's AgentFrame
   * finds it (contract 4.9).
   */
  spawn(req: SpawnRequest): Promise<SpawnInfo>;
  /** Resolves after the exit event of that generation has been delivered to Hub.onTerminalEvent (or at once if it is not running). */
  stop(name: string, generation: number): Promise<void>;
  /** TerminalHost.submit. false = not written. */
  typePointer(name: string, generation: number, text: string): boolean;
  /** TerminalHost.write for that generation: raw keys for Hub.answer. false = not written. Optional for fakes. */
  press?(name: string, generation: number, data: string): boolean;
  /** Propellant: count the tokens of that agent's transcript since the last call (a Stop, or a tool call at most every METER_INTERVAL_MS). */
  meter?(name: string, generation: number, transcriptPath: string): void;
  /** Telemetry: a PreToolUse, PostToolUse or PostToolUseFailure hook of that agent's current process. Optional for fakes. */
  toolHook?(name: string, event: HookEvent, payload: Record<string, unknown>): void;
  screen(name: string): ScreenProbe | null;
  title(name: string): TitleInfo | null;
  outputBytes(name: string): number;
  /** TerminalHost.forget: called once an agent was removed and its process has exited, so its terminal record can be freed. Optional for fakes. */
  forget?(name: string): void;
  /** To every connected browser. */
  emit(event: HubEvent): void;
  /** Downlink: something the Director should see (a Redline trip, a T-minus result), one line. Optional for fakes. */
  notify?(kind: DownlinkEventKind, text: string): void;
  /** Docking: the stations this one is docked with. Optional: without it "name@station" is not an address. */
  dock?: DockLink;
  log: Logger;
}

/** What the hub needs of Clearance: the secret values of an agent's keys (keys.json, mode 0600). */
export interface KeyStore {
  /** The values of one agent's keys as they are now: a copy. The hub reads them only to put them back when an edit cannot be saved. */
  values(name: string): Record<string, string>;
  /** Sets (string) or removes (null) keys of that agent; `fresh` starts from none (a hire). Rejects when the file cannot be written. */
  apply(name: string, patch: Record<string, string | null>, fresh?: boolean): Promise<void>;
  /** Moves the keys of a renamed agent. */
  rename(oldName: string, newName: string): Promise<void>;
  /** The agent was removed: its keys go. */
  remove(name: string): Promise<void>;
}

/** What the hub needs of Docking. */
export interface DockLink {
  /** The names of the docked stations. */
  stations(): string[];
  /** The agents of every docked station, as the last pull saw them (stations with none are left out). */
  rosters(): Array<{ station: string; agents: DockedAgent[] }>;
  /** Hands one message to a docked station. Never rejects: a station that cannot be reached is `ok: false` with the reason. */
  send(station: string, message: StationMessage): Promise<{ ok: boolean; note: string | null }>;
}

export interface HubOptions {
  /** Messages with hops above this go to the user instead (default 8, GONOGO_MAX_HOPS). */
  maxHops: number;
  /** Working directory of the boss when the roster is empty (the directory gonogo was started from). */
  bossDir: string;
  /** Max Q at start: at most this many agents work at once; null or absent = off (GONOGO_MAX_WORKING). */
  maxWorking?: number | null;
  /** Redline's automatic detectors (loop, error storm, ping-pong). Default true; GONOGO_REDLINE=off. Hub.trip works either way. */
  redline?: boolean;
}

export interface AgentSendRequest {
  /** Agent name, "boss" or "user". */
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
}
export interface ReadMessage {
  id: string;
  from: string;
  subject: string;
  body: string;
  inReplyTo: string | null;
  at: number;
}
export interface ReadMessagesResult {
  /** The messages in this result, which holds at most READ_MAX_MESSAGES of them (constants.ts). */
  count: number;
  messages: ReadMessage[];
  /** Present only when more unread messages are waiting than this result holds (they stay unread): how many. */
  remaining?: number;
  /** Present with `remaining`: one sentence that tells the agent to call read_messages again. */
  note?: string;
}
export interface RosterEntry {
  name: string;
  /** First 300 characters. */
  role: string;
  state: AgentState;
  boss: boolean;
  /** Roster position id, or null. */
  position: string | null;
}
export interface RosterResult {
  you: string;
  boss: string | null;
  agents: RosterEntry[];
  /** Always ["boss", "user"]. */
  specialRecipients: string[];
  /** Docking: the agents of every docked station, to be written to as "name@station". Absent when none is docked. */
  docked?: Array<{ station: string; agents: DockedAgent[] }>;
}

/**
 * The hub's public API (owner: builder A). Lifecycle methods are async and run one at a time per agent.
 * Every method that rejects a request throws an Error with name === 'HubError', a `code: ApiErrorCode` and an
 * optional `field: string`. Callers identify it by those properties (not by instanceof).
 */
export interface Hub {
  /** Load roster, create the boss on first run, mark every agent stopped, load history, start the boss, start the sweep timer. */
  start(): Promise<void>;
  /** Stop every agent (in parallel), clear timers. Does not touch the roster. */
  shutdown(): Promise<void>;
  /** Sorted by desk ascending (the boss first). */
  views(): AgentView[];
  /** Newest first, at most ACTIVITY_HUB_MAX (constants.ts) items. */
  activity(): ActivityItem[];
  /**
   * Validate, create, save, spawn. Resolves with the view after io.spawn resolved (state starting) or failed (state stopped,
   * exit.text "could not start: ..."). Once shutdown() has begun, hire, edit, restart, stop and remove reject with
   * HubError('conflict', 'the server is shutting down').
   */
  hire(req: HireRequest): Promise<AgentView>;
  /**
   * Save changes (role, dir, mode apply at the next start). Rename only while stopped; a rename emits an
   * AgentRemovedFrame for the old name and then an AgentFrame for the new one.
   */
  edit(name: string, req: EditRequest): Promise<AgentView>;
  /** Stop if running, then start. Also starts a stopped agent. */
  restart(name: string): Promise<AgentView>;
  stop(name: string): Promise<AgentView>;
  /** Stop, drop from the roster. The boss cannot be removed (409). Files on disk are kept. */
  remove(name: string): Promise<void>;
  /** from = "user", hops 0. Throws HubError on invalid input: bad_request for a user recipient, an empty or too long body or subject; not_found (field `to`) for an unknown recipient. */
  sendFromUser(req: UserMessageRequest): SendResult;
  /**
   * Docking: a message that came from `station`. The record says it is from "<from>@<station>" and keeps the hops it came with.
   * Throws HubError: bad_request for a `to` that is "user" or has an @ (a station never writes to the Director or on to a third
   * station), an empty or too long body or subject or a `from` that is not an agent name; not_found (field `to`) for an unknown recipient.
   */
  sendFromStation(station: string, req: StationMessage): SendResult;
  /**
   * `generation` is the one of the caller's token (the MCP edge passes it). Throws HubError: bad_request for self, an empty
   * or too long body or subject; not_found (field `to`) for an unknown recipient; conflict when `generation` is not the
   * agent's current one or a stop, restart or remove is running ("this session has ended").
   */
  sendFromAgent(from: string, generation: number, req: AgentSendRequest): SendResult;
  /**
   * Unknown agent: { count: 0, messages: [] }. A stale generation or a running transition: HubError('conflict', 'this session has ended').
   * One result holds at most READ_MAX_MESSAGES messages or READ_MAX_CHARS characters of JSON; the rest stay unread (back in the
   * queue) and the result says how many (`remaining`).
   */
  readMessages(agent: string, generation: number): ReadMessagesResult;
  /** Unknown agent: HubError('not_found'). A stale generation or a running transition: HubError('conflict'). */
  rosterFor(agent: string, generation: number): RosterResult;
  /** Synchronous: the reply goes back inside the HTTP response. Never throws. */
  onHook(input: HookInput): HookReply;
  /**
   * Browser keystrokes for the draft latch. Called for every input frame that was written to a running agent. Returns the
   * effect of the chunk (contract 4.6) so that web.ts can tell a real keystroke from focus and mouse reports.
   */
  onUserInput(name: string, data: string): InputEffect;
  onTerminalEvent(event: TerminalEvent): void;
  /**
   * T-minus. Throws HubError: conflict when a poll is open or on hold ("clear it first"); bad_request for an unknown or stopped
   * agent (field 'agents') or when there is nobody to poll. Sends each polled agent a message from "user" (subject "T-minus:
   * go/no-go poll") that tells it to call go_nogo. Emits a PollFrame.
   */
  startPoll(req: PollRequest): PollView;
  /** The Director forces a hold (status 'hold'). conflict when no poll is open. */
  holdPoll(): PollView;
  /** Ends the poll with status 'aborted' and tells the polled agents to stand by. conflict when there is no poll. */
  abortPoll(): PollView;
  /** Removes a finished (go, hold or aborted) poll from view; emits PollFrame with null. Never throws. */
  clearPoll(): void;
  /**
   * The go_nogo tool. `generation` is the caller's token generation (like sendFromAgent). Never throws: ok:false with a note
   * when there is no open poll, the caller is not in it, or the generation is stale. The first no-go turns the poll to hold.
   * When every entry voted go the poll is 'go' and the boss gets a message from "user" ("T-minus: all go").
   */
  vote(agent: string, generation: number, vote: PollVote, reason: string): VoteResult;
  /** Max Q. limit null = off, else 1..MAX_AGENTS (bad_request otherwise). Emits a GovernorFrame. */
  setGovernor(req: GovernorRequest): GovernorView;
  /**
   * Answers the permission prompt of an agent in state needs_you with needsKind 'permission': go presses Enter (the first
   * option, Yes, is the highlighted one), no-go presses Escape. conflict when the agent is not asking for a permission.
   * The state changes when the agent's hooks report it, as after a key typed in the terminal.
   */
  answer(name: string, req: AnswerRequest): AgentView;
  governor(): GovernorView;
  poll(): PollView | null;
  /**
   * Redline: interrupts a working Claude agent (Escape), puts it in needs_you with needsKind 'redline' and holds its mail
   * until the Director resumes it. No-op for a stopped, custom or already tripped agent. not_found for an unknown name.
   */
  trip(name: string, reason: string): void;
  /**
   * Hold: the Director's own Redline trip, reason HOLD_REASON, no Downlink notice. conflict unless the agent is idle or
   * working with no transition (needs_you, held or tripped, starting, stopped), or when it has no hooks (custom, Codex and
   * the other output-only engines).
   */
  hold(name: string): AgentView;
  /** Clears a Redline trip; conflict when the agent is not tripped. */
  resume(name: string): AgentView;
}

/* ---- Hangar and Recorder (docs/hangar-spec.md, docs/recorder-spec.md): the files and the git of one agent's folder ---- */

/** The editor opens and saves a file of at most this many bytes. */
export const HANGAR_FILE_MAX_BYTES = 1024 * 1024;
export interface HangarEntry {
  name: string;
  kind: 'file' | 'dir' | 'link';
  /** Bytes of a file; 0 for the others. */
  size: number;
}
export interface HangarListing {
  /** The folder, relative to the agent's folder, with `/` between names; '' is the folder itself. */
  path: string;
  entries: HangarEntry[];
  /** The folder has more entries than the list holds. */
  truncated: boolean;
}
export interface HangarFile {
  path: string;
  text: string;
  size: number;
  /** A hash of the content: a save sends it back, and the server refuses when the file no longer has it. */
  etag: string;
}
export interface HangarSaved {
  path: string;
  size: number;
  etag: string;
}
/** A save carries the etag of the text it was opened from. */
export interface HangarSaveRequest {
  path: string;
  text: string;
  etag: string;
}
export interface HangarCreateRequest {
  path: string;
  text?: string;
}

export const RECORDER_MESSAGE_MAX_CHARS = 10_000;
export const RECORDER_LOG_MAX = 50;
export const RECORDER_SCOPES = ['all', 'staged'] as const;
export type RecorderScope = (typeof RECORDER_SCOPES)[number];
export interface RecorderFile {
  path: string;
  /** Letter of the index (`M`, `A`, `D`, `R`, `C`, `U`), a space when the index is as the last commit, `?` for an untracked file. */
  index: string;
  /** Letter of the working tree, a space, or `?` for an untracked file. */
  tree: string;
  /** The old path of a rename or a copy. */
  from?: string;
}
export interface RecorderAuthor {
  name: string;
  email: string;
}
/** `repo: false` is an answer, not an error: the folder is not what the Recorder can work on, and `reason` says why. */
export type RecorderStatus =
  | { repo: false; reason: string }
  | { repo: true; branch: string; files: RecorderFile[]; more: number; author: RecorderAuthor | null };
export interface RecorderDiff {
  diff: string;
  truncated: boolean;
}
export interface RecorderCommit {
  hash: string;
  author: string;
  /** ms epoch. */
  at: number;
  subject: string;
}
export interface RecorderCommitRequest {
  message: string;
  scope: RecorderScope;
}
