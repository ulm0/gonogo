/**
 * "Add from the list" (docs/features/registry.md): a short list of MCP servers and skills checked by hand against their repository and package. A server fills
 * the box it is picked for (the person can still edit it); a skill shows the line to run in a terminal, with a key that copies it. The page installs and runs
 * nothing, fetches nothing, and a value of a key is never in an entry: only the names a server reads.
 */
import { useId, useState } from 'react';
import type { ReactElement } from 'react';
import { REGISTRY_STALE_DAYS, REGISTRY_WARNINGS } from '../shared/registry.js';
import { checkedText, entriesFor, folderText, safeSource, serversOf, skillsOf } from './registry.js';
import type { RegistryEntry, RegistryServer } from './registry.js';
import { copyText } from './uplink.js';

interface Props {
  /** What the engine takes: servers and skills, servers only. */
  payload: 'all' | 'servers';
  /** Whether the server of this id is already in the box (the person may have edited it: it is never overwritten). */
  has(id: string): boolean;
  /** Puts the server in the box. Only servers; a skill has no box to fill, only a line to run. */
  onAdd(entry: RegistryServer): void;
  /** Shown only where there is something to pick: a Payload fold shows servers and skills, the skills block only skills. */
  only?: 'mcp' | 'skill';
  /** The date the page was drawn (a test sets it). */
  now?: number;
  /** The entry the list opens on (the first one when none). */
  first?: string;
}

export function RegistryPicker({ payload, has, onAdd, only, now = Date.now(), first }: Props): ReactElement | null {
  const id = useId();
  const list = entriesFor(payload).filter((e) => only === undefined || e.kind === only);
  const [picked, setPicked] = useState<string>(first ?? list[0]?.id ?? '');
  const [copied, setCopied] = useState<boolean | null>(null);
  if (list.length === 0) return null;
  const entry: RegistryEntry = list.find((e) => e.id === picked) ?? (list[0] as RegistryEntry);
  const when = checkedText(entry.checked, now);
  const link = safeSource(entry);
  const servers = serversOf(list);
  const skills = skillsOf(list);
  const taken = entry.kind === 'mcp' && has(entry.id);
  return (
    <div className="registry" role="group" aria-label="Add from the list">
      <label htmlFor={id} className="rules-call">
        Add from the list
      </label>
      <select
        id={id}
        className="input"
        data-fit
        value={entry.id}
        onChange={(event) => {
          setPicked(event.target.value);
          setCopied(null);
        }}
      >
        {servers.length > 0 && (
          <optgroup label="MCP servers">
            {servers.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </optgroup>
        )}
        {skills.length > 0 && (
          <optgroup label="Skills">
            {skills.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      <p className="hint">
        {entry.summary} By {entry.publisher}. {entry.licence}
        {' · '}
        <span className="registry-checked" data-old={when.old || undefined}>
          {when.text}
        </span>
        {link !== null && (
          <>
            {' · '}
            <a href={link} target="_blank" rel="noreferrer noopener">
              Read it first
            </a>
          </>
        )}
      </p>
      {when.old && (
        <p className="hint registry-warn" role="note">
          Checked more than {REGISTRY_STALE_DAYS} days ago: it may be out of date. Read its repository again before you use it.
        </p>
      )}
      {entry.note !== null && <p className="hint">{entry.note}</p>}
      {entry.kind === 'mcp' ? (
        <>
          <p className="registry-runs">
            <strong>{entry.runs}</strong>
          </p>
          {entry.sendsTo !== null && <p className="hint">Sends to: {entry.sendsTo}</p>}
          <ul className="registry-warnings">
            <li>{REGISTRY_WARNINGS.runs}</li>
            {entry.transport === 'stdio' && <li>{REGISTRY_WARNINGS.pin}</li>}
            <li>{REGISTRY_WARNINGS.descriptions}</li>
            {entry.needs.length > 0 && (
              <li>
                {REGISTRY_WARNINGS.keys} Keys: {entry.needs.join(', ')}.
              </li>
            )}
          </ul>
          {entry.runtime !== null && <p className="hint">Needs {entry.runtime === 'node' ? 'Node (npx)' : 'uv (uvx)'} on the machine the agent runs on.</p>}
          {entry.edit !== null && <p className="hint">{entry.edit}</p>}
          <button type="button" className="btn" aria-disabled={taken || undefined} onClick={() => !taken && onAdd(entry)}>
            Add {entry.name} to the box
          </button>
          {taken && <p className="hint">{entry.id} is already in the box: edit it there.</p>}
          <p className="hint">The page itself installs and runs nothing: it only fills the box.</p>
        </>
      ) : (
        <>
          <p className="hint">gonogo does not fetch skills. Run this yourself, in a terminal, where you want the folder:</p>
          <code className="registry-line">{entry.install}</code>
          <button
            type="button"
            className="btn"
            data-kind="quiet"
            onClick={() => {
              void copyText(entry.install).then(setCopied);
            }}
          >
            {copied === null ? 'Copy the line' : copied ? 'Copied' : 'Not copied: select it'}
          </button>
          <p className="hint">{folderText(entry)}</p>
        </>
      )}
    </div>
  );
}
