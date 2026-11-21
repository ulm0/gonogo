import { StepUpDialog } from './StepUpDialog.js';
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { RECONNECT_DELAYS_MS, RECONNECT_SERVER_GONE_AFTER } from '../shared/protocol.js';
import { Comms } from './Comms.js';
import type { StartupPolicy } from '../shared/protocol.js';
import { startNotifications } from './notify-browser.js';
import { startWorker } from './push-browser.js';
import * as api from './api.js';
import { BlackBox } from './BlackBox.js';
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
import { isPanelKey, VIEW_FEATURE } from './shell.js';
import { unreadText } from './inbox.js';
import { activeOf, activeText } from './plan.js';
import { PhoneConsoleScreen, Needs, Operations, useAgentList, usePhone, useSeats } from './RoomView.js';
import { createAnnouncer } from './room.js';
import { CheckNow } from './CheckNow.js';
import { openConsole, openHire, readStored, showComms, showLivery, showLog, showLoop, showMissions, showPlan, showRoom, showRules, showWindow, useFeature, useStore, writeStored } from './store.js';
import { agentCounts, updateDialogText } from './selfupdate.js';
import { BASE, MAIN_PATH, ROOMS_PATH, setPublicOrigin } from './base.js';
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
      <span className="lamp-text">{text}</span>
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

const commsName = (unread: number): string => (unread === 0 ? 'Comms' : `Comms, ${unreadText(unread)}`);

function TopBar({ phone, onPanel }: { phone: boolean; onPanel(): void }): ReactElement {
  const list = useAgentList();
  const dir = list.find((a) => a.boss)?.dir ?? null;
  const unread = useStore((s) => s.downlink.unread);
  const view = useStore((s) => s.view);
  const off = useStore((s) => s.features);
  return (
    <header className="topbar">
      <h1 className="mark" aria-label="gonogo">
        <img className="mark-name" src={logo} alt="" aria-hidden="true" />
        <span className="label mark-unit" aria-hidden="true">
          GN-1<span className="mark-unit-long"> · OPERATIONS UNIT</span>
        </span>
      </h1>
      <VersionMark />
      {!phone && dir !== null && (
        <span className="topbar-dir" title={dir}>
          {dir}
        </span>
      )}
      <span className="topbar-grow" />
      <LinkLamp />
      {/* a round key on a phone: the bar has no room for the word beside the logo, the version, the lamp and the two keys that follow */}
      {phone ? (
        <a className="btn topbar-plus" data-kind="quiet" href={ROOMS_PATH} aria-label="Rooms" title="Rooms">
          <span className="rooms-mark" aria-hidden="true" />
        </a>
      ) : (
        <a className="btn" data-kind="quiet" href={ROOMS_PATH}>
          Rooms
        </a>
      )}
      {!phone && (
        <button type="button" className="btn" data-kind="quiet" aria-label={commsName(unread)} aria-current={view === 'comms' ? 'page' : undefined} onClick={() => showComms()}>
          Comms
          <UnreadCount />
        </button>
      )}
      {!phone && !off.includes('missions') && (
        <button type="button" className="btn" data-kind="quiet" aria-current={view === 'missions' ? 'page' : undefined} onClick={showMissions}>
          Missions
        </button>
      )}
      {!phone && !off.includes('launch-window') && (
        <button type="button" className="btn" data-kind="quiet" aria-current={view === 'window' ? 'page' : undefined} onClick={showWindow}>
          Launch Window
        </button>
      )}
      {!phone && !off.includes('flight-plan') && (
        <button type="button" className="btn" data-kind="quiet" aria-current={view === 'plan' ? 'page' : undefined} onClick={showPlan}>
          Flight Plan
          <PlanCount />
        </button>
      )}
      {!phone && !off.includes('mission-log') && (
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
      {!off.includes('livery') && (
        <button type="button" className="btn topbar-plus" data-kind="quiet" aria-label="Livery" title="Livery" aria-current={view === 'livery' ? 'page' : undefined} onClick={showLivery}>
          <span className="livery-mark" aria-hidden="true" />
        </button>
      )}
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
  const off = useStore((s) => s.features);
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
      <button type="button" className="btn" data-kind={view === 'comms' ? 'primary' : undefined} aria-label={commsName(unread)} aria-current={view === 'comms' ? 'page' : undefined} onClick={() => showComms()}>
        Comms
        <UnreadCount />
      </button>
      <button type="button" className="btn" onClick={goBrief}>
        Brief
      </button>
      {!off.includes('launch-window') && (
        <button type="button" className="btn" data-kind={view === 'window' ? 'primary' : undefined} aria-label="Launch Window" aria-current={view === 'window' ? 'page' : undefined} onClick={showWindow}>
          Launch
        </button>
      )}
      {!off.includes('flight-plan') && (
        <button type="button" className="btn" data-kind={view === 'plan' ? 'primary' : undefined} aria-label={planCount === '' ? 'Flight Plan' : `Flight Plan, ${planCount}`} aria-current={view === 'plan' ? 'page' : undefined} onClick={showPlan}>
          Plan
          <PlanCount />
        </button>
      )}
      {!off.includes('mission-log') && (
        <button type="button" className="btn" data-kind={view === 'log' ? 'primary' : undefined} aria-label="Mission Log" aria-current={view === 'log' ? 'page' : undefined} onClick={showLog}>
          Log
        </button>
      )}
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
        <p className="system-lead">This tab is not signed in.</p>
        <p className="system-text">Log in with your account. Before an account is set up, open the address gonogo printed when it started: the part after # is the key.</p>
        <p className="system-actions">
          <a className="btn" data-kind="primary" href="/login">
            LOG IN
          </a>
        </p>
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

/** The version by the logo says a newer one is out and asks the strip to show itself, even one dismissed for that version. */
const ROLLOUT_SHOW = 'gonogo:rollout-show';

const CHANGELOG_URL = 'https://github.com/ulm0/gonogo/blob/main/CHANGELOG.md';

/** The main room is the one that checks for a newer gonogo and updates it (a room under /r/<other>/ links there). */
const inMain = BASE === '' || BASE === '/r/main';

/** The newer version the check saw, or null. Main has it in its own rollout; any other room runs no check, so the supervisor says what main saw. */
function useNewer(): string | null {
  const rollout = useStore((s) => s.rollout);
  const [other, setOther] = useState<string | null>(null);
  useEffect(() => {
    if (inMain) return undefined;
    let alive = true;
    const ask = (): void => void api.roomsUpdate().then((v) => alive && setOther(v));
    ask();
    const timer = setInterval(ask, 30 * 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  return inMain ? (rollout?.newer === true ? rollout.latest : null) : other;
}

/** The running version by the logo, small; it links to the changelog. When a newer one is out it says so, in every room (the strip itself is main's: that is where Update lives). */
function VersionMark(): ReactElement | null {
  const info = useStore((s) => s.info);
  const newer = useNewer();
  // the webhook addresses the page shows use the public address when the Director gave one (docs/expose-spec.md)
  setPublicOrigin(info?.publicUrl);
  if (info === null) return null;
  return (
    <span className="topbar-version" data-newer={newer !== null ? 'true' : undefined}>
      <a className="version-mark" href={CHANGELOG_URL} target="_blank" rel="noreferrer noopener" aria-label={`gonogo ${info.version}, open the changelog`}>
        {info.version}
      </a>
      {newer !== null &&
        (inMain ? (
          <button type="button" className="version-new" onClick={() => window.dispatchEvent(new Event(ROLLOUT_SHOW))}>
            {newer} out
          </button>
        ) : (
          <a className="version-new" href={`${MAIN_PATH}?update`} aria-label={`${newer} is out, open the main room to update`}>
            {newer} out
          </a>
        ))}
    </span>
  );
}

/**
 * The same note in a room other than main. Its Update key lives in main (it asks before it stops every agent of main, with their count), so
 * here the key opens main with its strip shown; nothing is updated from this page. Dismissed for that version, like main's, in this browser.
 */
function OtherRoomStrip(): ReactElement | null {
  const info = useStore((s) => s.info);
  const latest = useNewer();
  const [dismissed, setDismissed] = useState(() => readStored(ROLLOUT_DISMISSED_KEY));
  if (inMain || latest === null || info === null || dismissed === latest) return null;
  return (
    <aside className="rollout-strip" aria-label="Update">
      <span>
        gonogo {latest} is out (this is {info.version}). Update it from the main room.
      </span>
      <a className="btn" href={`${MAIN_PATH}?update`}>
        Open main to update
      </a>
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

/**
 * Rollout: a quiet note when a newer gonogo is out, with the way to update the install this one is (the command is shown; with an npm or pnpm
 * global install, or a container with an update hook, an Update button runs it). Never without that click. Dismissed for that version, in this browser only.
 */
function RolloutStrip(): ReactElement | null {
  const rollout = useStore((s) => s.rollout);
  const [dismissed, setDismissed] = useState(() => readStored(ROLLOUT_DISMISSED_KEY));
  const [copied, setCopied] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const code = useRef<HTMLElement | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [policy, setPolicy] = useState<StartupPolicy | null>(null);
  const agents = useStore((s) => s.agents);
  const strip = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const show = (): void => {
      writeStored(ROLLOUT_DISMISSED_KEY, '');
      setDismissed('');
      requestAnimationFrame(() => strip.current?.focus());
    };
    // opened from another room's note: show the strip at once
    if (inMain && location.search === '?update') show();
    window.addEventListener(ROLLOUT_SHOW, show);
    return () => window.removeEventListener(ROLLOUT_SHOW, show);
  }, []);
  const update = rollout?.update;
  const busy = update !== undefined && (update.state === 'running' || update.state === 'reloading' || update.state === 'handed-off');
  // what the last Docker self-update left (done, rolled back) is shown after the restart, when the new version is no longer "newer"
  const result = update !== undefined && (update.state === 'done' || (update.state === 'failed' && !(rollout?.newer ?? false)));
  if (rollout === null || (!rollout.newer && !result) || (rollout.latest === null && !result)) return null;
  if (dismissed === rollout.latest && update === undefined) return null;
  const { command } = rollout;
  const latest = rollout.latest ?? update?.version ?? '';
  const inContainer = rollout.selfUpdate === true;
  const press = (): void => {
    if (busy) return;
    setError(null);
    if (!inContainer) {
      api.startUpdate(latest).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
      return;
    }
    // a container update stops every agent: say so, with the autostart state, and ask once more
    setConfirming(true);
    api.startupSettings().then((found) => setPolicy(found.policy), () => setPolicy(null));
  };
  return (
    <aside className="rollout-strip" aria-label="Update" ref={strip} tabIndex={-1}>
      {rollout.newer && (
        <span>
          gonogo {latest} is out (this is {rollout.current}).{rollout.canUpdate === true ? '' : ' To update, run:'}
        </span>
      )}
      {rollout.canUpdate !== true && <code ref={code}>{command}</code>}
      {rollout.canUpdate === true && rollout.newer && (
        <button type="button" className="btn" aria-disabled={busy || undefined} onClick={press}>
          Update to {latest}
        </button>
      )}
      {confirming && !busy && (
        <div className="rollout-confirm" role="alertdialog" aria-label={`Update to ${latest}`}>
          <p>{updateDialogText(latest, agentCounts(Object.values(agents).map((a) => a.state)), policy)}</p>
          <button
            type="button"
            className="btn"
            data-kind="primary"
            onClick={() => {
              setConfirming(false);
              api.startUpdate(latest).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
            }}
          >
            Update now
          </button>
          <button type="button" className="btn" data-kind="quiet" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      )}
      {update?.state === 'failed' && (update.verify === 'unattested' || update.verify === 'unchecked') && rollout.newer && !busy && (
        <span className="rollout-confirm" role="alert">
          {update.note}{' '}
          <button type="button" className="btn" onClick={() => api.startUpdate(latest, true).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))}>
            {update.verify === 'unchecked' ? 'Update anyway (could not check)' : 'Update anyway (no attestation)'}
          </button>
        </span>
      )}
      {update?.undo === true && (
        <button type="button" className="btn" aria-disabled={busy || undefined} onClick={() => api.undoUpdate().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))}>
          UNDO
        </button>
      )}
      {rollout.canUpdate !== true && (
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
      )}
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
      <CheckNow />
      {rollout.installNote !== undefined && rollout.installNote !== '' && <span className="hint rollout-note">{rollout.installNote}</span>}
      {error !== null && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
      {update !== undefined && update.state !== 'idle' && (
        <div className="rollout-progress" role="status">
          <span>{update.note}</span>
          {update.tail.length > 0 && (
            <details>
              <summary>Installer output</summary>
              <pre>{update.tail.join('\n')}</pre>
            </details>
          )}
          {update.rollback !== null && (
            <span>
              To go back: <code>{update.rollback}</code>, then reload.
            </span>
          )}
        </div>
      )}
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
  const shown = useStore((s) => s.view);
  const off = useStore((s) => s.features);
  // a view whose feature was switched off while it was open falls back to the Room
  const owner = VIEW_FEATURE[shown];
  const view = owner !== undefined && off.includes(owner) ? 'room' : shown;
  const activity = useStore((s) => s.activity);
  const agents = useStore((s) => s.agents);
  const list = useAgentList();
  if (form !== null) return <HireForm />;
  if (view === 'comms') return <Comms />;
  if (view === 'window') return <LaunchWindow />;
  if (view === 'plan') return <FlightPlan />;
  if (view === 'log') return <MissionLog />;
  if (view === 'livery') return <Livery />;
  if (view === 'hangar') return <Hangar />;
  if (view === 'recorder') return <Recorder />;
  if (view === 'board') return <PlotBoard />;
  if (view === 'blackbox') return <BlackBox />;
  if (view === 'rules') return <FlightRules />;
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
      <OtherRoomStrip />
      <Screen phone={phone} />
      {phone && form === null && <PhoneBar onPanel={() => setPanel(true)} />}
      <LiveRegion />
      {patch}
    </>
  );
}

export function App(): ReactElement {
  // the counts of Knowledge anchors on the tiles: asked again when the log changes (an agent's Stop makes the server say so)
  const anchorsOn = useFeature('knowledge-anchors');
  // before the first state the page does not know which features are off (it assumes none); the route of an off feature answers 404, which the console would show
  const known = useStore((s) => s.info !== null);
  const logRev = useStore((s) => s.log.rev);
  useEffect(() => {
    if (anchorsOn && known) void api.loadKnowledge();
  }, [anchorsOn, known, logRev]);
  // browser notifications and the unread count in the tab title: the switch is in Flight Rules, and nothing asks for permission here
  useEffect(() => startNotifications(), []);
  // the service worker of the installed app (shell and push): only where the browser allows one
  useEffect(() => startWorker(), []);
  const connection = useStore((s) => s.connection);
  const loading = useStore((s) => s.info === null);
  const gone = useStore((s) => s.failedAttempts >= RECONNECT_SERVER_GONE_AFTER);
  return (
    <div className="app">
      {connection === 'unauthorized' ? <Unauthorized /> : loading ? gone ? <ServerGone /> : <Standby /> : <Office />}
      <StepUpDialog />
    </div>
  );
}
