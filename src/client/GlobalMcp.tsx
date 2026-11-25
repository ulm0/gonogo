import { useEffect, useId, useState } from 'react';
import type { ReactElement } from 'react';
import type { GlobalMcpView } from '../shared/protocol.js';
import * as api from './api.js';
import { Switch } from '@/ui/checkbox.js';

/** Flight Rules: the MCP servers of `claude mcp add --scope user`, and whether the agents of this room get them (docs/features/global-mcp.md). Names, types and addresses only. */
export function GlobalMcpBlock(): ReactElement {
  const id = useId();
  const [view, setView] = useState<GlobalMcpView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.globalMcp().then((found) => live && setView(found), (e: unknown) => live && setProblem(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, []);
  const change = (patch: { host?: boolean; cleanRoom?: boolean }): void => {
    setProblem(null);
    api.setGlobalMcp(patch).then(setView, (e: unknown) => setProblem(e instanceof Error ? e.message : String(e)));
  };
  return (
    <section className="module rules-block" aria-labelledby={`${id}-title`}>
      <h2 className="label" id={`${id}-title`}>
        GLOBAL MCP SERVERS
      </h2>
      <p className="hint">
        The servers you added with <code>claude mcp add --scope user</code> are read at each start of an agent and put under the room&apos;s defaults and the agent&apos;s own: the same name, the later one wins. An agent can switch one off in its Payload fold.
      </p>
      {view !== null && (
        <>
          <label className="staff-check">
            <Switch role="switch" checked={view.host} onChange={(event) => change({ host: event.target.checked })} />
            Include them for the agents of this room
          </label>
          <label className="staff-check">
            <Switch role="switch" checked={view.cleanRoom} onChange={(event) => change({ cleanRoom: event.target.checked })} />
            Include them for Clean Room agents too
          </label>
          <p className="hint">
            Off for a Clean Room by default: a global server can carry a header or a token into the container, and the egress switch is there to keep secrets out. Turning either on asks for your password.
          </p>
          <p className="label">{view.source.toUpperCase()}</p>
          {view.servers.length === 0 ? (
            <p className="hint">None found. A server in a file that cannot be read, or with a field a Payload server does not have, is skipped (the log says which).</p>
          ) : (
            <ul className="staff-room-list">
              {view.servers.map((s) => (
                <li key={s.name}>
                  <span>{s.name}</span>{' '}
                  <span className="chip" data-tone="quiet">
                    {s.type} · {s.target === '' ? 'no address' : s.target}
                  </span>
                  {s.overriddenBy === 'room' && <span className="hint"> replaced by a room default of the same name</span>}
                </li>
              ))}
            </ul>
          )}
          <p className="hint">Only the name, type and address are shown here, never an argument, a header or a value.</p>
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
