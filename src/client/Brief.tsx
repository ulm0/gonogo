import { useId, useState, useSyncExternalStore } from 'react';
import type { FormEvent, KeyboardEvent, ReactElement } from 'react';
import { BODY_MAX_CHARS, MISSION_NAME_MAX_CHARS } from '../shared/protocol.js';
import type { AgentView } from '../shared/protocol.js';
import * as api from './api.js';
import { draftFromBrief } from './missions.js';
import { openNewMission } from './store.js';
import { briefSentText } from './wording.js';
import './loop.css';

/** The phone layout hides the label, so its placeholder has to say whom the box is for. */
const PHONE = '(max-width: 699px)';
const onPhone = (): boolean => typeof matchMedia === 'function' && matchMedia(PHONE).matches;
function subscribePhone(notify: () => void): () => void {
  if (typeof matchMedia !== 'function') return () => undefined;
  const query = matchMedia(PHONE);
  query.addEventListener('change', notify);
  return () => query.removeEventListener('change', notify);
}

/** The box that briefs FLIGHT. Its field has the class `brief-input`, so a screen can send the keyboard there. */
export function Brief({ boss }: { boss: AgentView | null }): ReactElement {
  const id = useId();
  const phone = useSyncExternalStore(subscribePhone, onPhone, () => false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; tone: 'ok' | 'danger' } | null>(null);

  const stopped = boss !== null && boss.state === 'stopped';
  const body = text.trim();
  const blocked = boss === null || stopped || busy;

  async function send(): Promise<void> {
    if (blocked || body === '') return;
    setBusy(true);
    setResult(null);
    try {
      const sent = await api.sendMessage({ to: 'boss', subject: 'Brief', body });
      if (!sent.ok || sent.status === 'undelivered') {
        setResult({ text: sent.note ?? 'The message could not be delivered.', tone: 'danger' });
      } else {
        setText('');
        setResult({ text: briefSentText(sent.note, boss.name, 'FLIGHT'), tone: 'ok' });
      }
    } catch (e) {
      setResult({ text: e instanceof Error ? e.message : String(e), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    void send();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter sends, Shift+Enter makes a newline; Enter that confirms an input-method composition is not a send.
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  const note = stopped ? { text: 'FLIGHT is stopped. Start it to brief.', tone: 'ok' as const } : result;
  return (
    <form className="brief" onSubmit={onSubmit}>
      <label className="brief-label" htmlFor={`${id}-text`}>
        Brief FLIGHT
      </label>
      <textarea
        id={`${id}-text`}
        className="textarea brief-input"
        rows={1}
        value={text}
        maxLength={BODY_MAX_CHARS}
        placeholder={phone ? 'Brief FLIGHT' : 'What do you want done?'}
        disabled={boss === null || stopped}
        aria-describedby={`${id}-note`}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <button type="submit" className="btn brief-send" data-kind="primary" aria-disabled={blocked || body === ''}>
        {busy ? 'Sending…' : 'Send'}
      </button>
      {body !== '' && (
        <button type="button" className="btn brief-mission" data-kind="quiet" onClick={() => openNewMission(draftFromBrief(text, MISSION_NAME_MAX_CHARS))}>
          Make this a mission
        </button>
      )}
      <p id={`${id}-note`} className={note?.tone === 'danger' ? 'error brief-note' : 'hint brief-note'} role="status">
        {note?.text}
      </p>
    </form>
  );
}
