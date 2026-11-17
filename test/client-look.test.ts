import { describe, expect, it } from 'vitest';
import { BUILTIN_LIVERIES, builtinEntries, contrast, defaultView, LIVERY_BRIEF_MAX_CHARS, LIVERY_NAMES } from '../src/shared/livery.js';
import { askedText, briefProblem, currentEntry, LIVERY_STORAGE_KEY, storedEntry, SWATCH_TOKENS, sourceText, xtermTheme } from '../src/client/look.js';

const night = BUILTIN_LIVERIES[1]!;

describe('the livery that is on', () => {
  it('is the one the view names, and the default when the view names none it holds', () => {
    const view = defaultView();
    expect(currentEntry({ ...view, current: 'night-shift' }).slug).toBe('night-shift');
    expect(currentEntry({ ...view, current: 'gone' }).slug).toBe('instrument');
    expect(currentEntry({ current: 'gone', liveries: [] }).slug).toBe('instrument');
  });

  it('draws a swatch from tokens that every livery has', () => {
    for (const token of SWATCH_TOKENS) expect(LIVERY_NAMES).toContain(token);
    expect(new Set(SWATCH_TOKENS).size).toBe(SWATCH_TOKENS.length);
  });

  it('says where a livery comes from', () => {
    const [instrument] = builtinEntries();
    const legend = (name: string): string => name.toUpperCase();
    expect(sourceText(instrument!, legend)).toBe('Ships with gonogo');
    expect(sourceText({ ...instrument!, builtin: false, author: 'ana' }, legend)).toBe('Designed by ANA');
    expect(sourceText({ ...instrument!, builtin: false, author: null }, legend)).toBe('Custom');
  });
});

describe('the terminal', () => {
  it('takes its screen and its text from --lcd and --lcd-text, as plain hex that xterm reads', () => {
    expect(xtermTheme(night.tokens)).toEqual({ background: '#0b0e0d', foreground: '#a9ecd4', cursor: '#a9ecd4', cursorAccent: '#0b0e0d', selectionBackground: expect.stringMatching(/^#[0-9a-f]{6}$/) });
    expect(xtermTheme({ '--lcd': 'rgb(10 20 30)', '--lcd-text': 'hsl(0 0% 100%)' })).toMatchObject({ background: '#0a141e', foreground: '#ffffff' });
  });

  it('keeps the selection readable: between the screen and the text, and the text still reads on it', () => {
    for (const l of BUILTIN_LIVERIES) {
      const t = xtermTheme(l.tokens);
      expect(contrast(t.selectionBackground, t.background)!, l.slug).toBeGreaterThan(1.2);
      expect(contrast(t.foreground, t.selectionBackground)!, l.slug).toBeGreaterThan(3);
    }
  });

  it('falls back to the Instrument screen for a token it does not have', () => {
    expect(xtermTheme({})).toMatchObject({ background: '#2b2f2a', foreground: '#cfe6c9' });
    expect(xtermTheme({ '--lcd': 'red' })).toMatchObject({ background: '#2b2f2a' });
  });
});

describe('the copy kept in the browser', () => {
  const text = JSON.stringify({ slug: 'night-shift', tokens: night.tokens });

  it('is trusted only when it is a whole livery that passes the same check as a submit', () => {
    expect(LIVERY_STORAGE_KEY).toBe('gonogo.livery');
    expect(storedEntry(text)).toEqual({ slug: 'night-shift', tokens: night.tokens });
    const weak = { ...night.tokens, '--muted': '#444444' };
    for (const bad of [
      null,
      '',
      'not json',
      '5',
      'null',
      JSON.stringify({ slug: 'night-shift' }),
      JSON.stringify({ tokens: night.tokens }),
      JSON.stringify({ slug: 'Night Shift', tokens: night.tokens }),
      JSON.stringify({ slug: '../x', tokens: night.tokens }),
      JSON.stringify({ slug: 'x', tokens: weak }),
      JSON.stringify({ slug: 'x', tokens: { ...night.tokens, '--body': '#000; x: y' } }),
    ]) {
      expect(storedEntry(bad), String(bad)).toBeNull();
    }
  });
});

describe('the design box', () => {
  it('asks for a line of text of at most the limit', () => {
    expect(briefProblem('')).toBe('Say what you want it to look like.');
    expect(briefProblem('  \n ')).toBe('Say what you want it to look like.');
    expect(briefProblem('a calm look for night')).toBe('');
    expect(briefProblem('x'.repeat(LIVERY_BRIEF_MAX_CHARS))).toBe('');
    expect(briefProblem('x'.repeat(LIVERY_BRIEF_MAX_CHARS + 1))).toBe(`At most ${LIVERY_BRIEF_MAX_CHARS} characters.`);
  });

  it('says what happened to the request', () => {
    expect(askedText('FLIGHT', true, null)).toBe('Asked FLIGHT. The livery appears in the list when it submits one.');
    expect(askedText('ANA', false, 'ana is stopped')).toBe('Not sent: ana is stopped');
    expect(askedText('ANA', false, null)).toBe('Not sent: the message was not delivered');
  });
});
