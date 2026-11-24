import { describe, expect, it } from 'vitest';
import { LONG_TEXT_EXCERPT_CHARS, LONG_TEXT_MAX_CHARS, longTextBody, longTextExcerpt, longTextKind, longTextNote } from '../src/shared/longtext.js';
import { BODY_MAX_CHARS } from '../src/shared/protocol.js';

describe('long text (shared/longtext.ts)', () => {
  it('a text that fits is sent as it is; more goes as a file; more than the most is refused', () => {
    expect(longTextKind(0)).toBe('short');
    expect(longTextKind(BODY_MAX_CHARS)).toBe('short');
    expect(longTextKind(BODY_MAX_CHARS + 1)).toBe('file');
    expect(longTextKind(LONG_TEXT_MAX_CHARS)).toBe('file');
    expect(longTextKind(LONG_TEXT_MAX_CHARS + 1)).toBe('too_long');
  });

  it('the line under the box says the size, the limit and what happens, and nothing when it fits', () => {
    expect(longTextNote(BODY_MAX_CHARS, 'FLIGHT')).toBeNull();
    expect(longTextNote(45_210, 'FLIGHT')).toEqual({
      text: 'Long text: 45,210 characters. A message holds 20,000, so it is saved as a file for FLIGHT; the message carries its path and the first lines.',
      tone: 'hint',
    });
    expect(longTextNote(LONG_TEXT_MAX_CHARS + 1, 'FLIGHT')).toEqual({
      text: 'Too long to send: 1,000,001 characters. The most is 1,000,000. Cut it, or save it as a file and send the path.',
      tone: 'danger',
    });
  });

  it('the excerpt is the first lines, cut at a line end near the limit, never in half of a pair', () => {
    expect(longTextExcerpt('short')).toBe('short');
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
    const cut = longTextExcerpt(lines);
    expect(cut.length).toBeLessThanOrEqual(LONG_TEXT_EXCERPT_CHARS);
    expect(lines.startsWith(`${cut}\n`)).toBe(true);
    const emoji = longTextExcerpt('a'.repeat(LONG_TEXT_EXCERPT_CHARS - 1) + '\u{1f44d}'.repeat(10));
    expect(emoji).toBe('a'.repeat(LONG_TEXT_EXCERPT_CHARS - 1));
  });

  it('the message names the file, the size and the first lines, and always fits in a message', () => {
    const text = `${'q'.repeat(30)}\n`.repeat(30_000);
    const body = longTextBody(text, '/home/agents/flight/inbox-files/m7-long-text.txt');
    expect(body).toContain('930,000 characters, 30,001 lines');
    expect(body).toContain('/home/agents/flight/inbox-files/m7-long-text.txt');
    expect(body.length).toBeLessThan(BODY_MAX_CHARS);
    expect(body.endsWith('…')).toBe(true);
  });
});
