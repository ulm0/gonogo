/**
 * Flight Rules: KNOWLEDGE (docs/knowledge-spec.md section 0b.4). For each repository the room works in: the claims the Director keeps about it, what the last check found
 * on each checkout (a word and a severity, never "false": "not confirmed" is as far as a read-only check can go), the proposals agents made (unreviewed, with a trial run
 * only the Director sees), and the checkouts that need the Director (BIND, IGNORE, UNBIND, MOVE). Nothing here blocks anything, and every text is drawn as plain text.
 */
import { useEffect, useId, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import type { Claim, ClaimResult, KnowledgeRepo, KnowledgeView, Proposal } from '../shared/protocol.js';
import * as api from './api.js';
import './knowledge.css';
import { anchorsText, atText, countsOf, folderOf, legText, plain, proposalsOrder, resultsOf, retryText, severityOf, shortId, sourceBadge, STATE_WORDS } from './knowledge.js';

/** One action at a time, with what failed: the message, and for a refused recheck or trial how long to wait (the server's `retryAfter`). */
function useRun(): { busy: boolean; error: string | null; retry: number | undefined; run(action: () => Promise<unknown>): void } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState<number | undefined>(undefined);
  const run = (action: () => Promise<unknown>): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setRetry(undefined);
    void action()
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setRetry((e as api.ApiFailure).retryAfter);
      })
      .finally(() => setBusy(false));
  };
  return { busy, error, retry, run };
}

const when = (at: number): string => new Date(at).toLocaleString();

/** The word of a result, with the branch it ran on and when. */
function ResultLine({ claim, result }: { claim: Claim; result: ClaimResult }): ReactElement {
  const state = STATE_WORDS[result.worst];
  const severity = severityOf(claim, result);
  return (
    <li className="know-result">
      <span className="chip" data-tone={state.tone}>
        {state.word}
      </span>
      <span className="hint">
        {folderOf(result.root)} · {atText(result.branch, result.commit)} · {when(result.checkedAt)}
        {severity === '' ? '' : ` · ${severity}`}
      </span>
      {result.legs.some((l) => l.note !== '') && (
        <ul className="know-notes">
          {result.legs.map((leg, i) => (leg.note === '' ? null : <li key={i}>{plain(leg.note, 200)}</li>))}
        </ul>
      )}
    </li>
  );
}

/** An add or edit form for a claim of the store: the statement, and the legs as the grammar writes them, one per line. */
function ClaimForm({ repo, claim, onDone, onSaved }: { repo: KnowledgeRepo; claim: Claim | null; onDone(): void; onSaved(next: KnowledgeRepo): void }): ReactElement {
  const id = useId();
  const { busy, error, run } = useRun();
  const [statement, setStatement] = useState(claim?.statement ?? '');
  const [anchors, setAnchors] = useState(claim === null ? '' : anchorsText(claim));
  const [diagnostics, setDiagnostics] = useState<Array<{ line: number; message: string }>>([]);
  const ready = statement.trim() !== '' && statement.trim().length <= 300;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!ready || busy) return;
    setDiagnostics([]);
    run(async () => {
      try {
        onSaved(claim === null ? await api.addClaim(repo.repoId, { statement: statement.trim(), anchors }) : await api.updateClaim(repo.repoId, claim.id, { statement: statement.trim(), anchors }));
        onDone();
      } catch (e) {
        setDiagnostics((e as api.ApiFailure).diagnostics ?? []);
        throw e;
      }
    });
  };
  return (
    <form className="know-form" onSubmit={submit} noValidate>
      <label htmlFor={`${id}-s`}>{claim === null ? 'New claim' : `Claim ${claim.id}`}</label>
      <input id={`${id}-s`} className="input" value={statement} maxLength={400} autoComplete="off" placeholder="Money is always an integer number of cents" aria-invalid={(statement.trim() !== '' && !ready) || undefined} onChange={(e) => setStatement(e.target.value)} />
      <label htmlFor={`${id}-a`}>Anchors, one per line</label>
      <textarea id={`${id}-a`} className="textarea know-anchors" value={anchors} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder={'src/**/*.ts !src/gen/** "parseFloat(" absent'} onChange={(e) => setAnchors(e.target.value)} />
      <p className="hint">A glob of tracked files (a leading ! leaves some out), then a pattern in /slashes/ or a fixed string in quotes, then present, absent, unique, count=N, each. A claim with no anchor is kept and never checked.</p>
      <div className="know-keys">
        <button type="submit" className="btn" data-kind="primary" aria-disabled={!ready || busy || undefined}>
          {claim === null ? 'Add claim' : 'Save claim'}
        </button>
        <button type="button" className="btn" data-kind="quiet" onClick={onDone}>
          Cancel
        </button>
      </div>
      {diagnostics.length > 0 && (
        <ul className="error know-diagnostics" role="alert">
          {diagnostics.map((d, i) => (
            <li key={i}>
              Line {d.line}: {plain(d.message, 200)}
            </li>
          ))}
        </ul>
      )}
      {error !== null && diagnostics.length === 0 && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function ClaimRow({ repo, claim, onSaved }: { repo: KnowledgeRepo; claim: Claim; onSaved(next: KnowledgeRepo): void }): ReactElement {
  const { busy, error, run } = useRun();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const mine = claim.source === 'store';
  const results = resultsOf(repo, claim);
  if (editing) return <li className="know-claim"><ClaimForm repo={repo} claim={claim} onDone={() => setEditing(false)} onSaved={onSaved} /></li>;
  return (
    <li className="know-claim" data-state={claim.state}>
      <div className="know-claim-head">
        <span className="plan-id">{plain(claim.id, 20)}</span>
        <span className="chip" data-tone="quiet">
          {plain(sourceBadge(claim), 24)}
        </span>
        <span className="chip" data-tone="quiet">
          {plain(claim.authority, 40)}
        </span>
        {claim.state !== 'active' && (
          <span className="chip" data-tone="quiet">
            {claim.state}
          </span>
        )}
      </div>
      <p className="know-statement">{plain(claim.statement)}</p>
      {claim.legs.length > 0 && <pre className="know-legs">{claim.legs.map((l) => plain(legText(l), 300)).join('\n')}</pre>}
      {claim.diagnostics.length > 0 && (
        <ul className="error know-diagnostics">
          {claim.diagnostics.map((d, i) => (
            <li key={i}>
              Line {d.line}: {plain(d.message, 200)}
            </li>
          ))}
        </ul>
      )}
      {claim.state === 'active' &&
        (results.length === 0 ? (
          <p className="hint">{claim.legs.length === 0 ? 'No anchor: never checked.' : 'Not checked yet.'}</p>
        ) : (
          <ul className="know-results">
            {results.map((r) => (
              <ResultLine key={r.root} claim={claim} result={r} />
            ))}
          </ul>
        ))}
      {mine ? (
        <div className="know-keys">
          <button type="button" className="btn" data-kind="quiet" aria-label={`Edit ${claim.id}`} aria-disabled={busy || undefined} onClick={() => setEditing(true)}>
            Edit
          </button>
          <button type="button" className="btn" data-kind="quiet" aria-label={`${claim.state === 'retired' ? 'Restore' : 'Retire'} ${claim.id}`} aria-disabled={busy || undefined} onClick={() => !busy && run(async () => onSaved(await api.updateClaim(repo.repoId, claim.id, { state: claim.state === 'retired' ? 'active' : 'retired' })))}>
            {claim.state === 'retired' ? 'Restore' : 'Retire'}
          </button>
          <button type="button" className="btn" data-kind="danger" aria-label={`Delete ${claim.id}`} aria-disabled={busy || undefined} onClick={() => setConfirming(true)}>
            Delete
          </button>
        </div>
      ) : (
        <p className="hint">{claim.source === 'repo' ? "Read from the repository's own file: change it there." : 'From a Mission Log entry: change it there.'}</p>
      )}
      {confirming && (
        <div className="flood" data-tone="nogo" role="group" aria-label={`Delete ${claim.id}`}>
          <p>Delete {plain(claim.id, 20)}? It is gone from the store; Retire keeps it.</p>
          <div className="know-keys">
            <button type="button" className="btn" onClick={() => setConfirming(false)}>
              Keep it
            </button>
            <button type="button" className="btn" data-kind="primary" aria-disabled={busy || undefined} onClick={() => !busy && run(async () => onSaved(await api.deleteClaim(repo.repoId, claim.id)))}>
              Delete
            </button>
          </div>
        </div>
      )}
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

/** A claim an agent proposed: unreviewed, labelled with who and where, and nothing happens until the Director accepts. */
function ProposalRow({ repo, proposal, onSaved }: { repo: KnowledgeRepo; proposal: Proposal; onSaved(next: KnowledgeRepo): void }): ReactElement {
  const id = useId();
  const { busy, error, retry, run } = useRun();
  const [reason, setReason] = useState('');
  const pending = proposal.status === 'pending';
  const trial = proposal.trial;
  return (
    <li className="know-claim" data-state={proposal.status}>
      <div className="know-claim-head">
        <span className="plan-id">{plain(proposal.id, 20)}</span>
        <span className="chip" data-tone="amber">
          unreviewed
        </span>
        <span className="hint">
          proposed by {plain(proposal.agent, 40)} · {atText(proposal.branch, proposal.commit)} · {when(proposal.at)}
        </span>
        {!pending && (
          <span className="chip" data-tone="quiet">
            {proposal.status}
          </span>
        )}
      </div>
      <p className="know-statement">{plain(proposal.statement)}</p>
      {proposal.legs.length > 0 && <pre className="know-legs">{proposal.legs.map((l) => plain(legText(l), 300)).join('\n')}</pre>}
      {proposal.reason !== undefined && proposal.reason !== '' && <p className="hint">Reason: {plain(proposal.reason, 200)}</p>}
      {pending && (
        <>
          {trial === undefined ? (
            <p className="hint">No trial run yet. A trial runs its anchors on that checkout, read-only, and shows you the result; the agent never sees it.</p>
          ) : (
            <ul className="know-results">
              <ResultLine claim={{ ...({} as Claim), legs: proposal.legs }} result={trial} />
            </ul>
          )}
          <div className="know-keys">
            <button type="button" className="btn" data-kind="quiet" aria-label={`Trial run ${proposal.id}`} aria-disabled={busy || undefined} onClick={() => !busy && run(async () => onSaved(await api.trialProposal(repo.repoId, proposal.id)))}>
              {trial === undefined ? 'Trial run' : 'Run it again'}
            </button>
            <button type="button" className="btn" data-kind="primary" aria-label={`Accept ${proposal.id}`} aria-disabled={busy || undefined} onClick={() => !busy && run(async () => onSaved(await api.acceptProposal(repo.repoId, proposal.id)))}>
              Accept
            </button>
            <label htmlFor={id} className="sr-only">
              Reason for rejecting {proposal.id} (optional)
            </label>
            <input id={id} className="input know-reason" value={reason} maxLength={200} autoComplete="off" placeholder="Reason (optional)" onChange={(e) => setReason(e.target.value)} />
            <button type="button" className="btn" data-kind="danger" aria-label={`Reject ${proposal.id}`} aria-disabled={busy || undefined} onClick={() => !busy && run(async () => onSaved(await api.rejectProposal(repo.repoId, proposal.id, reason.trim())))}>
              Reject
            </button>
          </div>
        </>
      )}
      {error !== null && (
        <p className="error" role="alert">
          {error}
          {retryText(retry)}
        </p>
      )}
    </li>
  );
}

/** The roots of a repo: where each checkout is, whether it is bound to this id, and what the Director can do about it. */
function Roots({ repo, onSaved }: { repo: KnowledgeRepo; onSaved(next: KnowledgeRepo): void }): ReactElement {
  const { busy, error, run } = useRun();
  const act = (path: string, action: 'bind' | 'ignore' | 'unbind'): void => {
    if (!busy) run(async () => onSaved(await api.bindRoot(repo.repoId, path, action)));
  };
  const twice = repo.roots.length > 1 && repo.roots.some((r) => !r.bound);
  return (
    <section className="know-roots" aria-label={`Checkouts of ${repo.label}`}>
      <h4 className="label">CHECKOUTS</h4>
      {twice && <p className="hint">Two checkouts claim {plain(repo.label, 80)}. Only a checkout you bound counts: a checkout can say it is any repository, so an unbound one reads and proposes nothing here.</p>}
      <ul className="know-roots-list">
        {repo.roots.map((root) => (
          <li key={root.path}>
            <span className="know-root-path" title={root.path}>
              {plain(root.path, 120)}
            </span>
            <span className="hint">
              {plain(root.branch, 60)}
              {root.agents.length > 0 ? ` · ${root.agents.map((a) => plain(a, 30)).join(', ')}` : ' · no agent'}
            </span>
            {root.bound ? (
              <>
                <span className="chip" data-tone="go">
                  bound
                </span>
                <button type="button" className="btn" data-kind="quiet" aria-label={`Unbind ${root.path}`} aria-disabled={busy || undefined} onClick={() => act(root.path, 'unbind')}>
                  Unbind
                </button>
              </>
            ) : (
              <>
                <span className="chip" data-tone="amber">
                  unbound
                </span>
                <button type="button" className="btn" aria-label={`Bind ${root.path}`} aria-disabled={repo.provisional || busy || undefined} onClick={() => !repo.provisional && act(root.path, 'bind')}>
                  Bind
                </button>
                <button type="button" className="btn" data-kind="quiet" aria-label={`Ignore ${root.path}`} aria-disabled={busy || undefined} onClick={() => act(root.path, 'ignore')}>
                  Ignore
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** Other ids that look like this repo (its root was rewritten, its remote moved): the Director decides; nothing moves by itself, and a move asks for the password. */
function Candidates({ repo, onSaved }: { repo: KnowledgeRepo; onSaved(next: KnowledgeRepo): void }): ReactElement | null {
  const { busy, error, run } = useRun();
  if (repo.candidates.length === 0) return null;
  return (
    <section className="know-candidates" aria-label={`Other repositories that look like ${repo.label}`}>
      {repo.candidates.map((c) => (
        <div key={c.repoId} className="flood" data-tone="amber">
          <p>
            Looks like {plain(c.label, 80)} ({shortId(c.repoId)}): {plain(c.why, 200)}
          </p>
          <div className="know-keys">
            <button type="button" className="btn" data-kind="primary" aria-label={`Move the claims of ${c.label} here`} aria-disabled={busy || undefined} onClick={() => !busy && run(async () => onSaved(await api.moveRepo(repo.repoId, c.repoId, 'move')))}>
              Move claims here
            </button>
            <button type="button" className="btn" data-kind="quiet" aria-disabled={busy || undefined} onClick={() => !busy && run(async () => onSaved(await api.moveRepo(repo.repoId, c.repoId, 'keep')))}>
              Keep separate
            </button>
          </div>
        </div>
      ))}
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** One repository. Exported for the tests, which draw it from fixtures. */
export function RepoCard({ repo, onSaved }: { repo: KnowledgeRepo; onSaved(next: KnowledgeRepo): void }): ReactElement {
  const { busy, error, retry, run } = useRun();
  const [adding, setAdding] = useState(false);
  const counts = countsOf(repo);
  const proposals = proposalsOrder(repo.proposals);
  return (
    <article className="know-repo module" aria-label={`Knowledge of ${repo.label}`}>
      <div className="know-repo-head">
        <h3 className="disp">{plain(repo.label, 80)}</h3>
        <span className="chip" data-tone="quiet">
          {shortId(repo.repoId)}
        </span>
        {repo.provisional && (
          <span className="chip" data-tone="amber">
            provisional
          </span>
        )}
        {counts.stale + counts.vacuous > 0 && (
          <span className="chip" data-tone="amber">
            {counts.stale > 0 ? `${counts.stale} not confirmed` : ''}
            {counts.stale > 0 && counts.vacuous > 0 ? ', ' : ''}
            {counts.vacuous > 0 ? `${counts.vacuous} vacuous` : ''}
          </span>
        )}
        <button type="button" className="btn" aria-disabled={busy || undefined} onClick={() => !busy && run(async () => onSaved(await api.recheckRepo(repo.repoId)))}>
          Recheck
        </button>
      </div>
      {repo.provisional && <p className="hint">A shallow clone: its first commit is not known, so its id is provisional. Claims can be read; proposals and binding wait until it is fetched in full.</p>}
      {error !== null && (
        <p className="error" role="alert">
          {error}
          {retryText(retry)}
        </p>
      )}
      <Roots repo={repo} onSaved={onSaved} />
      <Candidates repo={repo} onSaved={onSaved} />
      <h4 className="label">CLAIMS</h4>
      {repo.claims.length === 0 ? (
        <p className="hint">No claim yet. A claim is something true about this repository that you want checked, such as a name that must not come back.</p>
      ) : (
        <ul className="know-claims">
          {repo.claims.map((claim) => (
            <ClaimRow key={`${claim.source}:${claim.id}`} repo={repo} claim={claim} onSaved={onSaved} />
          ))}
        </ul>
      )}
      {adding ? (
        <ClaimForm repo={repo} claim={null} onDone={() => setAdding(false)} onSaved={onSaved} />
      ) : (
        <button type="button" className="btn" onClick={() => setAdding(true)}>
          Add claim
        </button>
      )}
      <h4 className="label">PROPOSALS{counts.pending > 0 ? ` · ${counts.pending} WAITING` : ''}</h4>
      {proposals.length === 0 ? (
        <p className="hint">No agent has proposed a claim. A proposal does nothing until you accept it, and the agent only learns that you accepted or rejected it.</p>
      ) : (
        <ul className="know-claims">
          {proposals.map((p) => (
            <ProposalRow key={p.id} repo={repo} proposal={p} onSaved={onSaved} />
          ))}
        </ul>
      )}
    </article>
  );
}

export function KnowledgeBlock(): ReactElement {
  const id = useId();
  const [view, setView] = useState<KnowledgeView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.knowledge().then(
      (found) => live && setView(found),
      (e: unknown) => live && setProblem(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, []);
  const put = (next: KnowledgeRepo): void => setView((v) => (v === null ? v : { ...v, repos: v.repos.map((r) => (r.repoId === next.repoId ? next : r)) }));
  return (
    <section className="module rules-block" aria-labelledby={`${id}-title`}>
      <h2 className="label" id={`${id}-title`}>
        KNOWLEDGE
      </h2>
      <p className="hint">
        What you want to stay true about a repository, checked read-only against each checkout an agent works in. &ldquo;Not confirmed&rdquo; means the check did not find it on that branch: it is a prompt to look, never a verdict, and nothing is ever blocked by it. Claims are yours; an agent can only
        propose one, and a proposal does nothing until you accept it. What a repository&apos;s own files say is shown here and never handed to an agent.
      </p>
      {problem !== null && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      {view !== null && !view.enabled && <p className="hint">Off. Turn on Knowledge in the Features block of this page to check claims.</p>}
      {view !== null && view.enabled && view.repos.length === 0 && <p className="hint">No repository yet. One appears here once an agent of this room works in a git folder.</p>}
      {view !== null && view.enabled && view.repos.map((repo) => <RepoCard key={repo.repoId} repo={repo} onSaved={put} />)}
    </section>
  );
}
