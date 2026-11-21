// The anchor grammar and the evaluation of one leg (src/server/anchorgrammar.ts). Part of the dialect-gate cases are ported from multivac's tests
// (test/anchor/dialect-and-lines.test.ts of github.com/ulm0/multivac, MIT, (c) 2026 Pierre Ugaz): gonogo must accept and refuse what multivac's grammar does for the
// subset it supports.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Leg } from '../src/shared/protocol.js';
import {
  ANCHOR_LITERAL_MAX_CHARS,
  AnchorSyntaxError,
  ReadBudget,
  compileAnchorRegex,
  evaluateLeg,
  globProblem,
  legFiles,
  matchingLines,
  movedTo,
  parseAnchors,
  parseLegLines,
  runAnchorJob,
  trackedReader,
} from '../src/server/anchorgrammar.js';
import type { AnchorWorkerMessage, FileSource } from '../src/server/anchorgrammar.js';

const fixture = readFileSync(new URL('./fixtures/multivac-anchors.md', import.meta.url), 'utf8');
const section = (name: string): string => {
  const start = fixture.indexOf(`## ${name}`);
  const next = fixture.indexOf('\n## ', start + 3);
  return fixture.slice(start, next === -1 ? undefined : next);
};

describe('the dialect gate (ported)', () => {
  it('a bare [:class:] is refused with grep\'s own wording, and the right form means what it says', () => {
    expect(() => compileAnchorRegex('PIN[:digit:]')).toThrow(/character class syntax is \[\[:digit:\]\]/);
    expect(compileAnchorRegex('PIN[[:digit:]]').test('PIN4')).toBe(true);
    expect(compileAnchorRegex('PIN[[:digit:]]').test('PINx')).toBe(false);
  });

  it('the constructs POSIX ERE does not have are named, not compiled', () => {
    const refused: Array<[string, RegExp]> = [
      ['a(?=b)', /no `\(\?\.\.\.\)`/],
      ['a(?:b)', /no `\(\?\.\.\.\)`/],
      ['a*?b', /greedy/],
      ['a+?b', /greedy/],
      ['(a)\\1', /backreference/],
      ['x\\ty', /no meaning in POSIX ERE/],
      ['x\\ny', /no meaning in POSIX ERE/],
      ['\\bword\\b', /not POSIX ERE/],
      ['\\d+', /use \[\[:digit:\]\]/],
    ];
    for (const [source, message] of refused) expect(() => compileAnchorRegex(source), source).toThrow(message);
    expect(() => compileAnchorRegex('a\\0b')).toThrow(/NUL escape/);
    expect(() => compileAnchorRegex('a\\7b')).toThrow(/backreference/);
    expect(() => compileAnchorRegex('x', 'g')).toThrow(/only "i"/);
    expect(() => compileAnchorRegex('[unclosed')).toThrow(AnchorSyntaxError);
    expect(() => compileAnchorRegex('')).toThrow(/empty pattern/);
  });

  it('every dialect form in use keeps compiling', () => {
    for (const source of ['[[:digit:]]', '[[:alpha:][:digit:]]', '[[:digit:]x]', '[]]', '[^]]', '^foo$', 'a{2,3}', '[a-z]', 'a\\.b', '(a|b)+', '[^[:space:]]', '(foo|bar)+', '(https?://x)', '(ab)?']) {
      expect(() => compileAnchorRegex(source), source).not.toThrow();
    }
  });

  it('an ESCAPED bracket stays literal: the class translation is not global', () => {
    expect(compileAnchorRegex('PIN\\[:digit:]').source).toBe('PIN\\[:digit:]');
    expect(compileAnchorRegex('PIN\\[:digit:]').test('PIN[:digit:]')).toBe(true);
    expect(compileAnchorRegex('PIN\\[:digit:]').test('PIN4')).toBe(false);
    expect(compileAnchorRegex('PIN[[:digit:]]').source).toBe('PIN[0-9]');
    expect(compileAnchorRegex('[[:alpha:][:digit:]]').source).toBe('[a-zA-Z0-9]');
  });

  it('refuses what multivac lacks: a repeated group that holds a quantifier, a pattern over 200 characters', () => {
    for (const source of ['(a+)+$', '(a*)*', '(a|b+)*', '(.*a){20}', '((a+)b)*', '(x+y){2,}', '([a-z]+[0-9]*)+']) expect(() => compileAnchorRegex(source), source).toThrow(/repeated group/);
    expect(() => compileAnchorRegex('a'.repeat(201))).toThrow(/at most 200/);
    expect(() => compileAnchorRegex('a'.repeat(200))).not.toThrow();
    // alternation inside a repeated group is allowed (the worker's end is the guard), and a bracket expression or an escape is not a group
    expect(() => compileAnchorRegex('(a|aa)+$')).not.toThrow();
    expect(() => compileAnchorRegex('[(+]*')).not.toThrow();
    expect(() => compileAnchorRegex('\\(a+\\)+')).not.toThrow();
    expect(() => compileAnchorRegex('(a+)?')).not.toThrow(); // optional, not repeated
  });
});

describe('the globs', () => {
  it('are refused when they leave the repository or are not paths', () => {
    for (const bad of ['', '../x', 'a/../b', '/etc/passwd', '~/x', '~', 'a\\b', 'C:x', 'a//b', 'a/', 'a\u0000b', 'x'.repeat(201)]) expect(globProblem(bad), JSON.stringify(bad)).not.toBeNull();
    for (const good of ['**', 'src/**/*.ts', '{src,lib}/*.ts', '.github/**/*.yml', '*.md', 'docs/a.md']) expect(globProblem(good), good).toBeNull();
  });

  it('match tracked paths the picomatch way: ** crosses directories, braces alternate, dotfiles match, exclusions subtract', () => {
    const files = ['a.md', 'docs/b.md', '.github/ci.yml', 'src/x/y.ts', 'src/x/y.test.ts', 'lib/z.ts'];
    expect(legFiles({ glob: '**.md', excludes: [] }, files)).toEqual(['a.md', 'docs/b.md']);
    expect(legFiles({ glob: '**', excludes: [] }, files)).toHaveLength(6);
    expect(legFiles({ glob: '.github/**/*.yml', excludes: [] }, files)).toEqual(['.github/ci.yml']);
    expect(legFiles({ glob: '{src,lib}/**/*.ts', excludes: ['**/*.test.ts'] }, files)).toEqual(['src/x/y.ts', 'lib/z.ts']);
    expect(legFiles({ glob: 'nothing/**', excludes: [] }, files)).toEqual([]);
  });
});

describe('the conformance fixture (multivac\'s documented anchors)', () => {
  it('parses every line of the accepted sections, with the legs of one claim together and in order', () => {
    const { anchors, diagnostics } = parseAnchors(section('ACCEPT: the four legs of the INV-01 example') + section('ACCEPT: the dead-term tombstone, an exclusion, every mode') + section('ACCEPT: gonogo\'s literal in place of a regex'));
    expect(diagnostics).toEqual([]);
    const inv01 = anchors.filter((a) => a.claimId === 'INV-01').map((a) => a.leg);
    expect(inv01.map((l) => l.mode)).toEqual(['present', 'absent', 'count', 'absent']);
    expect(inv01[2]).toMatchObject({ mode: 'count', count: 1, glob: 'db/migrations/*.sql', pattern: { kind: 'regex', source: 'update[[:space:]]+balances', i: true } });
    const byId = (id: string): Leg => anchors.find((a) => a.claimId === id)?.leg as Leg;
    expect(byId('INV-83')).toMatchObject({ glob: 'AGENTS.md', mode: 'absent', pattern: { kind: 'regex', i: false } });
    expect(byId('INV-77').excludes).toEqual(['07-rules.md']);
    expect(byId('INV-78').excludes).toEqual(['07-rules.md']); // !brain:<glob> is !<glob> in a store of one repo
    expect(byId('INV-79')).toMatchObject({ mode: 'unique', excludes: ['**/*.test.ts'] });
    expect(byId('INV-80').mode).toBe('each');
    expect(byId('INV-81').mode).toBe('each!');
    expect(byId('INV-82')).toMatchObject({ mode: 'present', glob: '{src,lib}/*.ts', pattern: { kind: 'regex', i: true } });
    expect(byId('INV-84')).toMatchObject({ mode: 'count', count: 3 });
    expect(byId('K-1')).toMatchObject({ mode: 'absent', pattern: { kind: 'literal', text: 'a fixed string' } });
    expect(byId('K-2')).toMatchObject({ mode: 'present', pattern: { kind: 'literal', text: 'say "hello" and \\ more' } });
    expect(anchors.map((a) => a.leg.line).every((n) => n > 0)).toBe(true);
  });

  it('refuses every line of the refused sections with a diagnostic that names the line, and does not crash', () => {
    for (const name of ['REFUSE: what multivac supports and a store of one repo does not', 'REFUSE: the dialect gate', 'REFUSE: what gonogo adds']) {
      const text = section(name);
      const lines = text.split('\n').filter((l) => l.includes('@anchor'));
      expect(lines.length, name).toBeGreaterThan(2);
      const { anchors, diagnostics } = parseAnchors(text);
      expect(anchors, name).toEqual([]);
      expect(diagnostics, name).toHaveLength(lines.length);
      for (const d of diagnostics) expect(d.line).toBeGreaterThan(0);
    }
    const one = parseAnchors(section('REFUSE: what multivac supports and a store of one repo does not'));
    expect(one.diagnostics.map((d) => d.message).join('\n')).toMatch(/this store has one repo/);
  });

  it('does not read fenced or indented documentation as law', () => {
    const { anchors, diagnostics } = parseAnchors(section('IGNORED: documentation, not law'));
    expect(anchors).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it('an anchor that is not a comment, one that is not closed, one with no claim id and one with an unknown mode are named', () => {
    const text = ['@anchor K-1 brain:*.ts /a/', '<!-- @anchor K-1 brain:*.ts /a/', '<!-- @anchor brain:*.ts /a/ -->', '<!-- @anchor K-1 brain:*.ts /a/ sometimes -->', '<!-- @anchor K-1 brain:*.ts a -->', '<!-- @anchor K-1 brain:*.ts ! /a/ -->'].join('\n');
    const { anchors, diagnostics } = parseAnchors(text);
    expect(anchors).toEqual([]);
    expect(diagnostics.map((d) => d.line)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(diagnostics[0]?.message).toMatch(/not an HTML comment/);
    expect(diagnostics[1]?.message).toMatch(/unterminated/);
    expect(diagnostics[3]?.message).toMatch(/unknown mode/);
  });

  it('a literal is at most 200 characters on one line, an escape is only \\" or \\\\, and text after it other than a mode is refused', () => {
    const ok = `<!-- @anchor K-1 brain:*.ts "${'x'.repeat(ANCHOR_LITERAL_MAX_CHARS)}" -->`;
    expect(parseAnchors(ok).anchors).toHaveLength(1);
    for (const bad of [`<!-- @anchor K-1 brain:*.ts "${'x'.repeat(ANCHOR_LITERAL_MAX_CHARS + 1)}" -->`, '<!-- @anchor K-1 brain:*.ts "a\\nb" -->', '<!-- @anchor K-1 brain:*.ts "a" absent extra -->', '<!-- @anchor K-1 brain:*.ts "a" sometimes -->']) {
      expect(parseAnchors(bad).anchors, bad).toEqual([]);
      expect(parseAnchors(bad).diagnostics, bad).toHaveLength(1);
    }
  });

  it('a ReDoS corpus: refused when parsed, or (when the shape is allowed) left to the worker\'s end', () => {
    const refused = ['(a+)+$', '(a*)*b', '(.*a){20}', '(a|b+)*', '((a+)+)+', '(x+x+)+y'];
    for (const source of refused) expect(parseAnchors(`<!-- @anchor K-1 brain:*.ts /${source}/ -->`).diagnostics, source).toHaveLength(1);
    const allowed = ['(a|aa)+$', '(foo|foobar)+x'];
    for (const source of allowed) expect(parseAnchors(`<!-- @anchor K-1 brain:*.ts /${source}/ -->`).anchors, source).toHaveLength(1);
    // a long alternation is one line, within 200 characters
    const alt = `(${Array.from({ length: 30 }, (_, i) => `w${i}`).join('|')})`;
    expect(parseAnchors(`<!-- @anchor K-1 brain:*.ts /${alt}/ -->`).anchors).toHaveLength(1);
  });
});

describe('the legs of one claim, as the store reads them (parseLegLines)', () => {
  it('gives the legs with the line each had in the file, and a diagnostic with its line for each line that is not one', () => {
    const out = parseLegLines(
      [
        { line: 7, text: '<!-- @anchor K-1 brain:src/**/*.ts /x/ unique -->' },
        { line: 8, text: '<!-- @anchor K-1 brain:docs/*.md "a text" absent -->' },
        { line: 9, text: '<!-- @anchor K-1 brain:*.ts /(a+)+$/ -->' },
        { line: 10, text: '<!-- @anchor K-2 brain:*.ts /x/ -->' },
        { line: 11, text: 'not an anchor at all' },
      ],
      'K-1',
    );
    expect(out.legs.map((l) => [l.line, l.mode])).toEqual([[7, 'unique'], [8, 'absent']]);
    expect(out.diagnostics.map((d) => d.line)).toEqual([9, 10, 11]);
    expect(out.diagnostics[1]?.message).toMatch(/names K-2, not K-1/);
    expect(out.diagnostics[2]?.message).toMatch(/not an anchor/);
  });

  it('reads what a proposal sends (claim id "p"), keeps one anchor to a line, and caps the number of legs', () => {
    expect(parseLegLines([{ line: 1, text: '<!-- @anchor p brain:*.ts "x" -->' }], 'p').legs).toHaveLength(1);
    const two = parseLegLines([{ line: 4, text: '<!-- @anchor p brain:*.ts "x" --> <!-- @anchor p brain:*.ts "y" -->' }, { line: 5, text: '<!-- @anchor p brain:*.ts "x" -->\n<!-- @anchor p brain:*.ts "y" -->' }], 'p');
    expect(two.legs).toEqual([]);
    expect(two.diagnostics).toEqual([{ line: 4, message: 'one anchor to a line' }, { line: 5, message: 'one anchor to a line' }]);
    const many = Array.from({ length: 501 }, (_, i) => ({ line: i + 1, text: '<!-- @anchor p brain:*.ts "x" -->' }));
    const out = parseLegLines(many, 'p');
    expect(out.legs).toHaveLength(500);
    expect(out.diagnostics.at(-1)).toMatchObject({ line: 501, message: expect.stringMatching(/at most 500 legs/) });
    expect(parseLegLines([], 'p')).toEqual({ legs: [], diagnostics: [] });
  });
});

describe('matching', () => {
  it('a CRLF line is a line: same verdicts and numbers as its LF twin; a lone CR is text', () => {
    const test = (src: string) => (line: string) => compileAnchorRegex(src).test(line);
    const lf = 'alpha\nbeta\ngamma\n';
    const crlf = 'alpha\r\nbeta\r\ngamma\r\n';
    for (const src of ['alpha$', '^beta$', 'gamma']) expect(matchingLines(crlf, test(src)), src).toEqual(matchingLines(lf, test(src)));
    expect(matchingLines(crlf, test('alpha$'))).toEqual([1]);
    expect(matchingLines('a\rb\n', test('b'))).toEqual([1]);
  });

  it('a line that carries a whole anchor comment never matches (a claim\'s own pattern must not satisfy another), an opener with no end is a line like any', () => {
    const text = '<!-- @anchor K-1 brain:*.ts /PIN/ absent -->\nPIN here\n<!-- @anchor K-2 brain:*.ts /PIN\n';
    expect(matchingLines(text, (l) => l.includes('PIN'))).toEqual([2, 3]);
  });
});

/** An in-memory checkout. */
const checkout = (files: Record<string, string | null>): FileSource => ({ files: Object.keys(files), read: (f) => files[f] ?? null });
const leg = (over: Partial<Leg> & Pick<Leg, 'mode' | 'glob'>): Leg => ({ excludes: [], pattern: { kind: 'literal', text: 'NEEDLE' }, line: 1, ...over });

describe('the legs', () => {
  const tree = checkout({ 'a.ts': 'one NEEDLE\nplain\n', 'b.ts': 'plain\n', 'c.ts': 'NEEDLE\nNEEDLE\n', 'bin.dat': null });

  it('present: ok when anything matches; stale (may have moved) when nothing does; vacuous when the glob matches no file', () => {
    expect(evaluateLeg(leg({ mode: 'present', glob: 'a.ts' }), tree)).toMatchObject({ state: 'ok' });
    expect(evaluateLeg(leg({ mode: 'present', glob: 'b.ts' }), tree)).toMatchObject({ state: 'stale', note: 'no match in 1 file (may have moved)' });
    expect(evaluateLeg(leg({ mode: 'present', glob: 'z/*.ts' }), tree)).toMatchObject({ state: 'vacuous' });
  });

  it('absent: ok with no match, stale (likely real) with the count of matches and files, vacuous over nothing', () => {
    expect(evaluateLeg(leg({ mode: 'absent', glob: 'b.ts' }), tree).state).toBe('ok');
    expect(evaluateLeg(leg({ mode: 'absent', glob: '*.ts' }), tree)).toEqual({ state: 'stale', note: 'forbidden text found: 3 matches in 2 files of 3 (likely real)' });
    expect(evaluateLeg(leg({ mode: 'absent', glob: 'none/*' }), tree).state).toBe('vacuous');
  });

  it('unique, count=N, each and each! say what they found, in counts', () => {
    expect(evaluateLeg(leg({ mode: 'unique', glob: 'a.ts' }), tree).state).toBe('ok');
    expect(evaluateLeg(leg({ mode: 'unique', glob: 'c.ts' }), tree)).toMatchObject({ state: 'stale', note: 'expected exactly one match, found 2 (may have moved)' });
    expect(evaluateLeg(leg({ mode: 'count', count: 3, glob: '*.ts' }), tree).state).toBe('ok');
    expect(evaluateLeg(leg({ mode: 'count', count: 2, glob: '*.ts' }), tree)).toMatchObject({ state: 'stale', note: 'count=2 pinned, found 3 (likely real)' });
    expect(evaluateLeg(leg({ mode: 'each', glob: '*.ts' }), tree)).toMatchObject({ state: 'stale', note: '1 file lacks the pattern (of 3) (likely real)' });
    expect(evaluateLeg(leg({ mode: 'each', glob: 'c.ts' }), tree).state).toBe('ok');
    expect(evaluateLeg(leg({ mode: 'each!', glob: 'b.ts' }), tree).state).toBe('ok');
    expect(evaluateLeg(leg({ mode: 'each!', glob: '*.ts' }), tree)).toMatchObject({ state: 'stale', note: 'forbidden text in 2 files of 3 (likely real)' });
  });

  it('a file that cannot be read is skipped and counted, never matched', () => {
    expect(evaluateLeg(leg({ mode: 'absent', glob: '*' }), tree).note).toMatch(/1 file was not read/);
    expect(evaluateLeg(leg({ mode: 'each', glob: 'bin.dat' }), tree).state).not.toBe('stale');
  });

  it('a regex leg matches as a regex, with the i flag; a bad pattern or glob in a stored leg is malformed, not a crash', () => {
    const t = checkout({ 'a.txt': 'PIN4 and pin5\n' });
    expect(evaluateLeg(leg({ mode: 'count', count: 1, glob: '*.txt', pattern: { kind: 'regex', source: 'PIN[[:digit:]]', i: false } }), t).state).toBe('ok');
    expect(evaluateLeg(leg({ mode: 'present', glob: '*.txt', pattern: { kind: 'regex', source: 'pin[[:digit:]]', i: true } }), t).state).toBe('ok');
    expect(evaluateLeg(leg({ mode: 'present', glob: '*.txt', pattern: { kind: 'regex', source: '(a+)+', i: false } }), t).state).toBe('malformed');
    expect(evaluateLeg(leg({ mode: 'present', glob: '../x', pattern: { kind: 'literal', text: 'a' } }), t).state).toBe('malformed');
  });

  it('the notes hold no text of the repository: a secret in a file shows in no note', () => {
    const t = checkout({ 'a.txt': 'SECRET-TOKEN-1234\n' });
    const verdicts = [evaluateLeg(leg({ mode: 'absent', glob: '*.txt', pattern: { kind: 'literal', text: 'SECRET' } }), t), evaluateLeg(leg({ mode: 'present', glob: '*.txt', pattern: { kind: 'literal', text: 'nothing' } }), t)];
    for (const v of verdicts) expect(v.note).not.toContain('SECRET-TOKEN');
  });

  it('for a present leg that found nothing, names the one other file of the same kind that holds it, and nothing when there are two', () => {
    const t = checkout({ 'src/a.ts': 'plain\n', 'src/b.ts': 'NEEDLE\n', 'notes.md': 'NEEDLE\n' });
    expect(movedTo(leg({ mode: 'present', glob: 'src/a.ts' }), t)).toBe('src/b.ts');
    const two = checkout({ 'src/a.ts': 'plain\n', 'src/b.ts': 'NEEDLE\n', 'src/c.ts': 'NEEDLE\n' });
    expect(movedTo(leg({ mode: 'present', glob: 'src/a.ts' }), two)).toBeNull();
  });

  it('a run that has read all it may leaves the leg unevaluated', () => {
    const t: FileSource = {
      files: ['a.txt'],
      read: () => {
        throw new ReadBudget('full');
      },
    };
    expect(evaluateLeg(leg({ mode: 'present', glob: '*.txt' }), t)).toEqual({ state: 'unevaluated', note: 'too much to read in one run' });
  });
});

describe('reading a repository safely', () => {
  let root: string;
  let outside: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gng-anchor-root-'));
    outside = mkdtempSync(join(tmpdir(), 'gng-anchor-out-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('reads a regular file, and nothing for a link to a file, a link to a folder, a path out of the root, a binary file or a missing one', () => {
    writeFileSync(join(root, 'ok.txt'), 'hello\n');
    writeFileSync(join(outside, 'secret.txt'), 'SECRET');
    mkdirSync(join(root, 'dir'));
    writeFileSync(join(root, 'dir', 'inner.txt'), 'inner');
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));
    symlinkSync(join(root, 'ok.txt'), join(root, 'inner-link.txt'));
    symlinkSync(outside, join(root, 'linkdir'));
    writeFileSync(join(root, 'bin.dat'), Buffer.from([1, 0, 2]));
    const reader = trackedReader(root);
    expect(reader.read('ok.txt')).toBe('hello\n');
    expect(reader.read('dir/inner.txt')).toBe('inner');
    for (const bad of ['link.txt', 'inner-link.txt', 'linkdir/secret.txt', '../x', '/etc/passwd', 'bin.dat', 'missing.txt', '', 'dir']) expect(reader.read(bad), bad).toBeNull();
  });

  it('a clean room worktree whose parent folder is a link pointing outside reads nothing', () => {
    writeFileSync(join(outside, 'f.txt'), 'SECRET');
    const link = join(root, '..', `gng-anchor-link-${process.pid}`);
    symlinkSync(outside, link);
    try {
      expect(trackedReader(link).read('f.txt')).toBe('SECRET'); // the root IS the link's target: its real path is the root (a root is resolved, files must lie under it)
      expect(trackedReader(root).read(`../${link.split('/').pop()}/f.txt`)).toBeNull();
    } finally {
      rmSync(link, { force: true });
    }
  });

  it('a file swapped for a link between the check and the open is refused (inode and device must be the same)', () => {
    writeFileSync(join(root, 'f.txt'), 'real');
    writeFileSync(join(outside, 'secret.txt'), 'SECRET');
    const reader = trackedReader(root, {}, (path) => {
      rmSync(path);
      symlinkSync(join(outside, 'secret.txt'), path);
    });
    expect(reader.read('f.txt')).toBeNull();
  });

  it('a file over its cap is skipped, and a run over its cap throws, so that nothing past it is read', () => {
    writeFileSync(join(root, 'big.txt'), 'x'.repeat(2000));
    writeFileSync(join(root, 'a.txt'), 'a'.repeat(600));
    writeFileSync(join(root, 'b.txt'), 'b'.repeat(600));
    const reader = trackedReader(root, { fileMax: 1000, runMax: 1000 });
    expect(reader.read('big.txt')).toBeNull();
    expect(reader.read('a.txt')).toHaveLength(600);
    expect(() => reader.read('b.txt')).toThrow(ReadBudget);
    expect(reader.bytes()).toBe(600);
  });

  it('a whole job in this thread: claims in order, the fast-path legs left alone, the tree not touched', () => {
    writeFileSync(join(root, 'a.txt'), 'NEEDLE\n');
    const messages: AnchorWorkerMessage[] = [];
    runAnchorJob(
      {
        kind: 'gonogo-anchor-run',
        root,
        files: ['a.txt'],
        claims: [
          { index: 0, legs: [leg({ mode: 'present', glob: 'a.txt' }), leg({ mode: 'absent', glob: '**' })] },
          { index: 2, legs: [leg({ mode: 'present', glob: 'a.txt', pattern: { kind: 'literal', text: 'gone' } })] },
        ],
        skip: ['0:1'],
      },
      (m) => void messages.push(m),
    );
    expect(messages.map((m) => m.type)).toEqual(['claim', 'claim', 'done']);
    expect(messages[0]).toMatchObject({ index: 0, legs: [{ state: 'ok' }, { state: 'unevaluated', note: 'answered another way' }] });
    expect(messages[1]).toMatchObject({ index: 2, legs: [{ state: 'stale' }] });
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('NEEDLE\n');
  });
});
