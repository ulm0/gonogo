/** The text helpers of the terminal toolbar: the last answer and Find. */
import { describe, expect, it } from 'vitest';
import { findLine, lastAnswer } from '../src/client/terminalText.js';

describe('lastAnswer', () => {
  it('is what follows the last prompt line, trimmed', () => {
    expect(lastAnswer(['old', '> first question', 'first answer', '❯ second question', 'second answer', 'more', ''])).toBe('second answer\nmore');
  });

  it('is everything when there is no prompt line', () => {
    expect(lastAnswer(['a', 'b'])).toBe('a\nb');
  });

  it('does not take a line that merely starts with the mark glued to text', () => {
    expect(lastAnswer(['>not a prompt', 'x'])).toBe('>not a prompt\nx');
  });
});

describe('findLine', () => {
  const lines = ['Claude Code v1', 'Fake model', 'say fake again', 'end'];

  it('finds the next match without regard to case, from the line given', () => {
    expect(findLine(lines, 'FAKE', -1, false)).toEqual({ line: 1, column: 0 });
    expect(findLine(lines, 'fake', 1, false)).toEqual({ line: 2, column: 4 });
  });

  it('goes round the end, and backwards', () => {
    expect(findLine(lines, 'fake', 2, false)).toEqual({ line: 1, column: 0 });
    expect(findLine(lines, 'fake', 1, true)).toEqual({ line: 2, column: 4 });
  });

  it('is null for an empty query and for no match', () => {
    expect(findLine(lines, '', 0, false)).toBeNull();
    expect(findLine(lines, 'zzz', 0, false)).toBeNull();
  });
});
