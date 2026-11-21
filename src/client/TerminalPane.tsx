import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { AgentView, SizeFrame, SnapshotFrame } from '../shared/protocol.js';
import { RECONNECT_SERVER_GONE_AFTER, RESIZE_DEBOUNCE_MS } from '../shared/protocol.js';
import * as api from './api.js';
import { currentEntry, xtermTheme } from './look.js';
import { store, useStore } from './store.js';
import { findLine, lastAnswer } from './terminalText.js';
import type { ClientState } from './store.js';
import { SERVER_GONE_TEXT } from './wording.js';

const MONO_FONT = '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
/** xterm measures its character cell after open(); if that is not done yet, look again a few times before attaching without a size. */
const MEASURE_RETRIES = 10;
const MEASURE_RETRY_MS = 50;
/** Far beyond the server's MAX_COLS and MAX_ROWS: only a broken frame is refused. */
const MAX_SANE_DIMENSION = 1000;

export interface PaneTarget {
  agent: AgentView | null;
  connection: ClientState['connection'];
}

/** What the toolbar of the console (TerminalBar.tsx) does to the screen: text out of the buffer, the size of the letters, a search, the bottom. */
export interface PaneTools {
  /** The text of the selection, the visible screen, the whole scrollback, or what came after the last line the Director typed. */
  text(mode: 'selection' | 'screen' | 'all' | 'last' | 'tail'): string;
  fontSize(delta: number): number;
  /** Selects and scrolls to the next (or previous) line holding the text; false when there is none. */
  find(query: string, backwards: boolean): boolean;
  latest(): void;
  /** True while the view is at the bottom. */
  atBottom(): boolean;
  refit(): void;
}

export interface PaneController extends PaneTools {
  update(target: PaneTarget): void;
  claimSize(): void;
  dispose(): void;
}

const sane = (cols: number, rows: number): boolean =>
  Number.isInteger(cols) &&
  Number.isInteger(rows) &&
  cols >= 1 &&
  rows >= 1 &&
  cols <= MAX_SANE_DIMENSION &&
  rows <= MAX_SANE_DIMENSION;

/** xterm swallows Tab, so this is the keyboard way out of the terminal: back to the tile of the console. */
function focusSelectedTile(): void {
  document.querySelector<HTMLElement>('.room-tile[data-selected="true"]')?.focus();
}

/** The LCD of the livery that is on (--lcd, --lcd-text): the screen of the terminal. */
const liveryTheme = (): ReturnType<typeof xtermTheme> => xtermTheme(currentEntry(store.getState().livery).tokens);

/**
 * Everything imperative about the one xterm of the page: attach and re-attach, snapshot, output, input and the size
 * rules of contract 8.4. React only passes the selected agent and the connection in, and shows what is around it.
 * Exported so that those rules can be driven without a browser (a fake host, terminal and api).
 */
export function createPaneController(host: HTMLElement, onSizeHint: (show: boolean) => void): PaneController {
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: MONO_FONT,
    fontSize: 13,
    scrollback: 2000,
    macOptionIsMeta: true,
    theme: liveryTheme(),
  });
  // a livery chosen on any device repaints the screen in place
  let livery = store.getState().livery;
  const stopLivery = store.subscribe(() => {
    const next = store.getState().livery;
    if (next === livery) return;
    livery = next;
    term.options.theme = liveryTheme();
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  // Chrome flags a form field with neither id nor name (an issue in DevTools on every page load).
  term.textarea?.setAttribute('name', 'terminal-input');
  // The web font may arrive after xterm measured its character cell: set the family again (xterm ignores the same value) so that it measures again, then fit.
  void document.fonts.load('13px "Geist Mono"').then(() => {
    if (disposed) return;
    term.options.fontFamily = 'monospace';
    term.options.fontFamily = MONO_FONT;
    refit();
    sync();
  });

  let target: PaneTarget = { agent: null, connection: 'connecting' };
  /** What the last applied snapshot said: which agent, which process generation, and whether it was running. */
  let snapshot: { name: string; generation: number; running: boolean } | null = null;
  /** The attach that has been sent and not answered yet. */
  let pending: { name: string; generation: number } | null = null;
  /** The size the pty is known to have, or that this window asked for: a resize is sent only when the xterm differs from it. */
  let lastSent: { cols: number; rows: number } | null = null;
  /** The agent whose screen the xterm holds (it is cleared when another agent is attached, not on a re-attach). */
  let shown: string | null = null;
  let measureTries = 0;
  let measureTimer: ReturnType<typeof setTimeout> | undefined;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  /** Never fit or send for a hidden page or an unsized host: it proposes a tiny grid and every resize repaints claude. */
  const visible = (): boolean => document.visibilityState === 'visible' && host.clientWidth > 0 && host.clientHeight > 0;

  /** The screen is of the selected agent, that process runs and the socket is open: input and sizes may go out. */
  const live = (): boolean =>
    snapshot !== null &&
    snapshot.running &&
    target.connection === 'open' &&
    target.agent !== null &&
    target.agent.name === snapshot.name &&
    target.agent.state !== 'stopped';

  function updateHint(): void {
    if (!live()) {
      onSizeHint(false);
      return;
    }
    const proposed = fit.proposeDimensions();
    onSizeHint(proposed !== undefined && (proposed.cols !== term.cols || proposed.rows !== term.rows));
  }

  function sendSize(): void {
    if (snapshot === null || !live() || !visible()) return;
    if (lastSent !== null && lastSent.cols === term.cols && lastSent.rows === term.rows) return;
    lastSent = { cols: term.cols, rows: term.rows };
    api.resize(snapshot.name, term.cols, term.rows);
  }

  function refit(): void {
    if (!visible()) return;
    // A stopped agent keeps the size of its last screen: fitting it would only reflow what the process drew.
    if (live()) {
      fit.fit();
      sendSize();
    }
    updateHint();
  }

  function attachTo(agent: AgentView): void {
    const dimensions = fit.proposeDimensions();
    if (dimensions === undefined && measureTries < MEASURE_RETRIES) {
      measureTries += 1;
      clearTimeout(measureTimer);
      measureTimer = setTimeout(sync, MEASURE_RETRY_MS);
      return;
    }
    measureTries = 0;
    if (!api.attach(agent.name, dimensions)) return;
    pending = { name: agent.name, generation: agent.generation };
    if (shown !== agent.name) {
      shown = agent.name;
      term.reset();
      onSizeHint(false);
    }
  }

  /** Contract 8.4 "Attach": decides, from the agent and the last snapshot, whether to ask for a screen again. */
  function sync(): void {
    if (disposed) return;
    const agent = target.agent;
    if (agent === null) {
      if (shown !== null) {
        shown = null;
        term.reset();
      }
      if (snapshot !== null || pending !== null) {
        snapshot = null;
        pending = null;
        api.detach();
      }
      onSizeHint(false);
      return;
    }
    if (target.connection !== 'open' || !visible()) return;
    const stale =
      snapshot === null ||
      snapshot.name !== agent.name ||
      snapshot.generation !== agent.generation ||
      (!snapshot.running && agent.state !== 'stopped');
    const inFlight = pending !== null && pending.name === agent.name && pending.generation === agent.generation;
    if (stale && !inFlight) attachTo(agent);
  }

  function takeFocusIfFree(): void {
    const active = document.activeElement;
    if (active === null || active === document.body) term.focus();
  }

  function onSnapshot(frame: SnapshotFrame): void {
    pending = null;
    if (disposed || !sane(frame.cols, frame.rows)) return;
    snapshot = { name: frame.agent, generation: frame.generation, running: frame.running };
    // The pty is the truth for its size: remember it first, so that the resize the snapshot causes is not sent back.
    lastSent = { cols: frame.cols, rows: frame.rows };
    term.reset();
    term.resize(frame.cols, frame.rows);
    term.write(frame.data, () => {
      if (disposed) return;
      updateHint();
      takeFocusIfFree();
    });
    updateHint();
  }

  function onSize(frame: SizeFrame): void {
    if (snapshot === null || frame.agent !== snapshot.name || !sane(frame.cols, frame.rows)) return;
    if (frame.cols !== term.cols || frame.rows !== term.rows) {
      // No window fits itself back in answer to this (two windows would fight over the pty for ever): only a hint.
      lastSent = { cols: frame.cols, rows: frame.rows };
      term.resize(frame.cols, frame.rows);
    }
    updateHint();
  }

  function sendInput(data: string, binary: boolean): void {
    if (snapshot !== null && live()) api.input(snapshot.name, data, binary);
  }

  term.attachCustomKeyEventHandler((event) => {
    if (event.isComposing) return true;
    if (event.altKey && event.shiftKey && event.code === 'KeyT') {
      if (event.type === 'keydown') {
        event.preventDefault();
        focusSelectedTile();
      }
      return false;
    }
    if (event.key === 'Enter' && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
      // xterm would send a bare CR, which submits the prompt; ESC CR inserts a newline in claude's box.
      if (event.type === 'keydown') {
        event.preventDefault();
        sendInput('\x1b\r', false);
      }
      return false;
    }
    return true;
  });

  const subscriptions = [
    term.onData((data) => sendInput(data, false)),
    term.onBinary((data) => sendInput(data, true)),
    term.onResize(() => {
      sendSize();
      updateHint();
    }),
  ];
  const stopListening = api.onTerminal({
    snapshot: onSnapshot,
    output: (bytes) => term.write(bytes),
    size: onSize,
    error: (frame) => {
      // The attach was refused: let the next frame of the agent try again.
      if (frame.ref === 'attach') pending = null;
    },
  });

  const observer = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      refit();
      sync();
    }, RESIZE_DEBOUNCE_MS);
  });
  // The wrapper, not the host: the host grows scrollbars while this window shows another window's size, a scrollbar
  // shrinks the content box that an observer reports, and this window would then fit itself back on its own.
  observer.observe(host.parentElement ?? host);
  const onVisibility = (): void => {
    if (document.visibilityState !== 'visible') return;
    refit();
    sync();
  };
  document.addEventListener('visibilitychange', onVisibility);

  const lines = (from: number, to: number): string[] => {
    const out: string[] = [];
    for (let y = from; y < to; y += 1) out.push(term.buffer.active.getLine(y)?.translateToString(true) ?? '');
    return out;
  };
  let findAt = -1;
  return {
    text(mode) {
      const buffer = term.buffer.active;
      if (mode === 'selection') return term.getSelection();
      if (mode === 'screen') return lines(buffer.viewportY, buffer.viewportY + term.rows).join('\n').trimEnd();
      const all = lines(0, buffer.length);
      if (mode === 'tail') return all.slice(-300).join('\n').trimEnd();
      if (mode === 'all') return all.join('\n').trimEnd();
      return lastAnswer(all);
    },
    fontSize(delta) {
      const next = Math.min(24, Math.max(9, (term.options.fontSize ?? 13) + delta));
      term.options.fontSize = next;
      refit();
      return next;
    },
    find(query, backwards) {
      const buffer = term.buffer.active;
      const hit = findLine(lines(0, buffer.length), query, findAt, backwards);
      if (hit === null) return false;
      findAt = hit.line;
      term.select(hit.column, hit.line, query.length);
      term.scrollToLine(Math.max(0, hit.line - Math.floor(term.rows / 2)));
      return true;
    },
    latest() {
      term.scrollToBottom();
    },
    atBottom() {
      const buffer = term.buffer.active;
      return buffer.viewportY >= buffer.baseY;
    },
    refit() {
      refit();
    },
    update(next) {
      target = next;
      if (next.connection !== 'open') {
        // The server dropped this socket's attachment with the socket; the screen stays, frozen, until the next snapshot.
        pending = null;
        snapshot = null;
        onSizeHint(false);
      }
      sync();
    },
    claimSize() {
      if (!live() || !visible()) return;
      fit.fit();
      sendSize();
      updateHint();
      term.focus();
    },
    dispose() {
      disposed = true;
      clearTimeout(measureTimer);
      clearTimeout(resizeTimer);
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      stopListening();
      stopLivery();
      for (const subscription of subscriptions) subscription.dispose();
      api.detach();
      fit.dispose();
      term.dispose();
    },
  };
}

/** The terminal that is on the page now (there is one), for the toolbar of the prototype layout. */
export const panes: { current: PaneController | null } = { current: null };

export function TerminalPane({ agent }: { agent: AgentView | null }): ReactElement {
  const connection = useStore((s) => s.connection);
  const failedAttempts = useStore((s) => s.failedAttempts);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const controller = useRef<PaneController | null>(null);
  const [sizeHint, setSizeHint] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return undefined;
    const created = createPaneController(host, setSizeHint);
    controller.current = created;
    panes.current = created;
    return () => {
      created.dispose();
      controller.current = null;
      if (panes.current === created) panes.current = null;
    };
  }, []);

  // Runs on every frame of the agent (a new object each time): the controller decides whether a new attach is due.
  useEffect(() => {
    controller.current?.update({ agent, connection });
  }, [agent, connection]);

  const frozen = connection !== 'open';
  const stopped = agent !== null && agent.state === 'stopped';
  // What the console panel does not say already: the state of the agent is in its header and its foot.
  let notice: string | null = null;
  if (connection === 'reconnecting') notice = failedAttempts >= RECONNECT_SERVER_GONE_AFTER ? SERVER_GONE_TEXT : 'Reconnecting...';
  else if (connection === 'connecting') notice = 'Connecting...';

  return (
    <div className="pane">
      {(notice !== null || sizeHint) && (
        <div className="pane-status">
          <div className="pane-notice" role="status" title={notice ?? undefined}>
            {notice}
          </div>
          {sizeHint && (
            <button type="button" className="btn" data-kind="quiet" onClick={() => controller.current?.claimSize()}>
              Size set by another window. Click to use this window's size.
            </button>
          )}
        </div>
      )}
      <div className="term-wrap">
        <div
          ref={hostRef}
          id="terminal-panel"
          className="term-host"
          role="region"
          aria-label={agent !== null ? `Terminal of ${agent.name}` : 'Terminal'}
          data-dim={frozen || stopped}
          data-scroll={sizeHint || stopped}
        />
        {agent === null && connection !== 'connecting' && <p className="pane-empty">Pick a console in the room</p>}
      </div>
      {agent !== null && <p className="pane-hint">Alt+Shift+T returns to the room</p>}
    </div>
  );
}
