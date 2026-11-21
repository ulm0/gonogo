import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClaimResult } from '../src/shared/protocol.js';
import { noLegs } from '../src/server/claimsfile.js';
import type { ParseLegs } from '../src/server/claimsfile.js';
import { createProposalStore, PROPOSALS_PENDING_MAX, PROPOSALS_PER_HOUR, serializeLeg } from '../src/server/knowledgeproposals.js';

const REPO = 'a'.repeat(16);
const who = { agent: 'ana', branch: 'main', commit: 'abc1234' };
let dir: string;
let now: number;
const open = (dirName = 'room', parseLegs: ParseLegs = noLegs) => createProposalStore({ dir: join(dir, dirName), now: () => now, parseLegs });
const leg = { mode: 'present' as const, glob: 'src/**/*.ts', literal: 'limit = 5' };
const refused = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('it was not refused');
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gonogo-proposals-'));
  now = 10_000_000;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('a leg of a proposal, serialized', () => {
  it('is the grammar: brain:<glob> [!<glob>] /regex/[i] or "literal", then the mode', () => {
    expect(serializeLeg(leg, 0)).toBe('brain:src/**/*.ts "limit = 5" present');
    expect(serializeLeg({ mode: 'absent', glob: 'src/**', exclude: ['src/legacy/**', '**/*.test.ts'], regex: 'old[[:space:]]+name', flags: 'i' }, 0)).toBe('brain:src/** !src/legacy/** !**/*.test.ts /old[[:space:]]+name/i absent');
    expect(serializeLeg({ mode: 'count', count: 3, glob: 'a/*', literal: 'x' }, 0)).toBe('brain:a/* "x" count=3');
    expect(serializeLeg({ mode: 'each!', glob: 'a', literal: 'say "hi" \\ done' }, 0)).toBe('brain:a "say \\"hi\\" \\\\ done" each!');
    // a slash in a regex is escaped, an escaped one is kept
    expect(serializeLeg({ mode: 'present', glob: 'a', regex: 'a/b\\/c' }, 0)).toBe('brain:a /a\\/b\\/c/ present');
  });

  it('refuses what could carry a comment mark, a second leg, a newline, a path out of the repository, or a missing or doubled pattern', async () => {
    const cases: Array<[unknown, RegExp]> = [
      [null, /must be an object/],
      [{ ...leg, extra: 1 }, /unknown field/],
      [{ ...leg, mode: 'sometimes' }, /mode must be/],
      [{ ...leg, glob: '../x' }, /glob must be/],
      [{ ...leg, glob: '/etc/*' }, /glob must be/],
      [{ ...leg, glob: '~/x' }, /glob must be/],
      [{ ...leg, glob: 'a b' }, /glob must be/],
      [{ ...leg, glob: 'a//b' }, /glob must be/],
      [{ ...leg, glob: 'a"b' }, /glob must be/],
      [{ ...leg, glob: 'a-->b' }, /glob must be/],
      [{ ...leg, glob: '!a' }, /glob must be/],
      [{ ...leg, exclude: ['../x'] }, /exclude must be/],
      [{ ...leg, exclude: ['a', 'b', 'c', 'd', 'e', 'f'] }, /exclude must be/],
      [{ mode: 'present', glob: 'a' }, /either regex or literal/],
      [{ ...leg, regex: 'x' }, /either regex or literal/],
      [{ mode: 'present', glob: 'a', regex: 'a\nb' }, /regex must be/],
      [{ mode: 'present', glob: 'a', regex: 'a-->b' }, /regex must be/],
      [{ mode: 'present', glob: 'a', regex: 'x'.repeat(201) }, /regex must be/],
      [{ mode: 'present', glob: 'a', regex: 'x', flags: 'g' }, /flags can only be/],
      [{ ...leg, literal: 'a\nb' }, /literal must be/],
      [{ ...leg, literal: 'a‮b' }, /literal must be/],
      [{ ...leg, literal: 'a --> b' }, /literal must be/],
      [{ ...leg, flags: 'i' }, /flags go with a regex/],
      [{ ...leg, mode: 'count' }, /count needs a whole number/],
      [{ ...leg, count: 2 }, /count goes with mode count/],
    ];
    for (const [input, message] of cases) expect(await refused(async () => serializeLeg(input, 0)), JSON.stringify(input)).toMatch(message);
  });
});

describe('proposals', () => {
  it('are pending, stamped, numbered per repository, and never anything else until decided', async () => {
    const s = open();
    const p = await s.propose(REPO, who, { statement: ' The limit\n is‮ 5. ', legs: [leg] });
    expect(p).toMatchObject({ id: 'p1', agent: 'ana', branch: 'main', commit: 'abc1234', at: now, statement: 'The limit is 5.', status: 'pending', legs: [] });
    expect(p).not.toHaveProperty('legLines');
    expect((await s.propose(REPO, { ...who, agent: 'ben' }, { statement: 'Two', legs: [leg] })).id).toBe('p2');
    expect((await s.propose('b'.repeat(16), who, { statement: 'Other repo', legs: [leg] })).id).toBe('p1');
    expect(await s.lines(REPO, 'p1')).toEqual(['brain:src/**/*.ts "limit = 5" present']);
    expect((await s.list(REPO)).map((x) => x.id)).toEqual(['p1', 'p2']);
    expect((await stat(join(dir, 'room', `${REPO}.json`))).mode & 0o777).toBe(0o600);
  });

  it('are per room: another room\'s folder holds its own', async () => {
    await open('room-a').propose(REPO, who, { statement: 'A', legs: [leg] });
    expect(await open('room-b').list(REPO)).toEqual([]);
    expect((await open('room-b').propose(REPO, who, { statement: 'B', legs: [leg] })).id).toBe('p1');
  });

  it('refuse a bad statement or legs, and what the grammar refuses, with the line', async () => {
    const s = open('room', (lines) => ({ legs: [], diagnostics: lines.filter((l) => l.text.includes('"nope"')).map((l) => ({ line: l.line, message: 'no such thing' })) }));
    expect(await refused(() => s.propose(REPO, who, { statement: '  ', legs: [leg] }))).toMatch(/needs a statement/);
    expect(await refused(() => s.propose(REPO, who, { statement: 's', legs: [] }))).toMatch(/1 to 5 legs/);
    expect(await refused(() => s.propose(REPO, who, { statement: 's', legs: Array.from({ length: 6 }, () => leg) }))).toMatch(/1 to 5 legs/);
    expect(await refused(() => s.propose(REPO, who, { statement: 's', legs: 'x' }))).toMatch(/1 to 5 legs/);
    expect(await refused(() => s.propose(REPO, who, { statement: 's', legs: [leg, { ...leg, literal: 'nope' }] }))).toMatch(/leg 2: no such thing/);
    expect(await s.list(REPO)).toEqual([]);
    expect(await refused(() => s.list('../x'))).toMatch(/not a repository id/);
  });

  it('are capped at 20 waiting and 10 an hour for an agent, and another agent is not held up', async () => {
    const s = open();
    for (let i = 0; i < PROPOSALS_PER_HOUR; i += 1) await s.propose(REPO, who, { statement: `s${i}`, legs: [leg] });
    expect(await refused(() => s.propose(REPO, who, { statement: 'one more', legs: [leg] }))).toMatch(/at most 10 proposals an hour/);
    await s.propose(REPO, { ...who, agent: 'ben' }, { statement: 'ben', legs: [leg] });
    now += 3_600_001;
    for (let i = 0; i < PROPOSALS_PER_HOUR; i += 1) await s.propose(REPO, who, { statement: `t${i}`, legs: [leg] });
    expect(await s.list(REPO)).toHaveLength(21);
    now += 3_600_001;
    expect(await refused(() => s.propose(REPO, who, { statement: 'over 20 waiting', legs: [leg] }))).toMatch(new RegExp(`${PROPOSALS_PENDING_MAX} proposals waiting`));
    // deciding one makes room
    await s.decide(REPO, 'p1', 'rejected', { reason: 'no' });
    await expect(s.propose(REPO, who, { statement: 'room again', legs: [leg] })).resolves.toMatchObject({ status: 'pending' });
  });

  it('are decided once; a reason is cleaned; a trial is kept for the Director', async () => {
    const s = open();
    await s.propose(REPO, who, { statement: 'x', legs: [leg] });
    const trial: ClaimResult = { id: 'p1', root: '/work/r', branch: 'main', commit: 'abc1234', worst: 'ok', legs: [{ state: 'ok', note: '' }], checkedAt: 5 };
    expect((await s.setTrial(REPO, 'p1', trial)).trial).toEqual(trial);
    expect(await s.decide(REPO, 'p1', 'rejected', { reason: ' too\nvague‮ ' })).toMatchObject({ status: 'rejected', reason: 'too vague' });
    expect(await refused(() => s.decide(REPO, 'p1', 'accepted', {}))).toMatch(/rejected already/);
    expect(await refused(() => s.lines(REPO, 'p1'))).toMatch(/is rejected/);
    expect(await refused(() => s.decide(REPO, 'p9', 'accepted', {}))).toMatch(/unknown proposal/);
  });

  it('a file that is not a proposals file is kept as .bad and a new one starts', async () => {
    const s = open();
    await s.propose(REPO, who, { statement: 'x', legs: [leg] });
    await writeFile(join(dir, 'room', `${REPO}.json`), '{ nope');
    expect(await s.list(REPO)).toEqual([]);
    expect((await readdir(join(dir, 'room'))).sort()).toEqual([`${REPO}.json.bad`]);
    expect((await readFile(join(dir, 'room', `${REPO}.json.bad`), 'utf8'))).toBe('{ nope');
  });
});
