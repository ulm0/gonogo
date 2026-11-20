// Moving room main of an old home into rooms/main (src/server/mainmigrate.ts): the plan, the pre-checks, the move with its journal, a crash in the middle, undo.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lockHooks } from '../src/server/home.js';
import { MIGRATION_FILE, migrate, planMigration, readMigration, resumeMigration, startupMigration, writeMigration } from '../src/server/mainmigrate.js';
import { loadRooms, mainLayout, MAIN_ROOM, recordedMainHome, ROOMS_FILE, roomHome, RoomsError, setMainHome } from '../src/server/rooms.js';

let root: string;
let servers: net.Server[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gng-migrate-'));
});
afterEach(async () => {
  for (const s of servers) await new Promise((r) => s.close(() => r(null)));
  servers = [];
  rmSync(root, { recursive: true, force: true });
});

const put = (path: string, text = 'x'): void => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};
/** An old home: main's files at the root next to the supervisor's own. */
function oldHome(agents: unknown[] = [{ name: 'ana', dir: '/projects/app', role: 'r', mode: 'default', sessionId: '1', desk: 0, boss: true, createdAt: 1 }]): void {
  put(join(root, 'agents.json'), JSON.stringify({ version: 1, agents }));
  put(join(root, 'messages.jsonl'), '{"a":1}\n');
  put(join(root, 'keys.json'), '{}');
  put(join(root, 'mission-log', 'l1.json'), '{}');
  put(join(root, 'black-box', 'x', 'y.txt'), 'y');
  put(join(root, 'agents', 'ana', 'settings.json'), '{}');
  put(join(root, 'gh', 'hosts.yml'), 'h');
  put(join(root, 'run', 'port'), '40000\n');
  put(join(root, 'run', 'update.json'), '{}');
  put(join(root, 'server.lock'), '99999999'); // a leftover: no process holds it, and it is old (a fresh one is waited on, see lockOwnerAlive)
  utimesSync(join(root, 'server.lock'), new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
  // the supervisor's own, and something that is nobody's
  put(join(root, 'auth.json'), '{}');
  put(join(root, 'token'), 't');
  put(join(root, 'push.json'), '{}');
  put(join(root, 'run', 'api.sock'), '');
  put(join(root, 'img', 'pasted.png'), 'png');
}
const main = (...p: string[]): string => join(root, 'rooms', 'main', ...p);
const listening = (path: string): Promise<void> =>
  new Promise((resolve) => {
    mkdirSync(join(path, '..'), { recursive: true });
    const s = net.createServer().listen(path, resolve as () => void);
    servers.push(s);
  });

describe('moving room main into rooms/main', () => {
  it('moves only main\'s files by rename, keeps the supervisor\'s and what it does not know, and writes the marker last', async () => {
    oldHome();
    const out = await startupMigration(root);
    expect(out).toMatchObject({ did: 'migrated', direction: 'forward' });
    for (const name of ['agents.json', 'messages.jsonl', 'keys.json']) {
      expect(existsSync(join(root, name)), name).toBe(false);
      expect(existsSync(main(name)), name).toBe(true);
    }
    expect(readFileSync(main('black-box', 'x', 'y.txt'), 'utf8')).toBe('y');
    expect(readFileSync(main('run', 'port'), 'utf8')).toBe('40000\n');
    expect(existsSync(main('run', 'update.json'))).toBe(true);
    expect(existsSync(main('gh', 'hosts.yml'))).toBe(true);
    // the supervisor's files, the socket of the supervisor and a folder nobody knows stay
    for (const name of ['auth.json', 'token', 'push.json', join('run', 'api.sock'), join('img', 'pasted.png'), ROOMS_FILE]) expect(existsSync(join(root, name)), name).toBe(true);
    expect(recordedMainHome(root)).toBe('rooms/main');
    expect(mainLayout(root)).toBe('rooms/main');
    expect(roomHome(root, MAIN_ROOM)).toBe(join(root, 'rooms', 'main'));
    expect(loadRooms(root).map((r) => r.id)).toEqual(['main']);
    expect(readMigration(root)).toMatchObject({ state: 'done', moved: 9 });
    // the leftover lock is not carried over: the room makes its own where it runs
    expect(existsSync(join(root, 'server.lock'))).toBe(false);
    expect(existsSync(main('server.lock'))).toBe(false);
    expect(lstatSync(join(root, MIGRATION_FILE)).mode & 0o777).toBe(0o600);
  });

  it('a dry run lists what would move and what stays, and writes nothing', async () => {
    oldHome();
    const before = readdirSync(root).sort();
    const plan = await planMigration(root, 'forward', { running: false });
    expect(plan.problems).toEqual([]);
    expect(plan.entries).toEqual(expect.arrayContaining(['agents.json', 'agents', 'black-box', 'gh', 'keys.json', 'messages.jsonl', 'mission-log', 'run/port', 'run/update.json']));
    expect(plan.entries).not.toContain('auth.json');
    expect(plan.stays).toEqual(['img']);
    expect(plan.to).toBe(main());
    expect(readdirSync(root).sort()).toEqual(before);
    expect(existsSync(join(root, MIGRATION_FILE))).toBe(false);
  });

  it('a pre-check that fails leaves the home as it is, says why with the agent\'s name, and is not tried again by itself', async () => {
    oldHome([
      { name: 'ana', dir: '/projects/app', role: 'r', mode: 'default', sessionId: '1', desk: 0, boss: true, createdAt: 1 },
      { name: 'wt', dir: '/projects/app', worktree: {}, role: 'r', mode: 'default', sessionId: '2', desk: 1, boss: false, createdAt: 1 },
      { name: 'cr', dir: '/projects/app', cleanRoom: {}, role: 'r', mode: 'default', sessionId: '3', desk: 2, boss: false, createdAt: 1 },
      { name: 'in', dir: join(root, 'agents', 'in'), role: 'r', mode: 'default', sessionId: '4', desk: 3, boss: false, createdAt: 1 },
    ]);
    const before = readdirSync(root).sort();
    const out = await startupMigration(root);
    expect(out.did).toBe('skipped');
    const reasons = out.did === 'skipped' ? out.problems.join('\n') : '';
    for (const name of ['wt', 'cr', 'in']) expect(reasons, name).toContain(`agent ${name} `);
    expect(reasons).not.toContain('agent ana ');
    expect(existsSync(join(root, 'agents.json'))).toBe(true);
    expect(existsSync(main())).toBe(false);
    expect(readdirSync(root).sort()).toEqual([...before, MIGRATION_FILE, ROOMS_FILE].sort());
    expect(readMigration(root)).toMatchObject({ state: 'skipped' });
    expect(recordedMainHome(root)).toBe('.');
    expect(roomHome(root, MAIN_ROOM)).toBe(root);
    // the marker says "leave it": the next start does nothing, even when the reason is gone
    writeFileSync(join(root, 'agents.json'), JSON.stringify({ version: 1, agents: [] }));
    expect(await startupMigration(root)).toEqual({ did: 'nothing' });
    expect(existsSync(main())).toBe(false);
  });

  it('refuses for each other reason too: a folder in the way, a worktree folder left over, a damaged roster, nothing to move', async () => {
    oldHome();
    mkdirSync(main(), { recursive: true });
    writeFileSync(main('stray'), 'x');
    let plan = await planMigration(root, 'forward', { running: false });
    expect(plan.problems.join('\n')).toContain('is not empty');
    rmSync(main('stray'));
    mkdirSync(join(root, 'worktrees', 'old'), { recursive: true });
    plan = await planMigration(root, 'forward', { running: false });
    expect(plan.problems.join('\n')).toMatch(/worktrees\/old is not a git worktree/);
    rmSync(join(root, 'worktrees'), { recursive: true });
    writeFileSync(join(root, 'agents.json'), '{nope');
    plan = await planMigration(root, 'forward', { running: false });
    expect(plan.problems.join('\n')).toContain('agents.json cannot be read');
    const empty = mkdtempSync(join(tmpdir(), 'gng-migrate-empty-'));
    try {
      expect((await planMigration(empty, 'forward', { running: false })).problems.join('\n')).toContain('nothing of room main');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('refuses while a room is running: a socket that answers, for a start, not for a dry run', async () => {
    oldHome();
    await listening(join(root, 'run', 'room.sock'));
    const live = await planMigration(root, 'forward', { running: true });
    expect(live.problems.join('\n')).toContain('answers');
    expect((await planMigration(root, 'forward', { running: false })).problems).toEqual([]);
    const result = await migrate(root, 'forward');
    expect(result.ok).toBe(false);
    expect(existsSync(join(root, 'agents.json'))).toBe(true);
    expect(existsSync(main())).toBe(false);
    expect(existsSync(join(root, MIGRATION_FILE))).toBe(false);
    for (const s of servers) await new Promise((r) => s.close(() => r(null)));
    servers = [];
    rmSync(join(root, 'run', 'room.sock'), { force: true });
    await listening(join(root, 'run', 'ptyhost.sock'));
    expect((await planMigration(root, 'forward', { running: true })).problems.join('\n')).toContain('pty host');
  });

  describe('leftover worktrees of Clean Rooms and plain worktrees (as on a real install: rso and simsup)', () => {
    let repo: string;
    const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });
    beforeEach(() => {
      repo = mkdtempSync(join(tmpdir(), 'gng-repo-'));
      git(repo, 'init', '-q', '-b', 'main');
      writeFileSync(join(repo, 'a.txt'), 'a');
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', 'one');
    });
    afterEach(() => rmSync(repo, { recursive: true, force: true }));
    const leftover = (dir: string, name: string): string => {
      const path = join(root, dir, name);
      mkdirSync(join(root, dir), { recursive: true });
      git(repo, 'worktree', 'add', '-q', '-b', `gonogo/${name}`, path);
      return path;
    };

    it('removes a clean one whose branch is merged (git worktree remove, the branch kept), journals it, and moves', async () => {
      oldHome();
      const rso = leftover('cleanroom', 'rso');
      const sim = leftover('cleanroom', 'simsup');
      const plan = await planMigration(root, 'forward', { running: false });
      expect(plan.problems).toEqual([]);
      expect(plan.removes.sort()).toEqual([rso, sim].sort());
      expect(existsSync(rso)).toBe(true); // a dry run removes nothing
      const out = await startupMigration(root);
      expect(out).toMatchObject({ did: 'migrated', removed: expect.arrayContaining([rso, sim]) });
      expect(existsSync(rso) || existsSync(sim) || existsSync(join(root, 'cleanroom'))).toBe(false);
      expect(git(repo, 'branch', '--list', 'gonogo/rso')).toContain('gonogo/rso');
      expect(git(repo, 'worktree', 'list')).not.toContain('cleanroom');
      expect(readMigration(root)).toMatchObject({ state: 'done', removedWorktrees: expect.arrayContaining([rso, sim]) });
      expect(existsSync(main('agents.json'))).toBe(true);
    });

    it('a dirty one, one with a commit that is not merged, or a plain folder still refuses, with the exact command; and nothing is removed', async () => {
      oldHome();
      const clean = leftover('cleanroom', 'rso');
      const dirty = leftover('worktrees', 'dirty');
      writeFileSync(join(dirty, 'new.txt'), 'x');
      const ahead = leftover('worktrees', 'ahead');
      writeFileSync(join(ahead, 'b.txt'), 'b');
      git(ahead, 'add', '.');
      git(ahead, 'commit', '-q', '-m', 'two');
      mkdirSync(join(root, 'worktrees', 'plain'));
      const out = await startupMigration(root);
      expect(out.did).toBe('skipped');
      const reasons = out.did === 'skipped' ? out.problems.join('\n') : '';
      expect(reasons).toContain(`has changes that are not committed: look at them, then run: git -C ${realpathSync(repo)} worktree remove ${dirty}`);
      expect(reasons).toMatch(/gonogo\/ahead\) that is not merged[^\n]*1 commit ahead[^\n]*run: git -C [^\n]* worktree remove [^\n]*worktrees\/ahead/);
      expect(reasons).toContain('worktrees/plain is not a git worktree');
      expect(reasons).not.toContain(clean); // the clean one is no reason
      expect(existsSync(clean)).toBe(true); // a refused move changes nothing
      expect(existsSync(join(root, 'agents.json'))).toBe(true);
    });

    it('a worktree that an agent of the roster has is not a leftover: the agent is the reason, and it is never removed', async () => {
      oldHome([{ name: 'rso', dir: '/p', cleanRoom: {}, role: 'r', mode: 'default', sessionId: '1', desk: 0, boss: true, createdAt: 1 }]);
      const rso = leftover('cleanroom', 'rso');
      const plan = await planMigration(root, 'forward', { running: false });
      expect(plan.removes).toEqual([]);
      expect(plan.problems.join('\n')).toContain('agent rso has a Clean Room');
      expect((await migrate(root, 'forward')).ok).toBe(false);
      expect(existsSync(rso)).toBe(true);
    });

    it('--dry-run on the command line says which ones it would remove', async () => {
      oldHome();
      const rso = leftover('cleanroom', 'rso');
      const plan = await planMigration(root, 'forward', { running: false });
      expect(plan.removes).toEqual([rso]);
    });
  });

  it('refuses while the lock of a room is held (its holder touches it every beat), and not for a lock nobody holds', async () => {
    oldHome();
    const was = lockHooks.beatMs;
    lockHooks.beatMs = 60;
    const lock = join(root, 'server.lock');
    writeFileSync(lock, `${process.ppid}\n`); // a live pid, no stamp: judged by its beat
    // the check waits on the file with a blocking sleep, so the holder must be another process
    const holder = spawn(process.execPath, ['-e', `setInterval(() => require('fs').utimesSync(${JSON.stringify(lock)}, new Date(), new Date()), 10)`], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 150));
    try {
      expect((await planMigration(root, 'forward', { running: true })).problems.join('\n')).toContain('server.lock names a live process');
    } finally {
      holder.kill();
      await new Promise((r) => holder.once('exit', r));
    }
    utimesSync(lock, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    try {
      expect((await planMigration(root, 'forward', { running: true })).problems).toEqual([]);
    } finally {
      lockHooks.beatMs = was;
    }
  });

  it('the marker skip: a recorded layout, a fresh home and a home with no room files are never moved by the start', async () => {
    oldHome();
    setMainHome(root, '.');
    expect(await startupMigration(root)).toEqual({ did: 'nothing' });
    expect(existsSync(join(root, 'agents.json'))).toBe(true);
    const fresh = mkdtempSync(join(tmpdir(), 'gng-migrate-fresh-'));
    try {
      expect(await startupMigration(fresh)).toEqual({ did: 'nothing' });
      expect(readdirSync(fresh)).toEqual([]);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
    // and one that has been moved is left where it is
    const again = mkdtempSync(join(tmpdir(), 'gng-migrate-again-'));
    try {
      put(join(again, 'agents.json'), JSON.stringify({ version: 1, agents: [] }));
      expect((await startupMigration(again)).did).toBe('migrated');
      expect(await startupMigration(again)).toEqual({ did: 'nothing' });
    } finally {
      rmSync(again, { recursive: true, force: true });
    }
  });

  it('MIGRATE NOW: a request on a home that said "leave it" moves it at the next start, with the same pre-checks', async () => {
    oldHome();
    setMainHome(root, '.');
    writeMigration(root, { state: 'requested', at: 1 });
    expect((await startupMigration(root)).did).toBe('migrated');
    expect(recordedMainHome(root)).toBe('rooms/main');
    // a request that cannot be done is a skipped note again, with the reason
    const second = mkdtempSync(join(tmpdir(), 'gng-migrate-req-'));
    try {
      put(join(second, 'agents.json'), JSON.stringify({ version: 1, agents: [{ name: 'w', dir: '/p', worktree: {} }] }));
      setMainHome(second, '.');
      writeMigration(second, { state: 'requested', at: 1 });
      expect(await startupMigration(second)).toMatchObject({ did: 'skipped' });
      expect(readMigration(second)).toMatchObject({ state: 'skipped' });
      expect(existsSync(join(second, 'agents.json'))).toBe(true);
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
  });

  it('a crash in the middle is finished at the next start: the journal names what is left, and nothing is overwritten or moved twice', async () => {
    oldHome();
    let seen = 0;
    await expect(
      migrate(root, 'forward', {
        afterEach: () => {
          seen += 1;
          if (seen === 3) throw new Error('crash');
        },
      }),
    ).rejects.toThrow('crash');
    const note = readMigration(root);
    expect(note).toMatchObject({ state: 'moving' });
    const entries = note?.state === 'moving' ? note.entries : [];
    expect(entries.length).toBe(9);
    // half and half: some of main's files are in each place, and no marker yet
    const moved = entries.filter((n) => existsSync(main(n)));
    const left = entries.filter((n) => existsSync(join(root, n)));
    expect(moved).toHaveLength(3);
    expect(left).toHaveLength(6);
    expect(recordedMainHome(root)).toBeNull();
    // the next start
    const out = await startupMigration(root);
    expect(out).toEqual({ did: 'resumed', direction: 'forward', moved: 6 });
    for (const n of entries) {
      expect(existsSync(main(n)), n).toBe(true);
      expect(existsSync(join(root, n)), n).toBe(false);
    }
    expect(recordedMainHome(root)).toBe('rooms/main');
    expect(readMigration(root)).toMatchObject({ state: 'done' });
    // a crash after the marker, before the note was changed, is finished the same way
    writeMigration(root, { state: 'moving', at: 1, entries });
    expect(resumeMigration(root)).toMatchObject({ ok: true, moved: 0 });
    expect(readMigration(root)).toMatchObject({ state: 'done' });
  });

  it('a name in both places stops a resume with a reason and overwrites nothing', async () => {
    oldHome();
    writeMigration(root, { state: 'moving', at: 1, entries: ['keys.json'] });
    put(main('keys.json'), 'mine');
    expect(() => resumeMigration(root)).toThrow(RoomsError);
    expect(readFileSync(main('keys.json'), 'utf8')).toBe('mine');
    expect(readFileSync(join(root, 'keys.json'), 'utf8')).toBe('{}');
    expect(recordedMainHome(root)).toBeNull();
  });

  it('a journal is read as data: a damaged one stops the start, and an entry that is not main\'s file is refused', () => {
    for (const bad of ['{nope', '[]', '{"state":"weird"}', JSON.stringify({ state: 'moving', at: 1, entries: ['../../etc/passwd'] }), JSON.stringify({ state: 'moving', at: 1, entries: ['auth.json'] })]) {
      writeFileSync(join(root, MIGRATION_FILE), bad);
      expect(() => readMigration(root), bad).toThrow(RoomsError);
    }
    rmSync(join(root, MIGRATION_FILE));
    expect(readMigration(root)).toBeNull();
  });

  it('undo puts main\'s files back at the root, removes the empty rooms/main, records the root and is not undone by the next start', async () => {
    oldHome();
    await startupMigration(root);
    put(main('run', 'room.sock'), ''); // a leftover of a room that has stopped
    const result = await migrate(root, 'undo');
    expect(result).toMatchObject({ ok: true, direction: 'undo' });
    for (const name of ['agents.json', 'messages.jsonl', 'keys.json']) expect(existsSync(join(root, name)), name).toBe(true);
    expect(readFileSync(join(root, 'black-box', 'x', 'y.txt'), 'utf8')).toBe('y');
    expect(existsSync(main())).toBe(false);
    expect(recordedMainHome(root)).toBe('.');
    expect(readMigration(root)).toBeNull();
    expect(roomHome(root, MAIN_ROOM)).toBe(root);
    expect(await startupMigration(root)).toEqual({ did: 'nothing' });
    expect(existsSync(main())).toBe(false);
  });

  it('undo asked on the page runs at the next start; an undo that cannot be done leaves main where it is and says why', async () => {
    oldHome();
    await startupMigration(root);
    writeMigration(root, { state: 'undo-requested', at: 1 });
    expect((await startupMigration(root)).did).toBe('migrated');
    expect(existsSync(join(root, 'agents.json'))).toBe(true);
    // again, with a file in the way at the root
    await startupMigration(root); // nothing: recorded "."
    setMainHome(root, 'rooms/main');
    mkdirSync(main(), { recursive: true });
    for (const name of ['agents.json', 'keys.json']) {
      writeFileSync(main(name), 'm');
    }
    rmSync(join(root, 'agents.json'));
    writeMigration(root, { state: 'undo-requested', at: 1 });
    const out = await startupMigration(root);
    expect(out.did).toBe('skipped');
    expect(out.did === 'skipped' ? out.problems.join('\n') : '').toContain('keys.json is in the way');
    expect(existsSync(main('agents.json'))).toBe(true);
    expect(readMigration(root)).toMatchObject({ state: 'done', undoReasons: expect.any(Array) });
    expect(recordedMainHome(root)).toBe('rooms/main');
  });

  it('undo is refused while main runs', async () => {
    oldHome();
    await startupMigration(root);
    await listening(main('run', 'room.sock'));
    const result = await migrate(root, 'undo');
    expect(result.ok).toBe(false);
    expect(existsSync(main('agents.json'))).toBe(true);
  });
});
