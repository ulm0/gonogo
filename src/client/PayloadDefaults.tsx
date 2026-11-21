/**
 * Flight Rules: PAYLOAD DEFAULTS (docs/payload-spec.md), the MCP servers and skill folders every agent of the room gets. An agent's own Payload
 * (its Edit form) can add to them, replace one by name, or switch one off, so the agent wins. The page is told what each item is and never a value:
 * a server is set whole and never read back, so to change one, set it again under its name.
 */
import { useEffect, useId, useState } from 'react';
import type { ReactElement } from 'react';
import type { PayloadDefaultServer, PayloadDefaults } from '../shared/protocol.js';
import * as api from './api.js';
import { asDefault } from './registry.js';
import { RegistryPicker } from './RegistryPicker.js';
import { useRun } from './WallView.js';

const SERVER_EXAMPLE = '{"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]}';

/** One line of an item: what it is, and the call that removes it. */
export function Item({ name, chip, detail, remove, onSaved }: { name: string; chip: string; detail: string; remove(): Promise<PayloadDefaults>; onSaved(next: PayloadDefaults): void }): ReactElement {
  const { busy, error, run } = useRun();
  return (
    <li className="rules-model">
      <span className="rules-call">{name}</span>
      <span className="chip" data-tone="quiet">
        {chip}
      </span>
      <span className="hint">{detail}</span>
      <button type="button" className="btn" data-kind="danger" aria-label={`Remove ${name}`} aria-disabled={busy || undefined} onClick={() => !busy && run(async () => onSaved(await remove()))}>
        Remove
      </button>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

/** What a server is, in words: where it points, how many arguments, and the names (never the values) of what it carries. */
export function serverDetail(s: PayloadDefaultServer): string {
  const carries = s.names.length === 0 ? '' : `, ${s.type === 'stdio' ? 'env' : 'headers'} ${s.names.join(', ')} (values not shown)`;
  return `${s.target}${s.type === 'stdio' ? `, ${s.args} argument${s.args === 1 ? '' : 's'}` : ''}${carries}`;
}

export function PayloadDefaultsBlock(): ReactElement {
  const id = useId();
  const [defaults, setDefaults] = useState<PayloadDefaults | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [config, setConfig] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const addServer = useRun();
  useEffect(() => {
    let live = true;
    api.payloadDefaults().then(
      (found) => live && setDefaults(found),
      (e: unknown) => live && setProblem(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, []);
  const saveServer = (): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(config);
    } catch {
      setParseError('Not JSON: write one server as an object.');
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setParseError('Not JSON: write one server as an object.');
      return;
    }
    setParseError(null);
    addServer.run(async () => {
      setDefaults(await api.setDefaultServer(name.trim(), parsed));
      setName('');
      setConfig('');
    });
  };
  return (
    <section className="module rules-block" aria-labelledby={`${id}-title`}>
      <h2 className="label" id={`${id}-title`}>
        PAYLOAD DEFAULTS
      </h2>
      <p className="hint">
        MCP servers and skill folders every agent of this room gets. An agent&apos;s own Payload (its Edit form) wins: a server or skill of the same name replaces the room&apos;s, and the agent can switch any of them off. An agent in a Clean Room gets none of these (a server&apos;s env and headers hold keys), and an engine
        that takes no payload gets none. It applies at each agent&apos;s next start. Values are saved in plain text on this machine (mode 0600) and never shown again: to change a server, set it again under its name.
      </p>
      {problem !== null && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      {defaults !== null && (
        <>
          <h3 className="label">MCP SERVERS</h3>
          {defaults.mcpServers.length === 0 ? (
            <p className="hint">None. Every agent has the gonogo tools and its own.</p>
          ) : (
            <ul className="rules-model-list">
              {defaults.mcpServers.map((s) => (
                <Item key={s.name} name={s.name} chip={s.type} detail={serverDetail(s)} remove={() => api.removeDefaultServer(s.name)} onSaved={setDefaults} />
              ))}
            </ul>
          )}
          <RegistryPicker
            payload="servers"
            only="mcp"
            has={(serverId) => defaults.mcpServers.some((x) => x.name === serverId)}
            onAdd={(entry) => {
              const filled = asDefault(entry);
              setName(filled.name);
              setConfig(filled.config);
              setParseError(null);
            }}
          />
          <div className="rules-model">
            <label htmlFor={`${id}-name`} className="rules-call">
              Server name
            </label>
            <input id={`${id}-name`} className="input" type="text" value={name} placeholder="files" autoComplete="off" autoCapitalize="none" spellCheck={false} onChange={(event) => setName(event.target.value)} />
            <label htmlFor={`${id}-config`} className="rules-call">
              Server (JSON)
            </label>
            <textarea
              id={`${id}-config`}
              className="textarea staff-servers"
              value={config}
              placeholder={SERVER_EXAMPLE}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              aria-invalid={parseError !== null || undefined}
              aria-describedby={parseError !== null ? `${id}-config-error` : undefined}
              onChange={(event) => setConfig(event.target.value)}
            />
            <button type="button" className="btn" aria-disabled={name.trim() === '' || config.trim() === '' || addServer.busy || undefined} onClick={() => name.trim() !== '' && config.trim() !== '' && !addServer.busy && saveServer()}>
              Set server
            </button>
            {parseError !== null && (
              <p className="error" id={`${id}-config-error`}>
                {parseError}
              </p>
            )}
            {addServer.error !== null && (
              <p className="error" role="alert">
                {addServer.error}
              </p>
            )}
          </div>
          <p className="hint">Skills (folders for Claude Code) are in the SKILLS block below.</p>
        </>
      )}
    </section>
  );
}
