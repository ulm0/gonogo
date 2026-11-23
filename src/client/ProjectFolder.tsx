/**
 * Flight Rules → Room → PROJECT FOLDER (docs/features/rooms.md, "Folders"): where the agents of this room work. The default is the folder gonogo was started in; a change
 * is for the agents that are hired or restarted after it, so when the boss runs in another folder the page offers to restart it. A write asks for the password again
 * (the dialog of api.ts); a refusal says why, in the words of the server.
 */
import { useEffect, useId, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import type { ProjectFolderView } from '../shared/protocol.js';
import * as api from './api.js';
import { bossNeedsRestart, sourceText } from './projectFolderModel.js';

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function ProjectFolderBlock(): ReactElement {
  const id = useId();
  const [view, setView] = useState<ProjectFolderView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restarted, setRestarted] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.projectFolder().then(
      (found) => live && setView(found),
      (e: unknown) => live && setProblem(messageOf(e)),
    );
    return () => {
      live = false;
    };
  }, []);
  const send = (dir: string | null): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setRestarted(null);
    api
      .setProjectFolder(dir)
      .then((next) => {
        setView(next);
        setEditing(false);
      })
      .catch((e: unknown) => setError(messageOf(e)))
      .finally(() => setBusy(false));
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (text.trim() !== '') send(text.trim());
  };
  const restartBoss = (): void => {
    if (view === null || view.boss === null || busy) return;
    const { name } = view.boss;
    setBusy(true);
    setError(null);
    // the boss's folder is changed, then it is started again in it (an agent keeps the folder it started in)
    api
      .edit(name, { dir: view.dir })
      .then(() => api.restart(name))
      .then(() => api.projectFolder())
      .then((next) => {
        setView(next);
        setRestarted(name);
      })
      .catch((e: unknown) => setError(messageOf(e)))
      .finally(() => setBusy(false));
  };
  return (
    <section className="module rules-block" aria-labelledby={`${id}-title`}>
      <h2 className="label" id={`${id}-title`}>
        PROJECT FOLDER
      </h2>
      <p className="hint">The folder your agents work in. The boss starts in it and the hire form offers it as the working directory; an agent can still choose another. A change is for agents hired or restarted after it.</p>
      {problem !== null && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      {view !== null && (
        <>
          <p className="pf-now">
            <code className="pf-dir">{view.dir}</code>
            <span className="chip" data-tone="quiet">
              {sourceText(view.source)}
            </span>
          </p>
          {typeof view.warning === 'string' && view.warning !== '' && (
            <p className="flood pf-warning" data-tone="amber" role="note">
              {view.warning}
            </p>
          )}
          {view.note !== undefined && <p className="hint">{view.note}</p>}
          {bossNeedsRestart(view) && view.boss !== null && (
            <div className="flood pf-restart" data-tone="amber" role="note">
              <p>
                {view.boss.name} runs in <code>{view.boss.dir}</code>. A restart puts it in <code>{view.dir}</code>.
              </p>
              <button type="button" className="btn" data-kind="primary" aria-disabled={busy || undefined} onClick={restartBoss}>
                Restart the boss now
              </button>
            </div>
          )}
          {restarted !== null && (
            <p className="hint" role="status">
              {restarted} was restarted in this folder.
            </p>
          )}
          {editing ? (
            <form className="pf-editor" onSubmit={submit} aria-label="Change the project folder">
              <input id={id} className="input" type="text" autoComplete="off" spellCheck={false} aria-label="Folder" placeholder="the whole path, e.g. /home/you/project" value={text} onChange={(e) => setText(e.target.value)} />
              <div className="rules-keys">
                <button type="submit" className="btn" data-kind="primary" aria-disabled={busy || text.trim() === '' || undefined}>
                  Set
                </button>
                {view.source === 'set' && (
                  <button type="button" className="btn" aria-disabled={busy || undefined} onClick={() => send(null)}>
                    Reset
                  </button>
                )}
                <button
                  type="button"
                  className="btn"
                  data-kind="quiet"
                  onClick={() => {
                    setEditing(false);
                    setError(null);
                  }}
                >
                  Cancel
                </button>
              </div>
              {error !== null && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
            </form>
          ) : (
            <>
              <button
                type="button"
                className="btn"
                data-kind="quiet"
                aria-label="Change the project folder"
                onClick={() => {
                  setText(view.source === 'set' ? view.dir : '');
                  setEditing(true);
                  setError(null);
                }}
              >
                Change
              </button>
              {error !== null && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
