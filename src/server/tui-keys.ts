/**
 * gonogo tui (docs/tui-spec.md): the bytes a terminal sends become keys, and a key changes the screen or asks for an action.
 * Pure: `step` takes the screen state and the room, and answers the new screen state and what to do. The app does it.
 */
import { clean, inboxOf, needsOf } from './tui-state.js';
import type { TuiState } from './tui-state.js';

export type Key = string;

const CSI: Readonly<Record<string, Key>> = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end' };
const TILDE: Readonly<Record<string, Key>> = { '1': 'home', '3': 'delete', '4': 'end', '5': 'pageup', '6': 'pagedown', '7': 'home', '8': 'end' };

/** The keys in a chunk of stdin. A chunk is whole keys: a lone Escape is the Escape key. Control keys are `ctrl-c`; printable characters are themselves. */
export function parseKeys(input: string): Key[] {
  const keys: Key[] = [];
  const chars = [...input];
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i] as string;
    if (c === '\x1b') {
      const next = chars[i + 1];
      if ((next === '[' || next === 'O') && i + 2 < chars.length) {
        // a sequence: parameters, then one final letter or ~
        let j = i + 2;
        let params = '';
        while (j < chars.length && /[0-9;]/.test(chars[j] as string)) params += chars[j++];
        const final = chars[j] ?? '';
        keys.push(final === '~' ? (TILDE[params.split(';')[0] ?? ''] ?? 'unknown') : (CSI[final] ?? 'unknown'));
        i = j;
        continue;
      }
      keys.push('esc');
      continue;
    }
    if (c === '\r' || c === '\n') keys.push('enter');
    else if (c === '\t') keys.push('tab');
    else if (c === '\x7f' || c === '\b') keys.push('backspace');
    else if (c === '\x03') keys.push('ctrl-c');
    else if (c === '\x15') keys.push('ctrl-u');
    else if (c === '\x1d') keys.push('ctrl-]');
    else if (c.charCodeAt(0) < 0x20) keys.push('unknown');
    else keys.push(c);
  }
  return keys;
}

export const SCREENS = ['room', 'inbox', 'needs', 'poll'] as const;
export type Screen = (typeof SCREENS)[number];

export interface Compose {
  to: string;
  /** What the line says it is for: "Message to ana", "Reply to ana". */
  label: string;
  subject: string;
  inReplyTo?: string;
  text: string;
}

export interface Ui {
  screen: Screen;
  room: number;
  inbox: number;
  needs: number;
  /** The inbox shows the whole message of the item under the cursor. */
  detail: boolean;
  help: boolean;
  compose: Compose | null;
  /** One line of what the last action did or refused, until the next key. */
  flash: string;
}

export const initialUi = (): Ui => ({ screen: 'room', room: 0, inbox: 0, needs: 0, detail: false, help: false, compose: null, flash: '' });

export type Action =
  | { kind: 'attach'; agent: string }
  | { kind: 'send'; to: string; subject: string; body: string; inReplyTo?: string }
  | { kind: 'hold'; agent: string }
  | { kind: 'resume'; agent: string }
  | { kind: 'read'; ids: string[] }
  | { kind: 'archive'; ids: string[] }
  | { kind: 'answer'; agent: string; go: boolean; needSeq: number | null }
  | { kind: 'relief'; id: string; go: boolean }
  | { kind: 'poll' }
  | { kind: 'quit' };

/** The longest message the line editor takes. */
export const COMPOSE_MAX = 2000;

const clamp = (n: number, length: number): number => Math.max(0, Math.min(n, Math.max(0, length - 1)));

/** The lengths of the three lists, so a cursor never points past the end after a list shrinks. */
export function lengths(state: TuiState): { room: number; inbox: number; needs: number } {
  return { room: state.agents.length, inbox: inboxOf(state).length, needs: needsOf(state).length };
}

/** What one key does. A key that means nothing here does nothing. */
export function step(ui: Ui, state: TuiState, key: Key): { ui: Ui; actions: Action[] } {
  const size = lengths(state);
  const cleared: Ui = { ...ui, flash: '', room: clamp(ui.room, size.room), inbox: clamp(ui.inbox, size.inbox), needs: clamp(ui.needs, size.needs) };
  const done = (next: Partial<Ui>, actions: Action[] = []): { ui: Ui; actions: Action[] } => ({ ui: { ...cleared, ...next }, actions });

  if (ui.help) return done({ help: false });

  if (ui.compose !== null) {
    const c = ui.compose;
    if (key === 'esc') return done({ compose: null });
    if (key === 'enter') {
      const body = c.text.trim();
      if (body === '') return done({ compose: null });
      return done({ compose: null, flash: `Sent to ${c.to}.` }, [{ kind: 'send', to: c.to, subject: c.subject, body, ...(c.inReplyTo === undefined ? {} : { inReplyTo: c.inReplyTo }) }]);
    }
    if (key === 'backspace') return done({ compose: { ...c, text: [...c.text].slice(0, -1).join('') } });
    if (key === 'ctrl-u') return done({ compose: { ...c, text: '' } });
    if (key === 'ctrl-c') return done({ compose: null });
    if ([...key].length === 1 && c.text.length < COMPOSE_MAX) return done({ compose: { ...c, text: c.text + key } });
    return done({});
  }

  if (key === 'ctrl-c' || key === 'q') return done({}, [{ kind: 'quit' }]);
  if (key === '?') return done({ help: true });
  if (key === 'tab') return done({ screen: SCREENS[(SCREENS.indexOf(ui.screen) + 1) % SCREENS.length] as Screen, detail: false });
  const direct = ['1', '2', '3', '4'].indexOf(key);
  if (direct >= 0) return done({ screen: SCREENS[direct] as Screen, detail: false });

  const move = key === 'up' || key === 'k' ? -1 : key === 'down' || key === 'j' ? 1 : 0;

  if (ui.screen === 'room') {
    if (move !== 0) return done({ room: clamp(cleared.room + move, size.room) });
    const agent = state.agents[cleared.room];
    if (agent === undefined) return done({});
    if (key === 'enter') return done({}, [{ kind: 'attach', agent: agent.name }]);
    if (key === 'n') return done({ compose: { to: agent.name, label: `Message to ${clean(agent.name, 40)}`, subject: '', text: '' } });
    if (key === 'h') return done({}, [{ kind: 'hold', agent: agent.name }]);
    if (key === 'r') return done({}, [{ kind: 'resume', agent: agent.name }]);
    return done({});
  }

  if (ui.screen === 'inbox') {
    const items = inboxOf(state);
    if (move !== 0) return done({ inbox: clamp(cleared.inbox + move, size.inbox), detail: false });
    const item = items[cleared.inbox];
    if (item === undefined) return done({});
    if (key === 'enter') return done({ detail: !ui.detail }, item.read || item.archived || ui.detail ? [] : [{ kind: 'read', ids: [item.id] }]);
    if (key === 'a') return done({ detail: false }, [{ kind: 'archive', ids: [item.id] }]);
    if (key === 'r') {
      if (item.type !== 'message') return done({ flash: 'Only a message can be answered.' });
      return done({ compose: { to: item.from, label: `Reply to ${clean(item.from, 40)}`, subject: /^re:/i.test(item.subject) ? item.subject : `Re: ${item.subject}`.trim(), inReplyTo: item.id, text: '' } }, item.read ? [] : [{ kind: 'read', ids: [item.id] }]);
    }
    return done({});
  }

  if (ui.screen === 'needs') {
    if (move !== 0) return done({ needs: clamp(cleared.needs + move, size.needs) });
    const need = needsOf(state)[cleared.needs];
    if (need === undefined) return done({});
    if (key === 'g' || key === 'x') {
      const go = key === 'g';
      return done({ flash: go ? 'GO sent.' : 'NO-GO sent.' }, [need.kind === 'permission' ? { kind: 'answer', agent: need.agent, go, needSeq: need.needSeq } : { kind: 'relief', id: need.id, go }]);
    }
    return done({});
  }

  // poll
  if (key === 't') return done({}, [{ kind: 'poll' }]);
  return done({});
}
