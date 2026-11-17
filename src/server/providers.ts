/**
 * Engine Bay (docs/engine-bay-spec.md): how each agent CLI other than Claude Code and the custom command is started.
 * Claude Code stays in launcher.ts as it was. An adapter names the arguments, the extra environment and the files it
 * needs in the agent's own folder; what the hub does with the CLI (hooks or output activity, mail or none) is
 * PROVIDER_INFO in protocol.ts. Nothing here touches the owner's project or the CLI's own home folder.
 */
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { MCP_SERVER_NAME, PROVIDER_INFO, PROVIDERS } from '../shared/protocol.js';
import type { HookEvent, McpServer, PermissionMode, Provider } from '../shared/protocol.js';
import { HOOK_PATH_PREFIX, HOOK_TIMEOUT_S, MCP_PATH } from './constants.js';

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
  switch (provider) {
    case 'gemini':
      // GEMINI_CLI_SYSTEM_SETTINGS_PATH is read before the owner's ~/.gemini settings and wins over them; their login stays.
      return {
        args: ['--approval-mode', GEMINI_MODES[ctx.mode], ...(ctx.seed ? ['--skip-trust'] : []), '--prompt-interactive', ctx.roleText],
        env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: file(GEMINI_SETTINGS_FILE) },
        files: { [GEMINI_SETTINGS_FILE]: JSON.stringify(buildGeminiSettings(ctx), null, 2) },
      };
    case 'codex':
      // -c overrides config.toml for this run only, so CODEX_HOME (and the owner's login in it) stays as it is.
      return {
        args: [
          '-c',
          `mcp_servers.${MCP_SERVER_NAME}.url=${JSON.stringify(`${ctx.hubUrl}${MCP_PATH}`)}`,
          '-c',
          `mcp_servers.${MCP_SERVER_NAME}.bearer_token_env_var="GONOGO_TOKEN"`,
          ...CODEX_MODES[ctx.mode],
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
      return { args: ['--mcp-config-file', file('kimi-mcp.json')], env: {}, files: { 'kimi-mcp.json': mcpJson(ctx) } };
    case 'copilot':
      return { args: ['--additional-mcp-config', `@${file('copilot-mcp.json')}`], env: {}, files: { 'copilot-mcp.json': mcpJson(ctx, { tools: ['*'] }) } };
    case 'pi':
      // pi reads MCP servers only from its own files, so it gets no gonogo tools: the role alone, without the preamble about them.
      return { args: ['--append-system-prompt', ctx.role], env: {}, files: {} };
    case 'qwen':
    case 'grok':
    case 'crush':
    case 'cursor':
      // No documented per-session MCP config and no checked way to pass a role: a terminal with a lamp, started by name.
      return { args: [], env: {}, files: {} };
  }
}

/** Whether `name` is an executable file in one of the PATH directories (moved here from cli.ts). */
export function onPath(name: string, pathVar: string | undefined): boolean {
  for (const dir of (pathVar ?? '').split(delimiter)) {
    if (dir === '') continue;
    try {
      const file = join(dir, name);
      accessSync(file, fsConstants.X_OK);
      if (statSync(file).isFile()) return true;
    } catch {
      // not in this directory
    }
  }
  return false;
}

/** ServerInfo.installed: what the hire form lists first. GONOGO_AGENT_CMD stands in for claude. */
export function installedProviders(path: string | undefined, agentCmd: boolean): Provider[] {
  return PROVIDERS.filter((p) => p === 'custom' || (p === 'claude' && agentCmd) || onPath(PROVIDER_INFO[p].bin, path));
}
