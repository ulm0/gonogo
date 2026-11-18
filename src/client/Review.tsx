/**
 * Post-Flight Review, in the Recorder: the changes of a console against its last commit, split into files and hunks with line
 * numbers. A key on a line opens a note; notes show under their line with their tone, can be answered and resolved, and are
 * listed with a jump to their line. Three keys send the Director's words to the agents: SEND NOTES (the open notes, to the author),
 * ASK WALKTHROUGH (the author annotates its own diff) and PEER REVIEW (another agent reviews it). The page asks again every few
 * seconds, so what the agents write appears; a form being written is never replaced.
 */
import { createContext, useContext, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { REVIEW_RATIONALE_MAX_CHARS, REVIEW_SUMMARY_MAX_CHARS, REVIEW_TONES } from '../shared/protocol.js';
import type { ReviewFileDiff, ReviewLine, ReviewNote, ReviewSide, ReviewTone, ReviewView } from '../shared/protocol.js';
import * as api from './api.js';
import { useRefresh } from './refresh.js';
import { useAgentList } from './RoomView.js';
import { actionProblems, authorText, countNotes, emptyNote, lineDomId, lineKey, noteDomId, noteProblem, noteRequest, numberOf, peerCandidates, placeText, sentText, sideOf, threadsByLine, threadsOf, TONE_CHIPS, TONE_LABELS } from './review.js';
import type { NoteValues, Thread } from './review.js';
import './review.css';

/** The console whose diff is under review: the pieces below read it instead of being passed it through every level. */
const AgentContext = createContext('');

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type Place = { file: string; side: ReviewSide; line: number } | { replyTo: string };

/** The form of a note or a reply: one line, an optional reason, a tone. Enter in the line sends it, Esc closes it. */
function NoteForm({ place, label, onSave, onCancel }: { place: Place; label: string; onSave(request: ReturnType<typeof noteRequest>): Promise<void>; onCancel(): void }): ReactElement {
  const id = useId();
  const [values, setValues] = useState<NoteValues>(emptyNote);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement | null>(null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const problem = noteProblem(values.summary);
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
    <form className="rv-form" aria-label={label} noValidate onSubmit={(e) => void submit(e)} onKeyDown={(e) => e.key === 'Escape' && !e.nativeEvent.isComposing && onCancel()}>
      <label htmlFor={`${id}-summary`} className="sr-only">
        {label}
      </label>
      <input
        id={`${id}-summary`}
        ref={(el) => {
          if (el !== null && first.current === null) el.focus();
          first.current = el;
        }}
        className="input"
        value={values.summary}
        maxLength={REVIEW_SUMMARY_MAX_CHARS}
        placeholder="What do you want to say about this line?"
        autoComplete="off"
        aria-invalid={error !== null}
        aria-describedby={error === null ? undefined : `${id}-error`}
        disabled={busy}
        onChange={(e) => setValues((v) => ({ ...v, summary: e.target.value }))}
      />
      <label htmlFor={`${id}-why`} className="sr-only">
        Reason (optional)
      </label>
      <textarea
        id={`${id}-why`}
        className="textarea"
        rows={2}
        value={values.rationale}
        maxLength={REVIEW_RATIONALE_MAX_CHARS}
        placeholder="Why (optional)"
        disabled={busy}
        onChange={(e) => setValues((v) => ({ ...v, rationale: e.target.value }))}
      />
      <div className="rv-form-row">
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
        <button type="submit" className="btn" data-kind="primary" aria-disabled={busy || undefined}>
          {busy ? 'Adding…' : 'Add'}
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
    work().then(onChanged, (e: unknown) => setError(messageOf(e))).finally(() => setBusy(false));
  };
  return (
    <div className="rv-note" id={noteDomId(note.id)} tabIndex={-1} data-tone={note.tone} data-resolved={note.status === 'resolved' || undefined} data-nested={nested || undefined}>
      <div className="rv-note-top">
        <span className="chip" data-tone={TONE_CHIPS[note.tone]}>
          {TONE_LABELS[note.tone]}
        </span>
        <span className="rv-author">{authorText(note)}</span>
        {note.status === 'resolved' && (
          <span className="chip" data-tone="quiet">
            RESOLVED
          </span>
        )}
        {note.outdated && (
          <span className="chip" data-tone="amber">
            OUTDATED
          </span>
        )}
        {note.author === 'user' && note.sentAt !== null && (
          <span className="chip" data-tone="quiet">
            SENT
          </span>
        )}
      </div>
      <p className="rv-summary">{note.summary}</p>
      {note.rationale !== undefined && <p className="rv-why">{note.rationale}</p>}
      <div className="rv-note-keys">
        {!nested && (
          <button type="button" className="btn" data-kind="quiet" aria-disabled={busy || undefined} onClick={() => act(() => api.reviewSetStatus(agent, note.id, note.status === 'open' ? 'resolved' : 'open'))}>
            {note.status === 'open' ? 'Resolve' : 'Reopen'}
          </button>
        )}
        <button type="button" className="btn" data-kind="quiet" aria-label={`Remove note ${note.id}`} aria-disabled={busy || undefined} onClick={() => act(() => api.reviewRemoveNote(agent, note.id))}>
          Remove
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
        <span className="rv-path">{label}</span> <span className="chip" data-tone="quiet">{file.status}</span>
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
                <div className="rv-line" data-kind={line.kind} id={number === null ? undefined : lineDomId(file.path, side, number)} tabIndex={-1}>
                  <span className="rv-num" aria-hidden="true">{line.old ?? ''}</span>
                  <span className="rv-num" aria-hidden="true">{line.new ?? ''}</span>
                  <code className="rv-text">
                    {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
                    {line.text}
                  </code>
                  {key !== null && number !== null && (
                    <button type="button" className="rv-add" aria-label={`Add a note on ${file.path} line ${number} (${side})`} onClick={() => setAdding(key)}>
                      +
                    </button>
                  )}
                </div>
                {threads.map((t) => (
                  <ThreadView key={t.root.id} thread={t} onChanged={onChanged} />
                ))}
                {key !== null && number !== null && adding === key && (
                  <NoteForm
                    place={{ file: file.path, side, line: number }}
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

/** The review of the console `agent`: its diff and notes, the list of notes, and the three actions. */
export function Review({ agent }: { agent: string }): ReactElement {
  const id = useId();
  const agents = useAgentList();
  const [view, setView] = useState<ReviewView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [adding, setAdding] = useState<string | null>(null);
  const [reviewer, setReviewer] = useState('');
  const [busy, setBusy] = useState(false);
  const [bump, setBump] = useState(0);
  const asked = useRef(0);

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
  const changed = (): void => {
    setBump((b) => b + 1);
    load();
  };

  const notes = view?.notes ?? [];
  const counts = useMemo(() => countNotes(notes), [notes]);
  const author = agents.find((a) => a.name === agent);
  const problems = actionProblems(author, counts);
  const peers = peerCandidates(agents, agent);
  const byLine = useMemo(() => threadsByLine(notes), [notes]);
  const threads = useMemo(() => threadsOf(notes), [notes]);

  const run = (work: () => Promise<string>): void => {
    if (busy) return;
    setBusy(true);
    setNotice('');
    setError(null);
    work().then(
      (text) => {
        setNotice(text);
        changed();
      },
      (e: unknown) => setError(messageOf(e)),
    ).finally(() => setBusy(false));
  };

  const jump = (note: ReviewNote): void => {
    const target = document.getElementById(lineDomId(note.file, note.side, note.line));
    target?.scrollIntoView({ block: 'center' });
    (document.getElementById(noteDomId(note.id)) ?? target)?.focus();
  };

  return (
    <AgentContext.Provider value={agent}>
    <section className="module rc-box rv" aria-label="Post-Flight Review" data-bump={bump}>
      <div className="rc-head">
        <h2 className="label">Post-Flight Review</h2>
        <span className="chip" data-tone={counts.open > 0 ? 'amber' : 'quiet'}>
          {`${counts.open} open`}
        </span>
        <button type="button" className="btn" data-kind="quiet" onClick={load}>
          Refresh
        </button>
      </div>
      <p className="hint">The changes since the last commit, staged or not. Add a note with the + key on a line. The agents read it with review_read and answer with review_note.</p>
      <div className="rv-actions" role="group" aria-label="Review actions">
        <button
          type="button"
          className="btn"
          data-kind="primary"
          aria-disabled={busy || problems.send !== null || undefined}
          aria-describedby={problems.send === null ? undefined : `${id}-send-why`}
          onClick={() => problems.send === null && run(async () => sentText((await api.reviewAct(agent, 'send')).sent, agent))}
        >
          {`SEND NOTES${counts.toSend > 0 ? ` (${counts.toSend})` : ''}`}
        </button>
        <button type="button" className="btn" aria-disabled={busy || problems.walkthrough !== null || undefined} onClick={() => problems.walkthrough === null && run(async () => (await api.reviewAct(agent, 'walkthrough'), `Asked ${agent} for a walkthrough of its diff.`))}>
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
        <button type="button" className="btn" aria-disabled={busy || reviewer === '' || problems.peer !== null || undefined} onClick={() => reviewer !== '' && problems.peer === null && run(async () => (await api.reviewPeer(agent, reviewer), `Asked ${reviewer} to review ${agent}'s diff.`))}>
          PEER REVIEW
        </button>
      </div>
      {problems.send !== null && (
        <p className="hint" id={`${id}-send-why`}>
          {problems.send}
        </p>
      )}
      {view !== null && view.reviewers.length > 0 && <p className="hint">{`Asked to review: ${view.reviewers.join(', ')}.`}</p>}
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
          <h3 className="label">{`Notes (${notes.length})`}</h3>
          <ul>
            {threads.map(({ root, replies }) => (
              <li key={root.id}>
                <span className="chip" data-tone={TONE_CHIPS[root.tone]}>
                  {TONE_LABELS[root.tone]}
                </span>{' '}
                <code>{placeText(root)}</code> {authorText(root)}: {root.summary}
                {replies.length > 0 && <span className="hint">{` · ${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}`}</span>}
                {root.status === 'resolved' && <span className="hint"> · resolved</span>}
                {root.outdated ? (
                  <span className="chip" data-tone="amber">
                    OUTDATED
                  </span>
                ) : (
                  <button type="button" className="btn rv-jump" data-kind="quiet" aria-label={`Jump to ${placeText(root)}`} onClick={() => jump(root)}>
                    Jump
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {view !== null && view.repo && view.files.length === 0 && <p className="hint">Nothing differs from the last commit.</p>}
      {view !== null && view.truncated && <p className="hint">The diff is longer than what is shown here: notes on later lines wait until the diff is smaller.</p>}
      {view?.files.map((f) => (
        <FileView key={f.path} file={f} byLine={byLine} adding={adding} setAdding={setAdding} onChanged={changed} />
      ))}
    </section>
    </AgentContext.Provider>
  );
}
