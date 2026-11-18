import { describe, expect, it } from 'vitest';
import type { AgentView, MemoryView } from '../src/shared/protocol.js';
import { askedText, canAsk, hasBudget, overText, resultText, sizeLine, sizeText } from '../src/client/mass.js';

const view = (patch: Partial<MemoryView> = {}): MemoryView => ({ exists: true, bytes: 2150, lines: 63, softLines: 200, softBytes: 16384, over: false, changedAt: 1000, backup: null, ...patch });
const agent = (patch: Partial<AgentView> = {}): AgentView => ({ name: 'ana', provider: 'claude', state: 'idle', transition: null, ...patch }) as AgentView;
const NOW = Date.UTC(2026, 10, 17, 14, 30);

describe('sizes', () => {
  it('read in bytes, KB and MB', () => {
    expect([0, 812, 1023, 1024, 2150, 16384, 1048576, 1572864].map(sizeText)).toEqual(['0 B', '812 B', '1023 B', '1.0 KB', '2.1 KB', '16.0 KB', '1.0 MB', '1.5 MB']);
  });

  it('say the lines and the size, or that the file is not there or too big to count', () => {
    expect(sizeLine(view())).toBe('63 lines · 2.1 KB');
    expect(sizeLine(view({ lines: 1, bytes: 12 }))).toBe('1 line · 12 B');
    expect(sizeLine(view({ lines: null, bytes: 2 * 1024 * 1024 }))).toBe('2.0 MB');
    expect(sizeLine(view({ exists: false, bytes: 0, lines: 0 }))).toBe('not made yet');
  });
});

describe('the warning', () => {
  it('names both limits when over, and is absent otherwise', () => {
    expect(overText(view())).toBeNull();
    expect(overText(view({ over: true }))).toBe('Over the soft limit of 200 lines or 16.0 KB');
  });
});

describe('the last request', () => {
  it('is not mentioned when no copy was made', () => {
    expect(askedText(view(), NOW)).toBeNull();
  });

  it('says whether the notes changed after the copy', () => {
    const at = NOW - 60_000;
    expect(askedText(view({ backup: { bytes: 21000, at }, changedAt: at - 5 }), NOW)).toMatch(/^Asked at \d\d:\d\d\. The notes have not changed since\.$/);
    expect(askedText(view({ backup: { bytes: 21000, at }, changedAt: at }), NOW)).toMatch(/have not changed/);
    expect(askedText(view({ backup: { bytes: 21000, at }, changedAt: at + 5 }), NOW)).toMatch(/changed since: 20\.5 KB then, 2\.1 KB now\.$/);
    expect(askedText(view({ backup: { bytes: 5, at }, changedAt: null }), NOW)).toMatch(/have not changed/);
  });
});

describe('who can be asked', () => {
  it('is an agent with the gonogo tools, and only while it runs', () => {
    expect(hasBudget(agent())).toBe(true);
    expect(hasBudget(agent({ provider: 'custom' }))).toBe(false);
    expect(canAsk(agent())).toBe(true);
    expect(canAsk(agent({ state: 'working' }))).toBe(true);
    expect(canAsk(agent({ state: 'stopped' }))).toBe(false);
    expect(canAsk(agent({ transition: 'restarting' }))).toBe(false);
  });

  it('is told what happened', () => {
    const send = { ok: true, id: 'm1', to: 'ana', status: 'queued', note: null } as const;
    expect(resultText('ana', { send, memory: view() })).toMatch(/^Asked ana to condense its notes\..*memory\.md\.bak\.$/);
    expect(resultText('ana', { send: { ...send, ok: false, status: 'undelivered', note: 'ana is stopped' }, memory: view() })).toBe('Not sent: ana is stopped.');
    expect(resultText('ana', { send: { ...send, ok: false, status: 'undelivered', note: null }, memory: view() })).toBe('Not sent: the hub did not deliver it.');
  });
});
