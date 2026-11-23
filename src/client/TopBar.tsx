/**
 * The top bar (docs/ui-semantic.md, "The top bar"): the logo and the version as a key, the link lamp, Rooms, Comms, a Work menu, a visible "Jump to…" field and a ⋯ menu.
 * One row at 1280 px. On a phone the same things: the bar has logo, version, lamp, Rooms and Jump; a bar at the bottom has Room, Comms, Work and More.
 */
import { useState } from 'react';
import type { ReactElement } from 'react';
import { DOCS_URL } from '../shared/protocol.js';
import * as api from './api.js';
import { CheckNow } from './CheckNow.js';
import { Pop } from './Pop.js';
import { MAIN_PATH, ROOMS_PATH, setPublicOrigin } from './base.js';
import { unreadText } from './inbox.js';
import { CHANGELOG_URL, inMain, ROLLOUT_DISMISSED_KEY, ROLLOUT_SHOW, useNewer } from './newer.js';
import { activeOf, activeText } from './plan.js';
import { readStored, showComms, showLivery, showLog, showLoop, showMissions, showPlan, showRoom, showRules, showWindow, useStore } from './store.js';
import { stripDismissed } from './selfupdate.js';
import { versionLabel } from './topbarModel.js';
import logo from '../../docs/brand/lockup.svg';

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

/** The small count of the Flight Plan: the tasks that are being worked on or are stuck. Saffron when one is blocked. */
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

/** The small count of the Comms key: what the Director has not read. The server keeps it, so the phone and the desk show the same. */
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

/** The version, as a key: whether this install is current, CHECK NOW, and what is out. In another room Update is main's, so it links there. */
function VersionButton({ phone }: { phone: boolean }): ReactElement | null {
  const info = useStore((s) => s.info);
  const newer = useNewer();
  const canUpdate = useStore((s) => s.rollout?.canUpdate === true);
  const canUndo = useStore((s) => s.rollout?.update?.undo === true);
  const installing = useStore((s) => ['running', 'reloading', 'handed-off'].includes(s.rollout?.update?.state ?? ''));
  const [undoError, setUndoError] = useState<string | null>(null);
  // the webhook addresses the page shows use the public address when the Director gave one (docs/expose-spec.md)
  setPublicOrigin(info?.publicUrl);
  if (info === null) return null;
  const label = versionLabel(info.version, newer, phone);
  return (
    <Pop className="lay-version" name={label.name} label={label.text}>
      {(close) => {
        // the strip under the top bar already has the Update key while it is shown (it is dismissed in this browser, or it is not): the version key then points to it, so no key is there twice
        const stripHidden = newer !== null && !installing && stripDismissed(readStored(ROLLOUT_DISMISSED_KEY), newer, false);
        return (
        <div className="lay-version-pop">
          <p className="lay-pop-title">
            gonogo {info.version} <span className="chip" data-tone={newer === null ? 'go' : 'amber'}>{newer === null ? 'up to date' : 'update available'}</span>
          </p>
          {newer !== null && <p className="hint">{newer} is out.{stripHidden ? ' Updating stops every agent while it installs, and it can be undone.' : ' The Update key is in the strip under the top bar.'}</p>}
          {inMain && <CheckNow />}
          {undoError !== null && (
            <p className="error" role="alert">
              {undoError}
            </p>
          )}
          <div className="lay-pop-keys">
            {newer !== null && stripHidden && (
              inMain ? (
                <button
                  type="button"
                  className="btn"
                  data-kind="primary"
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent(ROLLOUT_SHOW, { detail: { start: canUpdate } }));
                    close();
                  }}
                >
                  {canUpdate ? `Update to ${newer}` : 'How to update'}
                </button>
              ) : (
                <a className="btn" data-kind="primary" href={`${MAIN_PATH}?update`}>
                  Open main to update
                </a>
              )
            )}
            {canUndo && inMain && (
              <button
                type="button"
                className="btn"
                data-kind="quiet"
                onClick={() => {
                  setUndoError(null);
                  api.undoUpdate().then(close, (e: unknown) => setUndoError(e instanceof Error ? e.message : String(e)));
                }}
              >
                UNDO the last update
              </button>
            )}
            <a className="btn" data-kind="quiet" href={CHANGELOG_URL} target="_blank" rel="noreferrer noopener">
              What&apos;s new
            </a>
          </div>
        </div>
        );
      }}
    </Pop>
  );
}

/** A key of a menu: it shows its view and closes the menu. */
function Item({ label, run, close, aria, count }: { label: string; run(): void; close(): void; aria?: string; count?: ReactElement | null }): ReactElement {
  return (
    <button
      type="button"
      className="btn lay-item"
      data-kind="quiet"
      aria-label={aria}
      onClick={() => {
        run();
        close();
      }}
    >
      {label}
      {count}
    </button>
  );
}

function WorkMenu({ phone, up = false }: { phone: boolean; up?: boolean }): ReactElement {
  const off = useStore((s) => s.features);
  const goBrief = (): void => {
    showLoop();
    // The brief box is at the foot of the loop (its field has the class `brief-input`); it exists once the loop has rendered.
    requestAnimationFrame(() => document.querySelector<HTMLElement>('.brief-input')?.focus());
  };
  return (
    <Pop label="Work ▾" name="Work" up={up} align="start">
      {(close) => (
        <div className="lay-menu" role="group" aria-label="Work">
          {phone && <Item label="Brief" aria="Brief the boss" run={goBrief} close={close} />}
          {!off.includes('missions') && <Item label="Missions" run={showMissions} close={close} />}
          {!off.includes('flight-plan') && <Item label="Flight Plan" run={showPlan} close={close} count={<PlanCount />} />}
          {!off.includes('mission-log') && <Item label="Mission Log" run={showLog} close={close} />}
          {!off.includes('launch-window') && <Item label="Schedules" aria="Schedules (Launch Window)" run={showWindow} close={close} />}
        </div>
      )}
    </Pop>
  );
}

function MoreMenu({ up = false }: { up?: boolean }): ReactElement {
  const off = useStore((s) => s.features);
  return (
    <Pop label={up ? 'More' : '⋯'} name="More" up={up} align="end">
      {(close) => (
        <div className="lay-menu" role="group" aria-label="More">
          <Item label="Flight Rules" run={showRules} close={close} />
          {!off.includes('livery') && <Item label="Livery" run={showLivery} close={close} />}
          <a className="btn lay-item" data-kind="quiet" href={DOCS_URL} target="_blank" rel="noreferrer noopener">
            Docs
          </a>
        </div>
      )}
    </Pop>
  );
}

export function TopBar({ phone, onPanel }: { phone: boolean; onPanel(): void }): ReactElement {
  const unread = useStore((s) => s.downlink.unread);
  const view = useStore((s) => s.view);
  return (
    <header className="topbar lay-topbar">
      <h1 className="mark" aria-label="gonogo">
        <img className="mark-name" src={logo} alt="" aria-hidden="true" />
      </h1>
      <VersionButton phone={phone} />
      <span className="topbar-grow" />
      <LinkLamp />
      {/* a round key on a phone: the bar has no room for the word beside the logo, the version, the lamp and Jump */}
      {phone ? (
        <a className="btn topbar-plus" data-kind="quiet" href={ROOMS_PATH} aria-label="Rooms" title="Rooms">
          <span className="rooms-mark" aria-hidden="true" />
        </a>
      ) : (
        <>
          <a className="btn" data-kind="quiet" href={ROOMS_PATH}>
            Rooms
          </a>
          <button type="button" className="btn" data-kind="quiet" aria-label={commsName(unread)} aria-current={view === 'comms' ? 'page' : undefined} onClick={() => showComms()}>
            Comms
            <UnreadCount />
          </button>
          <WorkMenu phone={false} />
        </>
      )}
      <button type="button" className="btn lay-jump" data-kind="quiet" aria-label="Jump to… a console, a view or an action" aria-keyshortcuts="Meta+K Control+K" onClick={onPanel}>
        <span aria-hidden="true">⌕</span>
        <span className="lay-jump-text">{phone ? 'Jump' : 'Jump to…'}</span>
        <kbd className="lay-kbd">⌘K</kbd>
      </button>
      {!phone && <MoreMenu />}
    </header>
  );
}

/** A phone's bottom bar: Room, Comms, Work, More. */
export function PhoneBar(): ReactElement {
  const view = useStore((s) => s.view);
  const unread = useStore((s) => s.downlink.unread);
  return (
    <nav className="phone-bar lay-phone-bar" aria-label="Sections">
      <button type="button" className="btn" data-kind={view === 'room' ? 'primary' : undefined} aria-current={view === 'room' ? 'page' : undefined} onClick={showRoom}>
        Room
      </button>
      <button type="button" className="btn" data-kind={view === 'comms' ? 'primary' : undefined} aria-label={commsName(unread)} aria-current={view === 'comms' ? 'page' : undefined} onClick={() => showComms()}>
        Comms
        <UnreadCount />
      </button>
      <WorkMenu phone up />
      <MoreMenu up />
    </nav>
  );
}
