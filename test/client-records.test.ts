import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_KINDS, BOARD_MAX_CHARS } from '../src/shared/protocol.js';
import type { AgentView, BoardView } from '../src/shared/protocol.js';
import { copyText, countText as eventsText, gitText, KIND_CHIPS, stampText } from '../src/client/audit.js';
import { boardMode, conflictText, countText, tidy, writtenText } from '../src/client/board.js';

const agents = { flight: { name: 'flight', boss: true, position: 'flight' } } as unknown as Record<string, AgentView>;
const server = (over: Partial<BoardView> = {}): BoardView => ({ text: 'the plan', revision: 4, author: 'flight', updatedAt: Date.UTC(2026, 10, 18, 9, 30), ...over });

describe('the Plot Board page', () => {
  it('knows whether the box has typing in it, and whether the board moved on under it', () => {
    expect(boardMode('the plan', 4, server())).toBe('clean');
    expect(boardMode('the plan, edited', 4, server())).toBe('edited');
    expect(boardMode('the plan, edited', 3, server())).toBe('stale');
    // typing that ends up the same as the board is nothing to save, whatever the revision
    expect(boardMode('the plan', 3, server())).toBe('clean');
    expect(boardMode('', 0, server({ text: '', revision: 0 }))).toBe('clean');
  });

  it('says who wrote the plan and when, or that nobody did', () => {
    const now = Date.UTC(2026, 10, 18, 12, 0);
    expect(writtenText(server(), agents, now)).toMatch(/^Written by FLIGHT \d\d:\d\d, revision 4\.$/);
    expect(writtenText(server({ author: 'user' }), agents, now)).toMatch(/^Written by DIRECTOR /);
    expect(writtenText(server({ author: null, updatedAt: null, revision: 0 }), agents, now)).toBe('Nobody has written the Plot Board yet.');
    // a plan in the file by hand has no author, and is not "nobody"
    expect(writtenText(server({ author: null, updatedAt: now, revision: 0 }), agents, now)).toMatch(/^Written by hand \d\d:\d\d\.$/);
  });

  it('counts characters against the limit', () => {
    expect(countText('abc')).toBe(`3 of ${BOARD_MAX_CHARS} characters`);
    expect(countText('')).toBe(`0 of ${BOARD_MAX_CHARS} characters`);
  });

  it('keeps the text as the server will, so the box and the server compare equal', () => {
    expect(tidy('plan  \r\n\r\n')).toBe('plan');
    expect(tidy('a\rb')).toBe('a\nb');
  });

  it('says who changed the board in the words of the room', () => {
    expect(conflictText(server({ revision: 5 }), agents)).toBe('FLIGHT wrote revision 5 while you were typing. Your text is still in the box: copy it, then load the latest.');
    expect(conflictText(server({ author: null }), agents)).toMatch(/^Someone wrote revision 4 /);
  });
});

describe('the Black Box page', () => {
  it('has a chip for every kind of event, and a tone', () => {
    expect(Object.keys(KIND_CHIPS).sort()).toEqual([...AUDIT_KINDS].sort());
    for (const kind of AUDIT_KINDS) {
      expect(KIND_CHIPS[kind].text).toMatch(/^[A-Z -]+$/);
      expect(['amber', 'nogo', 'quiet']).toContain(KIND_CHIPS[kind].tone);
    }
  });

  it('says what git is doing, in one line for each state', () => {
    expect(gitText({ git: 'ok', note: '' })).toBe('Events are committed to a git repository, in batches.');
    expect(gitText({ git: 'missing', note: 'git was not found on the PATH' })).toBe('git was not found on the PATH. Events are written to the folder and not committed. Install git and restart gonogo.');
    expect(gitText({ git: 'error', note: 'fatal: cannot lock ref' })).toBe('git failed: fatal: cannot lock ref. Events are written to the folder; the next batch commits them again.');
  });

  it('writes a time in the zone of the browser, and survives one that is not a time', () => {
    expect(stampText(new Date(2026, 10, 18, 9, 5, 7).getTime())).toBe('2026-11-18 09:05:07');
    expect(stampText(Number.NaN)).toBe('--');
    expect(stampText(8.64e15 + 1)).toBe('--');
  });

  it('counts the events it shows', () => {
    expect(eventsText(0)).toBe('Nothing recorded yet.');
    expect(eventsText(1)).toBe('1 newest event. Older ones are in the repository.');
    expect(eventsText(200)).toBe('200 newest events. Older ones are in the repository.');
  });

  describe('copying the command', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('puts it on the clipboard', async () => {
      const writeText = vi.fn(async () => undefined);
      vi.stubGlobal('navigator', { clipboard: { writeText } });
      expect(await copyText('git -C x log -p')).toBe(true);
      expect(writeText).toHaveBeenCalledWith('git -C x log -p');
    });

    it('says no when the browser refuses or has no clipboard', async () => {
      vi.stubGlobal('navigator', { clipboard: { writeText: async () => Promise.reject(new Error('denied')) } });
      expect(await copyText('x')).toBe(false);
      vi.stubGlobal('navigator', {});
      expect(await copyText('x')).toBe(false);
    });
  });
});
