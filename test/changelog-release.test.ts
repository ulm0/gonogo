import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VERSION, fold, fragmentFiles } from '../scripts/changelog-release.mjs';

const base = '# Changelog\n\nintro\n\n## Unreleased\n\n- **Old.** left.\n\n## 0.1.0 (2026-01-01)\n\nhi\n\n- **A.** a.\n';

describe('changelog:release fold', () => {
  it('puts the fragments and the old Unreleased bullets under the new heading and empties Unreleased', () => {
    const out: string = fold(base, ['- **B.** b.\n', '- **C.** c.\n'], '0.2.0', '2026-02-02', 'Intro.');
    expect(out).toBe('# Changelog\n\nintro\n\n## Unreleased\n\n## 0.2.0 (2026-02-02)\n\nIntro.\n\n- **Old.** left.\n- **B.** b.\n- **C.** c.\n\n## 0.1.0 (2026-01-01)\n\nhi\n\n- **A.** a.\n');
  });

  it('refuses to make an empty release', () => {
    expect(() => fold('# C\n\n## Unreleased\n\n## 0.1.0 (x)\n', [], '0.2.0', '2026-02-02', 'I')).toThrow(/nothing to release/);
  });
});

describe('fragmentFiles and VERSION', () => {
  it('lists the .md files except README.md, and throws on a folder (a branch name with a slash) or another file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'changes-'));
    writeFileSync(join(dir, 'README.md'), 'r');
    writeFileSync(join(dir, 'b.md'), '- b');
    writeFileSync(join(dir, 'a.md'), '- a');
    expect(fragmentFiles(dir)).toEqual(['a.md', 'b.md']);
    mkdirSync(join(dir, 'eecom'));
    expect(() => fragmentFiles(dir)).toThrow(/eecom/);
  });

  it('takes x.y.z and a pre-release, nothing else', () => {
    for (const v of ['0.8.0', '1.0.0-rc.1', '1.0.0-beta']) expect(VERSION.test(v)).toBe(true);
    for (const v of ['0.8', 'v0.8.0', '1.0.0-', '1.0.0 x']) expect(VERSION.test(v)).toBe(false);
  });
});
