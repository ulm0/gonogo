/**
 * Flight Rules: ROOM KEYS (docs/features/room-keys.md), environment variables every agent of the room gets, such as the settings of Amazon Bedrock. A key
 * an agent has of its own (its Clearance) wins. A value is saved and never shown again: the list says SET and when. A Clean Room agent gets only the keys
 * marked for it, so the default keeps keys out of the container.
 */
import { useEffect, useId, useState } from 'react';
import type { ReactElement } from 'react';
import { KEY_NAME_PATTERN, keyWarning } from '../shared/protocol.js';
import type { RoomKeysView } from '../shared/protocol.js';
import * as api from './api.js';
import { useRun } from './WallView.js';
import { Switch } from '@/ui/checkbox.js';
import { Input } from '@/ui/input.js';

const NAME_RE = new RegExp(KEY_NAME_PATTERN);

/** One saved key: its name, SET and when, whether a Clean Room agent gets it (a switch), and REMOVE. */
function Row({ entry, onSaved }: { entry: RoomKeysView['keys'][number]; onSaved(next: RoomKeysView): void }): ReactElement {
  const id = useId();
  const { busy, error, run } = useRun();
  return (
    <li className="rules-model">
      <span className="rules-call">{entry.name}</span>
      <span className="chip" data-tone="quiet">
        SET {new Date(entry.at).toLocaleDateString()}
      </span>
      <label htmlFor={id}>
        <Switch id={id} role="switch" checked={entry.cleanRoom} disabled={busy} onChange={(event) => run(async () => onSaved(await api.setRoomKey(entry.name, { cleanRoom: event.target.checked })))} /> Also in a Clean Room
      </label>
      <button type="button" className="btn" data-kind="danger" aria-label={`Remove ${entry.name}`} aria-disabled={busy || undefined} onClick={() => !busy && run(async () => onSaved(await api.removeRoomKey(entry.name)))}>
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

export function RoomKeysBlock(): ReactElement {
  const id = useId();
  const [view, setView] = useState<RoomKeysView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [clean, setClean] = useState(false);
  const add = useRun();
  useEffect(() => {
    let live = true;
    api.roomKeys().then(
      (found) => live && setView(found),
      (e: unknown) => live && setProblem(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, []);
  const bad = name !== '' && !NAME_RE.test(name);
  const ready = name !== '' && !bad && value !== '';
  return (
    <section className="module rules-block" aria-labelledby={`${id}-title`}>
      <h2 className="label" id={`${id}-title`}>
        ROOM KEYS
      </h2>
      <p className="hint">
        Environment variables every agent of this room gets, such as the settings of Amazon Bedrock (<code>CLAUDE_CODE_USE_BEDROCK</code>, <code>AWS_REGION</code>, <code>AWS_BEARER_TOKEN_BEDROCK</code>). A key an agent has of its own (its Clearance fold) wins over the room&apos;s of the same name. A
        Clean Room agent gets only the keys switched on here for it: the container exists to keep keys out. Values are saved in plain text on this machine (mode 0600) and never shown again: set the same name again to change one. A change applies at each agent&apos;s next start: a running agent keeps what it started with. A value cannot contain a space.
      </p>
      {problem !== null && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      {view !== null && (
        <>
          {view.keys.length === 0 ? (
            <p className="hint">None.</p>
          ) : (
            <ul className="rules-model-list">
              {view.keys.map((entry) => (
                <Row key={entry.name} entry={entry} onSaved={setView} />
              ))}
            </ul>
          )}
          <div className="rules-model">
            <label htmlFor={`${id}-name`} className="rules-call">
              Key name
            </label>
            <Input id={`${id}-name`} type="text" value={name} placeholder="AWS_REGION" autoComplete="off" autoCapitalize="characters" spellCheck={false} aria-invalid={bad || undefined} onChange={(event) => setName(event.target.value.trim())} />
            <label htmlFor={`${id}-value`} className="rules-call">
              Value
            </label>
            <Input id={`${id}-value`} type="password" value={value} autoComplete="off" autoCapitalize="none" spellCheck={false} onChange={(event) => setValue(event.target.value)} />
            <label>
              <Switch role="switch" checked={clean} onChange={(event) => setClean(event.target.checked)} /> Also in a Clean Room
            </label>
            <button
              type="button"
              className="btn"
              aria-disabled={!ready || add.busy || undefined}
              onClick={() =>
                ready &&
                !add.busy &&
                add.run(async () => {
                  setView(await api.setRoomKey(name, { value, cleanRoom: clean }));
                  setName('');
                  setValue('');
                  setClean(false);
                })
              }
            >
              Set key
            </button>
            {keyWarning(name) !== null && (
              <p className="hint" role="status">
                {keyWarning(name)}
              </p>
            )}
            {bad && <p className="error">Use capital letters, digits and _, starting with a letter.</p>}
            {add.error !== null && (
              <p className="error" role="alert">
                {add.error}
              </p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
