/**
 * Files that differ only by case. On macOS and Windows a file system does not tell `Missions.tsx` from `missions.ts`: an import of './Missions.js' (the bundler maps
 * .js to .ts and .tsx) found the helper instead of the component, and the build failed with MISSING_EXPORT, while Linux built it fine. This reads the tracked files, so
 * it fails on Linux for what would fail there.
 *
 * Two rules: (1) no two tracked paths are the same once lower-cased (a checkout on a case-insensitive disk cannot hold both), and (2) no two source modules of one
 * folder differ only by case once the extension is dropped (the case that broke the build). A stylesheet beside a component (`comms.css` and `Comms.tsx`) is fine: it is
 * imported with its extension, so it cannot be mistaken for the module.
 */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const root = new URL('..', import.meta.url).pathname;
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\0')
  .filter((f) => f !== '');
const MODULE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|vue)$/;

/** The groups of 2 or more that share a key, as lists of their paths. */
function groups(list: string[], key: (path: string) => string): string[][] {
  const by = new Map<string, string[]>();
  for (const f of list) by.set(key(f), [...(by.get(key(f)) ?? []), f]);
  return [...by.values()].filter((g) => g.length > 1);
}

describe('files that differ only by case', () => {
  it('reads the tracked files: the scan is not looking at nothing', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f === 'src/client/Missions.tsx')).toBe(true);
  });

  it('no two tracked paths are the same once lower-cased', () => {
    expect(groups(files, (f) => f.toLowerCase())).toEqual([]);
  });

  it('no two source modules of one folder differ only by case once the extension is dropped', () => {
    const modules = files.filter((f) => MODULE.test(f));
    expect(groups(modules, (f) => f.replace(MODULE, '').toLowerCase())).toEqual([]);
  });

  it('the check itself sees a collision: Missions.tsx beside missions.ts', () => {
    const fake = ['src/a/Missions.tsx', 'src/a/missions.ts', 'src/a/missions.css', 'src/b/missions.ts'];
    expect(groups(fake.filter((f) => MODULE.test(f)), (f) => f.replace(MODULE, '').toLowerCase())).toEqual([['src/a/Missions.tsx', 'src/a/missions.ts']]);
    expect(groups(['a/X.ts', 'a/x.ts'], (f) => f.toLowerCase())).toEqual([['a/X.ts', 'a/x.ts']]);
  });
});
