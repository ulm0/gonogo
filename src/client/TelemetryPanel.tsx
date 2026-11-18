/**
 * Telemetry: the agent's tool calls, newest first, with start time, duration, tool and one line (docs/telemetry-spec.md).
 * Asked of the server when the section opens and every TELEMETRY_REFRESH_MS while it stays open.
 */
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { ToolCall } from '../shared/protocol.js';
import * as api from './api.js';
import { TELEMETRY_REFRESH_MS, telemetryRows } from './telemetry.js';

function Calls({ name }: { name: string }): ReactElement {
  const [calls, setCalls] = useState<ToolCall[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = (): void => {
      api.telemetry(name).then(
        (list) => {
          if (!live) return;
          setCalls(list);
          setError(null);
        },
        (e: unknown) => {
          if (live) setError(e instanceof Error ? e.message : String(e));
        },
      );
    };
    load();
    const timer = setInterval(load, TELEMETRY_REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [name]);
  if (error !== null) {
    return (
      <p className="error" role="alert">
        {error}
      </p>
    );
  }
  if (calls === null) return <p className="hint">Loading…</p>;
  if (calls.length === 0) return <p className="hint">No tool calls yet. They come from the agent's hooks (Claude Code, Gemini CLI).</p>;
  return (
    <ol className="telemetry lcd" aria-label={`Tool calls of ${name}, newest first`}>
      {telemetryRows(calls).map((row) => (
        <li key={row.key} className="telemetry-row">
          <span className="telemetry-time">{row.time}</span>
          <span className="telemetry-tool">{row.tool}</span>
          <span className="telemetry-ms" data-failed={row.failed || undefined}>
            {row.failed ? `${row.duration} · failed` : row.duration}
          </span>
          <span className="telemetry-bar" aria-hidden="true">
            <span style={{ width: `${row.bar}%` }} />
          </span>
          {row.detail !== '' && <span className="telemetry-detail">{row.detail}</span>}
        </li>
      ))}
    </ol>
  );
}

/** The TELEMETRY section of a console panel; it asks the server only while it is open. */
export function AgentTelemetry({ name }: { name: string }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <details className="panel-fuel" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="label">TELEMETRY</summary>
      {open && <Calls name={name} />}
    </details>
  );
}
