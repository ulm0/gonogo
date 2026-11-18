/**
 * gonogo tui (docs/tui-spec.md): what an agent's output may do to the Director's terminal. A console passes the agent's raw bytes
 * through, and some escape sequences act outside the screen: OSC 52 writes the clipboard, OSC 0, 1 and 2 set the title of the window
 * or the tab. The agent's output decides what they say, so they are cut out. Everything else (colours, cursor, the alternate screen,
 * hyperlinks) passes. The filter keeps its state between chunks, because a sequence can be split anywhere by the pty and the socket.
 *
 * An OSC starts with ESC ] and ends with BEL or ESC \. A sequence being dropped that never ends is let go after MAX_DROP bytes, so a
 * lost terminator cannot swallow the screen for ever. Not handled: the 8-bit forms (0x9d, 0x9c), which a UTF-8 terminal does not read as such.
 */

/** The OSC numbers that are cut: 0 (icon and title), 1 (icon), 2 (title), 52 (clipboard). */
const DROPPED = new Set(['0', '1', '2', '52']);
export const MAX_DROP = 64 * 1024;
/** The longest number held back while it is decided: a longer one is not one of ours. */
const MAX_NUMBER = 4;

const ESC = 0x1b;
const BEL = 0x07;
const BRACKET = 0x5d; // ]
const BACKSLASH = 0x5c;
const SEMICOLON = 0x3b;

type Mode = 'text' | 'esc' | 'number' | 'drop' | 'drop-esc';

export interface OscFilter {
  /** The bytes of a chunk without the sequences that are cut. */
  filter(chunk: Uint8Array): Buffer;
  /** How many sequences were cut so far. */
  readonly cut: number;
}

export function createOscFilter(): OscFilter {
  let mode: Mode = 'text';
  /** The digits of an OSC number, held back until it is clear whether they are ours. */
  let digits = '';
  let dropped = 0;
  let count = 0;

  return {
    get cut() {
      return count;
    },
    filter(chunk) {
      const out: number[] = [];
      /** Gives back what was held back: it was not ours. */
      const release = (): void => {
        out.push(ESC, BRACKET, ...Buffer.from(digits, 'latin1'));
        digits = '';
      };
      for (const byte of chunk) {
        switch (mode) {
          case 'text':
            if (byte === ESC) mode = 'esc';
            else out.push(byte);
            break;
          case 'esc':
            if (byte === BRACKET) {
              mode = 'number';
              digits = '';
            } else {
              out.push(ESC);
              mode = 'text';
              // the byte may itself start a sequence (ESC ESC ]): look at it again
              if (byte === ESC) mode = 'esc';
              else out.push(byte);
            }
            break;
          case 'number':
            if (byte >= 0x30 && byte <= 0x39 && digits.length < MAX_NUMBER) {
              digits += String.fromCharCode(byte);
            } else if (DROPPED.has(digits) && (byte === SEMICOLON || byte === BEL || byte === ESC)) {
              // ours: the number is followed by its text, or by the end of the sequence
              count += 1;
              dropped = 0;
              digits = '';
              mode = byte === BEL ? 'text' : byte === ESC ? 'drop-esc' : 'drop';
            } else {
              // not ours (another number, none, or too long): it all goes through unchanged
              release();
              mode = 'text';
              if (byte === ESC) mode = 'esc';
              else out.push(byte);
            }
            break;
          case 'drop':
            dropped += 1;
            if (byte === BEL) mode = 'text';
            else if (byte === ESC) mode = 'drop-esc';
            else if (dropped > MAX_DROP) mode = 'text';
            break;
          case 'drop-esc':
            // ESC \ ends it; ESC followed by anything else starts something new that this sequence did not end: it is let go
            if (byte === BACKSLASH) mode = 'text';
            else if (byte === ESC) mode = 'drop-esc';
            else {
              mode = 'text';
              out.push(ESC, byte);
            }
            break;
        }
      }
      return Buffer.from(out);
    },
  };
}
