/**
 * Engine Bay, opencode (docs/engine-bay-spec.md): opencode 1.x loads a plugin named in its config, so gonogo writes one into the agent's own
 * folder and names it in the config it passes with OPENCODE_CONFIG. Like pi's extension (piextension.ts), it gives opencode what Claude Code
 * gets from its settings:
 *
 * - the hook events the hub reads: `chat.message` (UserPromptSubmit, with the session id), `tool.execute.before/after` (PreToolUse,
 *   PostToolUse(Failure)), `session.idle` (Stop), `session.error` (StopFailure), `permission.asked` (PermissionRequest);
 * - mail at the end of a turn: a Stop block is sent to the same session as the next prompt (`session.promptAsync`);
 * - the permission mode and the tool rules: the config asks for every tool (`"*": "ask"`), and the plugin answers each question with the
 *   tool gate (toolgate.ts): allow and deny at once, ask is left to the console, the page or the phone (Enter allows once, Escape rejects).
 *
 * The MCP servers, the role (`instructions`) and the permissions are in the config itself (`buildOpencodeConfig`).
 */
import { MCP_SERVER_NAME } from '../shared/protocol.js';
import type { McpServer } from '../shared/protocol.js';
import { HOOK_PATH_PREFIX, HOOK_TIMEOUT_S, MCP_PATH } from './constants.js';
import { GATE_SOURCE } from './toolgate.js';
import type { GatePolicy } from './toolgate.js';

export const OPENCODE_PLUGIN_FILE = 'gonogo-opencode.js';
export const OPENCODE_CONFIG_FILE = 'opencode.json';
export const OPENCODE_SETTINGS_FILE = 'gonogo-opencode.json';
export const OPENCODE_ROLE_FILE = 'opencode-role.md';
export const OPENCODE_SETTINGS_ENV = 'GONOGO_OPENCODE_CONFIG';

/** What the plugin reads from GONOGO_OPENCODE_CONFIG. */
export interface OpencodeSettings {
  hookUrl: string;
  timeoutMs: number;
  /** MCP server names, longest first: opencode names a server's tool `<server>_<tool>`, the gate reads it as `mcp__<server>__<tool>`. */
  servers: string[];
  policy: GatePolicy;
  /** The room's subagent setting: with `limit`, at most that many `task` calls run at once (Claude Code's CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS). */
  subagentLimit: number | null;
}

/** opencode's own `mcp` entries: `local` with the command as one list, `remote` with url and headers. SSE is not one of its transports. */
export function opencodeServers(servers: Record<string, McpServer> | undefined): { servers: Record<string, Record<string, unknown>>; skipped: string[] } {
  const out: Record<string, Record<string, unknown>> = {};
  const skipped: string[] = [];
  for (const [name, server] of Object.entries(servers ?? {})) {
    if (name === MCP_SERVER_NAME) continue;
    if (server.type === 'sse') {
      skipped.push(name);
      continue;
    }
    if (server.type === 'http' || (server.type === undefined && server.url !== undefined && server.command === undefined)) {
      if (server.url === undefined) continue;
      out[name] = { type: 'remote', url: server.url, ...(server.headers ? { headers: { ...server.headers } } : {}), enabled: true };
      continue;
    }
    if (server.command === undefined) continue;
    out[name] = { type: 'local', command: [server.command, ...(server.args ?? [])], ...(server.env ? { environment: { ...server.env } } : {}), enabled: true };
  }
  return { servers: out, skipped };
}

/** opencode's tools, each asked about, so that the gate answers every call whatever the owner's own config allows. */
const ASKED = ['*', 'bash', 'edit', 'write', 'patch', 'read', 'glob', 'grep', 'list', 'webfetch', 'websearch', 'codesearch', 'task', 'todowrite', 'todoread', 'skill', 'external_directory', 'doom_loop'];

export function buildOpencodeConfig(input: { hubUrl: string; pluginPath: string; rolePath: string; servers?: Record<string, McpServer>; skills?: readonly string[]; effort?: string; anthropicBaseUrl?: string }): { config: Record<string, unknown>; names: string[]; skipped: string[] } {
  const { servers, skipped } = opencodeServers(input.servers);
  const mcp = { ...servers, [MCP_SERVER_NAME]: { type: 'remote', url: `${input.hubUrl}${MCP_PATH}`, headers: { Authorization: 'Bearer {env:GONOGO_TOKEN}' }, enabled: true } };
  return {
    config: {
      $schema: 'https://opencode.ai/config.json',
      plugin: [`file://${input.pluginPath}`],
      instructions: [input.rolePath],
      mcp,
      permission: Object.fromEntries(ASKED.map((tool) => [tool, 'ask'])),
      // a skill folder holds its SKILL.md; opencode scans each path for **/SKILL.md, so the folder itself is the path
      ...(input.skills !== undefined && input.skills.length > 0 ? { skills: { paths: [...input.skills] } } : {}),
      // effort is the variant of opencode's two primary agents
      ...(input.effort ? { agent: { build: { variant: input.effort }, plan: { variant: input.effort } } } : {}),
      // Clean Room egress: the Anthropic provider talks to gonogo's proxy (its base URL ends in /v1) with the placeholder key
      ...(input.anthropicBaseUrl ? { provider: { anthropic: { options: { baseURL: `${input.anthropicBaseUrl}/v1`, apiKey: '{env:ANTHROPIC_API_KEY}' } } } } : {}),
    },
    names: Object.keys(mcp).sort((a, b) => b.length - a.length),
    skipped,
  };
}

export function buildOpencodeSettings(input: { hubUrl: string; name: string; servers: string[]; policy: GatePolicy; subagentLimit?: number | null }): OpencodeSettings {
  return { hookUrl: `${input.hubUrl}${HOOK_PATH_PREFIX}${input.name}/`, timeoutMs: HOOK_TIMEOUT_S * 1000, servers: input.servers, policy: input.policy, subagentLimit: input.subagentLimit ?? null };
}

/**
 * The plugin: an ES module of plain JavaScript (opencode runs it with Bun), node's own modules only. Tool names reach the hub and the gate as
 * Claude Code's (bash is Bash, an MCP tool `files_read` is `mcp__files__read`).
 */
export const OPENCODE_PLUGIN_SOURCE = `// Written by gonogo at every start of this agent: an edit is lost at the next start.
import { readFileSync } from "node:fs";

${GATE_SOURCE}

const TOOLS = { bash: "Bash", read: "Read", edit: "Edit", write: "Write", patch: "Edit", multiedit: "MultiEdit", glob: "Glob", grep: "Grep", list: "LS", webfetch: "WebFetch", websearch: "WebSearch", task: "Task", todowrite: "TodoWrite", todoread: "TodoRead", skill: "Skill" };

export const Gonogo = async ({ client }) => {
  let settings;
  try {
    settings = JSON.parse(readFileSync(process.env.${OPENCODE_SETTINGS_ENV} ?? "", "utf8"));
  } catch (error) {
    console.error("gonogo: no settings for this agent, so it runs without gonogo: " + String(error));
    return {};
  }
  const token = process.env.GONOGO_TOKEN ?? "";
  // Propellant: each finished reply's usage waits here and goes with the next tool or end-of-turn hook
  const usage = [];
  const counted = new Set();
  const post = async (event, body) => {
    if (usage.length > 0 && (event === "Stop" || event === "StopFailure" || event === "PostToolUse" || event === "PostToolUseFailure")) body = { ...body, usage: usage.splice(0, 100) };
    try {
      const response = await fetch(settings.hookUrl + event, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(settings.timeoutMs),
      });
      return response.ok ? await response.json() : {};
    } catch {
      return {};
    }
  };
  const toolName = (name) => {
    if (typeof name !== "string") return String(name);
    if (TOOLS[name] !== undefined) return TOOLS[name];
    for (const server of settings.servers) if (name.startsWith(server + "_")) return "mcp__" + server + "__" + name.slice(server.length + 1);
    return name;
  };
  const callOf = (tool, args) => {
    const a = args && typeof args === "object" ? args : {};
    const path = typeof a.filePath === "string" ? a.filePath : typeof a.path === "string" ? a.path : undefined;
    return { tool, command: typeof a.command === "string" ? a.command : undefined, path, url: typeof a.url === "string" ? a.url : undefined };
  };
  const decide = (tool, args) => {
    try {
      return gateDecision(settings.policy, callOf(tool, args));
    } catch (error) {
      return { permission: "ask", reason: "the gate failed: " + String(error) };
    }
  };
  // what the gate said about each call, for the permission question opencode asks after tool.execute.before
  const calls = new Map();
  // prompts the plugin sent itself (mail): not the Director's words
  const sent = new Set();
  // the sessions of subagents (a task call makes one, with a parentID): their prompts and their end are not the agent's turn
  const children = new Set();
  const running = new Map();
  const isChild = (id) => typeof id === "string" && children.has(id);

  void post("Notification", { notification_type: "session_start" });

  const reply = async (asked, response) => {
    try {
      await client.postSessionIdPermissionsPermissionId({ path: { id: asked.sessionID, permissionID: asked.id }, body: { response } });
    } catch (error) {
      console.error("gonogo: could not answer a permission question: " + String(error));
    }
  };

  return {
    "chat.message": async (input, output) => {
      if (isChild(input?.sessionID)) return;
      const text = (output?.parts ?? []).filter((part) => part?.type === "text" && typeof part.text === "string" && part.synthetic !== true).map((part) => part.text).join("\\n");
      if (sent.delete(text)) return;
      await post("UserPromptSubmit", { prompt: text, session_id: input?.sessionID });
    },
    "tool.execute.before": async (input, output) => {
      const tool = toolName(input?.tool);
      let answer = decide(tool, output?.args);
      if (tool === "Task" && answer.permission !== "deny" && settings.subagentLimit !== null && running.size >= settings.subagentLimit) {
        answer = { permission: "deny", reason: "the room allows " + settings.subagentLimit + " subagents at once; wait for one to finish" };
      }
      const helper = isChild(input?.sessionID) ? { agent_id: input.sessionID } : {};
      if (typeof input?.callID === "string") {
        calls.set(input.callID, { tool, args: output?.args, answer });
        if (calls.size > 200) calls.delete(calls.keys().next().value);
      }
      await post("PreToolUse", { tool_name: tool, tool_input: output?.args, ...helper });
      if (answer.permission === "deny") {
        await post("PostToolUseFailure", { tool_name: tool, tool_input: output?.args, ...helper });
        throw new Error("gonogo: " + answer.reason);
      }
      if (tool === "Task" && typeof input?.callID === "string") {
        running.set(input.callID, true);
        await post("SubagentStart", { agent_id: input.callID, agent_type: typeof output?.args?.subagent_type === "string" ? output.args.subagent_type : "task" });
      }
    },
    "tool.execute.after": async (input, output) => {
      if (typeof input?.callID === "string") calls.delete(input.callID);
      const tool = toolName(input?.tool);
      if (tool === "Task" && typeof input?.callID === "string" && running.delete(input.callID)) await post("SubagentStop", { agent_id: input.callID });
      const failed = output?.metadata?.error !== undefined && output?.metadata?.error !== null && output?.metadata?.error !== false;
      await post(failed ? "PostToolUseFailure" : "PostToolUse", { tool_name: tool, tool_input: input?.args, ...(isChild(input?.sessionID) ? { agent_id: input.sessionID } : {}) });
    },
    event: async ({ event }) => {
      const p = event?.properties ?? {};
      switch (event?.type) {
        case "session.created": {
          if (typeof p.info?.parentID === "string" && typeof p.info?.id === "string") children.add(p.info.id);
          return;
        }
        case "message.updated": {
          const info = p.info;
          const t = info?.tokens;
          if (info?.role !== "assistant" || typeof info.id !== "string" || !info.time?.completed || t === undefined || counted.has(info.id)) return;
          counted.add(info.id);
          if (counted.size > 2000) counted.delete(counted.values().next().value);
          usage.push({ id: info.id, at: info.time.completed, model: typeof info.modelID === "string" ? info.modelID : null, i: t.input, cw: t.cache?.write, o: (t.output ?? 0) + (t.reasoning ?? 0), cr: t.cache?.read });
          if (usage.length > 500) usage.splice(0, usage.length - 500);
          return;
        }
        case "permission.asked": {
          const known = typeof p.tool?.callID === "string" ? calls.get(p.tool.callID) : undefined;
          const tool = known?.tool ?? toolName(p.permission);
          const answer = known?.answer ?? (p.permission === "external_directory" || p.permission === "doom_loop" ? { permission: "ask" } : decide(tool, p.metadata));
          if (answer.permission === "allow") return reply(p, "once");
          if (answer.permission === "deny") return reply(p, "reject");
          await post("PermissionRequest", { tool_name: tool, tool_input: known?.args ?? p.metadata ?? {} });
          return;
        }
        case "permission.replied":
          await post("Notification", { notification_type: "permission_answered" });
          return;
        case "session.error":
          if (isChild(p.sessionID)) return;
          await post("StopFailure", { error: "session.error" });
          return;
        case "session.idle": {
          if (typeof p.sessionID !== "string" || isChild(p.sessionID)) return;
          const answer = await post("Stop", { session_id: p.sessionID });
          if (answer.decision !== "block" || typeof answer.reason !== "string" || answer.reason === "") return;
          sent.add(answer.reason);
          try {
            await client.session.promptAsync({ path: { id: p.sessionID }, body: { parts: [{ type: "text", text: answer.reason }] } });
          } catch (error) {
            sent.delete(answer.reason);
            console.error("gonogo: could not hand the mail over: " + String(error));
          }
          return;
        }
      }
    },
  };
};
`;
