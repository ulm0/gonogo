import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { RECONNECT_DELAYS_MS, RECONNECT_SERVER_GONE_AFTER } from '../shared/protocol.js';
import { Loop } from './Activity.js';
import { startNotifications } from './notify-browser.js';
import * as api from './api.js';
import { BlackBox } from './BlackBox.js';
import { Downlink } from './Downlink.js';
import { FlightPlan } from './FlightPlan.js';
import { Missions } from './Missions.js';
import { RoomDesktop } from './RoomLayout.js';
import { Hangar } from './Hangar.js';
import { HireForm } from './HireForm.js';
import { LaunchWindow } from './LaunchWindow.js';
import { Livery } from './Livery.js';
import { MissionLog } from './MissionLog.js';
import { Recorder } from './Recorder.js';
import { PlotBoard } from './PlotBoard.js';
import { PatchPanel } from './PatchPanel.js';
import { Commissioning, FlightRules } from './Rules.js';
import { isPanelKey } from './shell.js';
import { PartyLine } from './PartyLine.js';
import { unreadText } from './inbox.js';
import { activeOf, activeText } from './plan.js';
import { PhoneConsoleScreen, Needs, Operations, useAgentList, usePhone, useSeats } from './RoomView.js';
import { createAnnouncer } from './room.js';
import { openConsole, openHire, readStored, showDownlink, showLivery, showLog, showLoop, showPlan, showRoom, showRules, showWindow, useStore, writeStored } from './store.js';
import { copyText } from './uplink.js';
import { Wall } from './WallView.js';
import { SERVER_GONE_TEXT } from './wording.js';
import logo from '../../docs/brand/lockup.svg';
import './shell.css';

/* ---- top bar ---- */

function LinkLamp(): ReactElement {
  const connection = useStore((s) => s.connection);
  const text = connection === 'open' ? 'LINK UP' : connection === 'connecting' ? 'CONNECTING' : 'LINK DOWN';
  return (
    <span className="lamp" role="status" data-link={connection === 'open' ? 'up' : connection === 'connecting' ? 'wait' : 'down'}>
      <span className="led" data-on={connection === 'open'} data-blink={connection === 'connecting'} aria-hidden="true" />
      {text}
    </span>
  );
}

/** The small count of the Flight Plan key: the tasks that are being worked on or are stuck. Saffron when one is blocked. */
function PlanCount(): ReactElement | null {
  const tasks = useStore((s) => s.tasks);
  const active = activeOf(tasks);
  if (active.doing + active.blocked === 0) return null;
  return (
    <span className="chip" data-tone={active.blocked > 0 ? 'amber' : 'quiet'} aria-label={activeText(active)}>
      {active.doing + active.blocked}
    </span>
  );
}

/** The small count of the Downlink key: what the Director has not read. The server keeps it, so the phone and the desk show the same. */
function UnreadCount(): ReactElement | null {
  const unread = useStore((s) => s.downlink.unread);
  if (unread === 0) return null;
  // the words are in the name of the key, so the number is not read twice
  return (
    <span className="chip" data-tone="amber" aria-hidden="true">
      {unread}
    </span>
  );
}

const downlinkName = (unread: number): string => (unread === 0 ? 'Downlink' : `Downlink, ${unreadText(unread)}`);

function TopBar({ phone, onPanel }: { phone: boolean; onPanel(): void }): ReactElement {
  const list = useAgentList();
  const dir = list.find((a) => a.boss)?.dir ?? null;
  const unread = useStore((s) => s.downlink.unread);
  const view = useStore((s) => s.view);
  return (
    <header className="topbar">
      <h1 className="mark" aria-label="gonogo">
        <img className="mark-name" src={logo} alt="" aria-hidden="true" />
        <span className="label mark-unit" aria-hidden="true">
          GN-1<span className="mark-unit-long"> · OPERATIONS UNIT</span>
        </span>
      </h1>
      {!phone && dir !== null && (
        <span className="topbar-dir" title={dir}>
          {dir}
        </span>
      )}
      <span className="topbar-grow" />
      <LinkLamp />
      {!phone && (
        <button type="button" className="btn" data-kind="quiet" aria-current={view === 'loop' ? 'page' : undefined} onClick={showLoop}>
          Loop
        </button>
      )}
      {!phone && (
        <button type="button" className="btn" data-kind="quiet" aria-label={downlinkName(unread)} aria-current={view === 'downlink' ? 'page' : undefined} onClick={showDownlink}>
          Downlink
          <UnreadCount />
        </button>
      )}
      {!phone && (
        <button type="button" className="btn" data-kind="quiet" aria-current={view === 'window' ? 'page' : undefined} onClick={showWindow}>
          Launch Window
        </button>
      )}
      {!phone && (
        <button type="button" className="btn" data-kind="quiet" aria-current={view === 'plan' ? 'page' : undefined} onClick={showPlan}>
          Flight Plan
          <PlanCount />
        </button>
      )}
      {!phone && (
        <button type="button" className="btn" data-kind="quiet" aria-current={view === 'log' ? 'page' : undefined} onClick={showLog}>
          Mission Log
        </button>
      )}
      {!phone && (
        <button type="button" className="btn topbar-plus" data-kind="quiet" aria-label="Patch Panel" aria-keyshortcuts="Meta+K Control+K" title="Patch Panel (Cmd+K or Ctrl+K)" onClick={onPanel}>
          <span className="patch-mark" aria-hidden="true" />
        </button>
      )}
      {!phone && (
        <button type="button" className="btn topbar-plus" data-kind="quiet" aria-label="Flight Rules" title="Flight Rules" aria-current={view === 'rules' ? 'page' : undefined} onClick={showRules}>
          <span className="rules-mark" aria-hidden="true" />
        </button>
      )}
      {/* round keys: another word in the bar would not fit on one line at 1280 px */}
      <button type="button" className="btn topbar-plus" data-kind="quiet" aria-label="Livery" title="Livery" aria-current={view === 'livery' ? 'page' : undefined} onClick={showLivery}>
        <span className="livery-mark" aria-hidden="true" />
      </button>
      {phone ? (
        <button type="button" className="btn topbar-plus" data-kind="primary" aria-label="Staff a console" onClick={() => openHire()}>
          +
        </button>
      ) : (
        <button type="button" className="btn" data-kind="primary" onClick={() => openHire()}>
          + Staff a console
        </button>
      )}
    </header>
  );
}

/** The wall of a phone is mission, clock, poll and Max Q; the three screens are one bar away. */
function PhoneBar({ onPanel }: { onPanel(): void }): ReactElement {
  const view = useStore((s) => s.view);
  const unread = useStore((s) => s.downlink.unread);
  const planCount = activeText(activeOf(useStore((s) => s.tasks)));
  const goBrief = (): void => {
    showLoop();
    // The brief box is at the foot of the loop (its field has the class `brief-input`); it exists once the loop has rendered.
    requestAnimationFrame(() => document.querySelector<HTMLElement>('.brief-input')?.focus());
  };
  return (
    <nav className="phone-bar" aria-label="Sections">
      <button type="button" className="btn" data-kind={view === 'room' ? 'primary' : undefined} aria-current={view === 'room' ? 'page' : undefined} onClick={showRoom}>
        Room
      </button>
      <button type="button" className="btn" data-kind={view === 'loop' ? 'primary' : undefined} aria-current={view === 'loop' ? 'page' : undefined} onClick={showLoop}>
        Loop
      </button>
      <button type="button" className="btn" onClick={goBrief}>
        Brief
      </button>
      <button type="button" className="btn" data-kind={view === 'downlink' ? 'primary' : undefined} aria-label={downlinkName(unread)} aria-current={view === 'downlink' ? 'page' : undefined} onClick={showDownlink}>
        Down
        <UnreadCount />
      </button>
      <button type="button" className="btn" data-kind={view === 'window' ? 'primary' : undefined} aria-label="Launch Window" aria-current={view === 'window' ? 'page' : undefined} onClick={showWindow}>
        Launch
      </button>
      <button type="button" className="btn" data-kind={view === 'plan' ? 'primary' : undefined} aria-label={planCount === '' ? 'Flight Plan' : `Flight Plan, ${planCount}`} aria-current={view === 'plan' ? 'page' : undefined} onClick={showPlan}>
        Plan
        <PlanCount />
      </button>
      <button type="button" className="btn" data-kind={view === 'log' ? 'primary' : undefined} aria-label="Mission Log" aria-current={view === 'log' ? 'page' : undefined} onClick={showLog}>
        Log
      </button>
      <button type="button" className="btn" aria-label="Patch Panel" onClick={onPanel}>
        Patch
      </button>
    </nav>
  );
}

/* ---- system states (System.dc.html) ---- */

function Unauthorized(): ReactElement {
  return (
    <main className="system" data-system="nogo">
      <section className="system-slab module flood" data-tone="nogo" aria-label="Not signed in">
        <p className="label system-label">
          <span className="led" data-on="true" aria-hidden="true" />
          NOT SIGNED IN
        </p>
        <h1 className="disp system-word">NO-GO</h1>
        <p className="system-lead">This tab has no key.</p>
        <p className="system-text">Open the address gonogo printed when it started. The part after # is your key.</p>
        <p className="lcd system-address">{`${location.origin}/#token=[YOUR TOKEN]`}</p>
      </section>
    </main>
  );
}

function Standby(): ReactElement {
  return (
    <main className="system">
      <section className="system-slab module" aria-label="Loading">
        <p className="label system-label">LOADING</p>
        <h1 className="disp system-word" data-ghost="true">
          STANDBY
        </h1>
        <div className="system-steps" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <p className="system-lead" role="status">
          Bringing up the room.
        </p>
        <p className="system-text muted">No consoles are drawn until the server says who is staffed.</p>
      </section>
    </main>
  );
}

const retryText = (failed: number): string => `Trying again in ${RECONNECT_DELAYS_MS[Math.min(failed, RECONNECT_DELAYS_MS.length - 1)] / 1000} s, attempt ${failed}.`;

function ServerGone(): ReactElement {
  const failed = useStore((s) => s.failedAttempts);
  return (
    <main className="system">
      <section className="system-slab module flood" data-tone="amber" aria-label="Server gone">
        <p className="label system-label">
          <span className="led" data-on="true" data-blink="true" aria-hidden="true" />
          LOSS OF SIGNAL
        </p>
        <h1 className="disp system-word">LOS</h1>
        <p className="system-lead" role="status">
          The server stopped answering.
        </p>
        <p className="system-text">{`Is gonogo still running? ${retryText(failed)}`}</p>
        <div>
          <button type="button" className="btn" data-kind="primary" data-size="big" onClick={api.retryNow}>
            Retry now
          </button>
        </div>
      </section>
    </main>
  );
}

/** Known state, but the server has not answered for a while: the room stays (it is the last truth we have) and says so. */
function GoneStrip(): ReactElement | null {
  const gone = useStore((s) => s.connection === 'reconnecting' && s.failedAttempts >= RECONNECT_SERVER_GONE_AFTER);
  if (!gone) return null;
  return (
    <p className="gone-strip flood" data-tone="amber" role="status">
      <span className="led" data-on="true" data-blink="true" aria-hidden="true" />
      {SERVER_GONE_TEXT}{' '}
      <button type="button" className="btn" data-kind="quiet" onClick={api.retryNow}>
        Retry now
      </button>
    </p>
  );
}

const ROLLOUT_DISMISSED_KEY = 'gonogo.rollout.dismissed';

/** Rollout: a quiet note when a newer gonogo is out, with the command that updates this one (shown, never run). Dismissed for that version, in this browser only. */
function RolloutStrip(): ReactElement | null {
  const rollout = useStore((s) => s.rollout);
  const [dismissed, setDismissed] = useState(() => readStored(ROLLOUT_DISMISSED_KEY));
  const [copied, setCopied] = useState<boolean | null>(null);
  const code = useRef<HTMLElement | null>(null);
  if (rollout === null || !rollout.newer || rollout.latest === null || dismissed === rollout.latest) return null;
  const { latest, command } = rollout;
  return (
    <aside className="rollout-strip" aria-label="Update">
      <span>
        gonogo {latest} is out (this is {rollout.current}). To update, run:
      </span>
      <code ref={code}>{command}</code>
      <button
        type="button"
        className="btn"
        data-kind="quiet"
        onClick={() =>
          // Without a clipboard (plain http from another machine) the command is selected, to copy by hand.
          void copyText(command).then((ok) => {
            setCopied(ok);
            if (!ok && code.current !== null) window.getSelection()?.selectAllChildren(code.current);
          })
        }
      >
        {copied === null ? 'Copy' : copied ? 'Copied' : 'Not copied'}
      </button>
      <button
        type="button"
        className="btn"
        data-kind="quiet"
        onClick={() => {
          writeStored(ROLLOUT_DISMISSED_KEY, latest);
          setDismissed(latest);
        }}
      >
        Dismiss
      </button>
    </aside>
  );
}

/* ---- the live region ---- */

/** `n` changes with every write, so the same words twice in a row are read twice. */
function LiveRegion(): ReactElement {
  const list = useAgentList();
  const { legends } = useSeats();
  const unread = useStore((s) => s.downlink.unread);
  const poll = useStore((s) => s.poll);
  const limit = useStore((s) => s.governor.limit);
  const relief = useStore((s) => s.relief.length);
  const [out, setOut] = useState({ n: 0, text: '' });
  const [announcer] = useState(() => createAnnouncer((text) => setOut((o) => ({ n: o.n + 1, text }))));
  useEffect(() => announcer.update({ agents: list, unread, poll, limit, relief }, legends), [announcer, list, unread, poll, limit, relief, legends]);
  useEffect(() => {
    announcer.resume();
    return () => announcer.stop();
  }, [announcer]);
  return (
    <p className="sr-only" role="status" aria-live="polite">
      <span key={out.n}>{out.text}</span>
    </p>
  );
}

/* ---- page ---- */

function Screen({ phone }: { phone: boolean }): ReactElement {
  const form = useStore((s) => s.form);
  const view = useStore((s) => s.view);
  const activity = useStore((s) => s.activity);
  const agents = useStore((s) => s.agents);
  const list = useAgentList();
  if (form !== null) return <HireForm />;
  if (view === 'loop') {
    return <Loop items={activity} agents={agents} boss={list.find((a) => a.boss) ?? null} onSelect={openConsole} onClose={showRoom} />;
  }
  if (view === 'window') return <LaunchWindow />;
  if (view === 'plan') return <FlightPlan />;
  if (view === 'downlink') return <Downlink />;
  if (view === 'log') return <MissionLog />;
  if (view === 'livery') return <Livery />;
  if (view === 'hangar') return <Hangar />;
  if (view === 'recorder') return <Recorder />;
  if (view === 'board') return <PlotBoard />;
  if (view === 'blackbox') return <BlackBox />;
  if (view === 'rules') return <FlightRules />;
  if (view === 'party') return <PartyLine />;
  if (view === 'missions') return <Missions />;
  if (phone) {
    return (
      <main className="room room-phone">
        <Wall />
        <Needs phone />
        <Commissioning />
        <Operations phone />
      </main>
    );
  }
  return <RoomDesktop />;
}

function Office(): ReactElement {
  const phone = usePhone();
  const form = useStore((s) => s.form);
  const consoleOpen = useStore((s) => s.consoleOpen);
  const view = useStore((s) => s.view);
  const [panel, setPanel] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!isPanelKey(e)) return;
      e.preventDefault();
      setPanel(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const patch = <PatchPanel open={panel} phone={phone} onClose={() => setPanel(false)} />;
  // A console open on a phone is a full screen with its own header and no bottom bar.
  if (phone && consoleOpen && form === null && view === 'room') {
    return (
      <>
        <PhoneConsoleScreen />
        <LiveRegion />
        {patch}
      </>
    );
  }
  return (
    <>
      <TopBar phone={phone} onPanel={() => setPanel(true)} />
      <GoneStrip />
      <RolloutStrip />
      <Screen phone={phone} />
      {phone && form === null && <PhoneBar onPanel={() => setPanel(true)} />}
      <LiveRegion />
      {patch}
    </>
  );
}

export function App(): ReactElement {
  // browser notifications and the unread count in the tab title: the switch is in Flight Rules, and nothing asks for permission here
  useEffect(() => startNotifications(), []);
  const connection = useStore((s) => s.connection);
  const loading = useStore((s) => s.info === null);
  const gone = useStore((s) => s.failedAttempts >= RECONNECT_SERVER_GONE_AFTER);
  return <div className="app">{connection === 'unauthorized' ? <Unauthorized /> : loading ? gone ? <ServerGone /> : <Standby /> : <Office />}</div>;
}
