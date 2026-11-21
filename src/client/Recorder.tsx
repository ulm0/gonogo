/**
 * Recorder: git for the selected console's folder (or its Clean Room worktree). What changed, a diff that can only be read,
 * the last 50 commits, and a commit of all changes or of what is staged, with the message the Director writes and the author
 * of his own git config. There is no button for push, pull, checkout or reset.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { RECORDER_LOG_MAX, RECORDER_MESSAGE_MAX_CHARS } from '../shared/protocol.js';
import type { RecorderCommit, RecorderDiff, RecorderFile, RecorderScope, RecorderStatus } from '../shared/protocol.js';
import * as api from './api.js';
import { WorkspaceHead, useWorkspaceAgent } from './Hangar.js';
import { whenText } from './inbox.js';
import { Review } from './Review.js';
import { commitGate } from './reviewModel.js';
import { commitProblem, diffLines, fileLabels, shortHash, stagedCount } from './changes.js';
import './loop.css';
import './hangar.css';
import './recorder.css';

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function Git({ agent }: { agent: string }): ReactElement {
  const id = useId();
  const [status, setStatus] = useState<RecorderStatus | null>(null);
  const [log, setLog] = useState<RecorderCommit[]>([]);
  const [picked, setPicked] = useState<string>('');
  const [staged, setStaged] = useState(false);
  const [diff, setDiff] = useState<RecorderDiff | null>(null);
  const [message, setMessage] = useState('');
  const [scope, setScope] = useState<RecorderScope>('all');
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The soft gate: why the Director is asked once more before a commit (open review notes, a verdict that is not an approval of this diff). */
  const [gate, setGate] = useState<string | null>(null);
  const alive = useRef(true);
  const asked = useRef(0);

  /** The last answer wins: a slow diff of a file that was left must not replace the diff of the one that is open. */
  const loadDiff = (path: string, cached: boolean): void => {
    const n = (asked.current += 1);
    api.gitDiff(agent, path, cached).then(
      (d) => void (alive.current && n === asked.current && (setDiff(d), setError(null))),
      (e: unknown) => void (alive.current && n === asked.current && setError(messageOf(e))),
    );
  };

  const refresh = (path = picked, cached = staged): void => {
    api.gitStatus(agent).then(
      (s) => {
        if (!alive.current) return;
        setStatus(s);
        if (s.repo) {
          void api.gitLog(agent).then((l) => alive.current && setLog(l), (e: unknown) => alive.current && setError(messageOf(e)));
          loadDiff(path, cached);
        }
      },
      (e: unknown) => void (alive.current && setError(messageOf(e))),
    );
  };

  useEffect(() => {
    alive.current = true;
    refresh();
    return () => {
      alive.current = false;
    };
    // once per agent: every later load is asked for
  }, []);

  const files: readonly RecorderFile[] = status?.repo ? status.files : [];
  const author = status?.repo ? status.author : null;
  const problem = commitProblem(message, scope, files, author !== null);
  const lines = useMemo(() => diffLines(diff?.diff ?? ''), [diff]);
  const now = useMemo(() => Date.now(), [log]);

  const show = (path: string, cached: boolean): void => {
    setPicked(path);
    setStaged(cached);
    loadDiff(path, cached);
  };

  async function commit(event: FormEvent | null, confirmed = false): Promise<void> {
    event?.preventDefault();
    if (busy || problem !== null) return;
    setBusy(true);
    setError(null);
    setMade(null);
    try {
      if (!confirmed) {
        // a review that cannot be read is not a reason to stop a commit
        const why = commitGate(await api.reviewView(agent).catch(() => null));
        if (why !== null) {
          if (alive.current) setGate(why);
          return;
        }
      }
      setGate(null);
      const done = await api.gitCommit(agent, { message, scope });
      if (!alive.current) return;
      setMessage('');
      setMade(`Committed ${shortHash(done.hash)}: ${done.subject}`);
      setPicked('');
      setStaged(false);
      refresh('', false);
    } catch (e) {
      if (alive.current) setError(messageOf(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  if (status === null) {
    return error === null ? (
      <p className="hint hg-empty" role="status">
        Reading git…
      </p>
    ) : (
      <div className="rc-box rc-retry">
        <p className="error" role="alert">
          {error}
        </p>
        <button
          type="button"
          className="btn"
          data-kind="quiet"
          onClick={() => {
            setError(null);
            refresh();
          }}
        >
          Try again
        </button>
      </div>
    );
  }
  if (!status.repo) {
    return (
      <p className="hint hg-empty" role="status">
        {status.reason}
      </p>
    );
  }
  return (
    <div className="hg-cols rc-cols">
      <div className="rc-side">
        <section className="module rc-box" aria-label="Changes">
          <div className="rc-head">
            <h2 className="label">Changes</h2>
            <span className="chip" data-tone="quiet">
              {status.branch}
            </span>
            <button type="button" className="btn" data-kind="quiet" onClick={() => refresh()}>
              Refresh
            </button>
          </div>
          <p className="rc-author">
            {author === null ? (
              <span className="chip" data-tone="amber">
                No git author. Set user.name and user.email.
              </span>
            ) : (
              `Author: ${author.name} <${author.email}>`
            )}
          </p>
          <ul className="rc-files">
            <li>
              <button type="button" className="rc-file" aria-pressed={picked === ''} onClick={() => show('', staged)}>
                All changes
              </button>
            </li>
            {files.map((file) => (
              <li key={file.path}>
                <button type="button" className="rc-file" aria-pressed={picked === file.path} onClick={() => show(file.path, file.tree === ' ' && file.index !== '?')}>
                  <span className="rc-path">{file.path}</span>
                  <span className="rc-labels">
                    {fileLabels(file).map((l) => (
                      <span key={l.text} className="chip" data-tone={l.staged ? 'go' : 'quiet'}>
                        {l.text}
                      </span>
                    ))}
                  </span>
                </button>
              </li>
            ))}
            {files.length === 0 && <li className="hint">Nothing has changed.</li>}
            {status.more > 0 && <li className="hint">{`${status.more} more files than are shown.`}</li>}
          </ul>
        </section>
        <form className="module rc-box rc-commit" aria-label="Commit" noValidate onSubmit={(e) => void commit(e)}>
          <h2 className="label">Commit</h2>
          <div className="field">
            <label htmlFor={`${id}-message`}>Message</label>
            <textarea id={`${id}-message`} className="textarea" rows={3} value={message} maxLength={RECORDER_MESSAGE_MAX_CHARS} autoComplete="off" onChange={(e) => setMessage(e.target.value)} />
          </div>
          <fieldset className="field rc-scope">
            <legend>What to commit</legend>
            <label className="rc-radio">
              <input type="radio" className="radio" name={`${id}-scope`} checked={scope === 'all'} onChange={() => setScope('all')} />
              {`All changes (${files.length}): git adds them first`}
            </label>
            <label className="rc-radio">
              <input type="radio" className="radio" name={`${id}-scope`} checked={scope === 'staged'} onChange={() => setScope('staged')} />
              {`Only what is staged (${stagedCount(files)})`}
            </label>
          </fieldset>
          <button type="submit" className="btn" data-kind="primary" aria-disabled={busy || problem !== null || undefined} aria-describedby={problem === null ? undefined : `${id}-why`}>
            Commit
          </button>
          {gate !== null && (
            <div className="flood rc-gate" data-tone="amber" role="alert">
              <p>{`${gate} Commit anyway?`}</p>
              <p className="hint">This is a question, not a lock: it only covers a commit made from this page, and an agent on the host commits by itself.</p>
              <div className="rc-gate-keys">
                <button type="button" className="btn" data-kind="primary" autoFocus aria-disabled={busy || undefined} onClick={() => void commit(null, true)}>
                  Commit anyway
                </button>
                <button type="button" className="btn" data-kind="quiet" onClick={() => setGate(null)}>
                  Not yet
                </button>
              </div>
            </div>
          )}
          <p className="hint">No git hook runs for a commit made here. The author is the one in your git config.</p>
          {problem !== null && (
            <p className="hint" id={`${id}-why`}>
              {problem}
            </p>
          )}
          {made !== null && (
            <p className="chip rc-made" data-tone="go" role="status">
              {made}
            </p>
          )}
        </form>
        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="rc-main">
        <section className="module rc-box" aria-label="Diff">
          <div className="rc-head">
            <h2 className="label">{`Diff: ${picked === '' ? 'all changes' : picked}`}</h2>
            <button type="button" className="btn" data-kind={staged ? 'quiet' : 'primary'} aria-pressed={!staged} onClick={() => show(picked, false)}>
              Not staged
            </button>
            <button type="button" className="btn" data-kind={staged ? 'primary' : 'quiet'} aria-pressed={staged} onClick={() => show(picked, true)}>
              Staged
            </button>
          </div>
          <pre className="lcd rc-diff" tabIndex={0} role="region" aria-label="Diff text">
            {lines.length === 0 ? (
              <span data-kind="ctx">{`Nothing ${staged ? 'is staged' : 'differs from the index'} here. A new file has no diff until it is staged.`}</span>
            ) : (
              lines.map((l, i) => (
                <span key={i} data-kind={l.kind}>
                  {l.text}
                  {'\n'}
                </span>
              ))
            )}
          </pre>
          {diff?.truncated === true && <p className="hint">The diff is longer than what is shown here.</p>}
        </section>
        <Review agent={agent} />
        <section className="module rc-box" aria-label="Log">
          <h2 className="label">{`Log: last ${RECORDER_LOG_MAX}`}</h2>
          {log.length === 0 ? (
            <p className="hint">No commits yet.</p>
          ) : (
            <ol className="rc-log">
              {log.map((c) => (
                <li key={c.hash}>
                  <code className="rc-hash">{shortHash(c.hash)}</code>
                  <span className="rc-subject">{c.subject}</span>
                  <span className="rc-by">{`${c.author}, ${whenText(c.at, now)}`}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
}

/** The view of the Git button of a console. */
export function Recorder(): ReactElement {
  const id = useId();
  const agent = useWorkspaceAgent();
  const heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <section className="hg" aria-labelledby={id}>
      <WorkspaceHead title="RECORDER" current="recorder" id={id} heading={heading} />
      {agent === null ? <p className="hint hg-empty">Pick a console in the room, or an agent above.</p> : <Git key={agent} agent={agent} />}
    </section>
  );
}
