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

/** The plugin is a directory of the agent's folder (opencode 2 loads a plugin as a package): its package.json and its index.js. */
export const OPENCODE_PLUGIN_DIR = 'gonogo-opencode';
export const OPENCODE_PLUGIN_FILE = `${OPENCODE_PLUGIN_DIR}/index.js`;
export const OPENCODE_PLUGIN_PACKAGE_FILE = `${OPENCODE_PLUGIN_DIR}/package.json`;
export const OPENCODE_CONFIG_FILE = 'opencode.json';
export const OPENCODE_SETTINGS_FILE = 'gonogo-opencode.json';
export const OPENCODE_ROLE_FILE = 'opencode-role.md';
export const OPENCODE_SETTINGS_ENV = 'GONOGO_OPENCODE_CONFIG';
/** opencode keeps its database and its logins under $XDG_DATA_HOME/opencode: each agent gets its own folder for them (its sessions never share a database with the owner's opencode or another agent), with the owner's logins linked in. */
export const OPENCODE_DATA_DIR = 'opencode-data';

/** What the plugin reads from GONOGO_OPENCODE_CONFIG. */
export interface OpencodeSettings {
  hookUrl: string;
  timeoutMs: number;
  /** MCP server names, longest first: opencode names a server's tool `<server>_<tool>`, the gate reads it as `mcp__<server>__<tool>`. */
  servers: string[];
  policy: GatePolicy;
  /** The room's subagent setting: with `limit`, at most that many `task` calls run at once (Claude Code's CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS). */
  subagentLimit: number | null;
  /** The agent's own folder (its memory, the handoff, its role): a question about a folder outside the project is answered yes for this one. */
  ownDir: string;
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
      plugin: [input.pluginPath],
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

export function buildOpencodeSettings(input: { hubUrl: string; name: string; servers: string[]; policy: GatePolicy; subagentLimit?: number | null; ownDir?: string }): OpencodeSettings {
  return { hookUrl: `${input.hubUrl}${HOOK_PATH_PREFIX}${input.name}/`, timeoutMs: HOOK_TIMEOUT_S * 1000, servers: input.servers, policy: input.policy, subagentLimit: input.subagentLimit ?? null, ownDir: input.ownDir ?? '' };
}

/**
 * The plugin, for opencode 2 (@opencode/cli): a directory with a package.json and an index.js, an ES module of plain JavaScript (node's own modules
 * only; opencode hands it the plugin context). Its default export is what Plugin.define returns (the object itself). Tool names reach the hub and the
 * gate as Claude Code's (shell is Bash, an MCP tool \`files_read\` is \`mcp__files__read\`).
 */
export const OPENCODE_PLUGIN_SOURCE = `// Written by gonogo at every start of this agent: an edit is lost at the next start.
import { readFileSync } from "node:fs";

${GATE_SOURCE}

const TOOLS = { shell: "Bash", read: "Read", edit: "Edit", write: "Write", patch: "Edit", glob: "Glob", grep: "Grep", list: "LS", webfetch: "WebFetch", websearch: "WebSearch", subagent: "Task", task: "Task", todowrite: "TodoWrite", skill: "Skill" };

const setup = async (ctx) => {
  let settings;
  try {
    settings = JSON.parse(readFileSync(process.env.${OPENCODE_SETTINGS_ENV} ?? "", "utf8"));
  } catch (error) {
    console.error("gonogo: no settings for this agent, so it runs without gonogo: " + String(error));
    return;
  }
  const token = process.env.GONOGO_TOKEN ?? "";
  // Propellant: the usage of each reply waits here (the session's running totals, as the difference since the last time) and goes with the next tool or end-of-turn hook
  const usage = [];
  const totals = new Map();
  let model = null;
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
  // what the gate reads of a call: the command, the path or the address, from the permission question (resources and metadata) or the tool's input
  const callOf = (tool, resources, meta) => {
    const m = meta && typeof meta === "object" ? meta : {};
    const first = Array.isArray(resources) && typeof resources[0] === "string" ? resources[0] : undefined;
    const path = typeof m.path === "string" ? m.path : typeof m.filePath === "string" ? m.filePath : tool === "Read" || tool === "Edit" || tool === "Write" || tool === "Glob" || tool === "Grep" ? first : undefined;
    return { tool, command: typeof m.command === "string" ? m.command : tool === "Bash" ? first : undefined, path, url: typeof m.url === "string" ? m.url : tool === "WebFetch" ? first : undefined };
  };
  const decide = (tool, resources, meta) => {
    try {
      return gateDecision(settings.policy, callOf(tool, resources, meta));
    } catch (error) {
      return { permission: "ask", reason: "the gate failed: " + String(error) };
    }
  };
  // the sessions of subagents (they have a parent): their prompts and their end are not the agent's turn
  const children = new Map();
  const isChild = async (id) => {
    if (typeof id !== "string") return false;
    if (children.has(id)) return children.get(id);
    let child = false;
    try {
      const session = await ctx.session.get({ sessionID: id });
      child = typeof session?.parentID === "string";
    } catch {
      child = false;
    }
    children.set(id, child);
    return child;
  };
  const running = new Set();

  void post("Notification", { notification_type: "session_start" });

  ctx.session.hook("model.request", (input) => {
    if (typeof input?.model?.id === "string") model = input.model.id;
  });
  ctx.session.hook("prompt", async (input) => {
    if (await isChild(input?.sessionID)) return;
    const text = typeof input?.prompt?.text === "string" ? input.prompt.text : "";
    await post("UserPromptSubmit", { prompt: text, session_id: input?.sessionID });
  });
  ctx.tool.hook("execute.before", async (input) => {
    const tool = toolName(input?.tool);
    const helper = (await isChild(input?.sessionID)) ? { agent_id: input.sessionID } : {};
    await post("PreToolUse", { tool_name: tool, tool_input: input?.input, ...helper });
    if (tool === "Task" && typeof input?.id === "string") {
      running.add(input.id);
      await post("SubagentStart", { agent_id: input.id, agent_type: typeof input?.input?.agent === "string" ? input.input.agent : "task" });
    }
  });
  ctx.tool.hook("execute.after", async (input) => {
    const tool = toolName(input?.tool);
    if (tool === "Task" && typeof input?.id === "string" && running.delete(input.id)) await post("SubagentStop", { agent_id: input.id });
    await post(input?.status === "error" ? "PostToolUseFailure" : "PostToolUse", { tool_name: tool, tool_input: input?.input, ...((await isChild(input?.sessionID)) ? { agent_id: input.sessionID } : {}) });
  });
  // the tool gate: allow and deny at once, ask is left to opencode's own question (the console, the page or the phone answer it)
  ctx.permission.hook("evaluate", async (input) => {
    // a folder outside the project: the agent's own (memory, handoff, role) is its own; any other is asked
    if (input?.action === "external_directory") {
      const dirs = Array.isArray(input.resources) ? input.resources : [];
      const own = settings.ownDir !== "" && dirs.length > 0 && dirs.every((d) => typeof d === "string" && (d.replace(/[*/]+$/, "") + "/").startsWith(settings.ownDir + "/"));
      input.effect = own ? "allow" : "ask";
      if (!own) await post("PermissionRequest", { tool_name: "external_directory", tool_input: { resources: dirs } });
      return;
    }
    const tool = toolName(input?.action);
    let answer = decide(tool, input?.resources, input?.metadata);
    if (tool === "Task" && answer.permission !== "deny" && settings.subagentLimit !== null && running.size >= settings.subagentLimit) {
      answer = { permission: "deny", reason: "the room allows " + settings.subagentLimit + " subagents at once; wait for one to finish" };
    }
    if (answer.permission === "allow") {
      input.effect = "allow";
    } else if (answer.permission === "deny") {
      input.effect = "deny";
      input.message = "gonogo: " + answer.reason;
      await post("PostToolUseFailure", { tool_name: tool, tool_input: input?.metadata ?? {} });
    } else {
      input.effect = "ask";
      await post("PermissionRequest", { tool_name: tool, tool_input: input?.metadata ?? { resources: input?.resources } });
    }
  });
  ctx.session.hook("experimental.idle", async (input) => {
    if (await isChild(input?.sessionID)) return;
    const answer = await post("Stop", { session_id: input?.sessionID });
    if (answer.decision !== "block" || typeof answer.reason !== "string" || answer.reason === "") return;
    // the mail goes into the same session and the turn goes on
    try {
      await ctx.session.synthetic({ sessionID: input.sessionID, text: answer.reason });
    } catch (error) {
      console.error("gonogo: could not hand the mail over: " + String(error));
    }
  });
  void (async () => {
    for await (const event of ctx.event.subscribe()) {
      const d = event?.data ?? {};
      if (event?.type === "session.usage.updated" && typeof d.sessionID === "string" && d.tokens) {
        const before = totals.get(d.sessionID) ?? { input: 0, output: 0, reasoning: 0, read: 0, write: 0 };
        const now = { input: d.tokens.input ?? 0, output: d.tokens.output ?? 0, reasoning: d.tokens.reasoning ?? 0, read: d.tokens.cache?.read ?? 0, write: d.tokens.cache?.write ?? 0 };
        totals.set(d.sessionID, now);
        const delta = { i: now.input - before.input, cw: now.write - before.write, o: now.output + now.reasoning - before.output - before.reasoning, cr: now.read - before.read };
        if (delta.i + delta.cw + delta.o + delta.cr > 0) usage.push({ id: d.sessionID + ":" + (event.id ?? usage.length), at: event.created ?? Date.now(), model, ...delta });
        if (usage.length > 500) usage.splice(0, usage.length - 500);
      } else if (event?.type === "session.execution.interrupted" && typeof d.sessionID === "string") {
        // the Director said no (or stopped the turn): the idle hook does not run after an interruption, so the turn ends here; the hub hands any mail over itself
        if (!(await isChild(d.sessionID))) await post("Stop", { session_id: d.sessionID });
      } else if (event?.type === "session.execution.failed" && typeof d.sessionID === "string") {
        if (!(await isChild(d.sessionID))) await post("StopFailure", { error: "session.execution.failed" });
      } else if (typeof event?.type === "string" && event.type.startsWith("permission.") && event.type.endsWith("replied")) {
        await post("Notification", { notification_type: "permission_answered" });
      }
    }
  })().catch((error) => console.error("gonogo: the event stream ended: " + String(error)));
};

export default { id: "gonogo", setup };
`;

/** The plugin directory opencode loads (the config's `plugin` names it): a package.json and the index.js above, in the agent's folder. */
export const OPENCODE_PLUGIN_PACKAGE = JSON.stringify({ name: 'gonogo-opencode', version: '0.0.0', private: true, type: 'module', main: 'index.js' }, null, 2);
