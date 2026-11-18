/**
 * Tool permissions (docs/features/permissions.md): a select for each common tool and a text for every other rule. Used by the hire and
 * edit forms (the agent's own rules) and by Flight Rules (the room's). The value is the text of src/client/permissions.ts.
 */
import type { ReactElement } from 'react';
import { PERMISSION_LISTS } from '../shared/protocol.js';
import type { PermissionList } from '../shared/protocol.js';
import { COMMON_TOOLS, setToolState, toolState } from './permissions.js';

const LABEL: Record<'' | PermissionList, string> = { '': 'Default', allow: 'Allow', ask: 'Ask', deny: 'Deny' };

export function PermissionsEditor({ id, value, onChange, error, inheritedDeny = [] }: { id: string; value: string; onChange(next: string): void; error?: string; /** The room's deny rules: they apply to this console whatever it says. */ inheritedDeny?: readonly string[] }): ReactElement {
  return (
    <div className="perm-editor" data-invalid={error !== undefined ? '' : undefined}>
      <ul className="perm-tools">
        {COMMON_TOOLS.map((tool) => (
          <li key={tool}>
            <label htmlFor={`${id}-${tool}`}>{tool}</label>
            <select id={`${id}-${tool}`} value={toolState(value, tool)} onChange={(event) => onChange(setToolState(value, tool, event.target.value as '' | PermissionList))}>
              {(['', ...PERMISSION_LISTS] as const).map((list) => (
                <option key={list} value={list}>
                  {LABEL[list]}
                </option>
              ))}
            </select>
          </li>
        ))}
      </ul>
      {inheritedDeny.length > 0 && (
        <p className="hint" id={`${id}-inherited`}>
          Denied by the room, always: {inheritedDeny.map((rule) => <code key={rule}>{rule} </code>)}
        </p>
      )}
      <label htmlFor={`${id}-text`} className="label">
        RULES
      </label>
      <textarea
        id={`${id}-text`}
        className="perm-text"
        rows={4}
        spellCheck={false}
        value={value}
        aria-invalid={error !== undefined}
        aria-describedby={`${id}-hint${error !== undefined ? ` ${id}-error` : ''}`}
        placeholder={'allow Bash(git:*)\ndeny WebFetch(domain:example.com)'}
        onChange={(event) => onChange(event.target.value)}
      />
      {error !== undefined && (
        <p className="error" id={`${id}-error`}>
          {error}
        </p>
      )}
      <p className="hint" id={`${id}-hint`}>
        One rule on each line: allow, ask or deny, then a tool, such as <code>allow Bash(git:*)</code> or <code>deny Read(./.env)</code>. Deny beats ask, and ask beats allow. The mode of the console still decides what is not listed.
      </p>
    </div>
  );
}
