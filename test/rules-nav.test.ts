/** The index of the groups of Flight Rules: a key for each group, at the top, in the order of the groups below. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('src/client/Rules.tsx', 'utf8');

describe('the index of Flight Rules', () => {
  it('has one key for each group, in the order of the groups', () => {
    const index = [...source.matchAll(/\['([a-z]+)', '([^']+)'\]/g)].map((m) => m[1]);
    const groups = [...source.matchAll(/<Group id="([a-z]+)"/g)].map((m) => m[1]);
    expect(index).toEqual(groups);
    expect(groups).toHaveLength(7);
  });

  it('opens the group and scrolls to it, and says which one is open', () => {
    expect(source).toContain('setOpenGroup(id)');
    expect(source).toContain('scrollIntoView({ block:');
    expect(source).toContain("aria-current={openGroup === id ? 'true' : undefined}");
  });
});
