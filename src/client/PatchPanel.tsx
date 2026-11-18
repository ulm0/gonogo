/**
 * Patch Panel, the command bar: Cmd/Ctrl+K, or its key in the top bar (the phone bar on a phone). One field that filters every
 * console, view and common action of the page; arrows choose, Enter runs, Esc closes. A modal <dialog>: the browser keeps the
 * keyboard inside it and the rest of the page out of reach of a screen reader while it is open.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ROOMS_PATH } from './base.js';
import type { KeyboardEvent, ReactElement } from 'react';
import { DOCS_URL } from '../shared/protocol.js';
import * as api from './api.js';
import { useAgentList, useSeats } from './RoomView.js';
import { commands, matchCommands, stepIndex } from './shell.js';
import type { Act, View } from './shell.js';
import { openConsole, openHire, showComms, showBlackBox, showBoard, showHangar, showLivery, showLog, showLoop, showMissions, openNewMission, showPlan, showRecorder, showRoom, showRules, showWindow, store, useStore } from './store.js';
import { restore } from '../shared/layout.js';
import { startEditing } from './EditRoomKey.js';
import { useRun } from './WallView.js';
import './patch.css';

const SHOW: Record<View, () => void> = {
  room: showRoom,
  comms: () => showComms(),
  missions: showMissions,
  board: showBoard,
  blackbox: showBlackBox,
  hangar: showHangar,
  recorder: showRecorder,
  window: showWindow,
  plan: showPlan,
  log: showLog,
  livery: showLivery,
  rules: showRules,
};

/** Runs a line. A store change is at once; a request to the server keeps the panel open until it answers, so an error can show. */
function perform(act: Act, phone: boolean): Promise<unknown> | null {
  switch (act.kind) {
    case 'console':
      openConsole(act.name);
      return null;
    case 'view':
      SHOW[act.view]();
      return null;
    case 'comms':
      showComms(act.tab);
      return null;
    case 'hire':
      openHire();
      return null;
    case 'docs':
      // a new tab, with no opener: the docs site is not part of this page
      window.open(DOCS_URL, '_blank', 'noopener,noreferrer');
      return null;
    case 'rooms':
      // the list of rooms is the supervisor's own page
      location.assign(ROOMS_PATH);
      return null;
    case 'new-mission':
      openNewMission();
      return null;
    case 'edit-room':
      // a promise, so that a refusal (a screen under 900 px) shows in the panel instead of being thrown away
      return Promise.resolve().then(startEditing);
    case 'reset-room':
      return api.resetRoom('all', store.getState().room.rev);
    case 'show-block': {
      const { room } = store.getState();
      return room.layout === null ? Promise.resolve() : api.saveRoom({ rev: room.rev, blocks: restore(room.layout.blocks, act.block), desks: room.layout.desks });
    }
    case 'brief':
      // the brief box is in the room on a desk and at the foot of the loop on a phone (its field has the class `brief-input`)
      (phone ? showLoop : showRoom)();
      requestAnimationFrame(() => document.querySelector<HTMLElement>('.brief-input')?.focus());
      return null;
    case 'poll':
      return api.startPoll({});
    case 'read':
      return api.markAllRead();
    case 'all-stop':
      return api.holdAll();
    case 'all-resume':
      return api.resumeAll();
    case 'livery':
      return api.selectLivery(act.slug);
    case 'propellant':
      // the room's Propellant is in Flight Rules: open the fold, or switch the meter to dollars, once the page has drawn it
      showRules();
      requestAnimationFrame(() => {
        if (act.part === 'prices') {
          const fold = document.getElementById('fuel-prices');
          if (fold instanceof HTMLDetailsElement) fold.open = true;
          fold?.querySelector('summary')?.focus();
        } else {
          document.getElementById('fuel-the room-dollars')?.click();
          requestAnimationFrame(() => document.getElementById('fuel-the room')?.focus());
        }
      });
      return null;
  }
}

export function PatchPanel({ open, phone, onClose }: { open: boolean; phone: boolean; onClose(): void }): ReactElement {
  const id = useId();
  const dialog = useRef<HTMLDialogElement | null>(null);
  const back = useRef<HTMLElement | null>(null);
  const ran = useRef(false);
  const field = useRef<HTMLInputElement | null>(null);
  const list = useAgentList();
  const { legends } = useSeats();
  const poll = useStore((s) => s.poll);
  const unread = useStore((s) => s.downlink.unread);
  const livery = useStore((s) => s.livery);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const { busy, error, run } = useRun();
  const room = useStore((s) => s.room);
  const off = useStore((s) => s.features);
  const all = useMemo(() => commands({ agents: list, legends, poll, unread, livery, room, off, inRoom: true }), [list, legends, poll, unread, livery, room, off]);
  const shown = useMemo(() => matchCommands(all, query), [all, query]);
  const at = Math.min(active, shown.length - 1);

  useEffect(() => {
    const d = dialog.current;
    if (d === null) return;
    if (open && !d.open) {
      back.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      ran.current = false;
      setQuery('');
      setActive(0);
      d.showModal();
      // the dialog would focus its first key (Close); the field is where the Director types
      field.current?.focus();
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  // keep the chosen line in sight when the arrows move past the edge of the list
  useEffect(() => {
    document.getElementById(`${id}-${at}`)?.scrollIntoView({ block: 'nearest' });
  }, [id, at]);

  // Closed and the keyboard given back to the opener before the page changes, so that a view that opens can still take it to its title.
  const shut = (): void => {
    ran.current = true;
    dialog.current?.close();
    back.current?.focus();
  };
  const choose = (index: number): void => {
    const c = shown[index];
    if (c === undefined || busy) return;
    if (c.act.kind === 'poll' || c.act.kind === 'read' || c.act.kind === 'livery' || c.act.kind === 'edit-room' || c.act.kind === 'reset-room' || c.act.kind === 'show-block') {
      const act = c.act;
      run(async () => {
        await perform(act, phone);
        shut();
      });
    } else {
      shut();
      void perform(c.act, phone);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || ((e.key === 'Home' || e.key === 'End') && e.ctrlKey)) {
      e.preventDefault();
      setActive(stepIndex(at, shown.length, e.key));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(at);
    }
  };

  return (
    <dialog
      ref={dialog}
      className="patch module"
      aria-labelledby={`${id}-title`}
      // Esc and a close by the browser: tell the page, then give the keyboard back to where it was
      onClose={() => {
        onClose();
        if (!ran.current) back.current?.focus();
      }}
      onClick={(e) => e.target === dialog.current && onClose()}
    >
      <div className="patch-head">
        <h2 className="label patch-title" id={`${id}-title`}>
          PATCH PANEL
        </h2>
        {/* a touch screen has no Esc */}
        <button type="button" className="btn" data-kind="quiet" onClick={() => dialog.current?.close()}>
          Close
        </button>
      </div>
      <input
        ref={field}
        className="input patch-input"
        type="text"
        role="combobox"
        aria-label="Console, view or action"
        aria-expanded="true"
        aria-controls={`${id}-list`}
        aria-activedescendant={at >= 0 ? `${id}-${at}` : undefined}
        aria-autocomplete="list"
        autoComplete="off"
        spellCheck={false}
        placeholder="Type a console, a view or an action"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKey}
      />
      <ul className="patch-list" id={`${id}-list`} role="listbox" aria-label="Matches">
        {shown.map((c, i) => (
          // the field keeps the keyboard (aria-activedescendant), so a line is clicked, not focused
          <li key={c.id} id={`${id}-${i}`} role="option" aria-selected={i === at} className="patch-option" onClick={() => choose(i)} onMouseMove={() => i !== at && setActive(i)}>
            <span className="patch-label">{c.label}</span>
            <span className="patch-group" aria-hidden="true">
              {c.group}
            </span>
          </li>
        ))}
      </ul>
      <p className="hint patch-foot" role="status">
        {error !== null ? '' : shown.length === 0 ? 'Nothing matches.' : busy ? 'Working…' : `${shown.length} ${shown.length === 1 ? 'match' : 'matches'}. Arrows choose, Enter runs, Esc closes.`}
      </p>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </dialog>
  );
}
