// scripts/multivac-conformance.mjs: the reading of `multivac verify` and the fixture. The conformance itself installs multivac and runs in the workflow
// (.github/workflows/multivac-conformance.yml), not here: a unit test must not need the network.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAnchors } from '../src/server/anchorgrammar.js';
import { FIXTURE, MULTIVAC_VERSION, readVerify } from '../scripts/multivac-conformance.mjs';

describe('reading what multivac verify prints', () => {
  it('counts parse errors and the states, and the claims', () => {
    const ok = readVerify('1 claims · 1 anchored (100%)\n  read      brain: x\n\n  ok          7\n  enact     not answered\n\n0 blocking broken · exit 0\n');
    expect(ok).toEqual({ parseLines: [], parseErrors: 0, counts: { ok: 7 }, claims: 1 });
    const bad = readVerify('  parse     .multivac/invariants.md:10 — \\d is not POSIX ERE\n\n7 claims · 6 anchored\n  broken      1\n  ok          6\n\n0 blocking broken · exit 1 · 1 anchor parse errors\n');
    expect(bad.parseLines).toHaveLength(1);
    expect(bad.parseErrors).toBe(1);
    expect(bad.counts).toEqual({ broken: 1, ok: 6 });
  });
});

describe('the locked tool (scripts/multivac-tool)', () => {
  const read = (name: string): { dependencies?: Record<string, string>; packages?: Record<string, { version?: string; integrity?: string; resolved?: string }> } => JSON.parse(readFileSync(new URL(`../scripts/multivac-tool/${name}`, import.meta.url), 'utf8')) as never;

  it('names the pinned multivac exactly, in the package and in the lockfile, and every locked package has an integrity hash from the npm registry', () => {
    expect(read('package.json').dependencies).toEqual({ multivac: MULTIVAC_VERSION });
    const lock = read('package-lock.json').packages ?? {};
    expect(lock['node_modules/multivac']?.version).toBe(MULTIVAC_VERSION);
    const locked = Object.entries(lock).filter(([name]) => name !== '');
    expect(locked.length).toBeGreaterThanOrEqual(4); // multivac and the three it needs
    for (const [name, entry] of locked) {
      expect(entry.integrity, name).toMatch(/^sha512-/);
      expect(entry.resolved, name).toMatch(/^https:\/\/registry\.npmjs\.org\//);
    }
  });
});

describe('the fixture', () => {
  it('pins an exact multivac version and is a store gonogo\'s own grammar accepts, every leg of it', () => {
    expect(MULTIVAC_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    for (const [id, , legs] of FIXTURE.claims as Array<[string, string, string[]]>) {
      const { anchors, diagnostics } = parseAnchors(legs.map((l) => `<!-- @anchor ${id} ${l} -->`).join('\n'));
      expect(diagnostics, id).toEqual([]);
      expect(anchors, id).toHaveLength(legs.length);
    }
  });
});
