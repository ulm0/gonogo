// JANITOR, a built-in position (src/shared/positions.ts): it exists, does not clash with another, and its role keeps the rules it was made with.
import { describe, expect, it } from 'vitest';
import { POSITIONS, positionById } from '../src/shared/positions.js';
import { AGENT_NAME_PATTERN, ROLE_MAX_CHARS } from '../src/shared/protocol.js';

const janitor = positionById('janitor');

describe('the JANITOR position', () => {
  it('is in the roster with a call sign, a title, a summary and a colour', () => {
    expect(janitor).toMatchObject({ id: 'janitor', callSign: 'JANITOR', title: 'Janitor' });
    expect(janitor?.summary).toBeTruthy();
    expect(janitor?.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(POSITIONS.map((p) => p.id)).toContain('janitor');
  });

  it('clashes with no other position: not the id, the call sign, the colour or the summary, and the id is a valid agent name', () => {
    const others = POSITIONS.filter((p) => p.id !== 'janitor');
    expect(others.some((p) => p.id === 'janitor' || p.callSign === 'JANITOR' || p.color.toLowerCase() === janitor?.color.toLowerCase() || p.summary === janitor?.summary)).toBe(false);
    expect(new RegExp(AGENT_NAME_PATTERN).test('janitor')).toBe(true);
    expect(new Set(POSITIONS.map((p) => p.id)).size).toBe(POSITIONS.length);
    expect(new Set(POSITIONS.map((p) => p.callSign)).size).toBe(POSITIONS.length);
    expect(new Set(POSITIONS.map((p) => p.color.toLowerCase())).size).toBe(POSITIONS.length);
  });

  it('keeps the rules: inventory first; local, merged and clean without asking; the boss for anything remote or irreversible; a Mission Log entry', () => {
    const role = janitor?.role ?? '';
    expect(role).toMatch(/Inventory first, delete second/);
    expect(role).toMatch(/Local, safe without asking/);
    expect(role).toMatch(/merged into origin\/main AND which have no uncommitted or unpushed changes/);
    expect(role).toMatch(/git branch -d, never -D/);
    expect(role).toMatch(/Ask the boss first[^]*before anything remote or irreversible/);
    expect(role).toMatch(/Mission Log entry/);
    expect(role.length).toBeLessThanOrEqual(ROLE_MAX_CHARS);
  });

  it('removes without asking only what is regenerable and unused, and never a worktree gonogo made for an agent or one in use', () => {
    const role = janitor?.role ?? '';
    const safe = /Local, safe without asking([^]*?)\n/.exec(role)?.[1] ?? '';
    for (const word of ['regenerable output', 'dist', 'coverage', 'test temp dirs', 'git branch -d, never -D', 'nothing is using']) expect(safe, word).toContain(word);
    // scratch files are not in the safe list: they are ask-first
    expect(safe).not.toMatch(/scratch/);
    expect(/Ask the boss first([^]*?)\n/.exec(role)?.[1] ?? '').toContain('scratch files');
    expect(role).toMatch(/Never remove a worktree gonogo made for an agent/);
    expect(role).toMatch(/any agent's console or any process is in[^]*?\/proc\/\*\/cwd/);
  });

  it('has the never-list: main, tags, releases, open PRs, credentials, containers, a forced delete', () => {
    const role = janitor?.role ?? '';
    const never = /Never touch:([^]*?)\n/.exec(role)?.[1] ?? '';
    for (const word of ['main', 'tags', 'releases', "open PRs' branches", 'credential', 'containers', 'protected branches']) expect(never, word).toContain(word);
    expect(role).toMatch(/Never use --force on a branch delete/);
    expect(role).toMatch(/git clean -x/);
    expect(role).toMatch(/rm -rf on a path you did not list first/);
  });

  it('is generic: no path of this machine, no account, no wrapper of this room, no FLIGHT by name', () => {
    const role = janitor?.role ?? '';
    expect(role).not.toMatch(/\/DATA|\/home\/|ulm0|\/bin\/gh|FLIGHT/);
    expect(role).toContain('the projects folder');
    expect(role).toContain("the room's gh login");
  });
});
