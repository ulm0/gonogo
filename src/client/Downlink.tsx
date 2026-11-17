/**
 * Downlink: the Director's inbox. Messages the agents sent to the Director and what the server noticed for him (a Redline
 * trip, a T-minus result, a schedule that failed, an Uplink refused, a task an agent blocked), unread first. What is read or
 * archived is kept by the server, so the phone and the desk agree. Every action is a key the keyboard and a screen reader
 * reach; j and k move between rows, e archives and r replies while the view has focus.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';
import type { AgentView, DownlinkItem } from '../shared/protocol.js';
import { Reply } from './Activity.js';
import * as api from './api.js';
import { afterLeaving, EVENT_CHIPS, FILTERS, filterCounts, filterItems, keyAction, rowId, stepId, unreadText, whenText } from './inbox.js';
import type { FilterId } from './inbox.js';
import { legendOf, subjectOf } from './loop.js';
import { showRoom, useStore } from './store.js';
import { useRun } from './WallView.js';
import './loop.css';
import './downlink.css';

/** The view draws at most this many rows; unread ones come first, so the rows left out are old read ones. */
const MAX_ROWS = 100;

interface RowProps {
  item: DownlinkItem;
  agents: Readonly<Record<string, AgentView>>;
  now: number;
  open: boolean;
  /** The row that carries the keyboard stop: the others are reached with j and k. */
  stop: boolean;
  onToggle(): void;
  onFocus(): void;
  onRead(): void;
  onArchive(): void;
  onReplied(): void;
}

function Row({ item, agents, now, open, stop, onToggle, onFocus, onRead, onArchive, onReplied }: RowProps): ReactElement {
  const unread = !item.read;
  const title = item.type === 'message' ? subjectOf(item) : item.text;
  const label = `${unread ? 'Unread. ' : ''}${item.type === 'message' ? `From ${legendOf(item.from, agents)}` : EVENT_CHIPS[item.kind].text}: ${title}`;
  const lamp = <span className="led" data-on={unread} aria-hidden="true" />;
  return (
    <li className="dl-row">
      <article id={rowId(item.id)} className="dl-item" data-item={item.id} data-unread={unread ? '' : undefined} tabIndex={stop ? 0 : -1} aria-label={label} onFocus={onFocus}>
        {item.type === 'message' ? (
          <button type="button" className="dl-head" aria-expanded={open} onClick={onToggle}>
            {lamp}
            <span className="dl-when">{whenText(item.at, now)}</span>
            <span className="dl-who">{legendOf(item.from, agents)}</span>
            <span className="dl-text">{title}</span>
          </button>
        ) : (
          <div className="dl-head">
            {lamp}
            <span className="dl-when">{whenText(item.at, now)}</span>
            <span className="chip dl-who" data-tone={EVENT_CHIPS[item.kind].tone}>
              {EVENT_CHIPS[item.kind].text}
            </span>
            <span className="dl-text">{title}</span>
          </div>
        )}
        {open && item.type === 'message' && (
          <div className="dl-open">
            <p className="loop-body">
              {item.body}
              {item.truncated ? ' …(cut)' : ''}
            </p>
            <Reply item={item} agents={agents} onSent={onReplied} />
          </div>
        )}
        <div className="dl-actions">
          {unread && (
            <button type="button" className="btn" aria-label={`Mark read: ${title}`} onClick={onRead}>
              Mark read
            </button>
          )}
          {!item.archived && (
            <button type="button" className="btn" aria-label={`Archive: ${title}`} onClick={onArchive}>
              Archive
            </button>
          )}
        </div>
      </article>
    </li>
  );
}

/** The view of the top bar's DOWNLINK key. */
export function Downlink(): ReactElement {
  const titleId = useId();
  const view = useStore((s) => s.downlink);
  const agents = useStore((s) => s.agents);
  const [filter, setFilter] = useState<FilterId>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  // what was read on this visit keeps its place until the page is left (filterItems)
  const [stay, setStay] = useState<ReadonlySet<string>>(() => new Set());
  const keep = (id: string): void => setStay((s) => (s.has(id) ? s : new Set(s).add(id)));
  const { busy, error, run } = useRun();
  const heading = useRef<HTMLHeadingElement | null>(null);
  const wantReply = useRef<string | null>(null);
  const counts = useMemo(() => filterCounts(view.items), [view.items]);
  const all = useMemo(() => filterItems(view.items, filter, stay), [view.items, filter, stay]);
  const rows = useMemo(() => all.slice(0, MAX_ROWS), [all]);
  const ids = useMemo(() => rows.map((item) => item.id), [rows]);
  // The page replaces the room: the keyboard starts at its title, not on a button that is gone.
  useEffect(() => heading.current?.focus(), []);
  // `r` on a row that was closed opens it: the box exists after this render.
  useEffect(() => {
    const id = wantReply.current;
    const input = id === null ? null : document.getElementById(rowId(id))?.querySelector<HTMLElement>('.loop-reply-input');
    if (input) {
      wantReply.current = null;
      input.focus();
    }
  });
  const now = useMemo(() => Date.now(), [view.items]);
  const stop = current !== null && ids.includes(current) ? current : (ids[0] ?? null);

  const focusRow = (id: string | null): void => {
    setCurrent(id);
    if (id === null) heading.current?.focus();
    else document.getElementById(rowId(id))?.focus();
  };
  const markRead = (id: string): void => {
    keep(id);
    run(async () => {
      await api.markRead([id]);
      setNotice('Marked read');
    });
  };
  const archive = (id: string): void => {
    if (busy) return;
    focusRow(afterLeaving(ids, id));
    run(async () => {
      await api.archiveItems([id]);
      setNotice('Archived');
    });
  };
  const toggle = (item: DownlinkItem): void => {
    const opening = openId !== item.id;
    setOpenId(opening ? item.id : null);
    // Opening a message is reading it; a failed call leaves it unread, and the button is still there.
    if (opening && !item.read) {
      keep(item.id);
      void api.markRead([item.id]).catch(() => undefined);
    }
  };
  const reply = (item: DownlinkItem): void => {
    if (item.type !== 'message') return;
    const input = document.getElementById(rowId(item.id))?.querySelector<HTMLElement>('.loop-reply-input');
    if (input) input.focus();
    else {
      wantReply.current = item.id;
      toggle(item);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const target = event.target as HTMLElement;
    const typing = target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
    const action = keyAction(event.key, event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing, typing);
    if (action === null) return;
    const on = target.closest<HTMLElement>('[data-item]')?.dataset.item ?? null;
    const item = rows.find((row) => row.id === on);
    if (action === 'next' || action === 'previous') focusRow(stepId(ids, on ?? current, action === 'next' ? 1 : -1));
    else if (item === undefined) return;
    else if (action === 'archive') {
      if (item.archived) return;
      archive(item.id);
    } else reply(item);
    event.preventDefault();
  };

  return (
    <section className="dl" aria-labelledby={titleId} onKeyDown={onKeyDown}>
      <header className="loop-head">
        <h1 id={titleId} ref={heading} tabIndex={-1} className="disp loop-title dl-heading">
          DOWNLINK
        </h1>
        <span className="chip" data-tone={view.unread > 0 ? 'amber' : 'quiet'}>
          {unreadText(view.unread)}
        </span>
        <div className="loop-filters" role="group" aria-label="Filter">
          {FILTERS.map(({ id, label }) => (
            <button key={id} type="button" className="btn loop-filter" data-kind={filter === id ? 'primary' : 'quiet'} aria-pressed={filter === id} onClick={() => setFilter(id)}>
              {label} <span className="loop-count">{counts[id]}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn loop-filter"
          aria-disabled={view.unread === 0 || undefined}
          onClick={() => {
            if (view.unread === 0) return;
            run(async () => {
              await api.markAllRead();
              setNotice('All marked read');
            });
          }}
        >
          Mark all read
        </button>
        <button type="button" className="btn loop-room" data-kind="quiet" onClick={showRoom}>
          Room
        </button>
      </header>
      <p className="hint dl-keys">Keys: j and k move, e archives, r replies.</p>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="dl-scroll module">
        {rows.length === 0 ? (
          <p className="loop-empty">
            {view.items.length === 0
              ? 'Nothing yet. What the agents send you, and what needs your eye (a Redline trip, a T-minus result, a schedule that failed, an Uplink refused, a task blocked or in review), lands here.'
              : 'Nothing in this filter.'}
          </p>
        ) : (
          <ol className="dl-list">
            {rows.map((item) => (
              <Row
                key={item.id}
                item={item}
                agents={agents}
                now={now}
                open={openId === item.id}
                stop={stop === item.id}
                onToggle={() => toggle(item)}
                onFocus={() => setCurrent(item.id)}
                onRead={() => {
                  // the key goes away once the row is read: the keyboard stays on the row
                  focusRow(item.id);
                  markRead(item.id);
                }}
                onArchive={() => archive(item.id)}
                onReplied={() => markRead(item.id)}
              />
            ))}
          </ol>
        )}
        {all.length > rows.length && <p className="hint dl-more">The newest {MAX_ROWS} of {all.length} are shown. Archive or mark read to reach the older ones.</p>}
      </div>
      <p className="sr-only" role="status">
        {notice}
      </p>
    </section>
  );
}
