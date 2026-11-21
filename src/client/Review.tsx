/**
 * Post-Flight Review, in the Recorder: the changes of a console against its last commit, split into files and hunks with line
 * numbers. A click on a line, or the + key in its gutter, opens a note under it; notes show under their line with their tone,
 * can be answered, resolved, reopened and deleted, and are listed with a filter and a jump to their line. A note whose line moved
 * follows it; one whose line is gone is listed in its own group with its old place and text. APPROVE and REQUEST CHANGES give a
 * verdict (the open notes go to the agent as one message); ASK WALKTHROUGH and PEER REVIEW ask an agent to explain or to review.
 * From the keyboard: n and p walk through the notes, c adds a note on the line that has the focus. The page asks again every few
 * seconds, so what the agents write appears; a form being written is never replaced.
 */
import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactElement } from 'react';
import { REVIEW_BODY_MAX_CHARS, REVIEW_TONES } from '../shared/protocol.js';
import type { ReviewFileDiff, ReviewLine, ReviewNote, ReviewSide, ReviewTone, ReviewView } from '../shared/protocol.js';
import * as api from './api.js';
import { whenText } from './inbox.js';
import { useRefresh } from './refresh.js';
import { useAgentList } from './RoomView.js';
import {
  actionProblems,
  authorText,
  bodyProblem,
  countThreads,
  emptyNote,
  FILTERS,
  filterThreads,
  lineDomId,
  lineKey,
  noteDomId,
  noteRequest,
  numberOf,
  outdatedThreads,
  peerCandidates,
  placeText,
  sideOf,
  STATUS_LABELS,
  stepNote,
  threadsByLine,
  threadsOf,
  TONE_CHIPS,
  TONE_LABELS,
  verdictText,
} from './reviewModel.js';
import type { Filter, NoteValues, Thread } from './reviewModel.js';
import './review.css';

/** The console whose diff is under review: the pieces below read it instead of being passed it through every level. */
const AgentContext = createContext('');

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type Place = { path: string; side: ReviewSide; line: number } | { replyTo: string };

/** The form of a note or a reply: the words, and for a note a tone. Esc closes it. */
function NoteForm({ place, label, onSave, onCancel }: { place: Place; label: string; onSave(request: ReturnType<typeof noteRequest>): Promise<void>; onCancel(): void }): ReactElement {
  const id = useId();
  const [values, setValues] = useState<NoteValues>(emptyNote);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => first.current?.focus(), []);
  const reply = 'replyTo' in place;

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const problem = bodyProblem(values.body);
    setError(problem);
    if (problem !== null) return void first.current?.focus();
    setBusy(true);
    try {
      await onSave(noteRequest(values, place));
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
    }
  }

  return (
    <form className="rv-form" aria-label={label} noValidate onSubmit={(e) => void submit(e)} onKeyDown={(e: KeyboardEvent) => e.key === 'Escape' && !e.nativeEvent.isComposing && onCancel()}>
      <label htmlFor={`${id}-body`} className="sr-only">
        {label}
      </label>
      <textarea
        id={`${id}-body`}
        ref={first}
        className="textarea"
        rows={2}
        value={values.body}
        maxLength={REVIEW_BODY_MAX_CHARS}
        placeholder={reply ? 'Your answer' : 'What do you want to say about this line?'}
        aria-invalid={error !== null}
        aria-describedby={error === null ? undefined : `${id}-error`}
        disabled={busy}
        onChange={(e) => setValues((v) => ({ ...v, body: e.target.value }))}
      />
      <div className="rv-form-row">
        {!reply && (
          <>
            <label htmlFor={`${id}-tone`} className="rv-tone-label">
              Tone
            </label>
            <select id={`${id}-tone`} className="input" value={values.tone} disabled={busy} onChange={(e) => setValues((v) => ({ ...v, tone: e.target.value as ReviewTone }))}>
              {REVIEW_TONES.map((t) => (
                <option key={t} value={t}>
                  {TONE_LABELS[t].toLowerCase()}
                </option>
              ))}
            </select>
          </>
        )}
        <button type="submit" className="btn" data-kind="primary" aria-disabled={busy || undefined}>
          {busy ? 'Adding…' : reply ? 'Reply' : 'Add note'}
        </button>
        <button type="button" className="btn" data-kind="quiet" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {error !== null && (
        <p className="error" id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function NoteItem({ note, nested, onChanged }: { note: ReviewNote; nested?: boolean; onChanged(): void }): ReactElement {
  const agent = useContext(AgentContext);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = (work: () => Promise<unknown>): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    work()
      .then(onChanged, (e: unknown) => setError(messageOf(e)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="rv-note" id={noteDomId(note.id)} tabIndex={-1} data-tone={note.tone} data-status={note.status} data-nested={nested || undefined}>
      <div className="rv-note-top">
        {note.tone !== undefined && (
          <span className="chip" data-tone={TONE_CHIPS[note.tone]}>
            {TONE_LABELS[note.tone]}
          </span>
        )}
        <span className="rv-author">{authorText(note)}</span>
        {!nested && note.status !== 'open' && (
          <span className="chip" data-tone="quiet">
            {STATUS_LABELS[note.status]}
          </span>
        )}
        {note.place.state === 'moved' && (
          <span className="chip" data-tone="quiet">
            MOVED
          </span>
        )}
      </div>
      <p className="rv-body">{note.body}</p>
      <div className="rv-note-keys">
        {!nested && (
          <button type="button" className="btn" data-kind="quiet" aria-disabled={busy || undefined} onClick={() => act(() => api.reviewSetStatus(agent, note.id, note.status === 'resolved' ? 'open' : 'resolved'))}>
            {note.status === 'resolved' ? 'Reopen' : 'Resolve'}
          </button>
        )}
        {!nested && note.status === 'addressed' && (
          <button type="button" className="btn" data-kind="quiet" aria-disabled={busy || undefined} onClick={() => act(() => api.reviewSetStatus(agent, note.id, 'open'))}>
            Reopen
          </button>
        )}
        <button type="button" className="btn" data-kind="quiet" aria-label={`Delete note ${note.id}`} aria-disabled={busy || undefined} onClick={() => act(() => api.reviewRemoveNote(agent, note.id))}>
          Delete
        </button>
      </div>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function ThreadView({ thread, onChanged }: { thread: Thread; onChanged(): void }): ReactElement {
  const agent = useContext(AgentContext);
  const [replying, setReplying] = useState(false);
  return (
    <div className="rv-thread">
      <NoteItem note={thread.root} onChanged={onChanged} />
      {thread.replies.map((r) => (
        <NoteItem key={r.id} note={r} nested onChanged={onChanged} />
      ))}
      {replying ? (
        <NoteForm
          place={{ replyTo: thread.root.id }}
          label={`Reply to note ${thread.root.id}`}
          onCancel={() => setReplying(false)}
          onSave={async (request) => {
            await api.reviewAddNote(agent, request);
            setReplying(false);
            onChanged();
          }}
        />
      ) : (
        <button type="button" className="btn rv-reply" data-kind="quiet" onClick={() => setReplying(true)}>
          Reply
        </button>
      )}
    </div>
  );
}

function FileView({ file, byLine, adding, setAdding, onChanged }: { file: ReviewFileDiff; byLine: Map<string, Thread[]>; adding: string | null; setAdding(key: string | null): void; onChanged(): void }): ReactElement {
  const agent = useContext(AgentContext);
  const label = file.status === 'renamed' && file.oldPath !== undefined ? `${file.oldPath} → ${file.path}` : file.path;
  return (
    <details className="rv-file" open>
      <summary>
        <span className="rv-path">{label}</span>{' '}
        <span className="chip" data-tone="quiet">
          {file.status}
        </span>
      </summary>
      {file.binary && <p className="hint">A binary file: there are no lines to note.</p>}
      {file.hunks.map((hunk, h) => (
        <div key={h} className="rv-hunk" role="group" aria-label={`${file.path}: ${hunk.header}`}>
          <p className="rv-hunk-head">{hunk.header}</p>
          {hunk.lines.map((line: ReviewLine, i) => {
            const side = sideOf(line);
            const number = numberOf(line);
            const key = number === null ? null : lineKey(file.path, side, number);
            const threads = key === null ? [] : (byLine.get(key) ?? []);
            return (
              <div key={i} className="rv-row-group">
                <div
                  className="rv-line"
                  data-kind={line.kind}
                  data-path={file.path}
                  data-side={side}
                  data-number={number ?? undefined}
                  id={number === null ? undefined : lineDomId(file.path, side, number)}
                  tabIndex={-1}
                  onClick={() => key !== null && setAdding(key)}
                >
                  <span className="rv-num" aria-hidden="true">
                    {line.old ?? ''}
                  </span>
                  <span className="rv-num" aria-hidden="true">
                    {line.new ?? ''}
                  </span>
                  <code className="rv-text">
                    {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
                    {line.text}
                  </code>
                  {key !== null && number !== null && (
                    <button
                      type="button"
                      className="rv-add"
                      aria-label={`Add a note on ${file.path} line ${number} (${side})`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setAdding(key);
                      }}
                    >
                      +
                    </button>
                  )}
                </div>
                {threads.map((t) => (
                  <ThreadView key={t.root.id} thread={t} onChanged={onChanged} />
                ))}
                {key !== null && number !== null && adding === key && (
                  <NoteForm
                    place={{ path: file.path, side, line: number }}
                    label={`Note on ${file.path} line ${number} (${side})`}
                    onCancel={() => setAdding(null)}
                    onSave={async (request) => {
                      await api.reviewAddNote(agent, request);
                      setAdding(null);
                      onChanged();
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      ))}
    </details>
  );
}

/** The review of the console `agent`: its diff and notes, the verdict and the asks. */
export function Review({ agent }: { agent: string }): ReactElement {
  const id = useId();
  const agents = useAgentList();
  const [view, setView] = useState<ReviewView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [adding, setAdding] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [reviewer, setReviewer] = useState('');
  const [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  const asked = useRef(0);
  const root = useRef<HTMLElement | null>(null);

  const load = (): void => {
    const n = (asked.current += 1);
    api.reviewView(agent).then(
      (v) => {
        if (n !== asked.current) return;
        setView(v);
        setError(null);
      },
      (e: unknown) => void (n === asked.current && setError(messageOf(e))),
    );
  };
  useRefresh(load);

  const notes = view?.notes ?? [];
  const threads = useMemo(() => threadsOf(notes), [notes]);
  const shown = useMemo(() => filterThreads(threads, filter), [threads, filter]);
  const byLine = useMemo(() => threadsByLine(shown), [shown]);
  const lost = useMemo(() => outdatedThreads(shown), [shown]);
  const counts = useMemo(() => countThreads(threads), [threads]);
  const author = agents.find((a) => a.name === agent);
  const problems = actionProblems(author, counts, view?.repo ?? false);
  const peers = peerCandidates(agents, agent);
  const walk = useMemo(() => shown.filter((t) => t.root.place.state === 'exact' || t.root.place.state === 'moved').map((t) => t.root.id), [shown]);

  const run = (work: () => Promise<string>): void => {
    if (busy) return;
    setBusy(true);
    setNotice('');
    setError(null);
    work()
      .then(
        (text) => {
          setNotice(text);
          load();
        },
        (e: unknown) => setError(messageOf(e)),
      )
      .finally(() => setBusy(false));
  };

  const jump = (note: ReviewNote): void => {
    setCurrent(note.id);
    const line = document.getElementById(lineDomId(note.path, note.side, note.place.line));
    line?.scrollIntoView({ block: 'center' });
    (document.getElementById(noteDomId(note.id)) ?? line)?.focus();
  };

  /** n and p walk through the notes, c opens a note on the line that has the focus; nothing happens while typing. */
  const onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement;
    if (event.metaKey || event.ctrlKey || event.altKey || event.nativeEvent.isComposing || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (event.key === 'n' || event.key === 'p') {
      const next = stepNote(walk, current, event.key === 'n' ? 1 : -1);
      const note = notes.find((x) => x.id === next);
      if (note !== undefined) {
        event.preventDefault();
        jump(note);
      }
    } else if (event.key === 'c') {
      const line = target.closest<HTMLElement>('.rv-line');
      const path = line?.dataset.path;
      const side = line?.dataset.side;
      const number = Number(line?.dataset.number);
      if (path !== undefined && (side === 'old' || side === 'new') && Number.isInteger(number)) {
        event.preventDefault();
        setAdding(lineKey(path, side, number));
      }
    }
  };

  return (
    <AgentContext.Provider value={agent}>
      {/* the keys of the section are for a reader who has the focus inside it */}
      <section ref={root} className="module rc-box rv" aria-label="Post-Flight Review" onKeyDown={onKeyDown}>
        <div className="rc-head">
          <h2 className="label">Post-Flight Review</h2>
          <span className="chip" data-tone={counts.open > 0 ? 'amber' : 'quiet'}>
            {`${counts.open} open`}
          </span>
          <button type="button" className="btn" data-kind="quiet" onClick={load}>
            Refresh
          </button>
        </div>
        <p className="hint">The changes since the last commit, staged or not. Click a line or press c on it to add a note; n and p walk through the notes. The agents read them with review_read and answer with review_note.</p>
        <div className="rv-actions" role="group" aria-label="Review actions">
          <button type="button" className="btn" data-kind="primary" aria-disabled={busy || problems.approve !== null || undefined} onClick={() => problems.approve === null && run(async () => (await api.reviewVerdict(agent, 'approved'), `Approved: ${agent} was told.`))}>
            APPROVE
          </button>
          <button
            type="button"
            className="btn"
            aria-disabled={busy || problems.changes !== null || undefined}
            aria-describedby={problems.changes === null ? undefined : `${id}-why`}
            onClick={() => problems.changes === null && run(async () => `Changes requested: ${(await api.reviewVerdict(agent, 'changes')).notes} open notes sent to ${agent}.`)}
          >
            REQUEST CHANGES
          </button>
          <button type="button" className="btn" aria-disabled={busy || problems.ask !== null || undefined} onClick={() => problems.ask === null && run(async () => (await api.reviewAsk(agent, { kind: 'walkthrough' }), `Asked ${agent} for a walkthrough of its diff.`))}>
            ASK WALKTHROUGH
          </button>
          <label htmlFor={`${id}-peer`} className="sr-only">
            Agent to review this diff
          </label>
          <select id={`${id}-peer`} className="input rv-peer" value={reviewer} onChange={(e) => setReviewer(e.target.value)}>
            <option value="">Pick a reviewer…</option>
            {peers.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name}
              </option>
            ))}
          </select>
          <button type="button" className="btn" aria-disabled={busy || reviewer === '' || problems.ask !== null || undefined} onClick={() => reviewer !== '' && problems.ask === null && run(async () => (await api.reviewAsk(agent, { kind: 'peer', reviewer }), `Asked ${reviewer} to review ${agent}'s diff.`))}>
            PEER REVIEW
          </button>
        </div>
        {problems.changes !== null && (
          <p className="hint" id={`${id}-why`}>
            {problems.changes}
          </p>
        )}
        {view !== null && (
          <p className="rv-verdict" data-stale={view.stale || undefined}>
            {verdictText(view, (ms) => whenText(ms, Date.now()))}
            {view.asked.length > 0 && ` Asked to review: ${view.asked.join(', ')}.`}
          </p>
        )}
        {notice !== '' && (
          <p className="chip rc-made" data-tone="go" role="status">
            {notice}
          </p>
        )}
        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {view === null && error === null && <p className="hint">Reading the diff…</p>}
        {view !== null && !view.repo && <p className="hint">{view.reason}</p>}
        {threads.length > 0 && (
          <div className="rv-list">
            <div className="rv-list-head">
              <h3 className="label">{`Notes (${threads.length})`}</h3>
              <div role="group" aria-label="Filter the notes" className="rv-filter">
                {FILTERS.map((f) => (
                  <button key={f.id} type="button" className="btn" data-kind={filter === f.id ? 'primary' : 'quiet'} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
            <ul>
              {shown.map(({ root: r, replies }) => (
                <li key={r.id} data-current={current === r.id || undefined}>
                  {r.tone !== undefined && (
                    <>
                      <span className="chip" data-tone={TONE_CHIPS[r.tone]}>
                        {TONE_LABELS[r.tone]}
                      </span>{' '}
                    </>
                  )}
                  <code>{placeText({ ...r, line: r.place.line })}</code> {authorText(r)}: {r.body.split('\n')[0]}
                  {replies.length > 0 && <span className="hint">{` · ${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}`}</span>}
                  {r.status !== 'open' && <span className="hint">{` · ${r.status}`}</span>}
                  {r.place.state === 'outdated' || r.place.state === 'unknown' ? (
                    <span className="chip" data-tone="amber">
                      {r.place.state === 'outdated' ? 'OUTDATED' : 'NOT SHOWN'}
                    </span>
                  ) : (
                    <button type="button" className="btn rv-jump" data-kind="quiet" aria-label={`Jump to ${placeText({ ...r, line: r.place.line })}`} onClick={() => jump(r)}>
                      Jump
                    </button>
                  )}
                </li>
              ))}
              {shown.length === 0 && <li className="hint">No note matches this filter.</li>}
            </ul>
          </div>
        )}
        {lost.length > 0 && (
          <div className="rv-lost" role="group" aria-label="Outdated notes">
            <h3 className="label">{`Outdated (${lost.length})`}</h3>
            <p className="hint">The line of these notes is not in the diff any more. They stay until you resolve or delete them.</p>
            {lost.map((t) => (
              <div key={t.root.id} className="rv-lost-item">
                <p className="rv-lost-place">
                  <code>{placeText(t.root)}</code>
                  <span className="hint">{t.root.text === '' ? '' : `: ${t.root.text}`}</span>
                </p>
                <ThreadView thread={t} onChanged={load} />
              </div>
            ))}
          </div>
        )}
        {view !== null && view.repo && view.files.length === 0 && <p className="hint">Nothing differs from the last commit.</p>}
        {view !== null && view.truncated && <p className="hint">The diff is longer than what is shown here: notes on later lines wait until the diff is smaller.</p>}
        {view?.files.map((f) => (
          <FileView key={f.path} file={f} byLine={byLine} adding={adding} setAdding={setAdding} onChanged={load} />
        ))}
      </section>
    </AgentContext.Provider>
  );
}
