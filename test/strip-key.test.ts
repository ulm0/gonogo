// The update strip and the version key's Update key: one rule says whether the strip is drawn (src/client/selfupdate.ts stripHidden).
import { describe, expect, it } from 'vitest';
import { stripHidden } from '../src/client/selfupdate.js';
import { setRolloutDismissed } from '../src/client/newer.js';
import type { RolloutView, UpdateView } from '../src/shared/protocol.js';

const update = (patch: Partial<UpdateView> = {}): UpdateView => ({ state: 'done', version: '0.13.1', note: 'Updated to 0.13.1.', tail: [], rollback: null, undo: true, ...patch });
const rollout = (patch: Partial<RolloutView> = {}): RolloutView => ({ enabled: true, current: '0.13.1', latest: '0.14.0', checkedAt: 1, newer: true, command: 'x', canUpdate: true, selfUpdate: true, update: update(), ...patch });

describe('whether the update strip is drawn', () => {
  it('is drawn on 0.13.1 with 0.14.0 out after an update to 0.13.1 (done, UNDO offered), and the version key does not point to it when it is dismissed', () => {
    expect(stripHidden(rollout(), null)).toBe(false);
    expect(stripHidden(rollout(), '')).toBe(false);
    expect(stripHidden(rollout(), '0.13.1')).toBe(false); // an old dismissal of another version
    expect(stripHidden(rollout(), '0.14.0')).toBe(true); // dismissed for this one: the version key has the Update key itself
  });

  it('is hidden with nothing to show, drawn for a result alone, and always drawn while installing', () => {
    expect(stripHidden(null, null)).toBe(true);
    expect(stripHidden(rollout({ newer: false, latest: '0.13.1', update: undefined }), null)).toBe(true);
    expect(stripHidden(rollout({ newer: false, latest: '0.13.1' }), null)).toBe(false); // the result of the last update
    expect(stripHidden(rollout({ update: update({ state: 'running' }) }), '0.14.0')).toBe(false);
  });
});

describe('the dismissal', () => {
  it('is kept by this page even when the browser refuses to store it, so the strip and the key agree', () => {
    const throws = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => {} };
    const before = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { value: throws, configurable: true });
    try {
      expect(() => setRolloutDismissed('0.14.0')).not.toThrow();
    } finally {
      if (before) Object.defineProperty(globalThis, 'localStorage', before);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
      setRolloutDismissed('');
    }
  });
});
