/**
 * Flight Rules, the settings screen: the settings the Director can already change, in one place. Max Q and the room's Propellant
 * are the wall's own modules; a setting that lives in its own feature (the livery, a console, the schedules and webhooks) is a
 * key that opens it. Commissioning, the checklist of an empty room, is here too: it uses the same keys.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import * as api from './api.js';
import { DOCS_URL } from '../shared/protocol.js';
import { DetailChips } from './DetailChips.js';
import { currentEntry } from './look.js';
import { ModelDefaultsBlock } from './ModelDefaults.js';
import { FeaturesBlock } from './Features.js';
import { PayloadDefaultsBlock } from './PayloadDefaults.js';
import { SkillsBlock } from './SkillsBlock.js';
import { KnowledgeBlock } from './Knowledge.js';
import { RitualTemplateBlock, RoomRulesBlock } from './RoomRules.js';
import { RoomKeysBlock } from './RoomKeys.js';
import { PermissionDefaultsBlock } from './PermissionDefaults.js';
import { AccountBlock } from './AccountBlock.js';
import { AllStopBlock, CoauthorBlock, StartupBlock, SubagentsBlock } from './StartupRules.js';
import { AutoUpdateBlock } from './AutoUpdateRules.js';
import { VersionCheckBlock } from './CheckNow.js';
import { PushBlock } from './PushBlock.js';
import { disableNotifications, enableNotifications, useNotifyStatus } from './notify-browser.js';
import { STATUS_TEXT } from './notify.js';
import { TabNameBlock } from './TabName.js';
import { PHONE_MODES } from '../shared/protocol.js';
import type { PhoneMode, RelayView } from '../shared/protocol.js';
import { useAgentList, useSeats } from './RoomView.js';
import { commissioningSteps, loadMarks, saveMarks, showCommissioning } from './shell.js';
import type { Mark, Step } from './shell.js';
import { openConsole, openEdit, showLivery, showRoom, showRules, showWindow, useFeature, useStore } from './store.js';
import { legendOf } from './wall.js';
import { MaxQ, Propellant } from './WallView.js';
import './loop.css';
import './rules.css';

/** The checklist's marks, shared by every place that shows or resets it in this tab. */
let marks = loadMarks();
const markListeners = new Set<() => void>();
function setMarks(next: Set<Mark>): void {
  marks = next;
  saveMarks(marks);
  for (const l of [...markListeners]) l();
}
function useMarks(): ReadonlySet<Mark> {
  const [, render] = useState(0);
  useEffect(() => {
    const l = (): void => render((n) => n + 1);
    markListeners.add(l);
    return () => {
      markListeners.delete(l);
    };
  }, []);
  return marks;
}
const addMark = (mark: Mark): void => setMarks(new Set([...marks, mark]));

const PHONE_TEXT: Record<PhoneMode, string> = {
  off: 'Off',
  telegram: 'Telegram buttons',
  'remote-control': 'Claude app (Remote Control)',
  both: 'Both',
};
const PHONE_HINT: Record<PhoneMode, string> = {
  off: 'Nothing is sent to a phone.',
  telegram: 'A pending permission or hire request goes to your Telegram chat with GO and NO-GO buttons. Needs a Telegram Relay target and a Telegram Uplink.',
  'remote-control': 'Lets you start a Claude Code agent with --remote-control, so you approve in the Claude app. Needs a claude.ai login; not for Clean Room or API-key rooms.',
  both: 'Both of the above; the first answer wins.',
};

/** Phone approvals: where a pending permission or hire request is sent. The Telegram target stays in Relay. */
function PhoneApprovals(): ReactElement {
  const id = useId();
  const [view, setView] = useState<RelayView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.getRelay().then((found) => live && setView(found), (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, []);
  const mode = view?.phone ?? 'off';
  return (
    <section className="module rules-block" aria-labelledby={`${id}-phone`}>
      <h2 className="label" id={`${id}-phone`}>
        PHONE APPROVALS
      </h2>
      <select
        className="input"
        data-fit
        aria-label="Phone approvals"
        value={mode}
        disabled={view === null}
        onChange={(event) => {
          setError(null);
          api.setPhoneMode(event.target.value as PhoneMode).then(setView, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
        }}
      >
        {PHONE_MODES.map((m) => (
          <option key={m} value={m}>
            {PHONE_TEXT[m]}
          </option>
        ))}
      </select>
      <p className="hint">{PHONE_HINT[mode]}</p>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** Live reload: hands over to the installed gonogo. With --pty-host the agents keep running; without it they stop and resume. */
function ReloadBlock(): ReactElement {
  const id = useId();
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <section className="module rules-block" aria-labelledby={`${id}-reload`}>
      <h2 className="label" id={`${id}-reload`}>
        RELOAD
      </h2>
      <p className="hint">After you updated gonogo, start the new version. Started with --pty-host, the agents keep running and the page reconnects in a moment.</p>
      <button
        type="button"
        className="btn"
        aria-disabled={busy || undefined}
        onClick={() => {
          if (busy) return;
          setBusy(true);
          setError(null);
          api.reloadServer().then(setNote, (e: unknown) => {
            setBusy(false);
            setError(e instanceof Error ? e.message : String(e));
          });
        }}
      >
        Reload gonogo
      </button>
      {note !== null && <p className="hint" role="status">{note}</p>}
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export function FlightRules(): ReactElement {
  const maxqOn = useFeature('maxq');
  const titleId = useId();
  const list = useAgentList();
  const { legends } = useSeats();
  const livery = useStore((s) => s.livery);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const current = useMarks();
  // The page replaces the room: the keyboard starts at its title.
  useEffect(() => heading.current?.focus(), []);
  return (
    <section className="rules" aria-labelledby={titleId}>
      <header className="loop-head">
        <h1 id={titleId} ref={heading} tabIndex={-1} className="disp loop-title rules-title">
          FLIGHT RULES
        </h1>
        <button type="button" className="btn loop-room" data-kind="quiet" onClick={showRoom}>
          Room
        </button>
      </header>
      <p className="hint">Every setting of the room. All of them are kept on the server, so every device shows the same; each one also has its place in the room.</p>
      <div className="rules-grid">
        {maxqOn && <MaxQ />}
        <Propellant />
        <section className="module rules-block" aria-labelledby={`${titleId}-look`}>
          <h2 className="label" id={`${titleId}-look`}>
            LIVERY
          </h2>
          <p className="rules-value">{currentEntry(livery).name}</p>
          <p className="hint">The look of every device.</p>
          <button type="button" className="btn" onClick={showLivery}>
            Choose a livery
          </button>
        </section>
        <PhoneApprovals />
        <ReloadBlock />
        <section className="module rules-block" aria-labelledby={`${titleId}-window`}>
          <h2 className="label" id={`${titleId}-window`}>
            LAUNCH WINDOW
          </h2>
          <p className="hint">Schedules, Uplink webhooks, Relay chat bridges and Docking with other stations.</p>
          <button type="button" className="btn" onClick={showWindow}>
            Open Launch Window
          </button>
        </section>
      </div>
      <TabNameBlock />
      <ModelDefaultsBlock />
      <RoomRulesBlock />
      <RitualTemplateBlock />
      <KnowledgeBlock />
      <PermissionDefaultsBlock />
      <PayloadDefaultsBlock />
      <SkillsBlock />
      <RoomKeysBlock />
      <StartupBlock />
      <VersionCheckBlock />
      <AutoUpdateBlock />
      <SubagentsBlock />
      <CoauthorBlock />
      <AccountBlock />
      <AllStopBlock />
      <FeaturesBlock />
      <section className="module rules-block" aria-labelledby={`${titleId}-consoles`}>
        <h2 className="label" id={`${titleId}-consoles`}>
          CONSOLES
        </h2>
        <p className="hint">Each console's directory, role, engine, permission mode and payload are in its Edit form; its own Propellant limit is in its panel.</p>
        <ul className="rules-consoles">
          {list.map((a) => (
            <li key={a.name}>
              <span className="rules-call">{legendOf(legends, a.name)}</span>
              <span className="hint rules-name">{a.name}</span>
              <DetailChips agent={a} />
              <button type="button" className="btn" data-kind="quiet" aria-label={`Edit ${legendOf(legends, a.name)}`} onClick={() => openEdit(a.name)}>
                Edit
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section className="module rules-block" aria-labelledby={`${titleId}-browser`}>
        <h2 className="label" id={`${titleId}-browser`}>
          THIS BROWSER
        </h2>
        <Notifications />
        <PushBlock />
        <p className="hint">The Commissioning checklist shows on an empty room until you put it away. Only this browser remembers that.</p>
        <button type="button" className="btn" aria-disabled={current.size === 0 || undefined} onClick={() => current.size > 0 && setMarks(new Set())}>
          Show Commissioning again
        </button>
      </section>
    </section>
  );
}

/** Browser notifications: a switch for this browser. The key is the user action that lets the browser ask for permission. */
function Notifications(): ReactElement {
  const status = useNotifyStatus();
  const on = status === 'on' || status === 'needs-permission';
  const blocked = status === 'unsupported' || status === 'insecure' || status === 'denied';
  return (
    <div className="rules-notify">
      <h3 className="label">NOTIFICATIONS</h3>
      <p className="hint" role="status">
        {STATUS_TEXT[status]}
      </p>
      <button
        type="button"
        className="btn"
        aria-pressed={on}
        aria-disabled={blocked || undefined}
        onClick={() => {
          if (blocked) return;
          if (on && status === 'on') disableNotifications();
          else void enableNotifications();
        }}
      >
        {status === 'on' ? 'Turn notifications off' : 'Turn notifications on'}
      </button>
    </div>
  );
}

const STEP_TEXT: Record<Step['id'], { title: string; detail: string }> = {
  flight: { title: 'Staff FLIGHT', detail: 'FLIGHT is created at the first start. It is staffed once it is up: answer a startup question in its terminal if it asks one.' },
  propellant: { title: 'Set a Propellant limit', detail: 'A token budget for the room. Over it, Redline stops the agents.' },
  livery: { title: 'Pick a livery', detail: 'The look every device shows.' },
  note: { title: 'Read the security note', detail: '' },
};

/** The first-run checklist, on an empty room. */
export function Commissioning(): ReactElement | null {
  const id = useId();
  const list = useAgentList();
  const propellant = useStore((s) => s.propellant);
  const livery = useStore((s) => s.livery);
  const current = useMarks();
  if (!showCommissioning(list, current)) return null;
  const boss = list.find((a) => a.boss);
  const steps = commissioningSteps(list, propellant, livery, current);
  const action: Record<Step['id'], ReactElement | null> = {
    flight: boss === undefined ? null : (
      <button type="button" className="btn" onClick={() => openConsole(boss.name)}>
        Open FLIGHT
      </button>
    ),
    propellant: (
      <button type="button" className="btn" onClick={showRules}>
        Flight Rules
      </button>
    ),
    livery: (
      <button
        type="button"
        className="btn"
        onClick={() => {
          addMark('livery');
          showLivery();
        }}
      >
        Livery
      </button>
    ),
    note: null,
  };
  return (
    <section className="module commission" aria-labelledby={`${id}-title`}>
      <div className="commission-head">
        <h2 className="label" id={`${id}-title`}>
          COMMISSIONING
        </h2>
        <span className="hint">{`${steps.filter((s) => s.done).length} of ${steps.length} done`}</span>
        <button
          type="button"
          className="btn"
          data-kind="quiet"
          onClick={() => {
            addMark('away');
            // the checklist and this key are gone: the keyboard goes to the first console of the room, not to the body of the page
            document.querySelector<HTMLElement>('.matrix button')?.focus();
          }}
        >
          Put away
        </button>
      </div>
      <ol className="commission-steps">
        {steps.map((step) => (
          <li key={step.id} data-done={step.done || undefined}>
            <span className="led" data-on={step.done} style={step.done ? { '--led': 'var(--go)' } as CSSProperties : undefined} aria-hidden="true" />
            <div className="commission-text">
              <h3 className="commission-title">
                {STEP_TEXT[step.id].title}
                <span className="sr-only">{step.done ? ', done' : ', to do'}</span>
              </h3>
              {step.id === 'note' ? (
                <details className="commission-note" onToggle={(e) => e.currentTarget.open && addMark('note')}>
                  <summary>Show the note</summary>
                  <p>The address with #token= is the password of this room, and the server runs shells as you. Keep gonogo on 127.0.0.1; to reach it from elsewhere use HTTPS or a private network.</p>
                  <p>An agent in bypassPermissions mode runs as your user and can read every file you can, the secrets gonogo keeps among them. Dock only with people you trust: their agents can write to yours.</p>
                </details>
              ) : (
                <p className="hint">{STEP_TEXT[step.id].detail}</p>
              )}
            </div>
            {action[step.id]}
          </li>
        ))}
      </ol>
      <p className="hint commission-extra">
        Docs: <a href={DOCS_URL} target="_blank" rel="noopener noreferrer">{DOCS_URL}</a>
      </p>
      <p className="hint commission-extra">Away from this tab a lot? Flight Rules can turn on notifications for messages to you, T-minus polls and Relief requests.</p>
    </section>
  );
}
