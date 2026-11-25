// Boxes that send on Enter: Enter sends, Shift+Enter is a newline, and Enter that confirms an input-method composition sends nothing.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { enterSends } from '../src/client/Brief.js';

const key = (k: string, shiftKey = false, isComposing = false): Parameters<typeof enterSends>[0] => ({ key: k, shiftKey, nativeEvent: { isComposing } as KeyboardEvent });

describe('enterSends', () => {
  it('sends on Enter alone', () => expect(enterSends(key('Enter'))).toBe(true));
  it('does not send on Shift+Enter (a new line)', () => expect(enterSends(key('Enter', true))).toBe(false));
  it('does not send while an input method is composing', () => expect(enterSends(key('Enter', false, true))).toBe(false));
  it('does not send on another key', () => expect(enterSends(key('a'))).toBe(false));
});

describe('the reply box under a message', () => {
  const source = readFileSync('src/client/Activity.tsx', 'utf8');
  const reply = source.slice(source.indexOf('export function Reply'), source.indexOf('function Row'));
  it('is a text area (an input line has no new line) that asks the same rule as the Brief box', () => {
    expect(reply).toContain('<Textarea');
    expect(reply).not.toMatch(/<(input|Input)\b/);
    expect(reply).toContain('enterSends(event)');
  });
});
