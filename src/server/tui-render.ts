/**
 * gonogo tui (docs/tui-spec.md): the screen as text. `render` is pure: the room, the screen state and a size go in, exactly `rows`
 * lines of exactly `cols` visible characters come out, with ANSI colours (the 16 standard ones) unless `color` is off. A state has
 * a glyph and a word, so the colour is never the only mark, and a log of the session still reads. Every text of the server goes
 * through `clean` first: an agent wrote it, and the terminal acts on what it is given.
 */
import { DOCS_URL, STATE_LABELS, tabTitle } from '../shared/protocol.js';
import type { AgentView, DownlinkItem } from '../shared/protocol.js';
import { lengths } from './tui-keys.js';
import type { Ui } from './tui-keys.js';
import { clean, inboxOf, isOnHold, isUnread, itemLine, needsOf } from './tui-state.js';
import type { TuiState } from './tui-state.js';

export interface Size {
  cols: number;
  rows: number;
}
export interface RenderOptions {
  color: boolean;
}

/** A piece of a line and how it is drawn. */
type Seg = readonly [text: string, style?: Style];
type Style = 'bold' | 'dim' | 'inverse' | 'go' | 'warn' | 'bad' | 'info';
const CODES: Readonly<Record<Style, string>> = { bold: '1', dim: '2', inverse: '7', go: '32', warn: '33', bad: '31', info: '36' };

const paint = (text: string, style: Style | undefined, color: boolean): string => (color && style !== undefined && text !== '' ? `\x1b[${CODES[style]}m${text}\x1b[0m` : text);

/** Segments cut to `width` visible characters and padded with spaces to it. */
function fit(width: number, segs: readonly Seg[], color: boolean): string {
  let left = Math.max(0, width);
  let out = '';
  for (const [text, style] of segs) {
    if (left <= 0) break;
    const chars = [...text];
    const shown = chars.length > left ? `${chars.slice(0, Math.max(0, left - 1)).join('')}…` : text;
    out += paint(shown, style, color);
    left -= [...shown].length;
  }
  return out + ' '.repeat(Math.max(0, left));
}

const wrap = (text: string, width: number): string[] => {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const words = clean(raw, 4000).split(' ');
    let line = '';
    for (const word of words) {
      if (line !== '' && [...line].length + 1 + [...word].length > width) {
        out.push(line);
        line = '';
      }
      line = line === '' ? word : `${line} ${word}`;
      while ([...line].length > width) {
        out.push([...line].slice(0, width).join(''));
        line = [...line].slice(width).join('');
      }
    }
    out.push(line);
  }
  return out;
};

const GLYPH: Readonly<Record<AgentView['state'], string>> = { starting: '~', idle: '.', working: '*', needs_you: '!', stopped: '-' };
const STATE_STYLE: Readonly<Record<AgentView['state'], Style | undefined>> = { starting: 'dim', idle: 'go', working: 'info', needs_you: 'warn', stopped: 'dim' };

export function stateWord(a: AgentView): string {
  if (isOnHold(a)) return 'on hold';
  return a.transition ?? STATE_LABELS[a.state];
}

const clock = (at: number): string => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** A window of `height` rows over `count` rows that keeps `cursor` in sight. */
function windowOf(count: number, cursor: number, height: number): { from: number; to: number } {
  if (count <= height) return { from: 0, to: count };
  const from = Math.max(0, Math.min(cursor - Math.floor(height / 2), count - height));
  return { from, to: from + height };
}

function roomPane(state: TuiState, ui: Ui, width: number, height: number, active: boolean, color: boolean): string[] {
  const out: string[] = [fit(width, [['ROOM', 'bold']], color)];
  if (!state.loaded) return pad(out.concat(fit(width, [[state.link === 'unauthorized' ? 'The server refused the token.' : 'Waiting for the server…', 'dim']], color)), width, height, color);
  if (state.agents.length === 0) return pad(out.concat(fit(width, [['No consoles yet. Staff one from the page.', 'dim']], color)), width, height, color);
  const { from, to } = windowOf(state.agents.length, ui.room, height - 1);
  for (let i = from; i < to; i += 1) {
    const a = state.agents[i] as AgentView;
    const here = active && i === ui.room;
    const extra = a.state === 'needs_you' && !isOnHold(a) ? clean(a.needsReason ?? '', 120) : a.held !== null ? clean(a.held.text, 120) : a.queued > 0 ? `${a.queued} waiting` : '';
    const segs: Seg[] = [
      [here ? '> ' : '  ', here ? 'bold' : undefined],
      [`${GLYPH[a.state]} `, STATE_STYLE[a.state]],
      [clean(a.name, 16).padEnd(width >= 70 ? 14 : 10), here ? 'bold' : undefined],
      [stateWord(a).padEnd(10), isOnHold(a) ? 'warn' : STATE_STYLE[a.state]],
      ...(width >= 70 ? ([[(a.position === null ? '' : clean(a.position, 12)).padEnd(10), 'dim']] as Seg[]) : []),
      [extra, a.state === 'needs_you' ? 'warn' : 'dim'],
    ];
    out.push(fit(width, here ? [['', undefined], ...segs.map(([t]) => [t, 'inverse'] as Seg)] : segs, color));
  }
  return pad(out, width, height, color);
}

function inboxPane(state: TuiState, ui: Ui, width: number, height: number, active: boolean, color: boolean): string[] {
  const items = inboxOf(state);
  const out: string[] = [fit(width, [['INBOX', 'bold'], [`  ${state.downlink.unread} unread`, 'dim']], color)];
  if (items.length === 0) return pad(out.concat(fit(width, [['Nothing in the Downlink.', 'dim']], color)), width, height, color);
  if (active && ui.detail) {
    const item = items[Math.min(ui.inbox, items.length - 1)] as DownlinkItem;
    const head = item.type === 'message' ? `From ${clean(item.from, 40)}: ${clean(item.subject, 120)}` : `Event ${item.kind}`;
    out.push(fit(width, [[head, 'bold']], color));
    const text = item.type === 'message' ? item.body + (item.truncated ? '\n[cut: the rest is in the log]' : '') : item.text;
    for (const l of wrap(text, Math.max(10, width))) out.push(fit(width, [[l]], color));
    return pad(out, width, height, color);
  }
  const { from, to } = windowOf(items.length, ui.inbox, height - 1);
  for (let i = from; i < to; i += 1) {
    const item = items[i] as DownlinkItem;
    const here = active && i === ui.inbox;
    const unread = isUnread(item);
    const segs: Seg[] = [
      [here ? '> ' : '  ', undefined],
      [unread ? 'NEW ' : '    ', unread ? 'warn' : undefined],
      [`${clock(item.at)} `, 'dim'],
      [itemLine(item, 400), undefined],
    ];
    out.push(fit(width, here ? segs.map(([t]) => [t, 'inverse'] as Seg) : segs, color));
  }
  return pad(out, width, height, color);
}

function needsPane(state: TuiState, ui: Ui, width: number, height: number, active: boolean, color: boolean): string[] {
  const needs = needsOf(state);
  const out: string[] = [fit(width, [['NEEDS YOU', 'bold'], [`  ${needs.length}`, 'dim']], color)];
  if (needs.length === 0) return pad(out.concat(fit(width, [['Nothing waits for a go or a no-go.', 'dim']], color)), width, height, color);
  const { from, to } = windowOf(needs.length, ui.needs, height - 1);
  for (let i = from; i < to; i += 1) {
    const n = needs[i]!;
    const here = active && i === ui.needs;
    const segs: Seg[] = [[here ? '> ' : '  ', undefined], [n.kind === 'permission' ? 'permission ' : 'hire       ', 'warn'], [n.kind === 'permission' ? `${clean(n.agent, 16)}: ` : `${n.by}: `, undefined], [n.reason, undefined]];
    out.push(fit(width, here ? segs.map(([t]) => [t, 'inverse'] as Seg) : segs, color));
  }
  return pad(out, width, height, color);
}

function pollPane(state: TuiState, width: number, height: number, color: boolean): string[] {
  const out: string[] = [fit(width, [['POLL', 'bold']], color)];
  const poll = state.poll;
  if (poll === null) return pad(out.concat(fit(width, [['No poll is open. Press t to call a T-minus poll.', 'dim']], color)), width, height, color);
  const style: Style = poll.status === 'go' ? 'go' : poll.status === 'hold' ? 'warn' : poll.status === 'aborted' ? 'bad' : 'info';
  out.push(fit(width, [[`${poll.subject === undefined ? 'T-minus' : `Static fire: ${clean(poll.subject, 60)}`}: `, undefined], [poll.status.toUpperCase(), style]], color));
  out.push(fit(width, [[clean(poll.note, 200), 'dim']], color));
  for (const e of poll.entries.slice(0, Math.max(0, height - 4))) {
    out.push(fit(width, [['  ', undefined], [clean(e.agent, 16).padEnd(14), undefined], [(e.vote ?? 'waiting').padEnd(9), e.vote === 'go' ? 'go' : e.vote === 'no-go' ? 'bad' : 'dim'], [clean(e.reason, 200), 'dim']], color));
  }
  return pad(out, width, height, color);
}

/** The end of what is being typed: the part that fits, so the cursor is always in sight. */
const tail = (text: string, room: number): string => (room > 0 && [...text].length > room ? [...text].slice(-room).join('') : text);

const blank = (width: number): string => ' '.repeat(Math.max(0, width));
function pad(lines: string[], width: number, height: number, _color: boolean): string[] {
  const out = lines.slice(0, height);
  while (out.length < height) out.push(blank(width));
  return out;
}

const HELP: readonly string[] = [
  'KEYS',
  '  1 2 3 4, Tab   ROOM, INBOX, NEEDS, POLL',
  '  up down, j k   move',
  '  ROOM    Enter attach to the console   n message   h hold   r resume',
  '  INBOX   Enter read the message   r reply   a archive',
  '  NEEDS   g GO   x NO-GO   (a permission dialog, or a hire request)',
  '  POLL    t call a T-minus poll',
  '  ?       this help      q, Ctrl-C   leave',
  'In a console: everything you type goes to it. Ctrl-] then q leaves it, Ctrl-] then ? lists the keys, Ctrl-] twice sends Ctrl-].',
  'A console has one size: attaching resizes it to this terminal, and the page follows.',
  `Docs: ${DOCS_URL}`,
];

const FOOTERS: Readonly<Record<Ui['screen'], string>> = {
  room: 'Enter attach  n message  h hold  r resume  Tab screens  ? help  q quit',
  inbox: 'Enter read  r reply  a archive  Tab screens  ? help  q quit',
  needs: 'g GO  x NO-GO  up/down choose  Tab screens  ? help  q quit',
  poll: 't call a poll  Tab screens  ? help  q quit',
};

const LINK_TEXT: Readonly<Record<TuiState['link'], string>> = { connecting: 'connecting…', open: 'connected', reconnecting: 'reconnecting…', unauthorized: 'token refused' };

/** The whole screen: exactly `rows` lines of `cols` visible characters. */
export function render(state: TuiState, ui: Ui, size: Size, options: RenderOptions): string[] {
  const cols = Math.max(20, size.cols);
  const rows = Math.max(6, size.rows);
  const color = options.color;
  const size2 = lengths(state);
  const needs = needsOf(state);
  const tabs: Array<[Ui['screen'], string, number]> = [['room', 'ROOM', size2.room], ['inbox', 'INBOX', state.downlink.unread], ['needs', 'NEEDS', needs.length], ['poll', 'POLL', state.poll === null ? 0 : 1]];
  // the name of the room, as the tab says it (cleaned: it is text from the server)
  const head: Seg[] = [[clean(tabTitle(state.tabName), 60), 'bold'], ['  ', undefined]];
  tabs.forEach(([id, name, n], i) => {
    const label = `${i + 1} ${name}${n > 0 && id !== 'room' && id !== 'poll' ? ` ${n}` : ''}`;
    head.push([` ${label} `, id === ui.screen ? 'inverse' : id === 'needs' && n > 0 ? 'warn' : undefined]);
  });
  head.push([`  ${LINK_TEXT[state.link]}`, state.link === 'open' ? 'dim' : 'warn']);
  const out: string[] = [fit(cols, head, color)];
  // the strip of what waits: it is on every screen, so a request is never off screen
  const first = needs[0];
  out.push(
    first === undefined
      ? fit(cols, [['Nothing waits for you.', 'dim']], color)
      : fit(cols, [[`NEEDS ${needs.length}: `, 'warn'], [first.kind === 'permission' ? `${clean(first.agent, 20)}: ${first.reason}` : `${first.by} asks to ${first.reason}`, undefined], [ui.screen === 'needs' ? '' : '  (press 3)', 'dim']], color),
  );
  const bodyHeight = rows - 4;
  let body: string[];
  if (ui.help) {
    body = pad(HELP.flatMap((l) => wrap(l, cols - 2).map((w, i) => fit(cols, [[(i === 0 ? '' : '    ') + w, l === 'KEYS' ? 'bold' : undefined]], color))), cols, bodyHeight, color);
  } else if (cols >= 100) {
    const left = Math.floor(cols * 0.45);
    const right = cols - left - 3;
    const l = roomPane(state, ui, left, bodyHeight, ui.screen === 'room', color);
    const r =
      ui.screen === 'needs' ? needsPane(state, ui, right, bodyHeight, true, color) : ui.screen === 'poll' ? pollPane(state, right, bodyHeight, color) : inboxPane(state, ui, right, bodyHeight, ui.screen === 'inbox', color);
    body = l.map((line, i) => `${line} │ ${r[i] ?? blank(right)}`);
  } else {
    body =
      ui.screen === 'room'
        ? roomPane(state, ui, cols, bodyHeight, true, color)
        : ui.screen === 'inbox'
          ? inboxPane(state, ui, cols, bodyHeight, true, color)
          : ui.screen === 'needs'
            ? needsPane(state, ui, cols, bodyHeight, true, color)
            : pollPane(state, cols, bodyHeight, color);
  }
  out.push(...body);
  // the line of the editor, or of what the last key did
  out.push(
    ui.compose === null
      ? fit(cols, [[ui.flash, 'warn']], color)
      : fit(cols, [[`${ui.compose.label}> `, 'bold'], [tail(ui.compose.text.replace(/[\u0000-\u001f\u007f]/g, ' '), cols - ui.compose.label.length - 4), undefined], ['_', 'dim']], color),
  );
  out.push(fit(cols, [[ui.compose === null ? FOOTERS[ui.screen] : 'Enter send  Esc cancel  Ctrl-U clear', 'dim']], color));
  return out;
}
