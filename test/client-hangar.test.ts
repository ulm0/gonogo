import { describe, expect, it } from 'vitest';
import { drafts, gutterText, indentEdit, indentUnit, joinEol, joinPath, lineCount, newPathProblem, parentOf, sizeText, splitEol } from '../src/client/editor.js';
import type { Edit } from '../src/client/editor.js';
import { commitProblem, diffLines, fileLabels, shortHash, stagedCount } from '../src/client/changes.js';
import { openHangar, openRecorder, selectConsole, showHangar, showRecorder, store } from '../src/client/store.js';
import { BUILTIN_LIVERIES, contrast } from '../src/shared/livery.js';
import type { RecorderFile } from '../src/shared/protocol.js';

/** What the textarea holds after an edit is applied. */
const applied = (value: string, e: Edit): { text: string; start: number; end: number } => ({ text: value.slice(0, e.from) + e.insert + value.slice(e.to), start: e.start, end: e.end });

describe('line endings', () => {
  it('edits CRLF as LF and writes it back as CRLF', () => {
    expect(splitEol('a\r\nb\r\n')).toEqual({ text: 'a\nb\n', eol: '\r\n' });
    expect(joinEol('a\nb\n', '\r\n')).toBe('a\r\nb\r\n');
    expect(splitEol('a\nb')).toEqual({ text: 'a\nb', eol: '\n' });
    expect(joinEol('a\nb', '\n')).toBe('a\nb');
    expect(splitEol('')).toEqual({ text: '', eol: '\n' });
  });

  it('gives up on a file that would not go back as it was', () => {
    expect(splitEol('a\r\nb\nc')).toBeNull();
    expect(splitEol('a\rb')).toBeNull();
    expect(splitEol('a\r\n\rb')).toBeNull();
  });
});

describe('indentUnit', () => {
  it('follows the file: a tab, 4 spaces, else 2', () => {
    expect(indentUnit('x\n\tfoo\n')).toBe('\t');
    expect(indentUnit('x\n    foo\n')).toBe('    ');
    expect(indentUnit('x\n  foo\n')).toBe('  ');
    expect(indentUnit('x\n   foo\n')).toBe('  ');
    expect(indentUnit('no indent')).toBe('  ');
    expect(indentUnit('')).toBe('  ');
  });
});

describe('indentEdit', () => {
  it('writes one unit at the cursor, and over a selection inside a line', () => {
    expect(applied('abcd', indentEdit('abcd', 2, 2, false, '  '))).toEqual({ text: 'ab  cd', start: 4, end: 4 });
    expect(applied('abcd', indentEdit('abcd', 1, 3, false, '\t'))).toEqual({ text: 'a\td', start: 2, end: 2 });
  });

  it('indents every line a selection touches, and keeps the selection on the same text', () => {
    const v = 'one\ntwo\nthree';
    expect(applied(v, indentEdit(v, 1, 9, false, '  '))).toEqual({ text: '  one\n  two\n  three', start: 3, end: 15 });
  });

  it('leaves a line alone that the selection only enters at its very start, and an empty line', () => {
    const v = 'one\ntwo\n\nthree';
    expect(applied(v, indentEdit(v, 0, 8, false, '  ')).text).toBe('  one\n  two\n\nthree');
    expect(applied(v, indentEdit(v, 0, 12, false, '  ')).text).toBe('  one\n  two\n\n  three');
  });

  it('takes the indent back with Shift+Tab: a unit, a tab, or the spaces that are there', () => {
    expect(applied('    a', indentEdit('    a', 5, 5, true, '    '))).toEqual({ text: 'a', start: 1, end: 1 });
    expect(applied('\ta', indentEdit('\ta', 2, 2, true, '  ')).text).toBe('a');
    expect(applied(' a', indentEdit(' a', 2, 2, true, '    ')).text).toBe('a');
    expect(applied('a', indentEdit('a', 1, 1, true, '  ')).text).toBe('a');
    expect(applied('  a\n  b', indentEdit('  a\n  b', 0, 7, true, '  ')).text).toBe('a\nb');
  });

  it('works at the very start, with a first line that is empty, and on a lone empty line', () => {
    expect(applied('\nx', indentEdit('\nx', 0, 0, true, '  '))).toEqual({ text: '\nx', start: 0, end: 0 });
    expect(applied('', indentEdit('', 0, 0, true, '  ')).text).toBe('');
    expect(applied('', indentEdit('', 0, 0, false, '  ')).text).toBe('  ');
  });

  it('never moves the selection before the line it works on', () => {
    const e = indentEdit('  a', 1, 1, true, '  ');
    expect(e.start).toBeGreaterThanOrEqual(e.from);
  });
});

describe('small helpers', () => {
  it('counts lines and numbers them', () => {
    expect([lineCount(''), lineCount('a'), lineCount('a\n'), lineCount('a\nb')]).toEqual([1, 1, 2, 2]);
    expect(gutterText(3)).toBe('1\n2\n3');
  });

  it('writes sizes and paths', () => {
    expect([sizeText(0), sizeText(1023), sizeText(1024), sizeText(1536), sizeText(1024 * 1024)]).toEqual(['0 B', '1023 B', '1.0 KB', '1.5 KB', '1.0 MB']);
    expect([joinPath('', 'a'), joinPath('a/b', 'c'), parentOf('a/b/c.txt'), parentOf('c.txt')]).toEqual(['a', 'a/b/c', 'a/b', '']);
  });

  it('refuses a new path that cannot be a file, before the server is asked', () => {
    expect(newPathProblem('src/new.ts')).toBeNull();
    expect(newPathProblem('./a.txt')).toBeNull();
    for (const path of ['', '   ', 'src/', '/etc/x', '../x', 'a/../x', '.git/config', 'a/.GIT/x', 'a\0b']) expect(newPathProblem(path), JSON.stringify(path)).not.toBeNull();
  });

  it('keeps what was not saved by agent', () => {
    drafts.set('ana', { path: 'a.txt', value: 'x', base: 'y', etag: 'e', eol: '\n' });
    expect(drafts.get('ana')?.value).toBe('x');
    drafts.delete('ana');
    expect(drafts.has('ana')).toBe(false);
  });
});

describe('the views', () => {
  it('open on an agent, and a tab keeps the agent', () => {
    openHangar('ana');
    expect(store.getState()).toMatchObject({ selected: 'ana', view: 'hangar', consoleOpen: false });
    showRecorder();
    expect(store.getState()).toMatchObject({ selected: 'ana', view: 'recorder' });
    selectConsole('ben');
    showHangar();
    expect(store.getState()).toMatchObject({ selected: 'ben', view: 'hangar' });
    openRecorder('ana');
    expect(store.getState()).toMatchObject({ selected: 'ana', view: 'recorder' });
  });
});

const file = (index: string, tree: string, over: Partial<RecorderFile> = {}): RecorderFile => ({ path: 'a.txt', index, tree, ...over });

describe('what git says about a file', () => {
  it('says it in words, staged and not', () => {
    expect(fileLabels(file('?', '?'))).toEqual([{ text: 'untracked', staged: false }]);
    expect(fileLabels(file('M', ' '))).toEqual([{ text: 'staged: modified', staged: true }]);
    expect(fileLabels(file(' ', 'D'))).toEqual([{ text: 'not staged: deleted', staged: false }]);
    expect(fileLabels(file('A', 'M'))).toEqual([
      { text: 'staged: added', staged: true },
      { text: 'not staged: modified', staged: false },
    ]);
    expect(fileLabels(file('R', ' ', { from: 'old.txt' }))).toEqual([{ text: 'staged: renamed from old.txt', staged: true }]);
    for (const pair of ['UU', 'AA', 'DD', 'AU', 'UD']) expect(fileLabels(file(pair[0] ?? '', pair[1] ?? ''))).toEqual([{ text: 'conflict', staged: false }]);
  });

  it('counts what is staged', () => {
    expect(stagedCount([file('?', '?'), file('M', ' '), file('A', 'M'), file(' ', 'M')])).toBe(2);
    expect(shortHash('0123456789abcdef')).toBe('0123456');
  });
});

describe('diffLines', () => {
  it('tells the lines of a diff apart, and does not take a file header for a change', () => {
    const diff = ['diff --git a/x b/x', 'index 1..2', '--- a/x', '+++ b/x', '@@ -1,2 +1,2 @@', ' same', '-old', '+new', '--- a line that starts with dashes', '\\ No newline at end of file', ''].join('\n');
    expect(diffLines(diff).map((l) => l.kind)).toEqual(['meta', 'meta', 'meta', 'meta', 'hunk', 'ctx', 'del', 'add', 'del', 'ctx']);
    expect(diffLines('')).toEqual([]);
  });

  it('starts again at the next file', () => {
    const diff = 'diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/y b/y\n--- a/y\n+++ b/y\n@@ -1 +1 @@\n-c\n+d\n';
    expect(diffLines(diff).map((l) => l.kind)).toEqual(['meta', 'hunk', 'del', 'add', 'meta', 'meta', 'meta', 'hunk', 'del', 'add']);
  });
});

describe('commitProblem', () => {
  const files = [file('M', ' '), file(' ', 'M', { path: 'b.txt' })];
  it('says what is missing before the server is asked', () => {
    expect(commitProblem('m', 'all', files, false)).toContain('no author');
    expect(commitProblem('  ', 'all', files, true)).toBe('Write a message for the commit.');
    expect(commitProblem('x'.repeat(10_001), 'all', files, true)).toContain('At most');
    expect(commitProblem('m', 'all', [], true)).toBe('Nothing has changed.');
    expect(commitProblem('m', 'staged', [file(' ', 'M')], true)).toBe('Nothing is staged.');
    expect(commitProblem('m', 'staged', files, true)).toBeNull();
    expect(commitProblem('m', 'all', files, true)).toBeNull();
  });
});

describe('the colours of the pages', () => {
  // hangar.css and recorder.css use only these pairs, which every livery already has to hold
  const PAIRS: Array<[string, string]> = [
    ['--text', '--key'],
    ['--text', '--well'],
    ['--text', '--panel'],
    ['--text-2', '--panel'],
    ['--muted', '--well'],
    ['--muted', '--panel'],
    ['--lcd-text', '--lcd'],
    ['--lcd-dim', '--lcd'],
    ['--lcd-warm', '--lcd'],
  ];
  it.each(BUILTIN_LIVERIES.map((l) => [l.slug, l.tokens] as const))('%s keeps 4.5:1 on each pair', (_slug, tokens) => {
    const colours: Readonly<Record<string, string>> = tokens;
    for (const [text, surface] of PAIRS) expect(contrast(colours[text] ?? '', colours[surface] ?? ''), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
  });
});
