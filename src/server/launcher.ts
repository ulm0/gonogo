/**
 * Turns an agent record into a claude process (contract section 7): the generated files under <home>/agents/<name>,
 * the exact command line, the child environment and the token of one start. Claude's own files are touched in seed
 * mode only.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { chmod, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { SubagentSettings } from '../shared/protocol.js';
import { cleanRoomBranch, HOOK_EVENTS, MCP_SERVER_NAME, PERMISSION_MODES, PROVIDER_INFO } from '../shared/protocol.js';
import type {
  AgentIdentity,
  AgentRecord,
  PermissionRules,
  Launcher,
  LauncherOptions,
  McpServer,
  PermissionMode,
  PreparedStart,
  SessionFlag,
} from '../shared/protocol.js';
import {
  AGENT_NAME_PATTERN,
  AGENT_TOKEN_FILE,
  AGENTS_DIR,
  ALLOWED_TOOLS,
  API_KEY_HELPER_COMMAND,
  CLAUDE_BIN,
  CLEAN_ROOM_CREDENTIALS,
  SUBAGENT_LIMIT_ENV,
  CLEAN_ROOM_ENV,
  CLEAN_ROOM_NOTE,
  WORKTREE_NOTE,
  COLORTERM_VALUE,
  DENIED_TOOLS,
  DIR_MODE,
  DOCKER_BIN,
  FILE_MODE,
  HOOK_PATH_PREFIX,
  HOOK_TIMEOUT_S,
  MCP_FILE,
  MCP_PATH,
  MEMORY_FILE,
  nullLogger,
  PAYLOAD_PLUGIN_DIR,
  PAYLOAD_PLUGIN_NAME,
  ROLE_PREAMBLE,
  SCRUB_ENV_EXACT,
  SCRUB_ENV_PREFIXES,
  SETTINGS_FILE,
  TERM_VALUE,
  TOKEN_BYTES,
  TRUST_VERIFY_ATTEMPTS,
  TRUST_VERIFY_DELAY_MS,
} from './constants.js';
import { prepareWorktree, worktreeBranch } from './worktree.js';
import type { WorktreePlace } from './worktree.js';
import { coauthorEnv, ensureHooksDir, realHookNames } from './coauthor.js';
import { remoteControlName } from './remotecontrol.js';
import { effectiveRules } from './permissions.js';
import { buildDockerArgs, cleanRoomImage, containerUrl, prepareCleanRoom, removeContainer } from './cleanroom.js';
import { parseAgentCmd } from './command.js';
import { isRecord } from './hooks.js';
import { buildProviderStart, knowsEffort, shellQuote, STATUS_LINE_SHIM } from './providers.js';
import type { OtherProvider } from './providers.js';

const NAME_RE = new RegExp(AGENT_NAME_PATTERN);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** claude blocks http hooks to private addresses without saying so, so only the two loopback forms of 0.3 item 13 are written. */
const LOOPBACK_URL_RE = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):\d{1,5}$/;
const CLAUDE_JSON = '.claude.json';
/** Open item O11 (contract 13): claude rewrites .claude.json on every start, so look once more after it had time to. Not in constants.ts. */
const TRUST_RECHECK_MS = 2_000;
const NO_PROXY_HOSTS = ['127.0.0.1', 'localhost'];
const SCRUB_EXACT = new Set<string>(SCRUB_ENV_EXACT);
/** The operator's own additions to the scrub lists (README, environment variables). Not in constants.ts. */
const SCRUB_EXTRA_VAR = 'GONOGO_SCRUB_ENV';

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const hasText = (value: unknown): value is string => typeof value === 'string' && value !== '';
const errorCode = (error: unknown): unknown => (isObject(error) ? error.code : undefined);
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/* ---- pure builders (exported so the tests can compare them with the JSON of section 7) ---- */

/** Re-exported: the reader lives in command.ts so that home.ts and web.ts can use it without importing the launcher. */
export { parseAgentCmd };

/**
 * One pass with a function replacer: a string replacement would read `$&`, `$'` and `$$` in the role, and replacing the
 * placeholders one after the other would expand a `{memory}` the owner wrote inside the role.
 */
export function buildRoleText(name: string, role: string, memoryPath: string): string {
  const values: Record<string, string> = { name, memory: memoryPath, role: role.trim() };
  return ROLE_PREAMBLE.replace(/\{(name|memory|role)\}/g, (_, key: string) => values[key]);
}

const unique = (items: string[]): string[] => [...new Set(items)];

/** The command of the Director's own status line in his user settings, or undefined. Read only: gonogo never writes that file. */
export async function ownStatusLine(configDir: string): Promise<string | undefined> {
  try {
    const saved: unknown = JSON.parse(await readFile(join(configDir, 'settings.json'), 'utf8'));
    const line = isRecord(saved) ? saved.statusLine : undefined;
    return isRecord(line) && line.type === 'command' && typeof line.command === 'string' && line.command.trim() !== '' ? line.command : undefined;
  } catch {
    return undefined;
  }
}

/** `none`: the Agent tool (and its old name Task) is denied, next to the Director's own deny rules. */
export function withNoSubagents(rules: PermissionRules, setting: SubagentSettings): PermissionRules {
  return setting.mode === 'none' ? { ...rules, deny: [...new Set([...(rules.deny ?? []), 'Agent', 'Task'])] } : rules;
}

export function buildSettings(input: {
  /** Tool permissions (docs/features/permissions.md): the agent's own rules, else the room's. gonogo's denials and its memory rules stay. */
  rules?: PermissionRules;
  hubUrl: string;
  name: string;
  mode: PermissionMode;
  memoryPath: string;
  apiKeyHelper: boolean;
  /** Plan quota: the status line that posts `rate_limits` to the hub; `next` is the Director's own status-line command, which keeps its output. Absent: none. */
  statusLine?: { node: string; next?: string };
}): Record<string, unknown> {
  const hooks: Record<string, unknown> = {};
  for (const event of HOOK_EVENTS) {
    hooks[event] = [
      {
        hooks: [
          {
            type: 'http',
            url: `${input.hubUrl}${HOOK_PATH_PREFIX}${input.name}/${event}`,
            timeout: HOOK_TIMEOUT_S,
            // claude sends "Bearer " with an empty token unless allowedEnvVars names the variable
            headers: { Authorization: 'Bearer $GONOGO_TOKEN' },
            allowedEnvVars: ['GONOGO_TOKEN'],
          },
        ],
      },
    ];
  }
  const memoryRule = `//${input.memoryPath.replace(/^\//, '')}`;
  const settings: Record<string, unknown> = {
    hooks,
    tui: 'fullscreen',
    promptSuggestionEnabled: false,
    crossSessionInbound: 'refuse',
    permissions: {
      deny: unique([...DENIED_TOOLS, ...(input.rules?.deny ?? [])]),
      allow: unique([`Read(${memoryRule})`, `Edit(${memoryRule})`, ...(input.rules?.allow ?? [])]),
      ...(input.rules?.ask?.length ? { ask: unique(input.rules.ask) } : {}),
    },
  };
  if (input.mode === 'bypassPermissions') settings.skipDangerousModePermissionPrompt = true;
  if (input.apiKeyHelper) settings.apiKeyHelper = API_KEY_HELPER_COMMAND;
  if (input.statusLine) {
    const url = `${input.hubUrl}${HOOK_PATH_PREFIX}${input.name}/StatusLine`;
    const words = [input.statusLine.node, '-e', STATUS_LINE_SHIM, url, ...(input.statusLine.next ? [input.statusLine.next] : [])];
    settings.statusLine = { type: 'command', command: words.map(shellQuote).join(' '), refreshInterval: 300 };
  }
  return settings;
}

/** `servers` are the agent's Payload servers; gonogo's own entry comes last so that nothing can replace it. */
export function buildMcpConfig(hubUrl: string, servers: Record<string, McpServer> = {}): Record<string, unknown> {
  return {
    mcpServers: {
      ...servers,
      [MCP_SERVER_NAME]: {
        type: 'http', // without it claude reads the entry as stdio and skips it
        url: `${hubUrl}${MCP_PATH}`,
        headers: { Authorization: 'Bearer ${GONOGO_TOKEN}' }, // expanded by claude from its environment
      },
    },
  };
}

/** Every flag on every start: --resume restores history and model, not settings, MCP config, tools, mode or role text. */
export function buildArgv(input: {
  flag: SessionFlag;
  sessionId: string;
  mode: PermissionMode;
  settingsPath: string;
  mcpPath: string;
  roleText: string;
  /** A plugin folder holding the agent's skills (Payload), loaded for this session only. */
  pluginDir?: string | null;
  /** Engine Bay: the model of the agent; none leaves the CLI's own default. */
  model?: string;
  /** Claude Code's `--effort`; none leaves its own. */
  effort?: string;
  /** Remote Control: the session name the Claude app shows; none is off. */
  remoteControl?: string;
  /** Feature toggles: tool names (`mcp__gonogo__hire_agent`) of features that are off, left out of `--allowedTools`. */
  toolsOff?: readonly string[];
}): string[] {
  return [
    input.flag === 'resume' ? '--resume' : '--session-id',
    input.sessionId,
    '--permission-mode',
    input.mode,
    '--settings',
    input.settingsPath,
    '--strict-mcp-config',
    '--mcp-config',
    input.mcpPath,
    ...(input.pluginDir ? ['--plugin-dir', input.pluginDir] : []),
    ...(input.model ? ['--model', input.model] : []),
    ...(input.effort ? ['--effort', input.effort] : []),
    ...(input.remoteControl ? ['--remote-control', input.remoteControl] : []),
    '--append-system-prompt',
    input.roleText,
    '--system-prompt-snapshot',
    'off',
    '--allowedTools', // variadic, so it stays last
    ...ALLOWED_TOOLS.filter((tool) => !input.toolsOff?.includes(tool)),
  ];
}

/** claude sends http hooks through HTTP(S)_PROXY unless the host is listed; the operator's own entries stay. */
function withLoopback(existing: string | undefined): string {
  const hosts = (existing ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host !== '');
  for (const loopback of NO_PROXY_HOSTS) {
    if (!hosts.some((host) => host.toLowerCase() === loopback)) hosts.push(loopback);
  }
  return hosts.join(',');
}

/**
 * Comma separated; an entry ending in an underscore is a prefix, any other entry an exact name. It is applied to the
 * variables the owner's shell passed on, before gonogo sets its own, so it cannot take away TERM, GONOGO_TOKEN and the like.
 */
function operatorScrub(value: string | undefined): { exact: Set<string>; prefixes: string[] } {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const raw of (value ?? '').split(',')) {
    const entry = raw.trim();
    if (entry === '') continue;
    if (entry.endsWith('_')) prefixes.push(entry);
    else exact.add(entry);
  }
  return { exact, prefixes };
}

/** `seed` must only be true once the folder trust is on disk: IS_DEMO hides the trust dialog without trusting the folder. */
export function buildChildEnv(input: {
  base: Record<string, string | undefined>;
  /** null for a custom command: it has no token to carry. */
  token: string | null;
  seed: boolean;
  /** Clearance: this agent's own keys. They win over the same name in `base` and are not scrubbed: the Director set them for this agent. */
  keys?: Record<string, string>;
}): Record<string, string> {
  const env: Record<string, string> = {};
  const extra = operatorScrub(input.base[SCRUB_EXTRA_VAR]);
  for (const [key, value] of Object.entries(input.base)) {
    if (value === undefined || SCRUB_EXACT.has(key) || extra.exact.has(key)) continue;
    if (SCRUB_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)) || extra.prefixes.some((prefix) => key.startsWith(prefix))) continue;
    env[key] = value;
  }
  Object.assign(env, input.keys);
  if (input.seed) {
    env.IS_DEMO = '1';
    // A plain ANTHROPIC_API_KEY triggers a dialog whose default is "No" (or "Not logged in" under IS_DEMO)
    const apiKey = env.ANTHROPIC_API_KEY;
    if (hasText(apiKey)) {
      delete env.ANTHROPIC_API_KEY;
      env.GONOGO_API_KEY = apiKey;
    }
  }
  env.TERM = TERM_VALUE;
  env.COLORTERM = COLORTERM_VALUE;
  if (input.token !== null) env.GONOGO_TOKEN = input.token;
  env.NO_PROXY = withLoopback(env.NO_PROXY);
  env.no_proxy = withLoopback(env.no_proxy);
  return env;
}

/** The lookup of a transcript must name a project directory the way claude does. */
export function transcriptDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/* ---- files ---- */

/** Temp file in the same directory, then rename: a reader never sees half a file. */
async function writeFileAtomic(path: string, data: string, mode: number): Promise<void> {
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temp, data, { flag: 'wx', mode });
    await chmod(temp, mode); // the umask may have taken bits away
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Payload skills: a plugin folder under the agent's own folder, made again at every start, with a symlink to each skill
 * folder. `claude --plugin-dir` loads it for that session only, so the owner's project and ~/.claude stay as they are.
 * Returns the folder, or null when the agent has no skills (a folder left by earlier skills is removed).
 */
async function writeSkillsPlugin(base: string, skills: readonly string[] | undefined): Promise<string | null> {
  const dir = join(base, PAYLOAD_PLUGIN_DIR);
  await rm(dir, { recursive: true, force: true });
  if (skills === undefined || skills.length === 0) return null;
  for (const skill of skills) {
    const found = await stat(join(skill, 'SKILL.md')).then((info) => info.isFile(), () => false);
    if (!found) throw new Error(`the skill folder has no SKILL.md: ${skill}`);
  }
  await mkdir(dir, { mode: DIR_MODE });
  await mkdir(join(dir, '.claude-plugin'), { mode: DIR_MODE });
  await mkdir(join(dir, 'skills'), { mode: DIR_MODE });
  await writeFile(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: PAYLOAD_PLUGIN_NAME, description: 'Skills chosen for this agent in gonogo' }, null, 2), { mode: FILE_MODE });
  for (const skill of skills) await symlink(skill, join(dir, 'skills', basename(skill)));
  return dir;
}

/** A missing file is an empty object; a file that is not a JSON object is an error (it is the user's, never overwrite it). */
async function readJsonObject(path: string): Promise<JsonObject> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('the file is not valid JSON; fix or delete it');
  }
  if (!isObject(parsed)) throw new Error('the file does not hold a JSON object; fix or delete it');
  return parsed;
}

const isTrusted = (doc: JsonObject, dirs: readonly string[]): boolean =>
  dirs.every((dir) => {
    const entry = isObject(doc.projects) ? doc.projects[dir] : undefined;
    return isObject(entry) && entry.hasTrustDialogAccepted === true;
  });

/** Everything but the trust keys belongs to the user and to claude, so it is carried over untouched. */
function withTrust(doc: JsonObject, dirs: readonly string[]): JsonObject {
  const projects = doc.projects === undefined ? {} : doc.projects;
  if (!isObject(projects)) throw new Error('"projects" is not an object; fix or delete the file');
  const merged: JsonObject = { ...projects };
  for (const dir of dirs) {
    const entry = merged[dir] === undefined ? {} : merged[dir];
    if (!isObject(entry)) throw new Error(`the entry of ${dir} under "projects" is not an object; fix or delete the file`);
    merged[dir] = { ...entry, hasTrustDialogAccepted: true };
  }
  return { ...doc, projects: merged };
}

/** `outer` is `inner` or holds it. */
const holds = (outer: string, inner: string): boolean => {
  const way = relative(outer, inner);
  return way === '' || (way !== '..' && !way.startsWith(`..${sep}`) && !isAbsolute(way));
};

/**
 * Claude Code trusts every non-git folder below a trusted one, so trust for the root, for the home directory or for a
 * folder above gonogo's or Claude's own files would switch the trust dialog and the hook gate off far beyond the
 * project the owner meant. Returns why `dirs` (the folder and its real path) must not be trusted, or null.
 * shortcut: paths are compared as spelled, so another letter case of the same folder on a case-insensitive disk passes; upgrade when a real run shows it.
 */
async function broadTrustReason(dirs: readonly string[], guards: readonly { path: string; what: string }[]): Promise<string | null> {
  for (const dir of dirs) {
    if (dir === parse(dir).root) return 'it is the root of the file system';
    for (const guard of guards) {
      for (const path of new Set([guard.path, await realpath(guard.path).catch(() => guard.path)])) {
        if (!holds(dir, path)) continue;
        return relative(dir, path) === '' ? `it is ${guard.what}` : `it holds ${guard.what} (${guard.path})`;
      }
    }
  }
  return null;
}

/**
 * Records and verifies the trust of `dirs` in `file` and returns the path that was written. Rewrites until a read-back
 * shows the keys, because claude rewrites the same file on every start (O11) and a lost update would leave the hooks
 * of an IS_DEMO child silent with nothing on screen to say so.
 */
async function seedTrust(file: string, dirs: readonly string[]): Promise<string> {
  try {
    await mkdir(dirname(file), { recursive: true, mode: DIR_MODE });
    // a symlinked file keeps being a symlink: rename over it would replace the link with a copy
    const target = await realpath(file).catch(() => file);
    for (let attempt = 1; ; attempt++) {
      const doc = await readJsonObject(target);
      if (isTrusted(doc, dirs)) return target;
      const mode = await stat(target).then(
        (info) => info.mode & 0o777,
        () => FILE_MODE,
      );
      await writeFileAtomic(target, JSON.stringify(withTrust(doc, dirs), null, 2), mode);
      if (isTrusted(await readJsonObject(target), dirs)) return target;
      if (attempt >= TRUST_VERIFY_ATTEMPTS) {
        throw new Error(`the trust entry did not stay in the file (${TRUST_VERIFY_ATTEMPTS} attempts)`);
      }
      await sleep(TRUST_VERIFY_DELAY_MS);
    }
  } catch (error) {
    throw new Error(`cannot record folder trust in ${file}: ${errorText(error)}`);
  }
}

/**
 * Claude keeps a transcript where the working directory was when the session began, so a later start from another
 * directory must still find it: look in the project directory of each candidate, then in every project directory.
 */
async function transcriptExists(projectsRoot: string, dirs: readonly string[], sessionId: string): Promise<boolean> {
  const file = `${sessionId}.jsonl`;
  const isFile = (path: string): Promise<boolean> =>
    stat(path).then(
      (info) => info.isFile(),
      () => false,
    );
  for (const dir of dirs) {
    if (await isFile(join(projectsRoot, transcriptDirName(dir), file))) return true;
  }
  const names = await readdir(projectsRoot).catch(() => [] as string[]);
  for (const name of names) {
    if (await isFile(join(projectsRoot, name, file))) return true;
  }
  return false;
}

/* ---- the launcher ---- */

export function createLauncher(options: LauncherOptions): Launcher {
  const log = options.log ?? nullLogger;
  const homeDir = resolve(options.homeDir);
  /** Keyed by the SHA-256 of the token: the token itself is never kept here, so the table can be saved for a live reload. */
  const byToken = new Map<string, AgentIdentity>();
  const hashOf = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');
  /** `container`: the Clean Room container of that start, removed when the start ends. */
  const byAgent = new Map<string, { hash: string; generation: number; container?: string }>();
  /** A removal still running per agent: the next start of that agent waits for it, so it never removes the new container. */
  const removals = new Map<string, Promise<void>>();
  let trustChain: Promise<unknown> = Promise.resolve();

  const agentDir = (name: string): string => {
    if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error('invalid agent name');
    return join(homeDir, AGENTS_DIR, name);
  };

  // Live reload: <home>/run/tokens.json holds name, generation and the hash of each live token (0600), so that a new server keeps
  // answering the hook and MCP calls of agents that kept running. Off unless the option is given.
  const tokensFile = options.tokensFile ?? null;
  const saveTokens = (): void => {
    if (tokensFile === null) return;
    try {
      const entries = [...byAgent.entries()].map(([name, v]) => ({ name, generation: v.generation, hash: v.hash }));
      const temp = `${tokensFile}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify({ version: 1, tokens: entries }), { mode: FILE_MODE });
      renameSync(temp, tokensFile);
    } catch (error) {
      log.warn(`could not save the tokens: ${errorText(error)}`);
    }
  };
  const loadTokens = (): void => {
    if (tokensFile === null) return;
    try {
      const saved = JSON.parse(readFileSync(tokensFile, 'utf8')) as { tokens?: Array<{ name?: unknown; generation?: unknown; hash?: unknown }> };
      for (const t of Array.isArray(saved.tokens) ? saved.tokens : []) {
        if (typeof t.name !== 'string' || !NAME_RE.test(t.name) || typeof t.generation !== 'number' || typeof t.hash !== 'string' || !/^[0-9a-f]{64}$/.test(t.hash)) continue;
        byToken.set(t.hash, { agent: t.name, generation: t.generation });
        byAgent.set(t.name, { hash: t.hash, generation: t.generation });
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') log.warn(`could not read the saved tokens: ${errorText(error)}`);
    }
  };
  loadTokens();

  const issue = (name: string, generation: number): string => {
    const older = byAgent.get(name);
    if (older) byToken.delete(older.hash);
    const token = randomBytes(TOKEN_BYTES).toString('hex');
    const hash = hashOf(token);
    byToken.set(hash, { agent: name, generation });
    byAgent.set(name, { hash, generation });
    saveTokens();
    return token;
  };

  // Synchronous on purpose: a restart that follows the exit must not find this unlink still queued behind its own token write
  const revoke = (name: string, generation: number): void => {
    const current = byAgent.get(name);
    if (!current || current.generation !== generation) return;
    byToken.delete(current.hash);
    byAgent.delete(name);
    saveTokens();
    if (current.container !== undefined) removals.set(name, removeContainer(current.container, options.env ?? process.env));
    try {
      unlinkSync(join(agentDir(name), AGENT_TOKEN_FILE));
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') log.warn(`could not delete the token file of ${name}: ${errorText(error)}`);
    }
    log.debug(`revoked the token of ${name} (generation ${generation})`);
  };

  // Several agents start together and each one reads, merges and renames the same file
  const recordTrust = (file: string, dirs: readonly string[]): Promise<string> => {
    const run = trustChain.then(() => seedTrust(file, dirs));
    trustChain = run.catch(() => undefined);
    return run;
  };

  const recheckTrust = (name: string, shown: string, written: string, dirs: readonly string[]): void => {
    setTimeout(() => {
      readJsonObject(written)
        .then((doc) => {
          if (!isTrusted(doc, dirs)) {
            log.warn(
              `the trust entry of ${name}'s folder is no longer in ${shown} ${TRUST_RECHECK_MS / 1000} s after its start; the next start records it again`,
            );
          }
        })
        .catch((error: unknown) => log.debug(`could not re-check the folder trust of ${name}: ${errorText(error)}`));
    }, TRUST_RECHECK_MS).unref();
  };

  /** A custom command is a plain terminal: no settings, MCP file, token or memory file, and no folder trust. */
  /**
   * The co-author line (docs/coauthor-spec.md): the agent's own hooks folder and the three variables that point git at it, when the room
   * and the agent have it on. Never an error: a start does not fail for want of a trailer.
   */
  const withCoauthor = async (agent: AgentRecord, env: Record<string, string>, cwd: string, agentFolder: string, onlyAdd = false): Promise<Record<string, string>> => {
    if (agent.coauthor === false || options.coauthor?.().enabled === false || agent.cleanRoom !== undefined) return env;
    try {
      const dir = await ensureHooksDir(agentFolder, agent.name, await realHookNames(cwd, options.env ?? process.env));
      const added = coauthorEnv(env, dir);
      return onlyAdd ? added : { ...env, ...added };
    } catch (error) {
      log.warn(`${agent.name}: no co-author line this start`, errorText(error));
      return onlyAdd ? {} : env;
    }
  };

  const prepareCustom = async (agent: AgentRecord): Promise<PreparedStart> => {
    const { name } = agent;
    let words: string[] | null;
    try {
      words = parseAgentCmd(agent.command);
    } catch (error) {
      throw new Error(`the command of ${name} cannot be read: ${errorText(error).replace(/^GONOGO_AGENT_CMD: /, '')}`);
    }
    const [file, ...args] = words ?? [];
    if (!file) throw new Error(`the command of ${name} is empty`);
    const dirInfo = await stat(agent.dir).catch(() => null);
    if (!dirInfo?.isDirectory()) throw new Error(`working directory does not exist: ${agent.dir}`);
    const where = (await plainWorktree(agent, options.env ?? process.env))?.cwd ?? agent.dir;
    const env = await withCoauthor(agent, buildChildEnv({ base: options.env ?? process.env, token: null, seed: false, keys: options.keys?.(name) }), where, agentDir(name));
    return { spec: { file, args, env, cwd: where }, flag: 'session-id', token: '' };
  };

  /** Engine Bay: another agent CLI, started by its program name with the files and flags of its adapter (providers.ts). */
  /** A plain worktree (not a Clean Room's): made or found, and the folder the agent starts in; null when the agent starts in its own folder. */
  const plainWorktree = async (agent: AgentRecord, from: Record<string, string | undefined>): Promise<WorktreePlace | null> => (agent.worktree === undefined || agent.cleanRoom !== undefined ? null : prepareWorktree(agent, homeDir, from));

  const prepareOther = async (agent: AgentRecord, provider: OtherProvider, base: string, hubUrl: string, memoryPath: string, token: string): Promise<PreparedStart> => {
    const ctx = {
      name: agent.name,
      mode: agent.mode,
      role: agent.role.trim(),
      roleText: buildRoleText(agent.name, agent.role, memoryPath),
      servers: agent.payload?.mcpServers,
      hubUrl,
      agentDir: base,
      tokenFile: join(base, AGENT_TOKEN_FILE),
      token,
      seed: options.seed,
      model: agent.model ?? options.defaultModel?.(provider),
    };
    const start = buildProviderStart(provider, ctx);
    for (const [file, content] of Object.entries(start.files)) await writeFileAtomic(join(base, file), content, FILE_MODE);
    const where = (await plainWorktree(agent, options.env ?? process.env))?.cwd ?? agent.dir;
    const env = await withCoauthor(agent, { ...buildChildEnv({ base: options.env ?? process.env, token, seed: false, keys: options.keys?.(agent.name) }), ...start.env }, where, base);
    log.debug(`prepared ${agent.name} to run ${provider}`);
    return { spec: { file: PROVIDER_INFO[provider].bin, args: start.args, env, cwd: where }, flag: 'session-id', token };
  };

  const prepareStart = async (
    agent: AgentRecord,
    opts: { generation: number; flag: SessionFlag | null },
  ): Promise<PreparedStart> => {
    const { name } = agent;
    const base = agentDir(name);
    const provider = agent.provider ?? 'claude';
    if (provider === 'custom') return prepareCustom(agent);
    if (typeof agent.sessionId !== 'string' || !UUID_RE.test(agent.sessionId)) {
      throw new Error(`invalid session id for ${name}`);
    }
    if (!PERMISSION_MODES.includes(agent.mode)) throw new Error(`unknown permission mode for ${name}`);
    const hubUrl = String(options.hubUrl()).replace(/\/+$/, '');
    if (!LOOPBACK_URL_RE.test(hubUrl)) {
      throw new Error(`the hub URL must be http://127.0.0.1:<port> or http://[::1]:<port>, got ${JSON.stringify(hubUrl)}`);
    }
    const env = options.env ?? process.env;

    const dirInfo = await stat(agent.dir).catch(() => null);
    if (!dirInfo?.isDirectory()) throw new Error(`working directory does not exist: ${agent.dir}`);
    const dir = resolve(agent.dir);

    await mkdir(base, { recursive: true, mode: DIR_MODE });
    if (((await stat(base)).mode & 0o777) !== DIR_MODE) await chmod(base, DIR_MODE);
    const memoryPath = join(base, MEMORY_FILE);
    await writeFile(memoryPath, `# Memory of ${name}\n\nNotes that survive restarts. Keep it short.\n`, {
      flag: 'wx',
      mode: FILE_MODE,
    }).catch((error: unknown) => {
      if (errorCode(error) !== 'EEXIST') throw error;
    });

    const token = issue(name, opts.generation);
    try {
      await writeFileAtomic(join(base, AGENT_TOKEN_FILE), `${token}\n`, FILE_MODE);
      if (provider !== 'claude') return await prepareOther(agent, provider, base, hubUrl, memoryPath, token);
      // Clean Room: a container has the worktree and the agent's own folder only, so it gets a home of its own under the agent's folder.
      if (agent.cleanRoom !== undefined) await removals.get(name);
      const clean = agent.cleanRoom === undefined ? null : await prepareCleanRoom(agent, homeDir, base, env);
      // A fresh container home has no folder trust and no login, so its dialogs are skipped as in seed mode.
      const plain = await plainWorktree(agent, env);
      const seed = options.seed || clean !== null;
      const agentUrl = clean === null ? hubUrl : containerUrl(hubUrl);
      const settingsPath = join(base, SETTINGS_FILE);
      const mcpPath = join(base, MCP_FILE);
      const keys = options.keys?.(name) ?? {};
      const moveApiKey = seed && hasText(keys.ANTHROPIC_API_KEY ?? env.ANTHROPIC_API_KEY);
      // Plan quota: the shim goes in always; the Director's own status line (user settings, read only) is chained, never replaced. Not in a container: his command is a host path.
      const ownConfig = hasText(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR : join(homedir(), '.claude');
      const next = clean === null ? await ownStatusLine(ownConfig) : undefined;
      const statusLine = { node: clean === null ? process.execPath : 'node', ...(next === undefined ? {} : { next }) };
      const subagentSetting = options.subagents?.() ?? { mode: 'allow' as const, limit: 4 };
      const settings = buildSettings({ hubUrl: agentUrl, name, mode: agent.mode, memoryPath, apiKeyHelper: moveApiKey, rules: withNoSubagents(effectiveRules(agent.permissions, options.defaultPermissions?.()), subagentSetting), statusLine });
      await writeFileAtomic(settingsPath, JSON.stringify(settings, null, 2), FILE_MODE);
      await writeFileAtomic(mcpPath, JSON.stringify(buildMcpConfig(agentUrl, agent.payload?.mcpServers), null, 2), FILE_MODE);
      const pluginDir = await writeSkillsPlugin(base, agent.payload?.skills);

      const configDir = hasText(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR : null;
      const startDir = plain?.cwd ?? dir;
      const realDir = await realpath(startDir).catch(() => startDir);
      const trustDirs = clean === null ? [...new Set([realDir, startDir])] : [clean.cwd];
      // the folder of the config that claude reads: the owner's, or the container's own home
      const claudeRoot = clean === null ? configDir ?? homedir() : clean.home;
      const claudeJson = join(claudeRoot, CLAUDE_JSON);
      let recheck: (() => void) | null = null;
      if (seed) {
        const broad = await broadTrustReason(trustDirs, [
          { path: homedir(), what: 'your home directory' },
          { path: homeDir, what: "gonogo's home directory" },
          { path: configDir ?? join(homedir(), '.claude'), what: "Claude Code's configuration folder" },
        ]);
        if (broad !== null) {
          throw new Error(`cannot record folder trust for ${dir}: ${broad} and trust covers every folder below it; use a project folder instead`);
        }
        if (moveApiKey && hasText(env.CLAUDE_CODE_OAUTH_TOKEN)) {
          log.warn('both ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN are set; the API key is used');
        }
        const written = await recordTrust(claudeJson, trustDirs);
        recheck = () => recheckTrust(name, claudeJson, written, trustDirs);
      }

      const projectsRoot = join(clean === null ? configDir ?? join(homedir(), '.claude') : clean.home, 'projects');
      const flag: SessionFlag =
        opts.flag ?? ((await transcriptExists(projectsRoot, clean === null ? [startDir, realDir] : [clean.cwd], agent.sessionId)) ? 'resume' : 'session-id');
      const roleText = buildRoleText(name, agent.role, memoryPath) + (clean === null ? '' : `\n${CLEAN_ROOM_NOTE.replace('{branch}', cleanRoomBranch(name))}`) + (plain === null ? '' : `\n${WORKTREE_NOTE.replace('{branch}', plain.branch)}`);
      const [file, ...leading] = options.agentCmd?.length ? options.agentCmd : [options.claudeBin ?? CLAUDE_BIN];
      // Effort: the console's own, else the room's. An old claude exits on an option it does not know: its own effort refuses the start (it asked for it), the room's is dropped with a warning (one setting must not stop every console). A Clean Room runs the image's claude, not the host's, so it is not asked.
      let effort = agent.effort ?? options.defaultEffort?.();
      if (effort && clean === null && !options.agentCmd?.length && (await knowsEffort(file as string, options.env ?? process.env)) === false) {
        if (agent.effort) throw new Error(`${file} does not list --effort, so the effort of ${name} cannot be set: update claude, or clear the effort`);
        log.warn(`${file} does not list --effort: the room's default effort is not passed to ${name}; update claude`);
        effort = undefined;
      }
      const claudeArgs = buildArgv({ flag, sessionId: agent.sessionId, mode: agent.mode, settingsPath, mcpPath, roleText, pluginDir, model: agent.model ?? options.defaultModel?.('claude', agent.position), remoteControl: agent.remoteControl === undefined ? undefined : remoteControlName(name), effort, toolsOff: options.toolsOff?.().map((tool) => `mcp__gonogo__${tool}`) });
      const childEnv = buildChildEnv({ base: env, token, seed, keys });
      // a Clean Room has no git of the Director's inside: nothing to mark there
      if (clean === null) Object.assign(childEnv, await withCoauthor(agent, childEnv, startDir, base, true));
      if (subagentSetting.mode === 'limit') childEnv[SUBAGENT_LIMIT_ENV] = String(subagentSetting.limit);
      let spec: PreparedStart['spec'];
      if (clean === null) {
        spec = { file, args: [...leading, ...claudeArgs], env: childEnv, cwd: startDir };
      } else {
        const uid = process.getuid?.();
        const gid = process.getgid?.();
        if (uid === undefined || gid === undefined) throw new Error('Clean Room needs a user id: it runs on macOS and Linux only');
        // by name: docker reads the values from its own environment, so no secret is on the command line
        // The agent's own keys go the same way: the container gets their names, and nothing else of the host's environment.
        const names = [...new Set([...CLEAN_ROOM_ENV, ...CLEAN_ROOM_CREDENTIALS, ...Object.keys(keys)])].filter((variable) => hasText(childEnv[variable]));
        const command: [string, ...string[]] = [file, ...leading, ...claudeArgs];
        const args = buildDockerArgs({ image: cleanRoomImage(agent.cleanRoom ?? {}, env), uid, gid, place: clean, agentDir: base, names, command });
        spec = { file: DOCKER_BIN, args, env: childEnv, cwd: clean.worktree };
        const started = byAgent.get(name);
        if (started?.generation === opts.generation) started.container = clean.container;
      }
      const prepared: PreparedStart = { spec, flag, token };
      recheck?.();
      log.debug(`prepared ${name} (generation ${opts.generation}) with --${flag}`);
      return prepared;
    } catch (error) {
      revoke(name, opts.generation);
      throw error;
    }
  };

  const renameAgentFiles = async (oldName: string, newName: string): Promise<void> => {
    const from = agentDir(oldName);
    const to = agentDir(newName);
    const exists = (path: string): Promise<boolean> =>
      lstat(path).then(
        () => true,
        () => false,
      );
    // The hub shows this text to the owner: no internal path, and a way out
    if (await exists(to)) {
      throw new Error(
        `the name "${newName}" is taken by a notes folder left over from a removed agent; choose another name, or delete that folder from the agents folder of the gonogo home`,
      );
    }
    if (!(await exists(from))) return;
    await rename(from, to);
  };

  return {
    prepareStart,
    resolveToken: (token) => (typeof token === 'string' ? (byToken.get(hashOf(token)) ?? null) : null),
    keepTokens: (live) => {
      for (const [name, v] of [...byAgent.entries()]) {
        if (live.some((l) => l.name === name && l.generation === v.generation)) continue;
        byToken.delete(v.hash);
        byAgent.delete(name);
      }
      saveTokens();
    },
    revoke,
    renameAgentFiles,
    memoryPath: (name) => join(agentDir(name), MEMORY_FILE),
  };
}
