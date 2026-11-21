/**
 * Mission Log: the memory every agent shares. A search box over the entries (newest first when it is empty), the entry
 * that is open, and for the Director a form to write, edit and delete. An entry is plain text: it is shown in a
 * preformatted block, never as HTML or markdown. The entries are not in the page state: the page asks the server, again
 * when a `log` frame says that something changed.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactElement } from 'react';
import { LOG_BODY_MAX_CHARS, LOG_QUERY_MAX_CHARS, LOG_TITLE_MAX_CHARS } from '../shared/protocol.js';
import { plain } from './knowledgeModel.js';
import type { LogAnchorState, LogChart, LogEntry, LogHit, LogSearch } from '../shared/protocol.js';
import * as api from './api.js';
import { whenText } from './inbox.js';
import { legendOf } from './loop.js';
import { countText, emptyValues, FIELDS, newsText, requestOf, rowId, validate, valuesOf } from './log.js';
import type { Field, Problems, Values } from './log.js';
import { Chart, Links } from './StarChart.js';
import { showRoom, useFeature, useStore } from './store.js';
import { useRun } from './WallView.js';
import './loop.css';
import './log.css';

/** What the left column shows: the search and its rows, the Star Chart, or the Star Chart as lists. */
type Lens = 'entries' | 'chart' | 'links';
const LENSES: ReadonlyArray<{ lens: Lens; label: string }> = [
  { lens: 'entries', label: 'Entries' },
  { lens: 'chart', label: 'Chart' },
  { lens: 'links', label: 'Links' },
];

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isField = (name: unknown): name is Field => typeof name === 'string' && (FIELDS as readonly string[]).includes(name);

function Tags({ tags }: { tags: readonly string[] }): ReactElement | null {
  if (tags.length === 0) return null;
  return (
    <span className="log-tags">
      {tags.map((tag) => (
        <span key={tag} className="chip" data-tone="quiet">
          {tag}
        </span>
      ))}
    </span>
  );
}

const ANCHOR_CHIPS = { ok: { tone: 'go', text: 'anchors ok' }, stale: { tone: 'amber', text: 'anchors' }, vacuous: { tone: 'amber', text: 'anchors' }, unchecked: { tone: 'quiet', text: 'anchors' } } as const;

/** What the last check of an entry's anchors found (docs/features/knowledge-anchors.md); nothing when there is none. Text from gonogo only, set as text. */
function AnchorChip({ state }: { state: LogAnchorState | undefined }): ReactElement | null {
  if (state === undefined) return null;
  const chip = ANCHOR_CHIPS[state.state];
  return (
    <span className="chip" data-tone={chip.tone} title={state.note}>
      {state.state === 'ok' ? chip.text : `${chip.text}: ${state.note}`}
    </span>
  );
}

/** One form for a new entry (`entry` is null) and for the Director's edit of one. */
function EntryForm({ entry, onDone }: { entry: LogEntry | null; onDone(saved: LogEntry | null): void }): ReactElement {
  const id = useId();
  const [values, setValues] = useState<Values>(() => (entry === null ? emptyValues() : valuesOf(entry)));
  const [problems, setProblems] = useState<Problems>({});
  const [topError, setTopError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement | null>(null);
  useEffect(() => first.current?.focus(), []);

  const change = (patch: Partial<Values>, field: Field): void => {
    setValues((v) => ({ ...v, ...patch }));
    setProblems((p) => ({ ...p, [field]: undefined }));
  };
  const describedBy = (field: Field, hint?: string): string | undefined => [hint, problems[field] !== undefined ? `${id}-${field}-error` : undefined].filter(Boolean).join(' ') || undefined;
  const error = (field: Field): ReactElement | null => {
    const text = problems[field];
    return text === undefined ? null : (
      <p className="error" id={`${id}-${field}-error`}>
        {text}
      </p>
    );
  };

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const found = validate(values);
    setProblems(found);
    setTopError(null);
    const bad = FIELDS.find((f) => found[f] !== undefined);
    if (bad !== undefined) {
      document.getElementById(`${id}-${bad}`)?.focus();
      return;
    }
    setBusy(true);
    try {
      onDone(entry === null ? await api.createLogEntry(requestOf(values)) : await api.updateLogEntry(entry.id, requestOf(values)));
    } catch (e) {
      const field = (e as { field?: unknown }).field;
      if (isField(field)) {
        setProblems({ [field]: messageOf(e) });
        document.getElementById(`${id}-${field}`)?.focus();
      } else setTopError(messageOf(e));
      setBusy(false);
    }
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) onDone(null);
  };

  return (
    <form className="log-form module" aria-label={entry === null ? 'New entry' : `Edit ${entry.id}`} noValidate onSubmit={(e) => void submit(e)} onKeyDown={onKeyDown}>
      <h2 className="label">{entry === null ? 'New entry' : `Edit ${entry.id}`}</h2>
      <fieldset className="log-fields" disabled={busy}>
        <div className="field" data-invalid={problems.title !== undefined ? '' : undefined}>
          <label htmlFor={`${id}-title`}>Title</label>
          <input
            id={`${id}-title`}
            ref={first}
            className="input"
            value={values.title}
            maxLength={LOG_TITLE_MAX_CHARS}
            autoComplete="off"
            aria-invalid={problems.title !== undefined}
            aria-describedby={describedBy('title')}
            onChange={(e) => change({ title: e.target.value }, 'title')}
          />
          {error('title')}
        </div>
        <div className="field">
          <label htmlFor={`${id}-tags`}>Tags</label>
          <input
            id={`${id}-tags`}
            className="input"
            value={values.tags}
            autoComplete="off"
            autoCapitalize="none"
            aria-invalid={problems.tags !== undefined}
            aria-describedby={describedBy('tags', `${id}-tags-hint`)}
            onChange={(e) => change({ tags: e.target.value }, 'tags')}
          />
          {error('tags')}
          <p className="hint" id={`${id}-tags-hint`}>
            Words that name the topic, separated by spaces. Search finds them like words of the title.
          </p>
        </div>
        <div className="field">
          <label htmlFor={`${id}-body`}>Entry</label>
          <textarea
            id={`${id}-body`}
            className="textarea log-body-input"
            rows={10}
            value={values.body}
            maxLength={LOG_BODY_MAX_CHARS}
            aria-invalid={problems.body !== undefined}
            aria-describedby={describedBy('body', `${id}-body-hint`)}
            onChange={(e) => change({ body: e.target.value }, 'body')}
          />
          {error('body')}
          <p className="hint" id={`${id}-body-hint`}>
            Plain text or markdown, shown as it is typed. One finding to an entry.
          </p>
        </div>
      </fieldset>
      {topError !== null && (
        <p className="error" role="alert">
          {topError}
        </p>
      )}
      <div className="log-actions">
        <button type="submit" className="btn" data-kind="primary" data-size="big" aria-disabled={busy || undefined}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn" data-size="big" data-kind="quiet" onClick={() => onDone(null)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function Reader({ entry, onEdit, onClose, onRemoved, onChanged }: { entry: LogEntry; onEdit(): void; onClose(): void; onRemoved(): void; onChanged(entry: LogEntry): void }): ReactElement {
  const titleId = useId();
  const agents = useStore((s) => s.agents);
  const { busy, error, run } = useRun();
  const anchorsOn = useFeature('knowledge-anchors');
  const [confirming, setConfirming] = useState(false);
  const [promoted, setPromoted] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const keep = useRef<HTMLButtonElement | null>(null);
  const del = useRef<HTMLButtonElement | null>(null);
  const asked = useRef(false);
  // the keyboard follows the entry that was opened, so a screen reader starts at its title
  useEffect(() => heading.current?.focus(), [entry.id]);
  useEffect(() => {
    // focus moves to Keep when it asks, and back to Delete when Keep closes the question
    if (confirming) keep.current?.focus();
    else if (asked.current) del.current?.focus();
    asked.current = confirming;
  }, [confirming]);
  return (
    <article className="log-entry module" aria-labelledby={titleId}>
      <h2 className="log-entry-title" id={titleId} ref={heading} tabIndex={-1}>
        {entry.title}
      </h2>
      <p className="log-meta">
        <span className="log-id">{entry.id}</span>
        <span>{legendOf(entry.author, agents)}</span>
        <span>{`updated ${whenText(entry.updatedAt, Date.now())}`}</span>
        <Tags tags={entry.tags} />
        <AnchorChip state={entry.anchorState} />
      </p>
      <pre className="log-body">{entry.body}</pre>
      <div className="log-actions">
        <button type="button" className="btn" onClick={onEdit}>
          Edit
        </button>
        {anchorsOn && entry.anchors !== undefined && (
          <button type="button" className="btn" aria-disabled={busy || undefined} onClick={() => void run(async () => onChanged(await api.recheckLogEntry(entry.id)))}>
            Recheck
          </button>
        )}
        {(entry.anchors?.length ?? 0) > 0 && (
          <button
            type="button"
            className="btn"
            data-kind="quiet"
            aria-describedby={`${titleId}-promote`}
            aria-disabled={busy || undefined}
            onClick={() =>
              !busy &&
              run(async () => {
                const made = await api.promoteEntry(entry.id);
                setPromoted(`${plain(made.claim.id, 20)} in ${made.repoId.slice(0, 8)}`);
              })
            }
          >
            Promote to a claim
          </button>
        )}
        {confirming ? (
          <div className="log-confirm flood" data-tone="nogo" role="group" aria-label={`Delete ${entry.id}?`}>
            <p>
              <strong>Delete {entry.id}?</strong> The file goes with it.
            </p>
            <button type="button" className="btn" ref={keep} onClick={() => setConfirming(false)}>
              Keep
            </button>
            <button
              type="button"
              className="btn"
              data-kind="primary"
              aria-disabled={busy || undefined}
              onClick={() => {
                setConfirming(false);
                run(async () => {
                  await api.deleteLogEntry(entry.id);
                  onRemoved();
                });
              }}
            >
              Delete
            </button>
          </div>
        ) : (
          <button type="button" ref={del} className="btn" data-kind="danger" aria-label={`Delete ${entry.id}`} aria-disabled={busy || undefined} onClick={() => setConfirming(true)}>
            Delete
          </button>
        )}
        <button type="button" className="btn" data-kind="quiet" onClick={onClose}>
          Close
        </button>
      </div>
      {(entry.anchors?.length ?? 0) > 0 && (
        <p className="hint" id={`${titleId}-promote`}>
          {promoted === null ? 'Promote makes a claim of the store from this entry (its title and anchors); the entry stays as it is.' : `Promoted: claim ${promoted}. See Flight Rules, Knowledge.`}
        </p>
      )}
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}

function Row({ hit, open, onOpen }: { hit: LogHit; open: boolean; onOpen(): void }): ReactElement {
  const agents = useStore((s) => s.agents);
  return (
    <li>
      <button type="button" id={rowId(hit.id)} className="log-row" aria-current={open ? 'true' : undefined} onClick={onOpen}>
        <span className="log-row-top">
          <span className="log-id">{hit.id}</span>
          <span className="log-who">{legendOf(hit.author, agents)}</span>
          <span className="log-when">{whenText(hit.updatedAt, Date.now())}</span>
        </span>
        <span className="log-row-title">{hit.title}</span>
        <Tags tags={hit.tags} />
        <AnchorChip state={hit.anchorState} />
        <span className="log-snippet">{hit.snippet}</span>
      </button>
    </li>
  );
}

/** The view of the top bar's MISSION LOG key. */
export function MissionLog(): ReactElement {
  const titleId = useId();
  const news = useStore((s) => s.log);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<LogSearch | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [entry, setEntry] = useState<LogEntry | null>(null);
  const [mode, setMode] = useState<'read' | 'edit' | 'new'>('read');
  const [lens, setLens] = useState<Lens>('entries');
  const [chart, setChart] = useState<LogChart | null>(null);
  // its own error: a good answer of the search must not wipe the word that the chart could not be had
  const [chartError, setChartError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const heading = useRef<HTMLHeadingElement | null>(null);
  const latest = useRef(0);
  // The page replaces the room: the keyboard starts at its title, not on a button that is gone.
  useEffect(() => heading.current?.focus(), []);

  // The list: asked again a moment after the last key, and at once when a frame says something changed.
  useEffect(() => {
    const ask = ++latest.current;
    const timer = setTimeout(() => {
      api.searchLog(query).then(
        (found) => {
          if (ask !== latest.current) return;
          setSearch(found);
          setListError(null);
        },
        (e: unknown) => ask === latest.current && setListError(messageOf(e)),
      );
    }, 200);
    return () => clearTimeout(timer);
  }, [query, news.rev]);

  // The Star Chart: asked when it is shown and again when a frame says something changed.
  useEffect(() => {
    if (lens === 'entries') return;
    let current = true;
    api.logChart().then(
      (found) => {
        if (!current) return;
        setChart(found);
        setChartError(null);
      },
      (e: unknown) => current && setChartError(messageOf(e)),
    );
    return () => {
      current = false;
    };
  }, [lens, news.rev]);

  // The open entry: asked again when a frame says something changed, since an agent may have rewritten it. One that is gone closes.
  useEffect(() => {
    if (openId === null) {
      setEntry(null);
      return;
    }
    let current = true;
    api.readLogEntry(openId).then(
      (found) => current && setEntry(found),
      (e: unknown) => {
        if (!current) return;
        if ((e as { status?: unknown }).status === 404) {
          setNotice(`${openId} was removed.`);
          setOpenId(null);
          setMode('read');
        } else setListError(messageOf(e));
      },
    );
    return () => {
      current = false;
    };
  }, [openId, news.rev]);

  // only what came while the page is up: the frame that was the last before it opened is old news
  const seen = useRef(news.rev);
  useEffect(() => {
    if (news.rev === seen.current) return;
    seen.current = news.rev;
    const text = newsText(news);
    if (text !== '') setNotice(text);
  }, [news]);

  const open = (id: string): void => {
    setOpenId(id);
    setMode('read');
  };
  const close = (): void => {
    const id = openId;
    setOpenId(null);
    setMode('read');
    // the key that opened it, when it is still in the list; else the title
    requestAnimationFrame(() => ((id === null ? null : document.getElementById(rowId(id))) ?? heading.current)?.focus());
  };
  const removed = (): void => {
    setOpenId(null);
    heading.current?.focus();
  };
  const saved = (found: LogEntry | null): void => {
    if (found === null) {
      setMode('read');
      // a cancelled new entry leaves nothing to focus (an open entry's reader takes the focus itself)
      if (openId === null) requestAnimationFrame(() => heading.current?.focus());
      return;
    }
    setEntry(found);
    setOpenId(found.id);
    setMode('read');
    setNotice(`${found.id} saved.`);
  };
  const showing = mode !== 'read' || openId !== null;

  return (
    <section className="log" aria-labelledby={titleId} data-open={showing ? '' : undefined}>
      <header className="loop-head">
        <h1 id={titleId} ref={heading} tabIndex={-1} className="disp loop-title log-heading">
          MISSION LOG
        </h1>
        <div className="chart-lens" role="group" aria-label="Show the log as">
          {LENSES.map((l) => (
            <button key={l.lens} type="button" className="btn" data-kind="quiet" aria-pressed={lens === l.lens} onClick={() => setLens(l.lens)}>
              {l.label}
            </button>
          ))}
        </div>
        <button type="button" className="btn" data-kind="primary" onClick={() => setMode('new')}>
          New entry
        </button>
        <button type="button" className="btn loop-room" data-kind="quiet" onClick={showRoom}>
          Room
        </button>
      </header>
      <div className="log-cols" data-lens={lens}>
        <div className="log-list">
          {lens === 'chart' && chart !== null && <Chart chart={chart} openId={openId} onOpen={open} />}
          {lens === 'links' && chart !== null && <Links chart={chart} openId={openId} onOpen={open} />}
          {lens !== 'entries' && chart === null && chartError === null && <p className="hint">Loading…</p>}
          {lens !== 'entries' && chartError !== null && (
            <p className="error" role="alert">
              {chartError}
            </p>
          )}
          {listError !== null && (
            <p className="error" role="alert">
              {listError}
            </p>
          )}
          {lens === 'entries' && (
            <>
              <form className="log-search module" role="search" onSubmit={(e) => e.preventDefault()}>
                <div className="field">
                  <label htmlFor={`${titleId}-q`}>Search the log</label>
                  <input
                    id={`${titleId}-q`}
                    className="input"
                    type="search"
                    value={query}
                    maxLength={LOG_QUERY_MAX_CHARS}
                    autoComplete="off"
                    autoCapitalize="none"
                    aria-describedby={`${titleId}-count`}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
                <p className="hint" id={`${titleId}-count`}>
                  {search === null ? 'Loading…' : countText(query, search)}
                </p>
              </form>
              {search !== null && search.hits.length === 0 && search.total === 0 && <p className="loop-empty">The log is empty. Agents write to it with log_write, and you can add an entry here.</p>}
              {search !== null && search.hits.length > 0 && (
                <ul className="log-rows">
                  {search.hits.map((hit) => (
                    <Row key={hit.id} hit={hit} open={hit.id === openId} onOpen={() => open(hit.id)} />
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
        <div className="log-side">
          {mode === 'new' && <EntryForm entry={null} onDone={saved} />}
          {mode === 'edit' && entry !== null && <EntryForm key={entry.id} entry={entry} onDone={saved} />}
          {mode === 'read' && entry !== null && openId === entry.id && <Reader entry={entry} onEdit={() => setMode('edit')} onClose={close} onRemoved={removed} onChanged={setEntry} />}
          {!showing && <p className="hint log-pick">Pick an entry to read it.</p>}
        </div>
      </div>
      <p className="sr-only" role="status">
        {notice}
      </p>
    </section>
  );
}
