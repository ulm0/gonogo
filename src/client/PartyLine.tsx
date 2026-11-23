/**
 * Party Line: the messages of the room as conversations, the one with the newest message first. A conversation is a reply
 * chain, or the same two parties with the same subject (src/client/threads.ts). Opening one shows its messages in order and a
 * box to answer as the Director, through the same route as the comm loop's reply box.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { ActivityItem, AgentView } from '../shared/protocol.js';
import { Reply } from './Activity.js';
import { whenText } from './inbox.js';
import { chipOf, legendOf, noteOf, routeText } from './loop.js';
import { showRoom, useStore } from './store.js';
import { linkLine } from './links.js';
import type { LinkItem } from './links.js';
import { useLinks } from './linksData.js';
import { groupThreads, repliers, replyTarget } from './threads.js';
import type { Thread } from './threads.js';
import './loop.css';
import './partyline.css';

/** The page draws at most this many threads; the store keeps the newest 200 messages, so it is rarely reached. */
const MAX_ROWS = 100;

const countText = (n: number): string => `${n} ${n === 1 ? 'message' : 'messages'}`;

function Message({ item, agents, now }: { item: ActivityItem; agents: Readonly<Record<string, AgentView>>; now: number }): ReactElement {
  const chip = chipOf(item);
  const note = noteOf(item);
  return (
    <li className="pl-msg" data-from-you={item.from === 'user' ? '' : undefined}>
      <p className="pl-msg-head">
        <span className="loop-route">{routeText(item, agents)}</span>
        <span className="loop-time">{whenText(item.at, now)}</span>
        {chip.tone !== 'quiet' && (
          <span className="chip" data-tone={chip.tone}>
            {chip.text}
          </span>
        )}
      </p>
      {note !== '' && chip.tone !== 'quiet' && <p className="loop-note">{note}</p>}
      <p className="loop-body">
        {item.body}
        {item.truncated ? ' …(cut)' : ''}
      </p>
    </li>
  );
}

/** The open thread: its messages oldest first, then the box to answer. */
function Open({ thread, agents, now }: { thread: Thread; agents: Readonly<Record<string, AgentView>>; now: number }): ReactElement {
  const id = useId();
  const who = useMemo(() => repliers(thread), [thread]);
  const [chosen, setChosen] = useState<string | null>(null);
  // the choice is dropped when that agent leaves the thread
  const to = chosen !== null && who.includes(chosen) ? chosen : (who[0] ?? null);
  return (
    <div className="pl-open">
      <ol className="pl-msgs">
        {thread.items.map((item) => (
          <Message key={item.id} item={item} agents={agents} now={now} />
        ))}
      </ol>
      {to === null ? (
        <p className="hint">This thread is with another station. You cannot write to it from here.</p>
      ) : (
        <div className="pl-answer">
          {who.length > 1 && (
            <div className="pl-to">
              <label className="legend" htmlFor={`${id}-to`}>
                Send to
              </label>
              <select id={`${id}-to`} className="input" value={to} onChange={(event) => setChosen(event.target.value)}>
                {who.map((name) => (
                  <option key={name} value={name}>
                    {legendOf(name, agents)}
                  </option>
                ))}
              </select>
            </div>
          )}
          {/* a new box for each agent, so that text typed for one is not sent to another */}
          <Reply key={to} item={replyTarget(thread, to)} agents={agents} />
        </div>
      )}
    </div>
  );
}

/** The view of the top bar's PARTY LINE key. */
export function PartyLine(): ReactElement {
  const titleId = useId();
  const items = useStore((s) => s.activity);
  const agents = useStore((s) => s.agents);
  const [openId, setOpenId] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const links = useLinks();
  const threads = useMemo(() => groupThreads(items, new Set(links.map((l) => l.id))), [items, links]);
  const rows = threads.slice(0, MAX_ROWS);
  const now = useMemo(() => Date.now(), [items]);
  // The page replaces the room: the keyboard starts at its title, not on a button that is gone.
  useEffect(() => heading.current?.focus(), []);

  return (
    <section className="pl" aria-labelledby={titleId}>
      <header className="loop-head">
        <h1 id={titleId} ref={heading} tabIndex={-1} className="disp loop-title pl-heading">
          PARTY LINE
        </h1>
        <span className="chip" data-tone="quiet">
          {threads.length} {threads.length === 1 ? 'thread' : 'threads'}
        </span>
        <button type="button" className="btn loop-room" data-kind="quiet" onClick={showRoom}>
          Room
        </button>
      </header>
      <div className="pl-scroll module">
        {rows.length === 0 ? (
          <p className="loop-empty">No messages yet. Conversations between agents, and with you, appear here.</p>
        ) : (
          <ol className="pl-list">
            {rows.map((thread) => {
              const open = openId === thread.id;
              const chip = chipOf(thread.last);
              return (
                <li key={thread.id} className="pl-row">
                  <button type="button" className="pl-head" aria-expanded={open} onClick={() => setOpenId(open ? null : thread.id)}>
                    <span className="loop-time">{whenText(thread.last.at, now)}</span>
                    <span className="loop-route">{thread.who.map((name) => legendOf(name, agents)).join(' · ')}</span>
                    <span className="pl-text">
                      <span className="loop-subject">{thread.title}</span>
                      {thread.link !== undefined && links.some((l) => l.id === thread.link) && (
                        <span className="chip" data-tone="quiet">
                          LINK · {linkLine(links.find((l) => l.id === thread.link) as LinkItem)}
                        </span>
                      )}
                      <span className="loop-note">{countText(thread.items.length)}</span>
                    </span>
                    {chip.tone !== 'quiet' && (
                      <span className="chip pl-chip" data-tone={chip.tone}>
                        {chip.text}
                      </span>
                    )}
                  </button>
                  {open && <Open thread={thread} agents={agents} now={now} />}
                </li>
              );
            })}
          </ol>
        )}
        {threads.length > rows.length && <p className="hint pl-more">The {MAX_ROWS} threads with the newest messages are shown, of {threads.length}.</p>}
      </div>
    </section>
  );
}
