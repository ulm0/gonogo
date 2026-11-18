/**
 * Hangar: the files of the selected console's folder (or its Clean Room worktree). A tree, and a plain monospaced textarea
 * with line numbers and Tab handling for a text file. The Director saves with a key (Ctrl or Cmd+S too); the server refuses
 * a save when the file changed on disk since it was read. No delete, no rename. An edit that is not saved stays in memory
 * when the page is left, and comes back with the agent.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactElement, RefObject } from 'react';
import { HANGAR_FILE_MAX_BYTES } from '../shared/protocol.js';
import type { HangarEntry, HangarListing } from '../shared/protocol.js';
import * as api from './api.js';
import type { ApiFailure } from './api.js';
import { drafts, gutterText, indentEdit, indentUnit, joinEol, joinPath, lineCount, newPathProblem, parentOf, sizeText, splitEol } from './editor.js';
import type { Edit, Eol } from './editor.js';
import { selectConsole, showHangar, showRecorder, showRoom, useStore } from './store.js';
import './loop.css';
import './hangar.css';

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The head of Hangar and of Recorder: the title, the agent they work on, the two tabs and the way back. */
export function WorkspaceHead({ title, current, id, heading }: { title: string; current: 'hangar' | 'recorder'; id: string; heading: RefObject<HTMLHeadingElement | null> }): ReactElement {
  const order = useStore((s) => s.order);
  const selected = useStore((s) => s.selected);
  return (
    <header className="loop-head hg-head">
      <h1 id={id} ref={heading} tabIndex={-1} className="disp loop-title hg-title">
        {title}
      </h1>
      <div className="field hg-agent">
        <label htmlFor={`${id}-agent`}>Agent</label>
        <select id={`${id}-agent`} className="input" value={selected !== null && order.includes(selected) ? selected : ''} onChange={(e) => selectConsole(e.target.value)}>
          {(selected === null || !order.includes(selected)) && <option value="">Pick an agent</option>}
          {order.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>
      <nav className="hg-tabs" aria-label="Files and git">
        <button type="button" className="btn" data-kind={current === 'hangar' ? 'primary' : 'quiet'} aria-current={current === 'hangar' ? 'page' : undefined} onClick={showHangar}>
          Files
        </button>
        <button type="button" className="btn" data-kind={current === 'recorder' ? 'primary' : 'quiet'} aria-current={current === 'recorder' ? 'page' : undefined} onClick={showRecorder}>
          Git
        </button>
      </nav>
      <button type="button" className="btn loop-room" data-kind="quiet" onClick={showRoom}>
        Room
      </button>
    </header>
  );
}

/** The views of Hangar and Recorder need a console that exists. */
export function useWorkspaceAgent(): string | null {
  const selected = useStore((s) => s.selected);
  const known = useStore((s) => selected !== null && s.agents[selected] !== undefined);
  return known ? selected : null;
}

/* ---- the tree ---- */

type Level = HangarListing | string | undefined;

interface TreeProps {
  path: string;
  depth: number;
  dirs: Readonly<Record<string, Level>>;
  expanded: ReadonlySet<string>;
  current: string | null;
  onToggle(path: string): void;
  onOpen(path: string): void;
}

function Tree({ path, depth, dirs, expanded, current, onToggle, onOpen }: TreeProps): ReactElement {
  const level = dirs[path];
  const indent = { paddingLeft: 10 + depth * 16 };
  if (level === undefined) return <p className="hint hg-note" style={indent}>Loading…</p>;
  if (typeof level === 'string') {
    return (
      <p className="error hg-note" role="alert">
        {level}
      </p>
    );
  }
  const row = (entry: HangarEntry): ReactElement => {
    const full = joinPath(path, entry.name);
    if (entry.kind === 'link') {
      return (
        <li key={entry.name}>
          <span className="hg-item hg-link" style={indent}>
            {entry.name}
            <span className="chip" data-tone="quiet">
              link
            </span>
          </span>
        </li>
      );
    }
    if (entry.kind === 'dir') {
      const open = expanded.has(full);
      return (
        <li key={entry.name}>
          <button type="button" className="hg-item" style={indent} aria-expanded={open} onClick={() => onToggle(full)}>
            <span className="hg-mark" aria-hidden="true">
              {open ? '▾' : '▸'}
            </span>
            {entry.name}
          </button>
          {open && (
            <ul className="hg-list">
              <Tree path={full} depth={depth + 1} dirs={dirs} expanded={expanded} current={current} onToggle={onToggle} onOpen={onOpen} />
            </ul>
          )}
        </li>
      );
    }
    return (
      <li key={entry.name}>
        <button type="button" className="hg-item" style={indent} aria-current={current === full ? 'true' : undefined} onClick={() => onOpen(full)}>
          <span className="hg-name">{entry.name}</span>
          <span className="hg-size">{sizeText(entry.size)}</span>
        </button>
      </li>
    );
  };
  return (
    <>
      {level.entries.map(row)}
      {level.entries.length === 0 && (
        <li className="hint hg-note" style={indent}>
          Empty.
        </li>
      )}
      {level.truncated && (
        <li className="hint hg-note" style={indent}>
          More entries than are shown.
        </li>
      )}
    </>
  );
}

/* ---- the editor ---- */

/** Applies an edit to the textarea in a way the browser's undo can take back. */
function apply(el: HTMLTextAreaElement, edit: Edit): void {
  el.focus();
  el.setSelectionRange(edit.from, edit.to);
  const done = edit.insert === '' ? document.execCommand('delete') : document.execCommand('insertText', false, edit.insert);
  if (!done) {
    el.setRangeText(edit.insert, edit.from, edit.to, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  el.setSelectionRange(edit.start, edit.end);
}

interface Open {
  path: string;
  /** What the file held when it was read (LF line ends), and the etag of that. */
  base: string;
  etag: string;
  eol: Eol;
  size: number;
  /** Why the editor will not change it, or null. */
  locked: string | null;
}

function openOf(path: string, text: string, etag: string, size: number): Open {
  const split = splitEol(text);
  return split === null
    ? { path, base: text, etag, eol: '\n', size, locked: 'This file mixes line endings, or has a lone carriage return, and the editor would change them. It is read-only here.' }
    : { path, base: split.text, etag, eol: split.eol, size, locked: null };
}

function Files({ agent }: { agent: string }): ReactElement {
  const id = useId();
  const kept = useMemo(() => drafts.get(agent) ?? null, [agent]);
  const [dirs, setDirs] = useState<Record<string, Level>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(['', ...(kept === null ? [] : ancestors(kept.path))]));
  const [file, setFile] = useState<Open | null>(() => (kept === null ? null : { path: kept.path, base: kept.base, etag: kept.etag, eol: kept.eol, size: 0, locked: null }));
  const [value, setValue] = useState(kept?.value ?? '');
  const [pending, setPending] = useState<string | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [createProblem, setCreateProblem] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ text: string; conflict: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const busyRef = useRef(false);
  const alive = useRef(true);
  const gutter = useRef<HTMLPreElement | null>(null);
  const editor = useRef<HTMLElement | null>(null);
  const leave = useRef(false);
  const latest = useRef({ file, value });
  latest.current = { file, value };
  const dirty = file !== null && file.locked === null && value !== file.base;
  const unit = useMemo(() => indentUnit(file?.base ?? ''), [file?.base]);
  const lines = useMemo(() => lineCount(value), [value]);
  const numbers = useMemo(() => gutterText(lines), [lines]);

  const act = async (work: () => Promise<void>): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (e) {
      if (alive.current) setProblem({ text: messageOf(e), conflict: (e as ApiFailure).status === 409 });
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  };

  const load = (path: string): Promise<void> =>
    api.listFiles(agent, path).then(
      (listing) => void (alive.current && setDirs((d) => ({ ...d, [path]: listing }))),
      (e: unknown) => void (alive.current && setDirs((d) => ({ ...d, [path]: messageOf(e) }))),
    );

  useEffect(() => {
    alive.current = true;
    for (const path of expanded) void load(path);
    return () => {
      alive.current = false;
      // an edit that was not saved waits for the Director's return
      const { file: f, value: v } = latest.current;
      if (f !== null && f.locked === null && v !== f.base) drafts.set(agent, { path: f.path, value: v, base: f.base, etag: f.etag, eol: f.eol });
      else drafts.delete(agent);
    };
    // the first load only: the folders that are open after it are loaded when they open
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent): void => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const toggle = (path: string): void => {
    const open = !expanded.has(path);
    setExpanded((s) => {
      const next = new Set(s);
      if (open) next.add(path);
      else next.delete(path);
      return next;
    });
    if (open && dirs[path] === undefined) void load(path);
  };

  const read = (path: string): Promise<void> =>
    act(async () => {
      const text = await api.readFile(agent, path);
      if (!alive.current) return;
      const next = openOf(path, text.text, text.etag, text.size);
      setFile(next);
      setValue(next.base);
      setSaved(false);
      setPending(null);
      // under 900 px the editor is below the tree: bring it up
      if (window.matchMedia('(max-width: 899px)').matches) requestAnimationFrame(() => editor.current?.scrollIntoView({ block: 'start' }));
    });

  const open = (path: string): void => {
    if (path === file?.path) return;
    if (dirty) setPending(path);
    else void read(path);
  };

  const save = (): Promise<void> =>
    act(async () => {
      if (file === null || file.locked !== null || value === file.base) return;
      const text = joinEol(value, file.eol);
      const done = await api.saveFile(agent, { path: file.path, text, etag: file.etag });
      if (!alive.current) return;
      setFile({ ...file, base: value, etag: done.etag, size: done.size });
      setSaved(true);
      void load(parentOf(file.path));
    });

  const create = (): Promise<void> =>
    act(async () => {
      const path = (creating ?? '').trim();
      const found = newPathProblem(path);
      setCreateProblem(found);
      if (found !== null) return;
      const parts = path.split('/').filter((p) => p !== '' && p !== '.');
      const made = await api.createFile(agent, { path: parts.join('/') });
      if (!alive.current) return;
      const folders = ancestors(parts.join('/'));
      setExpanded((s) => new Set([...s, ...folders]));
      await Promise.all(['', ...folders].map(load));
      setCreating(null);
      const next = openOf(made.path, '', made.etag, made.size);
      setFile(next);
      setValue('');
      setSaved(false);
    });

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void save();
      return;
    }
    if (event.key === 'Escape') {
      leave.current = true;
      return;
    }
    if (event.key === 'Shift') return;
    if (event.key !== 'Tab' || event.ctrlKey || event.altKey || event.metaKey || file?.locked != null) {
      leave.current = false;
      return;
    }
    if (leave.current) {
      // Escape, then Tab: the browser moves the focus on, so that Tab never traps the keyboard
      leave.current = false;
      return;
    }
    event.preventDefault();
    const el = event.currentTarget;
    apply(el, indentEdit(el.value, el.selectionStart, el.selectionEnd, event.shiftKey, unit));
  };

  const digits = String(lines).length;
  const folder = file === null ? '' : parentOf(file.path);
  return (
    <div className="hg-cols">
      <div className="hg-side module">
        <div className="hg-tools">
          <button
            type="button"
            className="btn"
            data-kind="quiet"
            aria-expanded={creating !== null}
            onClick={() => {
              setCreating(creating === null ? (folder === '' ? '' : `${folder}/`) : null);
              setCreateProblem(null);
            }}
          >
            New file
          </button>
          <button type="button" className="btn" data-kind="quiet" onClick={() => expanded.forEach((p) => void load(p))}>
            Refresh
          </button>
        </div>
        {creating !== null && (
          <form
            className="hg-new"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <div className="field" data-invalid={createProblem !== null ? '' : undefined}>
              <label htmlFor={`${id}-new`}>Path of the new file</label>
              <input
                id={`${id}-new`}
                className="input"
                value={creating}
                autoFocus
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                aria-invalid={createProblem !== null}
                aria-describedby={createProblem !== null ? `${id}-new-error` : `${id}-new-hint`}
                onChange={(e) => {
                  setCreating(e.target.value);
                  setCreateProblem(null);
                }}
                onKeyDown={(e) => e.key === 'Escape' && setCreating(null)}
              />
              {createProblem !== null ? (
                <p className="error" id={`${id}-new-error`}>
                  {createProblem}
                </p>
              ) : (
                <span className="hint" id={`${id}-new-hint`}>
                  Inside the agent's folder, in a folder that exists.
                </span>
              )}
            </div>
            <button type="submit" className="btn" data-kind="primary" aria-disabled={busy || undefined}>
              Create
            </button>
          </form>
        )}
        <ul className="hg-list hg-root">
          <Tree path="" depth={0} dirs={dirs} expanded={expanded} current={file?.path ?? null} onToggle={toggle} onOpen={open} />
        </ul>
      </div>
      <section className="hg-editor module" aria-label="Editor" ref={editor}>
        {pending !== null && (
          <div className="flood hg-ask" data-tone="amber" role="alert">
            <p>{`${file?.path ?? 'This file'} has changes that are not saved.`}</p>
            <div className="hg-row">
              <button type="button" className="btn" data-kind="danger" onClick={() => void read(pending)}>
                Discard and open {pending}
              </button>
              <button type="button" className="btn" data-kind="quiet" onClick={() => setPending(null)}>
                Keep editing
              </button>
            </div>
          </div>
        )}
        {problem !== null && (
          <div className="error hg-problem" role="alert">
            <p>{problem.text}</p>
            {problem.conflict && file !== null && (
              <button type="button" className="btn" onClick={() => void read(file.path)}>
                Discard my changes and reload
              </button>
            )}
          </div>
        )}
        {file === null ? (
          <p className="hint hg-empty">{`Pick a file in the tree, or make a new one. The editor opens text files of up to ${sizeText(HANGAR_FILE_MAX_BYTES)}.`}</p>
        ) : (
          <>
            <div className="hg-bar">
              <h2 className="hg-path">{file.path}</h2>
              <span className="chip" data-tone={dirty ? 'amber' : 'quiet'} role="status">
                {dirty ? 'Unsaved changes' : saved ? 'Saved' : file.locked !== null ? 'Read-only' : 'No changes'}
              </span>
              <span className="hg-size">{`${lines} ${lines === 1 ? 'line' : 'lines'}`}</span>
              <button type="button" className="btn" data-kind="primary" aria-disabled={!dirty || busy || undefined} onClick={() => dirty && void save()}>
                Save
              </button>
              <button type="button" className="btn" data-kind="quiet" aria-disabled={busy || undefined} onClick={() => void read(file.path)}>
                {dirty ? 'Discard changes' : 'Reload'}
              </button>
            </div>
            {file.locked !== null && <p className="hint">{file.locked}</p>}
            <div className="hg-ed" style={{ '--digits': digits } as CSSProperties}>
              <pre className="hg-gutter" ref={gutter} aria-hidden="true">
                {numbers}
              </pre>
              <textarea
                className="hg-text"
                value={value}
                readOnly={file.locked !== null}
                wrap="off"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                aria-label={`Contents of ${file.path}`}
                aria-describedby={`${id}-keys`}
                onChange={(e) => {
                  setValue(e.target.value);
                  setSaved(false);
                }}
                onKeyDown={onKeyDown}
                onScroll={(e) => {
                  if (gutter.current !== null) gutter.current.scrollTop = e.currentTarget.scrollTop;
                }}
              />
            </div>
            <p className="hint" id={`${id}-keys`}>
              Tab indents and Shift+Tab takes the indent back. To leave the box with the keyboard, press Escape, then Tab. Ctrl or Cmd+S saves.
            </p>
          </>
        )}
      </section>
    </div>
  );
}

/** "a/b/c.txt" has the folders "a" and "a/b". */
function ancestors(path: string): string[] {
  const parts = path.split('/').slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

/** The view of the Files button of a console. */
export function Hangar(): ReactElement {
  const id = useId();
  const agent = useWorkspaceAgent();
  const heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <section className="hg" aria-labelledby={id}>
      <WorkspaceHead title="HANGAR" current="hangar" id={id} heading={heading} />
      {agent === null ? <p className="hint hg-empty">Pick a console in the room, or an agent above.</p> : <Files key={agent} agent={agent} />}
    </section>
  );
}
