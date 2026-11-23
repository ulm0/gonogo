/** The words of the Project folder row of Flight Rules (src/client/projectFolderModel.ts) and its place in the Room group. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bossNeedsRestart, rowText, sourceText } from '../src/client/projectFolderModel.js';

describe('the project folder row', () => {
  it('says where the folder comes from, and marks the default in the line of the row', () => {
    expect(sourceText('default')).toBe('default: the folder gonogo started in');
    expect(sourceText('set')).toBe('set');
    expect(rowText({ dir: '/work/gonogo', source: 'default' })).toBe('/work/gonogo (default)');
    expect(rowText({ dir: '/home/me/project', source: 'set' })).toBe('/home/me/project');
  });

  it('offers to restart the boss only when it runs in another folder than the one in force', () => {
    expect(bossNeedsRestart({ dir: '/a', boss: { name: 'flight', dir: '/b' } })).toBe(true);
    expect(bossNeedsRestart({ dir: '/a', boss: { name: 'flight', dir: '/a' } })).toBe(false);
    expect(bossNeedsRestart({ dir: '/a', boss: null })).toBe(false);
  });

  it('is a row of the Room group, and Reset only comes when a folder is set', () => {
    const rules = readFileSync('src/client/Rules.tsx', 'utf8');
    expect(rules).toMatch(/<Row name="Project folder" now=\{folder\}><ProjectFolderBlock \/><\/Row>/);
    expect(rules.indexOf('Project folder')).toBeLessThan(rules.indexOf('<Group id="agents"'));
    const block = readFileSync('src/client/ProjectFolder.tsx', 'utf8');
    expect(block).toMatch(/view\.source === 'set' && \(\s*<button[^>]*onClick=\{\(\) => send\(null\)\}/);
    expect(block).toContain('Restart the boss now');
  });
});
