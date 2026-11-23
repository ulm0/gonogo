import { afterAll, describe, expect, it } from 'vitest';
import type { DockView, Task } from '../src/shared/protocol.js';
import { suggestedAddress, addressProblem, canHandOff, codeProblem, expiresText, handoffChoices, handoffRequest, localNote, statusText, toneOf, undockedText, wordOf } from '../src/client/docking.js';

// Set while the file loads: the dates below are made when the describe blocks are collected.
const savedZone = process.env.TZ;
process.env.TZ = 'America/New_York';
afterAll(() => {
  if (savedZone === undefined) delete process.env.TZ;
  else process.env.TZ = savedZone;
});

const at = (y: number, month: number, d: number, h = 0, min = 0): number => new Date(y, month - 1, d, h, min).getTime();
const now = at(2026, 11, 17, 15, 30);
const dock = (extra: Partial<DockView> = {}): DockView => ({ id: 'a'.repeat(32), name: 'lab', url: 'http://lab.test', since: 1, status: 'ok', seenAt: at(2026, 11, 17, 15, 29), error: null, agents: [], ...extra });
const task = (extra: Partial<Task> = {}): Task => ({ id: 't1', title: 'Fix it', detail: '', status: 'todo', assignee: null, createdBy: 'user', createdAt: 1, updatedAt: 1, notes: [], ...extra });

describe('addressProblem', () => {
  it('takes a web address with no path, and tells the rest what is wanted', () => {
    for (const ok of ['https://gonogo.example.com', 'http://192.168.1.5:7777', ' http://localhost:7777/ ', 'https://[::1]:8443']) expect(addressProblem(ok), ok).toBeUndefined();
    for (const bad of ['', 'gonogo', 'ftp://x.test', 'http://x.test/path', 'http://u:p@x.test', 'http://x.test/?a=1', 'http://x.test/#a', 'localhost:7777']) {
      expect(addressProblem(bad), bad).toBe('Type a web address with no path, such as https://gonogo.example.com.');
    }
  });
});

describe('codeProblem', () => {
  it('wants the whole code, which starts with its prefix', () => {
    expect(codeProblem('gonogo-dock:abc')).toBeUndefined();
    expect(codeProblem('  gonogo-dock:abc  ')).toBeUndefined();
    expect(codeProblem('')).toMatch(/^Paste the whole code/);
    expect(codeProblem('abc')).toBeUndefined(); // the server reads a code without its first words and says what is wrong with a bad one
  });
});

describe('localNote', () => {
  it('warns about an address that only this computer can reach, and says nothing of another', () => {
    for (const here of ['http://localhost:7777', 'http://127.0.0.1:7777', 'http://[::1]:7777', 'http://0.0.0.0:7777']) expect(localNote(here), here).toMatch(/only on this computer/);
    for (const there of ['https://gonogo.example.com', 'http://192.168.1.5:7777', 'http://100.64.0.2:7777', 'nonsense']) expect(localNote(there), there).toBeNull();
  });
});

describe('what a dock says', () => {
  it('the word, the tone and the line of each of the three states', () => {
    expect([wordOf(dock()), toneOf(dock())]).toEqual(['DOCKED', 'go']);
    expect([wordOf(dock({ status: 'down' })), toneOf(dock({ status: 'down' }))]).toEqual(['NO ANSWER', 'nogo']);
    expect([wordOf(dock({ status: 'new' })), toneOf(dock({ status: 'new' }))]).toEqual(['WAITING', 'quiet']);
    expect(statusText(dock(), now)).toBe('Answered at 15:29.');
    expect(statusText(dock({ status: 'new', seenAt: null }), now)).toBe('Waiting for the first answer.');
    expect(statusText(dock({ status: 'down', error: 'could not reach lab: ECONNREFUSED' }), now)).toBe('Not answering, last seen 15:29: could not reach lab: ECONNREFUSED');
    expect(statusText(dock({ status: 'down', seenAt: null, error: null }), now)).toBe('Not answering: no reason given');
  });

  it('a code says until when it works, and an undock says whether the other side was told', () => {
    expect(expiresText(at(2026, 11, 17, 15, 45), now)).toBe('It works once, until 15:45.');
    expect(undockedText('lab', true)).toBe('Undocked from lab.');
    expect(undockedText('lab', false)).toMatch(/^Undocked from lab\. It could not be reached/);
  });
});

describe('handing a task off', () => {
  it('offers nobody first, then the agents of the station, the boss marked', () => {
    expect(handoffChoices(dock())).toEqual([{ value: '', label: 'Nobody yet' }]);
    const agents = [
      { name: 'flight', role: 'boss', state: 'idle' as const, boss: true },
      { name: 'bob', role: 'tests', state: 'working' as const, boss: false },
    ];
    expect(handoffChoices(dock({ agents }))).toEqual([
      { value: '', label: 'Nobody yet' },
      { value: 'flight', label: 'flight (boss)' },
      { value: 'bob', label: 'bob' },
    ]);
  });

  it('only a task that is open here and was not handed off can go, and only when a station is docked', () => {
    expect(canHandOff(task(), [dock()])).toBe(true);
    expect(canHandOff(task({ status: 'blocked' }), [dock()])).toBe(true);
    expect(canHandOff(task(), [])).toBe(false);
    expect(canHandOff(task({ status: 'done' }), [dock()])).toBe(false);
    expect(canHandOff(task({ handedOff: 'lab', status: 'done' }), [dock()])).toBe(false);
  });

  it('asks for the task and the agent, or null for nobody', () => {
    expect(handoffRequest(task(), 'bob')).toEqual({ task: 't1', assignee: 'bob' });
    expect(handoffRequest(task(), '')).toEqual({ task: 't1', assignee: null });
  });
});

describe('localNote in a container', () => {
  it('says to use the host\'s network address, as seen from another machine', () => {
    expect(localNote('http://127.0.0.1:7777', true)).toMatch(/runs in a container.*host's network address.*address bar/);
    expect(localNote('http://127.0.0.1:7777', false)).not.toMatch(/container/);
    expect(localNote('http://192.168.0.5:7777', true)).toBeNull();
  });
});

describe('suggestedAddress', () => {
  it('starts the Address box with a network address of the computer when the page was opened as localhost, and keeps the scheme and the port', () => {
    expect(suggestedAddress('http://127.0.0.1:7777', ['192.168.0.5'])).toBe('http://192.168.0.5:7777');
    expect(suggestedAddress('http://localhost:7777', ['192.168.0.5', '10.0.0.2'])).toBe('http://192.168.0.5:7777');
    expect(suggestedAddress('https://localhost', ['192.168.0.5'])).toBe('https://192.168.0.5');
    expect(suggestedAddress('http://127.0.0.1:7777', [])).toBe('http://127.0.0.1:7777');
    expect(suggestedAddress('https://gonogo.example.com', ['192.168.0.5'])).toBe('https://gonogo.example.com');
    expect(suggestedAddress('nonsense', ['192.168.0.5'])).toBe('nonsense');
  });
});
