/**
 * Engine Bay (docs/engine-bay-spec.md): how each agent CLI other than Claude Code and the custom command is started.
 * Claude Code stays in launcher.ts as it was. An adapter names the arguments, the extra environment and the files it
 * needs in the agent's own folder; what the hub does with the CLI (hooks or output activity, mail or none) is
 * PROVIDER_INFO in protocol.ts. Nothing here touches the owner's project or the CLI's own home folder.
 */
import { execFile } from 'node:child_process';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { MCP_SERVER_NAME, PROVIDER_INFO, PROVIDERS } from '../shared/protocol.js';
import type { EngineCheck, HookEvent, McpServer, PermissionMode, Provider } from '../shared/protocol.js';
import { ENGINE_VERSION_CHARS, ENGINE_VERSION_MS, HOOK_PATH_PREFIX, HOOK_TIMEOUT_S, MCP_PATH } from './constants.js';

export type OtherProvider = Exclude<Provider, 'claude' | 'custom'>;

export interface StartContext {
  name: string;
  mode: PermissionMode;
  /** The owner's role text alone, for a CLI without the gonogo tools. */
  role: string;
  /** ROLE_PREAMBLE with the role, for a CLI with them. */
  roleText: string;
  hubUrl: string;
  agentDir: string;
  /** The file that holds this start's token (mode 0600). */
  tokenFile: string;
  token: string;
  seed: boolean;
  /** Engine Bay: the model of the agent, passed as `--model`; none leaves the CLI's default. */
  model?: string;
  /** The agent's Payload servers, for the CLIs that read Claude's mcp.json shape (Gemini, Kimi). */
  servers?: Record<string, McpServer>;
}
export interface ProviderStart {
  args: string[];
  env: Record<string, string>;
  /** File name in the agent's folder to its content, written with mode 0600 before the start. */
  files: Record<string, string>;
}

/** Gemini CLI hook event to the hub's own hook event: the hub handles both CLIs with one set of rules. */
export const GEMINI_HOOKS: Readonly<Record<string, HookEvent>> = {
  BeforeAgent: 'UserPromptSubmit',
  BeforeTool: 'PreToolUse',
  AfterTool: 'PostToolUse',
  Notification: 'Notification',
  AfterAgent: 'Stop',
};
export const GEMINI_SETTINGS_FILE = 'gemini-settings.json';
// shortcut: 'auto' is Claude Code's own classifier; the other CLIs have none, so it maps to their nearest mode (edits run, the rest asks). Give them their own mode if they ever ship one.
const GEMINI_MODES: Record<PermissionMode, string> = { default: 'default', acceptEdits: 'auto_edit', auto: 'auto_edit', bypassPermissions: 'yolo' };
const CODEX_MODES: Record<PermissionMode, string[]> = {
  default: [],
  acceptEdits: ['--full-auto'],
  auto: ['--full-auto'],
  bypassPermissions: ['--dangerously-bypass-approvals-and-sandbox'],
};

/**
 * Gemini CLI runs only command hooks, so each one runs this with `node -e`: it reads the hook input from stdin, forwards
 * the fields the hub reads to the hook URL with the token from the token file, and prints the hub's answer (a Stop
 * block becomes Gemini's AfterAgent block). The transcript path is not forwarded: Propellant reads only Claude's.
 * Any failure prints `{}`, which lets Gemini go on. No single quote inside: it is passed in single quotes.
 */
export const HOOK_SHIM = [
  'let d="";process.stdin.on("data",c=>d+=c).on("end",async()=>{try{',
  'const i=JSON.parse(d||"{}"),b={};',
  'for(const k of ["prompt","tool_name","tool_input","notification_type","message"])if(i[k]!==undefined)b[k]=i[k];',
  'const t=require("fs").readFileSync(process.argv[2],"utf8").trim();',
  'const r=await fetch(process.argv[1],{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+t},',
  `body:JSON.stringify(b),signal:AbortSignal.timeout(${HOOK_TIMEOUT_S * 1000})});`,
  'process.stdout.write(r.ok?await r.text():"{}")}catch{process.stdout.write("{}")}})',
].join('');

/** One shell word: Gemini runs a hook command through the shell. */
export const shellQuote = (word: string): string => `'${word.replace(/'/g, `'\\''`)}'`;

export function buildGeminiSettings(ctx: Pick<StartContext, 'hubUrl' | 'name' | 'tokenFile' | 'servers'>, node = process.execPath): Record<string, unknown> {
  const hooks: Record<string, unknown> = {};
  for (const [event, ours] of Object.entries(GEMINI_HOOKS)) {
    const url = `${ctx.hubUrl}${HOOK_PATH_PREFIX}${ctx.name}/${ours}`;
    const command = [node, '-e', HOOK_SHIM, url, ctx.tokenFile].map(shellQuote).join(' ');
    // Gemini's timeout is in milliseconds; the shim gives up one second earlier and answers {}.
    hooks[event] = [{ hooks: [{ type: 'command', command, timeout: (HOOK_TIMEOUT_S + 1) * 1000 }] }];
  }
  return {
    // trust: the gonogo tools run without a confirmation, like the --allowedTools of a Claude agent.
    // Payload servers come first and carry no `trust`: Gemini asks before their tools run. Its schema takes the mcp.json fields as they are.
    mcpServers: { ...ctx.servers, [MCP_SERVER_NAME]: { httpUrl: `${ctx.hubUrl}${MCP_PATH}`, headers: { Authorization: 'Bearer ${GONOGO_TOKEN}' }, trust: true } },
    hooks,
  };
}

// unused until a per-agent hooks.json location is verified (docs/facts/antigravity.md)
/**
 * Antigravity CLI (agy) hook event to the hub's own. Written from the vendor's hook page (docs/facts/antigravity.md), not from a run.
 * PreInvocation is the nearest of agy's events to a submitted prompt; its stdin carries `lastUserInput`.
 */
export const AGY_HOOKS: Readonly<Record<string, HookEvent>> = {
  PreInvocation: 'UserPromptSubmit',
  PreToolUse: 'PreToolUse',
  PostToolUse: 'PostToolUse',
  Stop: 'Stop',
};
export const AGY_HOOKS_FILE = 'agy-hooks.json';
export const AGY_MODES: Record<PermissionMode, string[]> = {
  default: [],
  acceptEdits: ['--mode', 'accept-edits'],
  auto: ['--mode', 'auto'],
  bypassPermissions: ['--dangerously-skip-permissions'],
};

/**
 * agy runs command hooks too: JSON on stdin in camelCase, JSON on stdout. This is HOOK_SHIM for it: it maps lastUserInput to
 * prompt and toolCall.name and args to tool_name and tool_input, sends a PostToolUse that has an `error` to PostToolUseFailure,
 * and turns the hub's Stop block into agy's Stop continue (the only decision that keeps agy going). A PreToolUse must answer
 * with a decision, so it says allow; any failure prints {} (a Stop or PostToolUse then lets agy go on).
 * No single quote inside: it is passed in single quotes.
 */
export const AGY_HOOK_SHIM = [
  'let d="";process.stdin.on("data",c=>d+=c).on("end",async()=>{let u=process.argv[1];const pre=u.endsWith("/PreToolUse");try{',
  'const i=JSON.parse(d||"{}"),b={},c=i.toolCall&&typeof i.toolCall==="object"?i.toolCall:{};',
  'if(i.lastUserInput!==undefined)b.prompt=i.lastUserInput;',
  'if(c.name!==undefined)b.tool_name=c.name;if(c.args!==undefined)b.tool_input=c.args;',
  'if(i.error&&u.endsWith("/PostToolUse"))u+="Failure";',
  'const t=require("fs").readFileSync(process.argv[2],"utf8").trim();',
  'const r=await fetch(u,{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+t},',
  `body:JSON.stringify(b),signal:AbortSignal.timeout(${HOOK_TIMEOUT_S * 1000})});`,
  'const a=r.ok?JSON.parse(await r.text()):{};',
  'process.stdout.write(JSON.stringify(a.decision==="block"?{decision:"continue",reason:a.reason}:pre?{decision:"allow"}:{}))',
  '}catch{process.stdout.write(pre?"{\\"decision\\":\\"allow\\"}":"{}")}})',
].join('');

/** hooks.json for agy: the tool events take a matcher wrapper (every tool), the others a plain handler list. Its timeout is in seconds. */
export function buildAgyHooks(ctx: Pick<StartContext, 'hubUrl' | 'name' | 'tokenFile'>, node = process.execPath): Record<string, unknown> {
  const hooks: Record<string, unknown> = {};
  for (const [event, ours] of Object.entries(AGY_HOOKS)) {
    const url = `${ctx.hubUrl}${HOOK_PATH_PREFIX}${ctx.name}/${ours}`;
    const handler = { type: 'command', command: [node, '-e', AGY_HOOK_SHIM, url, ctx.tokenFile].map(shellQuote).join(' '), timeout: HOOK_TIMEOUT_S + 1 };
    hooks[event] = event === 'PreToolUse' || event === 'PostToolUse' ? [{ matcher: '*', hooks: [handler] }] : [handler];
  }
  return hooks;
}

/** The MCP entry for a CLI that reads Claude's mcp.json shape but may not expand variables: the token is written in. */
function mcpJson(ctx: StartContext, extra: Record<string, unknown> = {}): string {
  const server = { type: 'http', url: `${ctx.hubUrl}${MCP_PATH}`, headers: { Authorization: `Bearer ${ctx.token}` }, ...extra };
  return JSON.stringify({ mcpServers: { ...ctx.servers, [MCP_SERVER_NAME]: server } }, null, 2);
}

/**
 * Every start of these CLIs is a new session: none of them is resumed by gonogo.
 * shortcut: a restart loses the conversation, upgrade when a CLI's resume by id is checked against a real run.
 */
export function buildProviderStart(provider: OtherProvider, ctx: StartContext): ProviderStart {
  const file = (name: string): string => join(ctx.agentDir, name);
  // Every engine with a model setting takes `--model <name>` (PROVIDER_INFO.model); the name is one argument, never a shell word.
  const model = ctx.model ? ['--model', ctx.model] : [];
  switch (provider) {
    case 'gemini':
      // GEMINI_CLI_SYSTEM_SETTINGS_PATH is read before the owner's ~/.gemini settings and wins over them; their login stays.
      return {
        args: ['--approval-mode', GEMINI_MODES[ctx.mode], ...(ctx.seed ? ['--skip-trust'] : []), ...model, '--prompt-interactive', ctx.roleText],
        env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: file(GEMINI_SETTINGS_FILE) },
        files: { [GEMINI_SETTINGS_FILE]: JSON.stringify(buildGeminiSettings(ctx), null, 2) },
      };
    case 'antigravity':
      // No hooks and no gonogo tools yet (see PROVIDER_INFO): a terminal with a lamp that knows the mode, the model and its role.
      // The role alone, without the preamble about tools it does not have. -i runs it as the first prompt and stays interactive.
      return { args: [...AGY_MODES[ctx.mode], ...model, '-i', ctx.role], env: {}, files: {} };
    case 'codex':
      // -c overrides config.toml for this run only, so CODEX_HOME (and the owner's login in it) stays as it is.
      return {
        args: [
          '-c',
          `mcp_servers.${MCP_SERVER_NAME}.url=${JSON.stringify(`${ctx.hubUrl}${MCP_PATH}`)}`,
          '-c',
          `mcp_servers.${MCP_SERVER_NAME}.bearer_token_env_var="GONOGO_TOKEN"`,
          ...CODEX_MODES[ctx.mode],
          ...model,
          ctx.roleText,
        ],
        env: {},
        files: {},
      };
    case 'opencode':
      // OPENCODE_CONFIG is merged over the owner's config; {env:...} is opencode's own substitution.
      return {
        args: ['--prompt', ctx.roleText],
        env: { OPENCODE_CONFIG: file('opencode.json') },
        files: {
          'opencode.json': JSON.stringify(
            { mcp: { [MCP_SERVER_NAME]: { type: 'remote', url: `${ctx.hubUrl}${MCP_PATH}`, headers: { Authorization: 'Bearer {env:GONOGO_TOKEN}' }, enabled: true } } },
            null,
            2,
          ),
        },
      };
    case 'kimi':
      return { args: ['--mcp-config-file', file('kimi-mcp.json'), ...model], env: {}, files: { 'kimi-mcp.json': mcpJson(ctx) } };
    case 'copilot':
      return { args: ['--additional-mcp-config', `@${file('copilot-mcp.json')}`], env: {}, files: { 'copilot-mcp.json': mcpJson(ctx, { tools: ['*'] }) } };
    case 'pi':
      // pi reads MCP servers only from its own files, so it gets no gonogo tools: the role alone, without the preamble about them.
      return { args: ['--append-system-prompt', ctx.role, ...model], env: {}, files: {} };
    case 'cursor':
      return { args: model, env: {}, files: {} };
    case 'qwen':
    case 'grok':
    case 'crush':
      // No documented per-session MCP config and no checked way to pass a role: a terminal with a lamp, started by name.
      return { args: [], env: {}, files: {} };
  }
}

/** The path of `name` when it is an executable file in one of the PATH directories, else null. */
export function findOnPath(name: string, pathVar: string | undefined): string | null {
  if (name === '') return null;
  for (const dir of (pathVar ?? '').split(delimiter)) {
    if (dir === '') continue;
    try {
      const file = join(dir, name);
      accessSync(file, fsConstants.X_OK);
      if (statSync(file).isFile()) return file;
    } catch {
      // not in this directory
    }
  }
  return null;
}

/** Whether `name` is an executable file in one of the PATH directories (moved here from cli.ts). */
export const onPath = (name: string, pathVar: string | undefined): boolean => findOnPath(name, pathVar) !== null;

// A terminal sequence (colour, title) whole, then what is left of control, C1 and text-direction characters: the line goes to a terminal and a web page.
const TERMINAL_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?)/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Pad Check: the first line a program prints for `--version`, with terminal sequences and control characters taken out and cut short. */
export const versionLine = (output: string): string | null => {
  const line = output.split('\n').map((l) => l.replace(TERMINAL_SEQUENCE, '').replace(CONTROL, '').trim()).find((l) => l !== '');
  return line === undefined ? null : line.slice(0, ENGINE_VERSION_CHARS);
};

/** Versions already read, by path and modification time: a program that was updated is asked again, one that failed is asked every time. */
const versionCache = new Map<string, string>();

/**
 * `<file> --version`, no shell, a few seconds at most, and an environment of PATH, HOME and LANG only, so that no key or token of
 * gonogo's environment reaches a program that is merely asked its version. null when it did not answer or printed nothing.
 */
async function versionOf(file: string, env: Record<string, string | undefined>): Promise<string | null> {
  const key = `${file}\0${statSync(file).mtimeMs}`;
  const known = versionCache.get(key);
  if (known !== undefined) return known;
  const output = await new Promise<string>((done) => {
    execFile(file, ['--version'], { timeout: ENGINE_VERSION_MS, maxBuffer: 64 * 1024, env: { PATH: env.PATH, HOME: env.HOME, LANG: env.LANG, NO_COLOR: '1' } }, (error, stdout) => done(error === null ? stdout : ''));
  });
  const line = versionLine(output);
  if (line !== null) versionCache.set(key, line);
  return line;
}

/** Pad Check: every engine but the custom command, where it was found and what it calls itself. Runs nothing but `--version`; never installs. */
export function checkEngines(env: Record<string, string | undefined>): Promise<EngineCheck[]> {
  return Promise.all(
    PROVIDERS.filter((provider) => provider !== 'custom').map(async (provider): Promise<EngineCheck> => {
      const { label, bin, install, docs } = PROVIDER_INFO[provider];
      const path = findOnPath(bin, env.PATH);
      return { provider, label, bin, path, version: path === null ? null : await versionOf(path, env).catch(() => null), install, docs };
    }),
  );
}

/** What `gonogo doctor` prints: one line per engine, and under a missing one the vendor's install command to copy. */
export function formatDoctor(checks: readonly EngineCheck[], agentCmd: string | null): string {
  const lines = ['gonogo doctor: which agent CLIs are on the PATH', ''];
  for (const check of checks) {
    if (check.path !== null) {
      lines.push(`ok  ${check.label} (${check.bin})  ${check.version ?? 'no version printed'}  ${check.path}`);
      continue;
    }
    lines.push(`--  ${check.label} (${check.bin})  not found`);
    lines.push(check.install === null ? `    no install command was checked; see ${check.docs}` : `    install: ${check.install}`);
    if (check.install !== null) lines.push(`    docs: ${check.docs}`);
  }
  if (agentCmd !== null) lines.push('', `GONOGO_AGENT_CMD is set (${agentCmd}): it replaces claude.`);
  lines.push('', 'gonogo never runs an install command: copy the one you want.');
  return lines.join('\n') + '\n';
}

/** ServerInfo.installed: what the hire form lists first. GONOGO_AGENT_CMD stands in for claude. */
export function installedProviders(path: string | undefined, agentCmd: boolean): Provider[] {
  return PROVIDERS.filter((p) => p === 'custom' || (p === 'claude' && agentCmd) || onPath(PROVIDER_INFO[p].bin, path));
}
