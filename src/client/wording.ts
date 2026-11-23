import { DOCS_URL, STATE_LABELS } from '../shared/protocol.js';
import type { ExitSummary } from '../shared/protocol.js';

// Words the owner reads, kept out of the components so that they can be tested without a DOM.

/** Shown by the page and by the terminal pane when the server stays away. */
export const SERVER_GONE_TEXT = 'The gonogo server is not reachable. Is it still running? Retrying every 10 s.';

/**
 * What the brief box says once the server took the message: the note of contract 5.8 in plain words (the owner has never
 * heard of a pointer). A note that is not listed gets the generic sentence, so a server that learns a new note cannot
 * put its own jargon in the box. `boss` is the name in the server's notes; `shown` is what the room calls the agent (FLIGHT for the boss).
 */
export function briefSentText(note: string | null, boss: string, shown: string = boss): string {
  if (note === null) return 'Sent.';
  return `Sent. ${plainNote(note, boss, shown)}`;
}

function plainNote(note: string, boss: string, shown: string): string {
  switch (note) {
    case `waiting: ${boss} is starting`:
      return `${shown} is starting and will see it when ready.`;
    case `waiting: ${boss} is working`:
      return `${shown} is working and will see it when its turn ends.`;
    case `waiting: ${boss} needs you`:
      return `${shown} needs you first and will see it after you answer.`;
    case 'waiting: about to type the pointer':
    case 'waiting: confirming the pointer':
      return `${shown} will see it in a moment.`;
    case `waiting: ${boss} is not ready for input`:
      return `${shown} is not ready for input and will see it soon.`;
    case `waiting: ${boss} is restarting`:
      return `${shown} is restarting and will see it afterwards.`;
    case `waiting: ${boss} has not read it yet`:
      return `${shown} has not read it yet; gonogo will remind it.`;
    case `held: text in ${boss}'s input`:
      return `It waits until the text typed in ${shown}'s terminal is sent or cleared.`;
    case 'held: pointer not confirmed within 2 s':
      return `On hold: ${shown} did not pick it up. Check its terminal.`;
    case `held: no hook has reached gonogo from ${boss}; is its folder trusted?`:
      return `On hold: gonogo is not hearing from ${shown}. Is its folder trusted?`;
    default:
      return `${shown} will see it as soon as it can.`;
  }
}

/** What the stopped card adds under "<name> is stopped": the exit text, unless it only repeats that (a stop the owner asked for is just "stopped"). */
export function stoppedCardDetail(exit: ExitSummary | null): string | null {
  if (exit === null || exit.text === '' || exit.text === STATE_LABELS.stopped) return null;
  return exit.text;
}

/** The wire says "user"; the room says Director. Every name shown on the page goes through here. */
export function displayName(name: string): string {
  return name === 'user' ? 'Director' : name;
}

const LOAD_LIMIT_NOTE = /^waiting: load limit \((\d+) of (\d+) agents working\)$/;

/** A note of the hub in the room's words; a note that is not listed is shown as it came. */
export function plainActivityNote(note: string): string {
  const load = LOAD_LIMIT_NOTE.exec(note);
  if (load !== null) return `waiting for Max Q: ${load[1]} of ${load[2]} agents working`;
  return note;
}

/** The glossary of the words the first screens use (room, console, FLIGHT, brief, Downlink); a page of the docs. */
export const GLOSSARY_URL = `${DOCS_URL}guide/glossary`;
