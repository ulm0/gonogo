/**
 * Flight Rules: ROOM RULES (docs/features/door.md), the Director's own text that every agent of the room gets at the start of a session, in the role
 * text, whatever its engine. It is the strongest text a console reads, so it is edited here only, behind the password again (api.ts turns the server's
 * step-up answer into the dialog and sends the change again), and a repo's AGENTS.md is only pointed to, never copied into it.
 */
import { useEffect, useId, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import type { RulesView } from '../shared/protocol.js';
import * as api from './api.js';
import { asSaved, bytesOf, bytesText, rulesProblem } from './roomRulesModel.js';
import { useRun } from './WallView.js';
import { Textarea } from '@/ui/textarea.js';

interface TextBlockProps {
  title: string;
  /** What this text is and who reads it, under the title. */
  hint: ReactNode;
  placeholder: string;
  label: string;
  /** The server trims this text (the rules do; the template is kept as typed). */
  trims: boolean;
  load(): Promise<RulesView>;
  save(text: string): Promise<RulesView>;
}

/** An editor for one of the Director's texts kept by the server (the rules, the template of the closing checklist): the size in bytes, the cap, SAVE, DISCARD and CLEAR. */
function TextBlock({ title, hint, placeholder, label, trims, load, save: send }: TextBlockProps): ReactElement {
  const id = useId();
  const [view, setView] = useState<RulesView | null>(null);
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const { busy, error, run } = useRun();
  useEffect(() => {
    let live = true;
    load().then(
      (found) => {
        if (!live) return;
        setView(found);
        setText(found.text);
      },
      (e: unknown) => live && setProblem(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, []);
  const max = view?.max ?? 8192;
  const bytes = bytesOf(asSaved(text, trims));
  const invalid = rulesProblem(text, max, trims);
  const changed = view !== null && asSaved(text, trims) !== view.text;
  const apply = (next: string): void =>
    run(async () => {
      const saved = await send(next);
      setView(saved);
      setText(saved.text);
    });
  return (
    <section className="module rules-block" aria-labelledby={`${id}-title`}>
      <h2 className="label" id={`${id}-title`}>
        {title}
      </h2>
      <p className="hint">{hint}</p>
      {problem !== null && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      {view !== null && (
        <>
          <label htmlFor={`${id}-text`} className="rules-call">
            {label}
          </label>
          <Textarea variant="field"
            id={`${id}-text`}
            className="rules-text"
            value={text}
            placeholder={placeholder}
            autoComplete="off"
            autoCapitalize="sentences"
            spellCheck
            aria-invalid={invalid !== null || undefined}
            aria-describedby={`${id}-count`}
            onChange={(event) => setText(event.target.value)}
          />
          <p className="hint" id={`${id}-count`} data-over={invalid !== null || undefined}>
            {bytesText(bytes, max)}
            {view.updatedAt === null ? ' · none saved yet' : ` · saved ${new Date(view.updatedAt).toLocaleString()}`}
          </p>
          {invalid !== null && (
            <p className="error" role="alert">
              {invalid}
            </p>
          )}
          <div className="rules-keys">
            <button type="button" className="btn" data-kind="primary" aria-label={`Save ${title.toLowerCase()}`} aria-disabled={!changed || invalid !== null || busy || undefined} onClick={() => changed && invalid === null && !busy && apply(text)}>
              Save
            </button>
            <button type="button" className="btn" data-kind="quiet" aria-label={`Discard changes to ${title.toLowerCase()}`} aria-disabled={!changed || busy || undefined} onClick={() => changed && !busy && setText(view.text)}>
              Discard changes
            </button>
            <button type="button" className="btn" data-kind="danger" aria-label={`Clear ${title.toLowerCase()}`} aria-disabled={view.text === '' || busy || undefined} onClick={() => view.text !== '' && !busy && apply('')}>
              Clear
            </button>
          </div>
          {error !== null && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </>
      )}
    </section>
  );
}

export function RoomRulesBlock(): ReactElement {
  return (
    <TextBlock
      title="ROOM RULES"
      label="Rules"
      trims
      placeholder="Always branch from main. Report in two lines. Never touch the migrations folder."
      load={api.rulesView}
      save={api.setRules}
      hint={
        <>
          Your rules for every agent of this room: how you branch, how you report, what never to touch. They are added at the end of the role text, under &ldquo;Room rules, written by the Director&rdquo; (the system prompt on Claude Code and pi, the first prompt on the other engines), when an agent starts, so a console reads them as your own words: only you can change them here, and the
          password is asked again. They reach the engines gonogo can give a role to (Claude Code, Gemini CLI, Codex, opencode, Antigravity, pi); the others, and a custom command, get nothing. A repo&apos;s own <code>AGENTS.md</code> is never copied into them: an agent is only told to read it, and the project&apos;s rules win over these.
        </>
      }
    />
  );
}

export function RitualTemplateBlock(): ReactElement {
  return (
    <TextBlock
      title="CLOSING CHECKLIST TEMPLATE"
      label="Template"
      trims={false}
      placeholder={'Tests pass on main\nNotes written in the Mission Log\n# a line that starts with # is a comment'}
      load={api.ritualTemplate}
      save={api.setRitualTemplate}
      hint={
        <>
          One line each: what you want checked before a mission is called done. A new mission copies it (a mission already made keeps its own list, which you edit on the mission page), and only you tick the lines. A line starting with <code>#</code> and a blank line are left out; at most 20 lines
          of 200 characters count. It is never a gate: a mission closes with items open. The password is asked again to change it.
        </>
      }
    />
  );
}
