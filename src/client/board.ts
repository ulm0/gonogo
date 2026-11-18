import { BOARD_MAX_CHARS } from '../shared/protocol.js';
import type { AgentView, BoardView } from '../shared/protocol.js';
import { whenText } from './inbox.js';
import { legendOf } from './loop.js';

// What the Plot Board shows and asks, kept out of PlotBoard.tsx so that it can be tested without a DOM.

/**
 * What the box holds against the server's copy. `clean`: the same text; `edited`: typed in, and the board is still at the
 * revision the typing started from; `stale`: typed in, and the board moved on (the boss wrote, or another browser).
 */
export type BoardMode = 'clean' | 'edited' | 'stale';

export function boardMode(text: string, base: number, server: BoardView): BoardMode {
  if (text === server.text) return 'clean';
  return server.revision === base ? 'edited' : 'stale';
}

/** "Written by FLIGHT 14:03, revision 4.", "Written by hand 14:03." for a file made by hand, or the line for a board nobody wrote. */
export function writtenText(view: BoardView, agents: Readonly<Record<string, AgentView>>, now: number): string {
  if (view.updatedAt === null) return 'Nobody has written the Plot Board yet.';
  // a plan put in board.md by hand has the time of the file and no author
  if (view.author === null) return `Written by hand ${whenText(view.updatedAt, now)}.`;
  return `Written by ${legendOf(view.author, agents)} ${whenText(view.updatedAt, now)}, revision ${view.revision}.`;
}

export const countText = (text: string): string => `${text.length} of ${BOARD_MAX_CHARS} characters`;

/** The text as the server will keep it: line ends as \n and no trailing white space, so that the box can be compared with the server's copy. */
export const tidy = (text: string): string => text.replace(/\r\n?/g, '\n').trimEnd();

/** What a refused save says in the page, in the Director's words. */
export const conflictText = (view: BoardView, agents: Readonly<Record<string, AgentView>>): string =>
  `${view.author === null ? 'Someone' : legendOf(view.author, agents)} wrote revision ${view.revision} while you were typing. Your text is still in the box: copy it, then load the latest.`;
