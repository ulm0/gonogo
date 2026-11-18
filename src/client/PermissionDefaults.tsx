/** Flight Rules: the tool rules of every Claude Code console that has none of its own (docs/features/permissions.md). */
import { useEffect, useId, useState } from 'react';
import type { ReactElement } from 'react';
import * as api from './api.js';
import { PermissionsEditor } from './PermissionsEditor.js';
import { parseRulesText, rulesOf, rulesToText } from './permissions.js';

export function PermissionDefaultsBlock(): ReactElement {
  const id = useId();
  const [saved, setSaved] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api.permissionDefaults().then(
      (found) => {
        if (!live) return;
        const next = rulesToText(found.permissions);
        setSaved(next);
        setText(next);
      },
      (e: unknown) => live && setProblem(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, []);
  const invalid = parseRulesText(text).problem;
  return (
    <section className="module rules-block" aria-labelledby={`${id}-title`}>
      <h2 className="label" id={`${id}-title`}>
        TOOL PERMISSIONS
      </h2>
      <p className="hint">The tools a Claude Code console may use without asking, must ask about, or may never use. A console with rules of its own (its Edit form) uses those instead. It applies at each console&apos;s next start.</p>
      {saved !== null && (
        <>
          <PermissionsEditor id={id} value={text} onChange={setText} error={invalid ?? undefined} />
          <button
            type="button"
            className="btn"
            aria-disabled={busy || invalid !== null || text === saved || undefined}
            onClick={() => {
              if (busy || invalid !== null || text === saved) return;
              setBusy(true);
              setProblem(null);
              api
                .setPermissionDefaults(rulesOf(text) ?? {})
                .then(
                  (found) => {
                    const next = rulesToText(found.permissions);
                    setSaved(next);
                    setText(next);
                  },
                  (e: unknown) => setProblem(e instanceof Error ? e.message : String(e)),
                )
                .finally(() => setBusy(false));
            }}
          >
            Save
          </button>
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
