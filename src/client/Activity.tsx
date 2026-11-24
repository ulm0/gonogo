import { useId, useMemo, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactElement } from 'react';
import type { ActivityItem, AgentView } from '../shared/protocol.js';
import * as api from './api.js';
import { longTextKind, longTextNote } from '../shared/longtext.js';
import { Brief, enterSends } from './Brief.js';
import { chipOf, FILTERS, filterCounts, filterItems, legendOf, noteOf, replyRequest, routeText, subjectOf, ofAgent, trafficOf } from './loop.js';
import type { FilterId } from './loop.js';
import { useStore } from './store.js';
import { briefSentText } from './wording.js';
import './loop.css';

/** The loop draws at most this many rows; the store keeps more. */
const MAX_ROWS = 100;
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function clockOf(at: number): string {
  try {
    return timeFormat.format(at);
  } catch {
    // An `at` outside the range of a Date must not take the whole page down with it.
    return '--:--';
  }
}

/** The box under a message for the Director: the answer goes to the sender, in the same thread. `onSent` runs once it was accepted. */
export function Reply({
  item,
  agents,
  onSent,
}: {
  item: Pick<ActivityItem, 'id' | 'from' | 'subject'>;
  agents: Readonly<Record<string, AgentView>>;
  onSent?(): void;
}): ReactElement {
  const id = useId();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; failed: boolean } | null>(null);
  const to = legendOf(item.from, agents);
  // a long reply goes as a file, as a long brief does (shared/longtext.ts)
  const kind = longTextKind(text.trim().length);
  const long = longTextNote(text.trim().length, to);

  async function send(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    const body = text.trim();
    if (busy || body === '' || kind === 'too_long') return;
    setBusy(true);
    setResult(null);
    try {
      const sent = await api.sendMessage(replyRequest(item, body));
      if (!sent.ok || sent.status === 'undelivered') {
        setResult({ text: sent.note ?? 'The message could not be delivered.', failed: true });
      } else {
        setText('');
        const sentText = briefSentText(sent.note, sent.to, to);
        setResult({ text: kind === 'file' ? `${sentText} The whole text was saved as a file; ${to} got its path and the first lines.` : sentText, failed: false });
        onSent?.();
      }
    } catch (e) {
      setResult({ text: e instanceof Error ? e.message : String(e), failed: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="loop-reply" onSubmit={(event) => void send(event)}>
      <label className="legend" htmlFor={`${id}-reply`}>
        Reply to {to}
      </label>
      <textarea
        id={`${id}-reply`}
        className="textarea loop-reply-input"
        rows={1}
        value={text}
        autoComplete="off"
        aria-describedby={`${id}-result ${id}-long`}
        aria-invalid={kind === 'too_long' || undefined}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
          if (enterSends(event)) void send(event);
        }}
      />
      <button type="submit" className="btn" data-kind="primary" aria-disabled={busy || text.trim() === '' || kind === 'too_long'}>
        {busy ? 'Sending…' : 'Send'}
      </button>
      <p id={`${id}-long`} className={long?.tone === 'danger' ? 'error loop-result' : 'hint loop-result'}>
        {long?.text}
      </p>
      <p id={`${id}-result`} className={result?.failed === true ? 'error loop-result' : 'hint loop-result'} role="status">
        {result?.text}
      </p>
    </form>
  );
}

function Row({
  item,
  agents,
  open,
  onToggle,
  onSelect,
}: {
  item: ActivityItem;
  agents: Readonly<Record<string, AgentView>>;
  open: boolean;
  onToggle(): void;
  onSelect(name: string): void;
}): ReactElement {
  const chip = chipOf(item);
  const note = noteOf(item);
  const toYou = item.to === 'user';
  const sender = item.from !== 'user' && Object.hasOwn(agents, item.from) ? item.from : null;
  return (
    <li className="loop-row" data-to-you={toYou ? '' : undefined} data-status={item.status}>
      <button type="button" className="loop-row-btn" aria-expanded={open} onClick={onToggle}>
        <span className="loop-time">{clockOf(item.at)}</span>
        <span className="loop-route">{routeText(item, agents)}</span>
        <span className="loop-text">
          <span className="loop-subject">{subjectOf(item)}</span>
          {note !== '' && <span className="loop-note">{note}</span>}
        </span>
        <span className="chip loop-chip" data-tone={chip.tone}>
          {chip.text}
        </span>
      </button>
      {open && (
        <div className="loop-open">
          <p className="loop-body">
            {item.body}
            {item.truncated ? ' …(cut)' : ''}
          </p>
          {toYou && <Reply item={item} agents={agents} />}
          {sender !== null && (
            <button
              type="button"
              className="btn loop-console"
              data-kind="quiet"
              onClick={() => onSelect(sender)}
            >
              Open {legendOf(sender, agents)}
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/** The full comm loop: every message in the room, newest first, with the brief box at its foot. */
export function Loop({
  items,
  agents,
  boss,
  onSelect,
  onClose,
  agent = null,
  onAgent,
}: {
  items: readonly ActivityItem[];
  agents: Readonly<Record<string, AgentView>>;
  boss: AgentView | null;
  onSelect(name: string): void;
  onClose(): void;
  /** The agent the list is filtered to, or null for everyone; with `onAgent` the head shows the picker. */
  agent?: string | null;
  onAgent?(name: string | null): void;
}): ReactElement {
  const [filter, setFilter] = useState<FilterId>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const mine = useMemo(() => ofAgent(items, agent), [items, agent]);
  const counts = useMemo(() => filterCounts(mine), [mine]);
  const rows = useMemo(() => filterItems(mine, filter).slice(0, MAX_ROWS), [mine, filter]);

  return (
    <section className="loop" aria-labelledby="loop-title">
      <header className="loop-head">
        <h1 id="loop-title" className="disp loop-title">
          COMM LOOP
        </h1>
        <div className="loop-filters" role="group" aria-label="Filter">
          {FILTERS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              className="btn loop-filter"
              data-kind={filter === id ? 'primary' : 'quiet'}
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {label} <span className="loop-count">{counts[id]}</span>
            </button>
          ))}
        </div>
        {onAgent !== undefined && (
          <label className="loop-agent">
            <span className="label">Agent</span>
            <select className="input" value={agent ?? ''} onChange={(event) => onAgent(event.target.value === '' ? null : event.target.value)}>
              <option value="">everyone</option>
              {agent !== null && !Object.hasOwn(agents, agent) && <option value={agent}>{agent}</option>}
              {Object.keys(agents).sort().map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="button" className="btn loop-room" data-kind="quiet" onClick={onClose}>
          Room
        </button>
      </header>
      <div className="loop-scroll module">
        {rows.length === 0 ? (
          <p className="loop-empty">{mine.length === 0 ? 'No messages yet.' : 'Nothing in this filter.'}</p>
        ) : (
          <ol className="loop-list">
            {rows.map((item) => (
              <Row
                key={item.id}
                item={item}
                agents={agents}
                open={openId === item.id}
                onToggle={() => setOpenId(openId === item.id ? null : item.id)}
                onSelect={(name) => {
                  onSelect(name);
                  onClose();
                }}
              />
            ))}
          </ol>
        )}
      </div>
      <div className="loop-foot module">
        <Brief boss={boss} />
      </div>
    </section>
  );
}

/** The last three messages to or from one agent, for its console panel. */
export function ConsoleTraffic({
  items,
  name,
  onOpenLoop,
}: {
  items: readonly ActivityItem[];
  name: string;
  onOpenLoop(): void;
}): ReactElement {
  const agents = useStore((s) => s.agents);
  const rows = trafficOf(items, name);
  const who = legendOf(name, agents);
  return (
    <section className="loop-traffic" aria-label={`Comm loop of ${who}`}>
      <div className="loop-traffic-head">
        <h2 className="label">Comm loop · {who}</h2>
        <button type="button" className="btn loop-link" data-kind="quiet" onClick={onOpenLoop}>
          All traffic
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="loop-traffic-empty">No traffic yet.</p>
      ) : (
        <ol className="loop-traffic-list">
          {rows.map((item) => {
            const chip = chipOf(item);
            return (
              <li key={item.id} className="loop-traffic-row">
                <span className="loop-time">{clockOf(item.at)}</span>
                <span className="loop-route">{routeText(item, agents)}</span>
                <span className="loop-traffic-subject">{subjectOf(item)}</span>
                <span className="chip loop-chip" data-tone={chip.tone}>
                  {chip.text}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
