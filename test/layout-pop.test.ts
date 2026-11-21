/** The Layout popover: the three densities it offers are the three presets of the room preferences, and the grid editor is one key in it. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DENSITIES } from '../src/client/roomPrefs.js';

const source = readFileSync('src/client/LayoutPop.tsx', 'utf8');

describe('the Layout popover', () => {
  it('offers every density the preferences have, with a name and a line', () => {
    for (const name of Object.keys(DENSITIES)) expect(source, name).toMatch(new RegExp(`\\b${name}: \\{ name: '`));
  });

  it('has the grid editor as a key', () => {
    expect(source).toContain('<EditRoomKey />');
  });
});
