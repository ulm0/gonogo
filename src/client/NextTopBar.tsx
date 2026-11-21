/**
 * The top bar of the prototype layout (docs/ui-semantic.md, "The top bar"): the logo and the version as a button, the link lamp, Rooms, Comms, a Work menu, a visible
 * "Jump to…" field and a ⋯ menu. One row at 1280 px; on a phone the same things in a bar of its own and a bottom bar of four keys.
 */
import type { ReactElement } from 'react';
import { DOCS_URL } from '../shared/protocol.js';
import { CheckNow } from './CheckNow.js';
import { NextPop } from './NextPop.js';
import { ROOMS_PATH } from './base.js';
import { unreadText } from './inbox.js';
import { showComms, showLivery, showLog, showMissions, showPlan, showRoom, showRules, showWindow, useStore } from './store.js';
import logo from '../../docs/brand/lockup.svg';

const CHANGELOG_URL = 'https://github.com/ulm0/gonogo/blob/main/CHANGELOG.md';

function Lamp(): ReactElement {
  const connection = useStore((s) => s.connection);
  const text = connection === 'open' ? 'LINK UP' : connection === 'connecting' ? 'CONNECTING' : 'LINK DOWN';
  return (
    <span className="lamp" role="status" data-link={connection === 'open' ? 'up' : connection === 'connecting' ? 'wait' : 'down'}>
      <span className="led" data-on={connection === 'open'} data-blink={connection === 'connecting'} aria-hidden="true" />
      <span className="lamp-text">{text}</span>
    </span>
  );
}

/** The version, as a key: whether this install is current, the CHECK NOW that used to be in Flight Rules, and what is out. */
export function VersionButton(): ReactElement | null {
  const info = useStore((s) => s.info);
  const rollout = useStore((s) => s.rollout);
  if (info === null) return null;
  const newer = rollout?.newer === true ? rollout.latest : null;
  return (
    <NextPop className="next-version" name={newer === null ? `gonogo ${info.version}, up to date` : `gonogo ${info.version}, ${newer} is out`} label={newer === null ? `${info.version} ✓` : `${info.version} → ${newer}`}>
      {(close) => (
        <div className="next-version-pop">
          <p className="next-pop-title">
            gonogo {info.version} <span className="chip" data-tone={newer === null ? 'go' : 'amber'}>{newer === null ? 'up to date' : 'update available'}</span>
          </p>
          {newer !== null && <p className="hint">{newer} is out. Updating stops every agent while it installs, and it can be undone.</p>}
          <CheckNow />
          <div className="next-pop-keys">
            {newer !== null && (
              <button
                type="button"
                className="btn"
                data-kind="primary"
                onClick={() => {
                  window.dispatchEvent(new Event('gonogo:rollout-show'));
                  close();
                }}
              >
                Update to {newer}
              </button>
            )}
            <a className="btn" data-kind="quiet" href={CHANGELOG_URL} target="_blank" rel="noreferrer noopener">
              What&apos;s new
            </a>
          </div>
        </div>
      )}
    </NextPop>
  );
}

/** The views of the Work menu and of ⋯; each key closes the panel and shows its view. */
function Item({ label, run, close, aria }: { label: string; run(): void; close(): void; aria?: string }): ReactElement {
  return (
    <button
      type="button"
      className="btn next-item"
      data-kind="quiet"
      aria-label={aria}
      onClick={() => {
        run();
        close();
      }}
    >
      {label}
    </button>
  );
}

export function WorkMenu({ up = false }: { up?: boolean }): ReactElement {
  const off = useStore((s) => s.features);
  return (
    <NextPop label="Work ▾" name="Work" up={up} align="start">
      {(close) => (
        <div className="next-menu" role="group" aria-label="Work">
          {!off.includes('missions') && <Item label="Missions" run={showMissions} close={close} />}
          {!off.includes('flight-plan') && <Item label="Flight Plan" run={showPlan} close={close} />}
          {!off.includes('mission-log') && <Item label="Mission Log" run={showLog} close={close} />}
          {!off.includes('launch-window') && <Item label="Schedules" aria="Schedules (Launch Window)" run={showWindow} close={close} />}
        </div>
      )}
    </NextPop>
  );
}

export function MoreMenu({ up = false }: { up?: boolean }): ReactElement {
  const off = useStore((s) => s.features);
  return (
    <NextPop label={up ? 'More' : '⋯'} name="More" up={up} align="end">
      {(close) => (
        <div className="next-menu" role="group" aria-label="More">
          <Item label="Flight Rules" run={showRules} close={close} />
          {!off.includes('livery') && <Item label="Livery" run={showLivery} close={close} />}
          <a className="btn next-item" data-kind="quiet" href={DOCS_URL} target="_blank" rel="noreferrer noopener">
            Docs
          </a>
        </div>
      )}
    </NextPop>
  );
}

export function NextTopBar({ phone, onPanel }: { phone: boolean; onPanel(): void }): ReactElement {
  const unread = useStore((s) => s.downlink.unread);
  const view = useStore((s) => s.view);
  const commsName = unread === 0 ? 'Comms' : `Comms, ${unreadText(unread)}`;
  return (
    <header className="topbar next-topbar">
      <h1 className="mark" aria-label="gonogo">
        <img className="mark-name" src={logo} alt="" aria-hidden="true" />
      </h1>
      <VersionButton />
      <span className="topbar-grow" />
      <Lamp />
      {!phone && (
        <>
          <a className="btn" data-kind="quiet" href={ROOMS_PATH}>
            Rooms
          </a>
          <button type="button" className="btn" data-kind="quiet" aria-label={commsName} aria-current={view === 'comms' ? 'page' : undefined} onClick={() => showComms()}>
            Comms
            {unread > 0 && (
              <span className="chip" data-tone="amber" aria-hidden="true">
                {unread}
              </span>
            )}
          </button>
          <WorkMenu />
        </>
      )}
      <button type="button" className="btn next-jump" data-kind="quiet" aria-label="Jump to a console, a view or an action" aria-keyshortcuts="Meta+K Control+K" onClick={onPanel}>
        <span aria-hidden="true">⌕</span>
        <span className="next-jump-text">Jump to…</span>
        <kbd className="next-kbd">⌘K</kbd>
      </button>
      <MoreMenu />
    </header>
  );
}

/** A phone's bottom bar: Room, Comms, Work, More. */
export function NextPhoneBar(): ReactElement {
  const unread = useStore((s) => s.downlink.unread);
  const view = useStore((s) => s.view);
  return (
    <nav className="phone-bar next-phone-bar" aria-label="Sections">
      <button type="button" className="btn" data-kind={view === 'room' ? 'primary' : undefined} aria-current={view === 'room' ? 'page' : undefined} onClick={showRoom}>
        Room
      </button>
      <button type="button" className="btn" data-kind={view === 'comms' ? 'primary' : undefined} aria-label={unread === 0 ? 'Comms' : `Comms, ${unreadText(unread)}`} onClick={() => showComms()}>
        Comms
        {unread > 0 && (
          <span className="chip" data-tone="amber" aria-hidden="true">
            {unread}
          </span>
        )}
      </button>
      <WorkMenu up />
      <MoreMenu up />
    </nav>
  );
}
