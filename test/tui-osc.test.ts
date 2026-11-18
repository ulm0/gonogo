/** gonogo tui: the filter that cuts OSC 0, 1, 2 and 52 out of a console's output, across any split of the chunks. */
import { describe, expect, it } from 'vitest';
import { createOscFilter, MAX_DROP } from '../src/server/tui-osc.js';

const run = (...chunks: Array<string | Buffer>): string => {
  const f = createOscFilter();
  return Buffer.concat(chunks.map((c) => f.filter(typeof c === 'string' ? Buffer.from(c, 'utf8') : c))).toString('utf8');
};
const ESC = '\x1b';
const BEL = '\x07';
const ST = `${ESC}\\`;

describe('what is cut', () => {
  it.each(['0', '1', '2', '52'])('cuts OSC %s ended by BEL or by ST, with its text', (n) => {
    expect(run(`a${ESC}]${n};some text${BEL}b`)).toBe('ab');
    expect(run(`a${ESC}]${n};some text${ST}b`)).toBe('ab');
  });

  it('cuts the clipboard write with its base64 and a title with its text, and counts them', () => {
    const f = createOscFilter();
    expect(f.filter(Buffer.from(`x${ESC}]52;c;aGVsbG8=${BEL}y${ESC}]0;pwned${BEL}z`)).toString()).toBe('xyz');
    expect(f.cut).toBe(2);
  });

  it('cuts a sequence with no text, and one that is the whole chunk', () => {
    expect(run(`a${ESC}]2${BEL}b`)).toBe('ab');
    expect(run(`${ESC}]0;t${BEL}`)).toBe('');
    expect(run(`${ESC}]52;;${ST}`)).toBe('');
  });
});

describe('what passes', () => {
  it('lets plain text, colours, the cursor and the alternate screen through unchanged', () => {
    const text = `hello ${ESC}[31mred${ESC}[0m ${ESC}[2J${ESC}[H${ESC}[?1049h ${ESC}7 ${ESC}8 é😀\r\n`;
    expect(run(text)).toBe(text);
  });

  it('lets other OSC through: hyperlinks, the cwd, colours, and numbers that only start like ours', () => {
    for (const osc of [`${ESC}]8;;https://example.test${BEL}link${ESC}]8;;${BEL}`, `${ESC}]7;file:///tmp${BEL}`, `${ESC}]10;?${BEL}`, `${ESC}]11;rgb:00/00/00${ST}`, `${ESC}]20;x${BEL}`, `${ESC}]520;x${BEL}`, `${ESC}]12345;x${BEL}`, `${ESC}]${BEL}`, `${ESC}]x`]) {
      expect(run(`a${osc}b`), osc).toBe(`a${osc}b`);
    }
  });

  it('leaves a lone ESC, an ESC before another ESC, and a sequence that is not an OSC as they are', () => {
    expect(run(`${ESC}`)).toBe('');
    expect(run(`${ESC}x`)).toBe(`${ESC}x`);
    expect(run(`${ESC}${ESC}[1mx`)).toBe(`${ESC}${ESC}[1mx`);
    expect(run(`${ESC}${ESC}]2;t${BEL}k`)).toBe(`${ESC}k`);
  });
});

describe('across chunks', () => {
  const sample = `before ${ESC}]52;c;ZGF0YQ==${BEL} middle ${ESC}]0;title${ST} ${ESC}]8;;u${BEL}L${ESC}]8;;${BEL} after`;
  const expected = `before  middle  ${ESC}]8;;u${BEL}L${ESC}]8;;${BEL} after`;

  it('gives the same output however the bytes are split, down to one byte at a time', () => {
    expect(run(sample)).toBe(expected);
    const bytes = Buffer.from(sample, 'utf8');
    for (let size = 1; size <= 9; size += 1) {
      const parts: Buffer[] = [];
      for (let i = 0; i < bytes.length; i += size) parts.push(bytes.subarray(i, i + size));
      expect(run(...parts), `chunks of ${size}`).toBe(expected);
    }
    // every single split point
    for (let i = 0; i <= bytes.length; i += 1) expect(run(bytes.subarray(0, i), bytes.subarray(i)), `split at ${i}`).toBe(expected);
  });

  it('holds back what may be the start of ours until it knows, and gives it back when it is not', () => {
    const f = createOscFilter();
    expect(f.filter(Buffer.from(`a${ESC}`)).toString()).toBe('a');
    expect(f.filter(Buffer.from(']')).toString()).toBe('');
    expect(f.filter(Buffer.from('5')).toString()).toBe('');
    expect(f.filter(Buffer.from('3;x')).toString()).toBe(`${ESC}]53;x`);
  });
});

describe('a sequence that never ends', () => {
  it('is let go after MAX_DROP bytes, so a lost terminator does not swallow the screen', () => {
    const f = createOscFilter();
    f.filter(Buffer.from(`${ESC}]52;c;`));
    // the first MAX_DROP bytes are swallowed, the few after the limit are text again
    expect(f.filter(Buffer.alloc(MAX_DROP + 10, 0x41)).length).toBeLessThanOrEqual(12);
    expect(f.filter(Buffer.from('visible')).toString()).toBe('visible');
  });

  it('starts a new one after an interrupted one: an ESC that is not ST ends the drop and is kept', () => {
    expect(run(`${ESC}]2;t${ESC}[31mred`)).toBe(`${ESC}[31mred`);
  });
});
