/**
 * gonogo tui (docs/tui-spec.md): a console takes the whole screen and what you type goes to it unchanged. One key is the way out,
 * Ctrl-] (the one telnet uses; Claude Code does not): after it, q leaves the console, ? lists the keys, Ctrl-] again sends a
 * Ctrl-] to the console, and any other key is sent as it is, the Ctrl-] itself taken out.
 */

export const ESCAPE = '\x1d';

export interface ConsoleInput {
  /** True after a Ctrl-] that waits for its second key. */
  pending: boolean;
}

export interface ConsoleStep {
  state: ConsoleInput;
  /** What goes to the console. */
  send: string;
  /** Leave the console, or show the keys. Nothing after it in the chunk is sent. */
  action?: 'detach' | 'help';
}

export const initialConsoleInput = (): ConsoleInput => ({ pending: false });

/** A chunk of stdin in console mode: the text to send on, and whether the escape asked for something. */
export function consoleInput(state: ConsoleInput, chunk: string): ConsoleStep {
  let pending = state.pending;
  let send = '';
  for (const c of chunk) {
    if (pending) {
      pending = false;
      if (c === 'q') return { state: { pending }, send, action: 'detach' };
      if (c === '?') return { state: { pending }, send, action: 'help' };
      send += c;
    } else if (c === ESCAPE) pending = true;
    else send += c;
  }
  return { state: { pending }, send };
}

export const CONSOLE_HELP = ' Ctrl-] q: back to the room   Ctrl-] Ctrl-]: send Ctrl-]   Ctrl-] ?: this line ';
