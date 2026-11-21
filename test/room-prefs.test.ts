/** The room preferences: the three densities of the Layout popover, written as the per-panel modes they stand for. */
import { describe, expect, it } from 'vitest';
import { DENSITIES, densityOf, PANELS } from '../src/client/roomPrefs.js';

describe('densities', () => {
  it('each preset is recognised as itself', () => {
    for (const name of ['focus', 'standard', 'full'] as const) expect(densityOf({ ...DENSITIES[name] })).toBe(name);
  });

  it('a mix of modes is no preset', () => {
    expect(densityOf({ ...DENSITIES.standard, maxq: 'hidden' })).toBeNull();
  });

  it('Focus keeps only the clock, Full wall shows every panel as a box, Standard puts all in the strip', () => {
    expect(PANELS.filter((p) => DENSITIES.focus[p.id] !== 'hidden').map((p) => p.id)).toEqual(['mission']);
    expect(PANELS.every((p) => DENSITIES.full[p.id] === 'panel')).toBe(true);
    expect(PANELS.every((p) => DENSITIES.standard[p.id] === 'strip')).toBe(true);
  });
});
