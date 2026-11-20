import { describe, expect, it } from 'vitest';
import { fold } from '../scripts/changelog-release.mjs';

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
