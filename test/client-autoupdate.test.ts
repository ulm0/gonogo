// The text box of the AUTO-UPDATE block: windows as the Director types them, and what is refused before it is sent.
import { describe, expect, it } from 'vitest';
import { parseWindows, windowsText } from '../src/client/AutoUpdateRules.js';

describe('the windows box', () => {
  it('reads up to four HH:MM-HH:MM separated by commas, and writes them the same way', () => {
    expect(parseWindows('02:00-05:00')).toEqual([{ from: '02:00', to: '05:00' }]);
    expect(parseWindows(' 02:00 - 05:00 , 13:00-14:30 ')).toEqual([{ from: '02:00', to: '05:00' }, { from: '13:00', to: '14:30' }]);
    expect(windowsText([{ from: '02:00', to: '05:00' }, { from: '23:00', to: '01:00' }])).toBe('02:00-05:00, 23:00-01:00');
    expect(parseWindows(windowsText([{ from: '23:00', to: '01:00' }]))).toEqual([{ from: '23:00', to: '01:00' }]);
  });
  it('refuses what the server would refuse', () => {
    for (const bad of ['', ' , ', '2:00-5:00', '24:00-01:00', '02:00-02:00', '02:00-05:00-06:00', '01:00-02:00,01:00-02:00,01:00-02:00,01:00-02:00,01:00-02:00']) expect(parseWindows(bad), bad).toBeNull();
  });
});
