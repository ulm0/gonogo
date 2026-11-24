/**
 * Engine Bay, pi (docs/engine-bay-spec.md): pi 1.6 loads an extension given with `--extension`, so gonogo writes one into the agent's own
 * folder at every start. It gives pi what Claude Code gets from its settings and mcp.json, without touching ~/.pi or the project:
 *
 * - the gonogo MCP server and the agent's Payload servers (`pi.registerMcpServer`, for this session only),
 * - the hook events the hub reads (`UserPromptSubmit`, `PreToolUse`, `PostToolUse(Failure)`, `Stop`, `StopFailure`), posted to the same
 *   `/hook/<name>/<event>` URLs as Claude Code's http hooks, with the agent's token,
 * - mail at the end of a turn: a Stop the hub answers with a block becomes pi's own continuation (`agent_before_settle`), the same as
 *   Claude Code's Stop block,
 * - the permission mode and the tool rules (toolgate.ts): a call the gate denies is blocked with the reason, one it asks about opens pi's own
 *   confirmation (Enter allows, Escape refuses: the page's GO / NO-GO and the phone press those) and tells the hub it needs the Director.
 *
 * The extension reads its settings from the file named by GONOGO_PI_CONFIG (mode 0600: a Payload server's env and headers can hold a key) and the
 * token from GONOGO_TOKEN, which gonogo sets for every agent. It never throws into pi: a hub that does not answer lets pi go on.
 */
import { MCP_SERVER_NAME } from '../shared/protocol.js';
import type { McpServer } from '../shared/protocol.js';
import { HOOK_PATH_PREFIX, HOOK_TIMEOUT_S, MCP_PATH } from './constants.js';
import { GATE_SOURCE } from './toolgate.js';
import type { GatePolicy } from './toolgate.js';

export const PI_EXTENSION_FILE = 'gonogo-pi.ts';
export const PI_CONFIG_FILE = 'gonogo-pi.json';
export const PI_SESSIONS_DIR = 'pi-sessions';
export const PI_CONFIG_ENV = 'GONOGO_PI_CONFIG';

/** One server as pi's `mcpServers` entry: stdio is `command`/`args`/`env`, http is `url`/`headers`. pi has no SSE transport. */
export interface PiServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  exposure: 'direct';
}

export interface PiConfig {
  /** `<hub>/hook/<name>/`: the event name is added at the end. */
  hookUrl: string;
  mcpUrl: string;
  timeoutMs: number;
  servers: Record<string, PiServer>;
  policy: GatePolicy;
}

/**
 * The agent's servers in pi's shape. Every tool is `direct` (declared to the model like a built-in), as Claude Code declares every MCP tool.
 * An SSE server is left out (pi refuses the transport) and named in `skipped`.
 */
export function piServers(servers: Record<string, McpServer> | undefined): { servers: Record<string, PiServer>; skipped: string[] } {
  const out: Record<string, PiServer> = {};
  const skipped: string[] = [];
  for (const [name, server] of Object.entries(servers ?? {})) {
    if (name === MCP_SERVER_NAME) continue;
    if (server.type === 'sse') {
      skipped.push(name);
      continue;
    }
    if (server.type === 'http' || (server.type === undefined && server.url !== undefined && server.command === undefined)) {
      if (server.url === undefined) continue;
      out[name] = { url: server.url, ...(server.headers ? { headers: { ...server.headers } } : {}), exposure: 'direct' };
      continue;
    }
    if (server.command === undefined) continue;
    out[name] = { command: server.command, ...(server.args ? { args: [...server.args] } : {}), ...(server.env ? { env: { ...server.env } } : {}), exposure: 'direct' };
  }
  return { servers: out, skipped };
}

export function buildPiConfig(input: { hubUrl: string; name: string; servers?: Record<string, McpServer>; policy: GatePolicy }): { config: PiConfig; skipped: string[] } {
  const { servers, skipped } = piServers(input.servers);
  return {
    config: { hookUrl: `${input.hubUrl}${HOOK_PATH_PREFIX}${input.name}/`, mcpUrl: `${input.hubUrl}${MCP_PATH}`, timeoutMs: HOOK_TIMEOUT_S * 1000, servers, policy: input.policy },
    skipped,
  };
}

/**
 * The extension itself. Plain TypeScript with no import but node's own: pi loads it with jiti, and the agent's folder has no node_modules.
 * Tool names are given as Claude Code's (bash is Bash), so the hub's "doing" line and its repeat and storm checks read them the same.
 */
export const PI_EXTENSION_SOURCE = `// Written by gonogo at every start of this agent: an edit is lost at the next start.
import { readFileSync } from "node:fs";

${GATE_SOURCE}

const TOOLS: Record<string, string> = { bash: "Bash", read: "Read", edit: "Edit", write: "Write", grep: "Grep", find: "Glob", ls: "LS", list_mcp_resources: "ListMcpResourcesTool", list_mcp_resource_templates: "ListMcpResourcesTool", read_mcp_resource: "ReadMcpResourceTool" };

export default function gonogo(pi: any): void {
  let config: { hookUrl: string; mcpUrl: string; timeoutMs: number; servers: Record<string, unknown>; policy: any };
  try {
    config = JSON.parse(readFileSync(process.env.${PI_CONFIG_ENV} ?? "", "utf8"));
  } catch (error) {
    console.error("gonogo: no settings for this agent, so it runs without gonogo: " + String(error));
    return;
  }
  const token = process.env.GONOGO_TOKEN ?? "";
  for (const [name, server] of Object.entries(config.servers ?? {})) {
    try {
      pi.registerMcpServer(name, server);
    } catch (error) {
      console.error("gonogo: the MCP server " + name + " was not added: " + String(error));
    }
  }
  pi.registerMcpServer("${MCP_SERVER_NAME}", {
    url: config.mcpUrl,
    headers: { Authorization: "Bearer " + token },
    exposure: "direct",
    description: "gonogo: your team's messages, roster, tasks, votes and log",
  });

  // Propellant: each reply's usage waits here and goes with the next tool or end-of-turn hook
  const usage: Array<Record<string, unknown>> = [];
  const post = async (event: string, body: Record<string, unknown>): Promise<{ decision?: string; reason?: string }> => {
    if (usage.length > 0 && (event === "Stop" || event === "StopFailure" || event === "PostToolUse" || event === "PostToolUseFailure")) body = { ...body, usage: usage.splice(0, 100) };
    try {
      const response = await fetch(config.hookUrl + event, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      return response.ok ? await response.json() : {};
    } catch {
      return {};
    }
  };
  const tool = (name: unknown): string => (typeof name === "string" ? (TOOLS[name] ?? name) : String(name));
  const callOf = (name: string, input: any) => ({
    tool: name,
    command: typeof input?.command === "string" ? input.command : undefined,
    path: typeof input?.path === "string" ? input.path : undefined,
    url: typeof input?.url === "string" ? input.url : undefined,
  });
  const decide = (name: string, input: unknown): { permission: string; reason: string } => {
    try {
      return gateDecision(config.policy, callOf(name, input));
    } catch (error) {
      return { permission: "ask", reason: "the gate failed: " + String(error) };
    }
  };
  const short = (input: unknown): string => {
    const text = JSON.stringify(input ?? {});
    return text.length > 300 ? text.slice(0, 300) + "..." : text;
  };

  pi.on("message_end", async (event: any) => {
    const m = event?.message;
    const u = m?.usage;
    if (m?.role !== "assistant" || u === undefined || u === null) return;
    const id = typeof m.responseId === "string" && m.responseId !== "" ? m.responseId : String(m.timestamp ?? Date.now()) + ":" + String(m.model ?? "");
    usage.push({ id, at: typeof m.timestamp === "number" ? m.timestamp : Date.now(), model: typeof m.model === "string" ? m.model : null, i: u.input, cw: u.cacheWrite, o: u.output, cr: u.cacheRead });
    if (usage.length > 500) usage.splice(0, usage.length - 500);
  });

  // Plan quota: a claude.ai subscription's unified windows, from Anthropic's response headers (utilization 0 to 1, reset in epoch seconds),
  // sent as Claude Code's status line sends them, at most every 30 s. An API key's per-minute limits are not a plan and are not sent.
  let quotaAt = 0;
  pi.on("after_provider_response", async (event: any) => {
    const h = event?.headers ?? {};
    const window = (name: string): Record<string, number> | undefined => {
      const used = Number(h["anthropic-ratelimit-unified-" + name + "-utilization"]);
      const reset = Number(h["anthropic-ratelimit-unified-" + name + "-reset"]);
      return Number.isFinite(used) && Number.isFinite(reset) && reset > 0 ? { used_percentage: used * 100, resets_at: reset } : undefined;
    };
    const five = window("5h");
    const seven = window("7d");
    if ((five === undefined && seven === undefined) || Date.now() - quotaAt < 30_000) return;
    quotaAt = Date.now();
    void post("StatusLine", { rate_limits: { ...(five ? { five_hour: five } : {}), ...(seven ? { seven_day: seven } : {}) } });
  });

  // the hub holds a new agent in "starting" until a hook proves it is up
  pi.on("session_start", async (_event: any, ctx: any) => {
    await post("Notification", { notification_type: "session_start" });
    // no provider signed in and no key: every prompt would fail, so the Director is asked first (as gonogo does for a Claude Code without a login)
    let usable = 1;
    try {
      const found = await ctx?.modelRegistry?.getAvailable?.();
      if (Array.isArray(found)) usable = found.length;
    } catch {
      usable = 1;
    }
    if (usable === 0) await post("Notification", { notification_type: "agent_needs_input", message: "pi has no model it can use: sign in with /login in its console, or set a provider's key in its Clearance" });
  });
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    if (event.messageType !== "user") return;
    let session: string | undefined;
    try {
      session = ctx?.sessionManager?.getSessionId?.();
    } catch {
      session = undefined;
    }
    await post("UserPromptSubmit", { prompt: typeof event.prompt === "string" ? event.prompt : "", ...(typeof session === "string" ? { session_id: session } : {}) });
  });
  pi.on("tool_call", async (event: any, ctx: any) => {
    const name = tool(event.toolName);
    const answer = decide(name, event.input);
    await post("PreToolUse", { tool_name: name, tool_input: event.input });
    if (answer.permission === "deny") {
      await post("PostToolUseFailure", { tool_name: name, tool_input: event.input });
      return { block: true, reason: "gonogo: " + answer.reason };
    }
    if (answer.permission === "allow") return undefined;
    await post("PermissionRequest", { tool_name: name, tool_input: event.input });
    const yes = ctx?.hasUI === true ? await ctx.ui.confirm("gonogo: allow " + name + "?", short(event.input)) : false;
    await post("Notification", { notification_type: "permission_answered" });
    return yes ? undefined : { block: true, reason: "The Director did not allow this call (" + answer.reason + ")." };
  });
  pi.on("tool_result", async (event: any) => {
    await post(event.isError ? "PostToolUseFailure" : "PostToolUse", { tool_name: tool(event.toolName), tool_input: event.input });
  });
  // the end of a turn: mail the hub hands over continues the run, as a Stop block does in Claude Code
  pi.on("agent_before_settle", async (event: any) => {
    if (event.continue === true) return undefined;
    if (event.outcome !== "completed") {
      await post("StopFailure", { error: String(event.outcome) });
      return undefined;
    }
    const reply = await post("Stop", {});
    if (reply.decision !== "block" || typeof reply.reason !== "string" || reply.reason === "") return undefined;
    return {
      entries: [...(event.entries ?? []), { type: "custom_message", customType: "gonogo", content: reply.reason, display: true }],
      continue: true,
    };
  });
}
`;
