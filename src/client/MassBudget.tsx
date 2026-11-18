/**
 * Mass Budget: the size of an agent's memory.md in its console panel, a warning over the soft limit, and REFLECT, which asks the
 * agent to condense the file. gonogo only reads the size and sends the request; the agent rewrites its own file. The size is asked
 * when the console opens and after each change of the agent's state (an agent that has just worked may have written to it).
 */
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { AgentView, MemoryView } from '../shared/protocol.js';
import * as api from './api.js';
import { askedText, canAsk, hasBudget, overText, resultText, sizeLine } from './mass.js';
import { useNow } from './store.js';
import { useRun } from './WallView.js';
import './mass.css';

export function MassBudget({ agent }: { agent: AgentView }): ReactElement | null {
  const now = useNow();
  const { busy, error, run } = useRun();
  const [view, setView] = useState<MemoryView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const shown = hasBudget(agent);
  const asking = canAsk(agent);

  useEffect(() => {
    if (!shown) return;
    let current = true;
    api.agentMemory(agent.name).then(
      (found) => {
        if (!current) return;
        setView(found);
        setProblem(null);
      },
      (e: unknown) => current && setProblem(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      current = false;
    };
  }, [shown, agent.name, agent.generation, agent.stateSince]);

  if (!shown) return null;
  const over = view === null ? null : overText(view);
  const asked = view === null ? null : askedText(view, now);
  return (
    <section className="mass" aria-label="Memory file of this console">
      <div className="mass-row">
        <h3 className="label">MASS BUDGET</h3>
        <p className="mass-size">
          <code>memory.md</code> {view === null ? (problem === null ? 'reading…' : 'unknown') : sizeLine(view)}
        </p>
        <button
          type="button"
          className="btn"
          data-kind="quiet"
          aria-disabled={busy || !asking || view === null || !view.exists || undefined}
          onClick={() => {
            if (busy || !asking || view === null || !view.exists) return;
            setNotice('');
            run(async () => {
              const result = await api.reflect(agent.name);
              setView(result.memory);
              setNotice(resultText(agent.name, result));
            });
          }}
        >
          Reflect
        </button>
      </div>
      {over !== null && <p className="mass-over">{over}. Reflect asks {agent.name} to condense it.</p>}
      {asked !== null && <p className="hint">{asked}</p>}
      {!asking && <p className="hint">Start the console to ask it.</p>}
      <p className="hint mass-notice" role="status">
        {notice}
      </p>
      {(error ?? problem) !== null && (
        <p className="error" role="alert">
          {error ?? problem}
        </p>
      )}
    </section>
  );
}
