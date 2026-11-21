/** The words of the version key of the top bar. */
import { describe, expect, it } from 'vitest';
import { versionLabel } from '../src/client/topbarModel.js';

describe('versionLabel', () => {
  it('says the install is current', () => {
    expect(versionLabel('0.11.1', null)).toEqual({ text: '0.11.1 ✓', name: '0.11.1 ✓: gonogo 0.11.1, up to date' });
  });

  it('keeps the words the key shows at the start of its name', () => {
    for (const newer of [null, '0.12.0']) {
      const { text, name } = versionLabel('0.11.1', newer);
      expect(name.startsWith(text)).toBe(true);
    }
  });

  it('says what is out, in the key and in its name', () => {
    expect(versionLabel('0.11.1', '0.12.0')).toEqual({ text: '0.11.1 → 0.12.0', name: '0.11.1 → 0.12.0: gonogo 0.11.1, 0.12.0 is out' });
  });
});
