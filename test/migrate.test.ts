import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '../src/shared/protocol.js';
import { openHome } from '../src/server/home.js';
import { FORMATS, migrateHome } from '../src/server/migrate.js';
import type { Format } from '../src/server/migrate.js';

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/migrate/${name}`, import.meta.url));
const read = (path: string): string => readFileSync(path, 'utf8');
const mode = (path: string): number => statSync(path).mode & 0o777;

/** The widgets format of the fixtures: version 1 called its list `items`; version 2 renamed it; version 3 added a unit. */
const widgets: Format = {
  file: 'widgets.json',
  steps: [
    ({ items, ...rest }) => ({ ...rest, widgets: items }),
    (data) => ({ ...data, widgets: (data.widgets as Array<Record<string, unknown>>).map((w) => ({ ...w, unit: 'cm' })) }),
  ],
};

let home: string;
let infos: string[];
const log: Logger = {
  debug: () => undefined,
  info: (message) => void infos.push(message),
  warn: () => undefined,
  error: () => undefined,
  child: () => log,
};
const names = (): string[] => readdirSync(home).sort();

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gonogo-migrate-'));
  infos = [];
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('migrateHome', () => {
  it('upgrades an old file one version at a time, keeps a private copy of the original, and says so', () => {
    copyFileSync(fixture('widgets-v1.json'), join(home, 'widgets.json'));
    migrateHome(home, log, [widgets]);
    expect(JSON.parse(read(join(home, 'widgets.json')))).toEqual(JSON.parse(read(fixture('widgets-v3.json'))));
    expect(read(join(home, 'widgets.json.bak-v1'))).toBe(read(fixture('widgets-v1.json')));
    expect(mode(join(home, 'widgets.json'))).toBe(0o600);
    expect(mode(join(home, 'widgets.json.bak-v1'))).toBe(0o600);
    expect(names()).toEqual(['widgets.json', 'widgets.json.bak-v1']);
    expect(infos).toHaveLength(1);
    expect(infos[0]).toMatch(/widgets\.json was upgraded from format version 1 to 3; the old file is kept as .+widgets\.json\.bak-v1$/);
  });

  it('starts from the version the file has: a version 2 file runs only the last step, and its copy is called v2', () => {
    writeFileSync(join(home, 'widgets.json'), JSON.stringify({ version: 2, widgets: [{ name: 'a', size: 3 }] }));
    migrateHome(home, log, [widgets]);
    expect(JSON.parse(read(join(home, 'widgets.json')))).toEqual({ version: 3, widgets: [{ name: 'a', size: 3, unit: 'cm' }] });
    expect(names()).toEqual(['widgets.json', 'widgets.json.bak-v2']);
  });

  it('leaves a current file alone, and a second run changes nothing', () => {
    copyFileSync(fixture('widgets-v3.json'), join(home, 'widgets.json'));
    migrateHome(home, log, [widgets]);
    expect(read(join(home, 'widgets.json'))).toBe(read(fixture('widgets-v3.json')));
    expect(names()).toEqual(['widgets.json']);
    copyFileSync(fixture('widgets-v1.json'), join(home, 'widgets.json'));
    migrateHome(home, log, [widgets]);
    const done = read(join(home, 'widgets.json'));
    infos = [];
    migrateHome(home, log, [widgets]);
    expect(read(join(home, 'widgets.json'))).toBe(done);
    expect(names()).toEqual(['widgets.json', 'widgets.json.bak-v1']);
    expect(infos).toEqual([]);
  });

  it('refuses a version newer than it knows, names the file and both versions, and changes nothing', () => {
    copyFileSync(fixture('widgets-v9.json'), join(home, 'widgets.json'));
    expect(() => migrateHome(home, log, [widgets])).toThrowError(
      new RegExp(`^${join(home, 'widgets.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} was saved by a newer gonogo \\(format version 9; this one reads up to 3\\)\\. Start the gonogo that saved it, or move the file away`),
    );
    expect(read(join(home, 'widgets.json'))).toBe(read(fixture('widgets-v9.json')));
    expect(names()).toEqual(['widgets.json']);
  });

  it('leaves a missing file, a file that is not JSON, and a file without a usable version to the store that owns it', () => {
    writeFileSync(join(home, 'a.json'), '{ not json');
    writeFileSync(join(home, 'b.json'), JSON.stringify({ items: [] }));
    writeFileSync(join(home, 'c.json'), JSON.stringify({ version: '1' }));
    writeFileSync(join(home, 'd.json'), JSON.stringify({ version: 1.5 }));
    writeFileSync(join(home, 'e.json'), JSON.stringify({ version: 0 }));
    writeFileSync(join(home, 'f.json'), JSON.stringify([1, 2]));
    const before = names().map((n) => read(join(home, n)));
    const formats = ['missing.json', 'a.json', 'b.json', 'c.json', 'd.json', 'e.json', 'f.json'].map((file) => ({ ...widgets, file }));
    migrateHome(home, log, formats);
    expect(names().map((n) => read(join(home, n)))).toEqual(before);
    expect(names()).toHaveLength(6);
  });

  it('reads a file without a version as version 1 only for a format gonogo wrote without one (propellant.json)', () => {
    const bare = JSON.stringify({ items: [{ name: 'a', size: 3 }] });
    writeFileSync(join(home, 'widgets.json'), bare);
    writeFileSync(join(home, 'other.json'), bare);
    migrateHome(home, log, [{ ...widgets, unversionedIs1: true }, { ...widgets, file: 'other.json' }]);
    expect(JSON.parse(read(join(home, 'widgets.json')))).toEqual({ version: 3, widgets: [{ name: 'a', size: 3, unit: 'cm' }] });
    expect(read(join(home, 'widgets.json.bak-v1'))).toBe(bare);
    expect(read(join(home, 'other.json'))).toBe(bare);
    expect(FORMATS.filter((f) => f.unversionedIs1).map((f) => f.file)).toEqual(['propellant.json']);
  });

  it('keeps the file as it was, and its copy, when a step fails', () => {
    writeFileSync(join(home, 'widgets.json'), JSON.stringify({ version: 1 }));
    const broken: Format = { file: 'widgets.json', steps: [() => { throw new Error('no items'); }] };
    expect(() => migrateHome(home, log, [broken])).toThrowError(/widgets\.json: the step from version 1 to 2 failed \(no items\); the file was not changed, and a copy is .+widgets\.json\.bak-v1$/);
    expect(read(join(home, 'widgets.json'))).toBe('{"version":1}');
    expect(read(join(home, 'widgets.json.bak-v1'))).toBe('{"version":1}');
    expect(names()).toEqual(['widgets.json', 'widgets.json.bak-v1']);
  });

  it('does not replace a copy that is already there, and still upgrades', () => {
    writeFileSync(join(home, 'widgets.json'), JSON.stringify({ version: 2, widgets: [] }));
    writeFileSync(join(home, 'widgets.json.bak-v2'), 'the first copy');
    migrateHome(home, log, [widgets]);
    expect(read(join(home, 'widgets.json.bak-v2'))).toBe('the first copy');
    expect(JSON.parse(read(join(home, 'widgets.json')))).toEqual({ version: 3, widgets: [] });
  });

  it('writes nothing when the copy cannot be made', () => {
    // root writes anywhere, so the test only means something for another user
    if (process.getuid?.() === 0) return;
    writeFileSync(join(home, 'widgets.json'), '{"version":1,"items":[]}');
    chmodSync(home, 0o500);
    try {
      expect(() => migrateHome(home, log, [widgets])).toThrowError(/cannot copy .+widgets\.json to .+widgets\.json\.bak-v1: .+; nothing was changed/);
    } finally {
      chmodSync(home, 0o700);
    }
    expect(names()).toEqual(['widgets.json']);
    expect(read(join(home, 'widgets.json'))).toBe('{"version":1,"items":[]}');
  });

  it('upgrades every .json file of a folder, and skips the copies and other files', () => {
    const folder = join(home, 'shelf');
    mkdirSync(folder);
    copyFileSync(fixture('widgets-v1.json'), join(folder, 'one.json'));
    copyFileSync(fixture('widgets-v1.json'), join(folder, 'two.json'));
    writeFileSync(join(folder, 'note.txt'), 'x');
    writeFileSync(join(folder, 'old.json.bak-v1'), JSON.stringify({ version: 1, items: [] }));
    migrateHome(home, log, [{ ...widgets, file: 'shelf/*.json' }]);
    for (const name of ['one.json', 'two.json']) expect(JSON.parse(read(join(folder, name)))).toEqual(JSON.parse(read(fixture('widgets-v3.json'))));
    expect(readdirSync(folder).sort()).toEqual(['note.txt', 'old.json.bak-v1', 'one.json', 'one.json.bak-v1', 'two.json', 'two.json.bak-v1']);
    migrateHome(home, log, [{ ...widgets, file: 'nothing/*.json' }]);
  });
});

describe('the formats of this gonogo', () => {
  it('names every versioned file of the home, each at version 1 (no step yet)', () => {
    expect(FORMATS.map((f) => f.file).sort()).toEqual(
      ['agents.json', 'docking.json', 'downlink.json', 'keys.json', 'liveries/*.json', 'livery.json', 'prices.json', 'propellant.json', 'quota.json', 'relay.json', 'rollout.json', 'schedules.json', 'station.json', 'tasks.json', 'uplinks.json'].sort(),
    );
    expect(FORMATS.every((f) => f.steps.length === 0)).toBe(true);
  });

  it('refuses a file of a newer version for each of them, before the store reads it', () => {
    for (const { file } of FORMATS) {
      const dir = mkdtempSync(join(tmpdir(), 'gonogo-migrate-real-'));
      try {
        const path = file.endsWith('/*.json') ? join(dir, file.replace('*', 'x')) : join(dir, file);
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, JSON.stringify({ version: 2 }));
        expect(() => migrateHome(dir, log)).toThrowError(/was saved by a newer gonogo \(format version 2; this one reads up to 1\)/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('stops openHome with that message, releases the lock, and opens again once the file is gone', async () => {
    writeFileSync(join(home, 'agents.json'), JSON.stringify({ version: 2, agents: [] }));
    expect(() => openHome(home)).toThrowError(/agents\.json was saved by a newer gonogo \(format version 2/);
    expect(names()).not.toContain('server.lock');
    expect(read(join(home, 'agents.json'))).toBe(JSON.stringify({ version: 2, agents: [] }));
    rmSync(join(home, 'agents.json'));
    const opened = openHome(home);
    expect(opened.loadRoster()).toEqual({ version: 1, agents: [] });
    await opened.close();
  });

  it('opens a home of version 1 files as it always did, and writes no copy', async () => {
    writeFileSync(join(home, 'agents.json'), JSON.stringify({ version: 1, agents: [] }));
    writeFileSync(join(home, 'tasks.json'), JSON.stringify({ version: 1, seq: 0, tasks: [] }));
    const opened = openHome(home);
    await opened.close();
    expect(names().filter((n) => n.includes('.bak-'))).toEqual([]);
  });
});
