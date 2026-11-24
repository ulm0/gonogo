/**
 * The tool gate (docs/features/permissions.md, "Other engines"): what Claude Code does with its `--permission-mode` and the `permissions`
 * of its settings, done by gonogo for an engine whose own extension or plugin can stop a tool call (pi, opencode). The launcher writes a
 * policy into the agent's own folder; the extension asks `gateDecision` before every tool call, and the answer is Claude Code's: `allow`
 * runs it, `ask` opens the engine's dialog (the console, the page's GO / NO-GO and the phone answer it), `deny` refuses it with the reason.
 *
 * `gateDecision` runs inside pi and opencode as well as here: it is copied into their extension source with `Function.prototype.toString`,
 * so it uses nothing from outside its own body (no import, no closure, no TypeScript-only syntax at run time).
 */
import type { PermissionMode, PermissionRules } from '../shared/protocol.js';

export interface GatePolicy {
  mode: PermissionMode;
  /** The agent's effective rules (its own, else the room's, the room's deny always), with gonogo's own rules added (memory file, subagents). */
  rules: PermissionRules;
  /** gonogo's own tools that run without a question (`mcp__gonogo__send_message`, ...): the ones of features that are on. */
  allowed: string[];
  /** The agent's working folder: a relative path pattern starts there, and acceptEdits accepts edits inside it. */
  cwd: string;
  home: string;
}

/** One tool call, in Claude Code's names: `Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`, `LS`, `WebFetch`, `Task`, `mcp__<server>__<tool>`. */
export interface GateCall {
  tool: string;
  command?: string;
  path?: string;
  url?: string;
}

export interface GateAnswer {
  permission: 'allow' | 'ask' | 'deny';
  /** The rule that decided, or the mode. */
  reason: string;
}

export function gateDecision(policy: GatePolicy, call: GateCall): GateAnswer {
  const READS = ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead'];
  const EDITS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
  // meta tools: pi's codemode and tool_search run other tools, and each of those is asked about on its own
  const QUIET = ['TodoWrite', 'TodoRead', 'Task', 'Agent', 'ExitPlanMode', 'Skill', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'codemode', 'tool_search'];
  const escape = (text: string): string => text.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  /** `*` is any text, `**` too across folders, for a command; a path's `*` stays inside one folder. */
  const globRe = (glob: string, path: boolean): RegExp => {
    let out = '';
    for (let i = 0; i < glob.length; i += 1) {
      const c = glob[i] as string;
      if (c === '*') {
        if (glob[i + 1] === '*') {
          i += 1;
          if (path && glob[i + 1] === '/') {
            i += 1;
            out += '(?:.*/)?';
          } else out += '.*';
        } else out += path ? '[^/]*' : '.*';
      } else if (c === '?') out += path ? '[^/]' : '.';
      else out += escape(c);
    }
    return new RegExp(`^${out}$`);
  };
  const join = (dir: string, rest: string): string => `${dir.replace(/\/+$/, '')}/${rest.replace(/^\.?\//, '')}`;
  /** Claude Code's path rules: `//abs`, `~/home`, `/` and `./` and a bare pattern from the working folder; a pattern with no `/` matches a name at any depth. */
  const pathMatches = (pattern: string, path: string): boolean => {
    let absolute: string;
    if (pattern.startsWith('//')) absolute = pattern.slice(1);
    else if (pattern.startsWith('~/')) absolute = join(policy.home, pattern.slice(2));
    else if (!pattern.includes('/')) absolute = join(policy.cwd, `**/${pattern}`);
    else absolute = join(policy.cwd, pattern);
    const target = path.startsWith('/') ? path : join(policy.cwd, path);
    const re = globRe(absolute, true);
    // a folder pattern covers what is inside it
    return re.test(target) || globRe(`${absolute.replace(/\/+$/, '')}/**`, true).test(target);
  };
  const mcpParts = (name: string): [string, string] | null => {
    const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
    return m === null ? null : [m[1] as string, m[2] as string];
  };
  const matches = (rule: string): boolean => {
    const open = rule.indexOf('(');
    const name = open === -1 ? rule : rule.slice(0, open);
    const pattern = open === -1 ? null : rule.slice(open + 1, rule.length - 1);
    if (name.startsWith('mcp__')) {
      if (pattern !== null || !call.tool.startsWith('mcp__')) return false;
      if (name === call.tool) return true;
      const ours = mcpParts(call.tool);
      const server = name.replace(/__\*$/, '').replace(/^mcp__/, '');
      return ours !== null && !server.includes('__') && ours[0] === server;
    }
    const family = READS.includes(name) ? READS : EDITS.includes(name) ? EDITS : [name];
    if (pattern === null) return name === call.tool;
    if (!family.includes(call.tool)) return false;
    if (name === 'Bash') {
      if (call.command === undefined) return false;
      const command = call.command.trim();
      // `git:*` is Claude Code's prefix rule: every command that starts with `git`
      if (pattern.endsWith(':*')) return command.startsWith(pattern.slice(0, -2));
      return pattern.includes('*') ? globRe(pattern, false).test(command) : command === pattern;
    }
    if (name === 'WebFetch') {
      if (call.url === undefined || !pattern.startsWith('domain:')) return false;
      try {
        const host = new URL(call.url).hostname;
        const want = pattern.slice('domain:'.length);
        return want.startsWith('*.') ? host.endsWith(want.slice(1)) : host === want;
      } catch {
        return false;
      }
    }
    if (call.path === undefined) return false;
    return pathMatches(pattern, call.path);
  };
  const first = (list: readonly string[] | undefined): string | undefined => (list ?? []).find(matches);
  const denied = first(policy.rules.deny);
  if (denied !== undefined) return { permission: 'deny', reason: `denied by the rule ${denied}` };
  const asked = first(policy.rules.ask);
  if (asked !== undefined) return { permission: 'ask', reason: `the rule ${asked} asks` };
  if (policy.allowed.includes(call.tool)) return { permission: 'allow', reason: 'a gonogo tool' };
  const allowed = first(policy.rules.allow);
  if (allowed !== undefined) return { permission: 'allow', reason: `allowed by the rule ${allowed}` };
  if (policy.mode === 'bypassPermissions') return { permission: 'allow', reason: 'bypass mode' };
  if (READS.includes(call.tool) || QUIET.includes(call.tool)) return { permission: 'allow', reason: 'reading' };
  if (EDITS.includes(call.tool) && (policy.mode === 'acceptEdits' || policy.mode === 'auto')) {
    // an edit whose path is not known (opencode's patch names its files in the patch text) is not known to be inside: it is asked
    const inside = call.path !== undefined && pathMatches('**', call.path);
    if (inside) return { permission: 'allow', reason: `${policy.mode} accepts edits in the working folder` };
  }
  return { permission: 'ask', reason: `${policy.mode} mode asks` };
}

/**
 * `const gateDecision = ...` for an extension that runs it in another process. A build that keeps function names wraps inner functions in
 * `__name(...)`: the wrapper gives the copy its own, so it needs nothing from the module it came from.
 */
export const GATE_SOURCE = `const gateDecision = ((__name) => (${gateDecision.toString()}))((f) => f);`;
