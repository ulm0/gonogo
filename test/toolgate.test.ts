/** The tool gate (src/server/toolgate.ts): Claude Code's permission mode and rules, decided by gonogo for pi and opencode. */
import { describe, expect, it } from 'vitest';
import { GATE_SOURCE, gateDecision } from '../src/server/toolgate.js';
import type { GatePolicy } from '../src/server/toolgate.js';

const policy = (over: Partial<GatePolicy> = {}): GatePolicy => ({ mode: 'default', rules: {}, allowed: ['mcp__gonogo__send_message'], cwd: '/work/app', home: '/home/me', ...over });
const p = (pol: GatePolicy, call: Parameters<typeof gateDecision>[1]): string => gateDecision(pol, call).permission;

describe('the modes', () => {
  it('default: reads run, commands, edits, the web and other MCP tools ask, gonogo\'s own run', () => {
    const pol = policy();
    for (const tool of ['Read', 'Glob', 'Grep', 'LS', 'TodoWrite', 'Task']) expect(p(pol, { tool }), tool).toBe('allow');
    expect(p(pol, { tool: 'Bash', command: 'ls' })).toBe('ask');
    expect(p(pol, { tool: 'Edit', path: '/work/app/a.ts' })).toBe('ask');
    expect(p(pol, { tool: 'WebFetch', url: 'https://x.example' })).toBe('ask');
    expect(p(pol, { tool: 'mcp__files__read' })).toBe('ask');
    expect(p(pol, { tool: 'mcp__gonogo__send_message' })).toBe('allow');
    // a feature that is off leaves its tool out of the allowed ones: it asks, as in Claude Code
    expect(p(pol, { tool: 'mcp__gonogo__hire_agent' })).toBe('ask');
  });

  it('acceptEdits and auto accept edits inside the working folder only; bypass runs everything but a deny', () => {
    for (const mode of ['acceptEdits', 'auto'] as const) {
      expect(p(policy({ mode }), { tool: 'Write', path: '/work/app/src/a.ts' }), mode).toBe('allow');
      expect(p(policy({ mode }), { tool: 'Edit', path: 'src/a.ts' }), mode).toBe('allow');
      expect(p(policy({ mode }), { tool: 'Edit', path: '/etc/passwd' }), mode).toBe('ask');
      expect(p(policy({ mode }), { tool: 'Bash', command: 'ls' }), mode).toBe('ask');
    }
    expect(p(policy({ mode: 'bypassPermissions' }), { tool: 'Bash', command: 'rm -rf x' })).toBe('allow');
    expect(p(policy({ mode: 'bypassPermissions', rules: { deny: ['Bash(rm:*)'] } }), { tool: 'Bash', command: 'rm -rf x' })).toBe('deny');
  });
});

describe('the rules', () => {
  it('deny beats ask beats allow, and the first list with a match decides', () => {
    const pol = policy({ rules: { allow: ['Bash'], ask: ['Bash(git push:*)'], deny: ['Bash(git push --force:*)'] } });
    expect(p(pol, { tool: 'Bash', command: 'ls' })).toBe('allow');
    expect(p(pol, { tool: 'Bash', command: 'git push origin main' })).toBe('ask');
    expect(gateDecision(pol, { tool: 'Bash', command: 'git push --force origin' })).toStrictEqual({ permission: 'deny', reason: 'denied by the rule Bash(git push --force:*)' });
  });

  it('a Bash rule is exact, a prefix with :*, or a wildcard', () => {
    const pol = policy({ rules: { allow: ['Bash(npm test)', 'Bash(git:*)', 'Bash(npm run * --silent)'] } });
    expect(p(pol, { tool: 'Bash', command: 'npm test' })).toBe('allow');
    expect(p(pol, { tool: 'Bash', command: 'npm test --watch' })).toBe('ask');
    expect(p(pol, { tool: 'Bash', command: 'git status' })).toBe('allow');
    expect(p(pol, { tool: 'Bash', command: 'npm run build --silent' })).toBe('allow');
  });

  it('path rules: relative to the working folder, //absolute, ~/home, a bare name at any depth; Read covers the reading tools, Edit the editing ones', () => {
    const pol = policy({ rules: { deny: ['Read(./.env)', 'Read(//etc/**)', 'Edit(~/notes/*.md)', 'Read(secret.txt)'], allow: ['Edit(./src/**)'] } });
    expect(p(pol, { tool: 'Read', path: '/work/app/.env' })).toBe('deny');
    expect(p(pol, { tool: 'Grep', path: '/etc/ssh' })).toBe('deny');
    expect(p(pol, { tool: 'Read', path: '/etc/hosts' })).toBe('deny');
    expect(p(pol, { tool: 'Write', path: '/home/me/notes/a.md' })).toBe('deny');
    expect(p(pol, { tool: 'Read', path: '/work/app/deep/down/secret.txt' })).toBe('deny');
    expect(p(pol, { tool: 'Write', path: '/work/app/src/x/y.ts' })).toBe('allow');
    expect(p(pol, { tool: 'Write', path: '/work/app/test/y.ts' })).toBe('ask');
    expect(p(pol, { tool: 'Read', path: '/work/app/README.md' })).toBe('allow');
  });

  it('WebFetch by domain, MCP by server or tool, a plain name matches every call of that tool', () => {
    const pol = policy({ rules: { allow: ['WebFetch(domain:docs.example.com)', 'mcp__files', 'mcp__db__query'], deny: ['WebFetch(domain:*.bad.example)'] } });
    expect(p(pol, { tool: 'WebFetch', url: 'https://docs.example.com/a' })).toBe('allow');
    expect(p(pol, { tool: 'WebFetch', url: 'https://x.bad.example/a' })).toBe('deny');
    expect(p(pol, { tool: 'WebFetch', url: 'https://other.example' })).toBe('ask');
    expect(p(pol, { tool: 'mcp__files__read_file' })).toBe('allow');
    expect(p(pol, { tool: 'mcp__db__query' })).toBe('allow');
    expect(p(pol, { tool: 'mcp__db__drop' })).toBe('ask');
    expect(p(policy({ rules: { deny: ['Task'] } }), { tool: 'Task' })).toBe('deny');
  });
});

describe('the copy that runs in another process', () => {
  it('is self-contained: evaluated alone, it answers as the original', () => {
    const copy = new Function(`${GATE_SOURCE}\nreturn gateDecision;`)() as typeof gateDecision;
    const pol = policy({ rules: { deny: ['Read(./.env)'], allow: ['Bash(git:*)'] } });
    for (const call of [{ tool: 'Read', path: '.env' }, { tool: 'Bash', command: 'git log' }, { tool: 'Bash', command: 'ls' }, { tool: 'Edit', path: 'a' }]) {
      expect(copy(pol, call)).toStrictEqual(gateDecision(pol, call));
    }
  });
});

describe('an edit whose path is not known', () => {
  it('is asked under acceptEdits and auto (opencode\'s patch names its files in its text), and still allowed in bypass', () => {
    for (const mode of ['acceptEdits', 'auto'] as const) expect(gateDecision(policy({ mode }), { tool: 'Edit' }).permission, mode).toBe('ask');
    expect(gateDecision(policy({ mode: 'bypassPermissions' }), { tool: 'Edit' }).permission).toBe('allow');
  });
});
