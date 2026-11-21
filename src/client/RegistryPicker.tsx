/**
 * "Add from the list" (docs/features/registry.md): a short list of MCP servers and skills checked by hand against their repository and package. A server fills
 * the box it is picked for (the person can still edit it); a skill shows the line to run in a terminal, with a key that copies it. The page installs and runs
 * nothing, fetches nothing, and a value of a key is never in an entry: only the names a server reads.
 */
import { useId, useState } from 'react';
import type { ReactElement } from 'react';
import { checkedText, entriesFor, folderText, needsText, safeSource, serversOf, skillsOf } from './registry.js';
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
}

export function RegistryPicker({ payload, has, onAdd, only, now = Date.now() }: Props): ReactElement | null {
  const id = useId();
  const list = entriesFor(payload).filter((e) => only === undefined || e.kind === only);
  const [picked, setPicked] = useState<string>(list[0]?.id ?? '');
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
        {entry.summary} {entry.licence}
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
      {entry.note !== null && <p className="hint">{entry.note}</p>}
      {entry.kind === 'mcp' ? (
        <>
          {entry.runtime !== null && <p className="hint">Needs {entry.runtime === 'node' ? 'Node (npx)' : 'uv (uvx)'} on the machine the agent runs on.</p>}
          {entry.edit !== null && <p className="hint">{entry.edit}</p>}
          {entry.needs.length > 0 && <p className="hint">{needsText(entry)}</p>}
          <button type="button" className="btn" aria-disabled={taken || undefined} onClick={() => !taken && onAdd(entry)}>
            Add {entry.name} to the box
          </button>
          {taken && <p className="hint">{entry.id} is already in the box: edit it there.</p>}
          <p className="hint">It runs a command with the agent&apos;s own rights, like one you typed yourself. Nothing is installed by this page.</p>
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
