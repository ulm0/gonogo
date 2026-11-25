import { useEffect, useId, useState } from 'react';
import type { ReactElement } from 'react';
import type { AutoReviewDraft, AutoReviewJob, AutoReviewSettings, AutoReviewView } from '../shared/protocol.js';
import * as api from './api.js';
import { Switch } from '@/ui/checkbox.js';
import { Textarea } from '@/ui/textarea.js';

const STATUS_TEXT: Record<AutoReviewJob['status'], string> = { queued: 'queued', running: 'reviewers working', done: 'draft ready', posted: 'posted', skipped: 'skipped', superseded: 'superseded by a new commit', failed: 'failed' };
/** Lists are typed one per line or separated by commas. */
const lines = (text: string): string[] => text.split(/[\n,]/).map((s) => s.trim()).filter((s) => s !== '');

/** The draft of one job as the Director reads it before POST: each reviewer's summary and findings by file, and what was dropped. Text only (it was cleaned on the server). */
export function DraftView({ draft }: { draft: AutoReviewDraft }): ReactElement {
  return (
    <div className="auto-review-draft" data-testid="auto-review-draft">
      {draft.overCap === true && <p className="error" role="status">{"This review went over its cap for a pull request, so it is not posted by itself: read it, then POST if you want it."}</p>}
      {draft.usd !== undefined && <p className="hint">{`Estimated cost so far: $${draft.usd.toFixed(2)}.`}</p>}
      {draft.parts.map((p) => (
        <div key={p.position}>
          <h4 className="label">{p.position.toUpperCase()}</h4>
          <p>{p.summary}</p>
          <ul>
            {p.findings.map((f, i) => (
              <li key={`${f.file}:${f.line}:${i}`}>
                <code>
                  {f.file}:{f.line}
                </code>{' '}
                <span className="chip" data-tone={f.severity === 'high' ? 'alert' : 'quiet'}>
                  {f.severity}
                </span>{' '}
                {f.text}
              </li>
            ))}
          </ul>
          {p.dropped.length > 0 && <p className="hint">{`${p.dropped.length} finding(s) dropped because they were not on a line of the diff.`}</p>}
        </div>
      ))}
    </div>
  );
}

/** Flight Rules: auto-review (docs/features/auto-review.md). The setting, the jobs of the watched repos, and the draft with its POST. */
export function AutoReviewBlock(): ReactElement {
  const id = useId();
  const [view, setView] = useState<AutoReviewView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState<{ job: string; draft: AutoReviewDraft | null } | null>(null);
  const [repos, setRepos] = useState('');
  const [authors, setAuthors] = useState('');
  const [busy, setBusy] = useState(false);
  const fail = (e: unknown): void => setProblem(e instanceof Error ? e.message : String(e));
  const load = (): void => void api.getAutoReview().then((found) => (setView(found), setProblem(null)), fail);
  useEffect(() => {
    let live = true;
    const read = (): void => void api.getAutoReview().then((found) => live && setView(found), (e: unknown) => live && fail(e));
    read();
    const timer = setInterval(read, 20_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (view !== null) {
      setRepos(view.settings.repos.join('\n'));
      setAuthors(view.settings.authors.join('\n'));
    }
    // only when the saved lists change, not on every poll of the jobs
  }, [view?.settings.repos.join(','), view?.settings.authors.join(',')]);
  const save = (patch: Partial<AutoReviewSettings>): void => {
    setBusy(true);
    setProblem(null);
    api.setAutoReview(patch).then(setView, fail).finally(() => setBusy(false));
  };
  const show = (job: AutoReviewJob): void => {
    setOpen({ job: job.id, draft: null });
    api.getReviewDraft(job.id).then((draft) => setOpen({ job: job.id, draft }), fail);
  };
  const act = (what: Promise<unknown>): void => {
    setBusy(true);
    setProblem(null);
    what.then(() => (setOpen(null), load()), fail).finally(() => setBusy(false));
  };
  return (
    <section className="module rules-block" aria-labelledby={`${id}-title`}>
      <h2 className="label" id={`${id}-title`}>
        AUTO-REVIEW
      </h2>
      <p className="hint">
        Reviews the pull requests of the repos you link: a branch of the same repo, by you or the authors you list, never a fork or a draft. RSO and RETRO read the diff, read-only, and write findings; nothing is posted until you click POST (or turn on auto-post). It comments under your own GitHub login and never approves or merges. Turning it on or changing what it watches asks for your password.
      </p>
      {view !== null && (
        <>
          <label className="staff-check">
            <Switch role="switch" checked={view.settings.enabled} disabled={busy} onChange={(e) => save({ enabled: e.target.checked })} />
            Review pull requests of the linked repos
          </label>
          <label className="staff-check">
            <Switch role="switch" checked={view.settings.autoPost} disabled={busy} onChange={(e) => save({ autoPost: e.target.checked })} />
            Post the review without my click (comments appear as you)
          </label>
          <div className="field">
            <label htmlFor={`${id}-repos`}>Repos (owner/repo, one per line)</label>
            <Textarea variant="field" id={`${id}-repos`} rows={2} value={repos} autoComplete="off" spellCheck={false} onChange={(e) => setRepos(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={`${id}-authors`}>Authors to review (GitHub logins; empty means only the login this room uses)</label>
            <Textarea variant="field" id={`${id}-authors`} rows={2} value={authors} autoComplete="off" spellCheck={false} onChange={(e) => setAuthors(e.target.value)} />
          </div>
          <button type="button" className="btn" aria-disabled={busy || undefined} onClick={() => !busy && save({ repos: lines(repos), authors: lines(authors) })}>
            Save the lists
          </button>{' '}
          <button type="button" className="btn" data-kind="quiet" aria-disabled={busy || !view.settings.enabled || undefined} onClick={() => !busy && view.settings.enabled && act(api.pollAutoReview())}>
            Look now
          </button>
          <p className="hint">
            Up to ${view.settings.maxUsdPerPr} a pull request and ${view.settings.maxUsdPerDay} a day (estimates); larger than {view.settings.maxFiles} files or {view.settings.maxLines} lines is skipped. {view.lastPoll === null ? 'Not looked yet.' : view.lastPoll.error === null ? `Last look ${new Date(view.lastPoll.at).toLocaleTimeString()}.` : `Last look failed: ${view.lastPoll.error}`}
          </p>
          {view.jobs.length === 0 ? (
            <p className="hint">No pull request yet.</p>
          ) : (
            <ul className="staff-room-list" aria-label="Review jobs">
              {view.jobs.slice(0, 15).map((job) => (
                <li key={job.id}>
                  <span>
                    {job.repo}#{job.pr}
                  </span>{' '}
                  <span className="hint">{job.title}</span>{' '}
                  <span className="chip" data-tone={job.status === 'failed' ? 'alert' : 'quiet'}>
                    {STATUS_TEXT[job.status]}
                    {job.reason !== undefined ? `: ${job.reason}` : ''}
                  </span>{' '}
                  {(job.status === 'done' || job.status === 'running' || job.status === 'posted') && (
                    <button type="button" className="btn" data-kind="quiet" onClick={() => show(job)}>
                      {job.status === 'done' ? 'Read the draft' : 'View'}
                    </button>
                  )}{' '}
                  {job.url !== undefined && /^https:\/\/github\.com\//.test(job.url) && (
                    <a href={job.url} target="_blank" rel="noreferrer noopener">
                      on GitHub
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
          {open !== null && (
            <div className="module" role="region" aria-label="Draft review">
              {open.draft === null ? <p className="hint">Nothing written yet.</p> : <DraftView draft={open.draft} />}
              {view.jobs.find((j) => j.id === open.job)?.status === 'done' && (
                <button type="button" className="btn" aria-disabled={busy || undefined} onClick={() => !busy && act(api.postReview(open.job))}>
                  POST to the pull request
                </button>
              )}{' '}
              {['done', 'running', 'queued'].includes(view.jobs.find((j) => j.id === open.job)?.status ?? '') && (
                <button type="button" className="btn" data-kind="quiet" aria-disabled={busy || undefined} onClick={() => !busy && act(api.skipReview(open.job))}>
                  Skip this job
                </button>
              )}{' '}
              <button type="button" className="btn" data-kind="quiet" onClick={() => setOpen(null)}>
                Close
              </button>
            </div>
          )}
        </>
      )}
      {problem !== null && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}
