import { useId, useState, useSyncExternalStore } from 'react';
import type { FormEvent, KeyboardEvent, ReactElement } from 'react';
import { MISSION_NAME_MAX_CHARS } from '../shared/protocol.js';
import { longTextKind, longTextNote } from '../shared/longtext.js';
import type { AgentView } from '../shared/protocol.js';
import * as api from './api.js';
import { draftFromBrief } from './missionsModel.js';
import { openNewMission } from './store.js';
import { briefSentText } from './wording.js';
import './loop.css';
import { Textarea } from '@/ui/textarea.js';

/** Enter sends, Shift+Enter makes a newline; Enter that confirms an input-method composition is not a send. Every box that sends on Enter asks this. */
export const enterSends = (event: Pick<KeyboardEvent<HTMLTextAreaElement>, 'key' | 'shiftKey' | 'nativeEvent'>): boolean => event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing;

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
  // a text over a message's size goes as a file (shared/longtext.ts); one over the most a file takes is refused here, before anything is sent
  const kind = longTextKind(body.length);
  const long = longTextNote(body.length, 'FLIGHT');
  const blocked = boss === null || stopped || busy || kind === 'too_long';

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
        const sentText = briefSentText(sent.note, boss.name, 'FLIGHT');
        setResult({ text: kind === 'file' ? `${sentText} The whole text was saved as a file; FLIGHT got its path and the first lines.` : sentText, tone: 'ok' });
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
    if (enterSends(event)) {
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
      <Textarea variant="field"
        id={`${id}-text`}
        className="brief-input"
        rows={1}
        value={text}
        placeholder={phone ? 'Brief FLIGHT' : 'What do you want done?'}
        disabled={boss === null || stopped}
        aria-describedby={`${id}-note ${id}-long`}
        aria-invalid={kind === 'too_long' || undefined}
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
      <p id={`${id}-long`} className={long?.tone === 'danger' ? 'error brief-note brief-long' : 'hint brief-note brief-long'}>
        {long?.text}
      </p>
      <p id={`${id}-note`} className={note?.tone === 'danger' ? 'error brief-note' : 'hint brief-note'} role="status">
        {note?.text}
      </p>
    </form>
  );
}
