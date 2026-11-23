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
import { RoomScreen } from './RoomScreen.js';
import { Hangar } from './Hangar.js';
import { HireForm } from './HireForm.js';
import { LaunchWindow } from './LaunchWindow.js';
import { Livery } from './Livery.js';
import { MissionLog } from './MissionLog.js';
import { Recorder } from './Recorder.js';
import { PlotBoard } from './PlotBoard.js';
import { PatchPanel } from './PatchPanel.js';
import { FlightRules } from './Rules.js';
import { isPanelKey, VIEW_FEATURE } from './shell.js';
import { PhoneConsoleScreen, useAgentList, usePhone, useSeats } from './RoomView.js';
import { createAnnouncer } from './room.js';
import { readStored, useFeature, useStore, writeStored } from './store.js';
import { agentCounts, stripDismissed, UPDATE_TRUST_TEXT, updateDialogText, verifyPanel } from './selfupdate.js';
import { MAIN_PATH } from './base.js';
import { copyText } from './uplink.js';
import { SERVER_GONE_TEXT } from './wording.js';
import { inMain, ROLLOUT_DISMISSED_KEY, ROLLOUT_SHOW, useNewer } from './newer.js';
import { ExposureBanner } from './ExposureBanner.js';
import { SetupStrip } from './SetupStrip.js';
import { PhoneBar, TopBar } from './TopBar.js';
import './shell.css';

/* ---- system states (System.dc.html) ---- */

function Unauthorized(): ReactElement {
  // the address gonogo prints has the key of the first setup in it: once a login exists that key is refused, and the tab says so instead of a bare refusal
  const oldLink = api.hadSetupLink();
  return (
    <main className="system" data-system="nogo">
      <section className="system-slab module flood" data-tone="nogo" aria-label="Not signed in">
        <p className="label system-label">
          <span className="led" data-on="true" aria-hidden="true" />
          NOT SIGNED IN
        </p>
        <h1 className="disp system-word">NO-GO</h1>
        <p className="system-lead">{oldLink ? 'This link was for the first setup.' : 'This tab is not signed in.'}</p>
        <p className="system-text">
          {oldLink ? 'A login exists now: sign in with your name and password. The address with # in it opens gonogo only until the login is set up.' : 'Log in with your account. Before an account is set up, open the address gonogo printed when it started: the part after # is the key.'}
        </p>
        <p className="system-actions">
          <a className="btn" data-kind="primary" href="/login">
            {oldLink ? 'SIGN IN' : 'LOG IN'}
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
  // the version key asks for the update itself (detail.start), not only for the strip: one click there, then the one confirmation here
  const startRef = useRef<(() => void) | null>(null);
  // set again by the render that shows the strip: a render that returns nothing leaves it empty, so a request that outlives the strip never starts an update by itself
  startRef.current = null;
  const [wantStart, setWantStart] = useState(false);
  useEffect(() => {
    const show = (event?: Event): void => {
      writeStored(ROLLOUT_DISMISSED_KEY, '');
      setDismissed('');
      if ((event as CustomEvent<{ start?: boolean }> | undefined)?.detail?.start === true) setWantStart(true);
      requestAnimationFrame(() => strip.current?.focus());
    };
    // opened from another room's note: show the strip at once
    if (inMain && location.search === '?update') show();
    window.addEventListener(ROLLOUT_SHOW, show);
    return () => window.removeEventListener(ROLLOUT_SHOW, show);
  }, []);
  useEffect(() => {
    if (wantStart) {
      setWantStart(false);
      startRef.current?.();
    }
  }, [wantStart, dismissed, rollout]);
  const update = rollout?.update;
  const busy = update !== undefined && (update.state === 'running' || update.state === 'reloading' || update.state === 'handed-off');
  // what the last Docker self-update left (done, rolled back) is shown after the restart, when the new version is no longer "newer"
  const result = update !== undefined && (update.state === 'done' || (update.state === 'failed' && !(rollout?.newer ?? false)));
  if (rollout === null || (!rollout.newer && !result) || (rollout.latest === null && !result)) return null;
  const { command } = rollout;
  const latest = rollout.latest ?? update?.version ?? '';
  if (stripDismissed(dismissed, latest, busy)) return null;
  const inContainer = rollout.selfUpdate === true;
  // an image gonogo could not vouch for (the check was refused, or the image has no signature): said once, short, with the way on
  const failedVerify = update?.state === 'failed' && (update.verify === 'unattested' || update.verify === 'unchecked') && rollout.newer && !busy ? update.verify : null;
  const panelText = failedVerify === null ? null : verifyPanel(failedVerify);
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
  startRef.current = press;
  return (
    <aside className="rollout-strip" aria-label="Update" ref={strip} tabIndex={-1}>
      {rollout.newer && (
        <span>
          gonogo {latest} is out (this is {rollout.current}).{rollout.canUpdate === true ? '' : ' To update, run:'}
        </span>
      )}
      {rollout.canUpdate !== true && <code ref={code}>{command}</code>}
      {rollout.canUpdate === true && rollout.newer && failedVerify === null && !confirming && (
        <button type="button" className="btn" aria-disabled={busy || undefined} onClick={press}>
          Update to {latest}
        </button>
      )}
      {confirming && !busy && (
        <div className="rollout-confirm" role="alertdialog" aria-label={`Update to ${latest}`}>
          <p>{updateDialogText(latest, agentCounts(Object.values(agents).map((a) => a.state)), policy)}</p>
          <details className="rollout-fold">
            <summary className="btn" data-kind="quiet">
              What this runs
            </summary>
            <p>{UPDATE_TRUST_TEXT}</p>
          </details>
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
      {failedVerify !== null && panelText !== null && (
        <div className="rollout-confirm" role="alert">
          <p>{panelText.problem}</p>
          {panelText.fix !== null && (
            <details className="rollout-fix">
              <summary className="btn" data-kind="quiet">
                How to fix
              </summary>
              <p>{panelText.fix}</p>
            </details>
          )}
          <button type="button" className="btn" onClick={() => api.startUpdate(latest, true).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))}>
            {panelText.button}
          </button>
        </div>
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
      {rollout.installNote !== undefined && rollout.installNote !== '' && (
        <details className="rollout-fold rollout-note">
          <summary className="btn" data-kind="quiet">
            About this install
          </summary>
          <p>{rollout.installNote}</p>
        </details>
      )}
      {error !== null && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
      {update !== undefined && update.state !== 'idle' && failedVerify === null && (
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
  if (phone) return <RoomScreen phone />;
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
      <SetupStrip />
      <ExposureBanner />
      <GoneStrip />
      <RolloutStrip />
      <OtherRoomStrip />
      <Screen phone={phone} />
      {phone && form === null && <PhoneBar />}
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
