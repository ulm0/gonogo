/**
 * Flight Rules, THIS DEVICE (docs/features/mobile.md): push to the installed app. One key turns it on for the device in your hand (the
 * click is what lets the browser ask for permission, which iOS also needs), one check chooses to see the sender and the first words
 * on the lock screen (off: a generic line), and the devices that already get a push are listed, each with a key to take it off.
 */
import { useId, useState } from 'react';
import type { ReactElement } from 'react';
import { pushTest } from './api.js';
import { PUSH_TEXT } from './push.js';
import { disablePush, enablePush, removeDevice, usePushStatus } from './push-browser.js';

export function PushBlock(): ReactElement {
  const id = useId();
  const { status, view, mine } = usePushStatus();
  const [snippet, setSnippet] = useState(false);
  const [note, setNote] = useState('');
  const on = status === 'on';
  const blocked = status !== 'on' && status !== 'off';
  const say = (text: string | null): void => setNote(text ?? '');
  return (
    <div className="rules-notify rules-push">
      <h3 className="label">PUSH TO THIS DEVICE</h3>
      <p className="hint" role="status">
        {PUSH_TEXT[status]}
      </p>
      <div className="check-row">
        <input id={`${id}-snippet`} type="checkbox" className="check" checked={snippet} disabled={on || blocked} onChange={(e) => setSnippet(e.target.checked)} />
        <label htmlFor={`${id}-snippet`}>Show who it is from and the first words on the lock screen</label>
      </div>
      <button
        type="button"
        className="btn"
        aria-pressed={on}
        aria-disabled={blocked || undefined}
        onClick={() => {
          if (blocked) return;
          say(null);
          if (on) void disablePush();
          else void enablePush(snippet).then(say);
        }}
      >
        {on ? 'Turn push off for this device' : 'Turn push on for this device'}
      </button>
      {note !== '' && (
        <p className="error" role="alert">
          {note}
        </p>
      )}
      {view.devices.length > 0 && (
        <ul className="rules-devices" aria-label="Devices that get a push">
          {view.devices.map((d) => (
            <li key={d.id}>
              <span className="rules-name">
                {d.name}
                {d.id === mine ? ' (this device)' : ''}
                {d.snippet ? ', shows the text' : ''}
              </span>
              <button type="button" className="btn" data-kind="quiet" aria-label={`Send a test to ${d.name}`} onClick={() => void pushTest(d.id).then((r) => say(r.ok ? `Test sent to ${d.name}.` : `Test not delivered: ${r.note}.`), (e: unknown) => say(e instanceof Error ? e.message : 'The test failed.'))}>
                Test
              </button>
              <button type="button" className="btn" data-kind="danger" aria-label={`Remove ${d.name}`} onClick={() => void removeDevice(d.id)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
