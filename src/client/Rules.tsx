/**
 * Flight Rules, the settings screen: the settings the Director can already change, in one place. Max Q and the room's Propellant
 * are the wall's own modules; a setting that lives in its own feature (the livery, a console, the schedules and webhooks) is a
 * key that opens it. Commissioning, the checklist of an empty room, is here too: it uses the same keys.
 */
import { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, ReactElement, ReactNode } from 'react';
import * as api from './api.js';
import { DOCS_URL } from '../shared/protocol.js';
import { DetailChips } from './DetailChips.js';
import { currentEntry } from './look.js';
import { ModelDefaultsBlock } from './ModelDefaults.js';
import { FeaturesBlock } from './Features.js';
import { PayloadDefaultsBlock } from './PayloadDefaults.js';
import { SkillsBlock } from './SkillsBlock.js';
import { KnowledgeBlock } from './Knowledge.js';
import { SemanticBlock } from './Semantic.js';
import { RitualTemplateBlock, RoomRulesBlock } from './RoomRules.js';
import { RoomKeysBlock } from './RoomKeys.js';
import { PermissionDefaultsBlock } from './PermissionDefaults.js';
import { AccountBlock } from './AccountBlock.js';
import { AllStopBlock, CoauthorBlock, StartupBlock, SubagentsBlock } from './StartupRules.js';
import { EgressBlock } from './EgressRules.js';
import { GlobalMcpBlock } from './GlobalMcp.js';
import { AutoUpdateBlock } from './AutoUpdateRules.js';
import { VersionCheckBlock } from './CheckNow.js';
import { PushBlock } from './PushBlock.js';
import { disableNotifications, enableNotifications, useNotifyStatus } from './notify-browser.js';
import { STATUS_TEXT } from './notify.js';
import { TabNameBlock } from './TabName.js';
import { PHONE_MODES } from '../shared/protocol.js';
import type { PhoneMode, RelayView } from '../shared/protocol.js';
import { useAgentList, usePhone, useSeats } from './RoomView.js';
import { commissioningSteps, loadMarks, saveMarks, showCommissioning } from './shell.js';
import type { Mark, Step } from './shell.js';
import { openConsole, openEdit, showLivery, showLoop, showRoom, showRules, useFeature, useStore } from './store.js';
import { legendOf } from './wall.js';
import { MaxQ, Propellant } from './WallView.js';
import { Row, useValue } from './Row.js';
import { DockingPanel } from './DockingPanel.js';
import { SchedulesBlock } from './LaunchWindow.js';
import { RelayPanel } from './RelayPanel.js';
import { UplinkPanel } from './UplinkPanel.js';
import { GLOSSARY_URL } from './wording.js';
import { ProjectFolderBlock } from './ProjectFolder.js';
import { rowText as folderRowText } from './projectFolderModel.js';
import { DOCKING_ROW, takeRulesTarget } from './rulesTarget.js';
import { RuntimeSettingsBlock } from './RuntimeSettings.js';
import { summary as runtimeSummary } from './runtimeSettingsModel.js';
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

/** The groups of Flight Rules, in order: the index at the top has a key for each, and each group below has its heading. */
const GROUPS: ReadonlyArray<readonly [string, string]> = [['room', 'Room'], ['agents', 'Agents'], ['budget', 'Budget and limits'], ['auto', 'Automation and connections'], ['knowledge', 'Knowledge'], ['security', 'Security'], ['system', 'System and update']];

/** The open group and how to change it: a context, so that Group is one component for good (one defined inside FlightRules is a new type at every render, and React would rebuild every block in it each time a value arrives). */
const GroupContext = createContext<{ open: string; setOpen(id: string): void; base: string }>({ open: '', setOpen: () => undefined, base: '' });

function Group({ id, title, children }: { id: string; title: string; children: ReactNode }): ReactElement | null {
  const { open, base } = useContext(GroupContext);
  // option B: the index at the top chooses the group, and only that group is below it
  if (open !== id) return null;
  return (
    <section className="lay-group" id={`${base}-g-${id}`} aria-label={title} data-open>
      <h2 className="lay-group-title">{title}</h2>
      <div className="lay-group-body">{children}</div>
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
  // a key elsewhere (the docked chip) can ask for one row: its group opens and so does the row
  const wanted = useRef(takeRulesTarget());
  const [openGroup, setOpenGroup] = useState(wanted.current?.group ?? 'room');
  useEffect(() => {
    const row = wanted.current?.row;
    wanted.current = null;
    if (row === undefined) return;
    requestAnimationFrame(() => {
      const name = [...document.querySelectorAll('.lay-row-name')].find((el) => el.textContent === row);
      const details = name?.closest('details');
      if (details instanceof HTMLDetailsElement) details.open = true;
      details?.querySelector('summary')?.focus();
      details?.scrollIntoView({ block: 'nearest' });
    });
  }, []);
  const model = useValue(() => api.modelDefaults().then((m) => `${m.engine ?? 'claude'}${m.effort ? `, effort ${m.effort}` : ''}`));
  const perms = useValue(() => api.permissionDefaults().then((p) => `${Object.values(p.permissions as Record<string, unknown>).flat().length} rules`));
  const payload = useValue(() => api.payloadDefaults().then((p) => `${p.mcpServers.length} servers, ${p.skills.length} skills`));
  const sub = useValue(() => api.subagentSettings().then((x) => (x.mode === 'limit' ? `at most ${x.limit}` : x.mode)));
  const coauthor = useValue(() => api.coauthorSettings().then((c) => (c.enabled ? 'co-author line on' : 'co-author line off') + (c.prFooter ? ', PR footer on' : '')));
  const globalNow = useValue(() => api.globalMcp().then((g) => `${g.servers.length} found, ${g.host ? 'on' : 'off'} for agents${g.cleanRoom ? ', on for Clean Room' : ''}`));
  const egress = useValue(() => api.egressSettings().then((e) => (e.anthropic ? 'kept out of containers' : 'in the container')));
  const auto = useValue(() => api.autoUpdate().then((a) => (a.enabled ? 'on' : 'off')));
  const version = useStore((s) => s.info?.version ?? '');
  const tabName = useStore((s) => s.tabName);
  const governor = useStore((s) => s.governor);
  const schedules = useStore((s) => s.schedules.length);
  const uplinks = useStore((s) => s.uplinks.length);
  const docked = useStore((s) => s.docking.docks.length);
  const rules = useValue(() => api.rulesView().then((r) => (r.bytes === 0 ? 'none written' : `${r.bytes} bytes`)));
  const template = useValue(() => api.ritualTemplate().then((r) => (r.bytes === 0 ? 'none written' : `${r.bytes} bytes`)));
  const startup = useValue(() => api.startupSettings().then((x) => `after a restart: ${x.policy}`));
  const know = useValue(() => api.knowledge().then((k) => (k.enabled ? `on, ${k.repos.length} repositories` : 'off')));
  const folder = useValue(() => api.projectFolder().then(folderRowText));
  // the line of the row follows a change made in it (the value above was asked once, when the page opened)
  const [folderNow, setFolderNow] = useState<string | null>(null);
  const runtime = useValue(() => api.runtimeSettings().then(runtimeSummary));
  const keys = useValue(() => api.roomKeys().then((k) => `${k.keys.length} keys`));
  const off = useStore((s) => s.features);
  const current = useMarks();
  const liveryBlock = (
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
  );
  const consolesBlock = (
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
  );
  const browserBlock = (
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
  );
  // The page replaces the room: the keyboard starts at its title.
  useEffect(() => heading.current?.focus(), []);
  return (
    <GroupContext.Provider value={{ open: openGroup, setOpen: setOpenGroup, base: titleId }}>
    <section className="rules lay-rules" aria-labelledby={titleId}>
      <header className="loop-head">
        <h1 id={titleId} ref={heading} tabIndex={-1} className="disp loop-title rules-title">
          FLIGHT RULES
        </h1>
        <button type="button" className="btn loop-room" data-kind="quiet" onClick={showRoom}>
          ← Back to the room
        </button>
      </header>
      <nav className="lay-group-nav" aria-label="Groups of settings">
        {GROUPS.map(([id, title]) => (
          <a
            key={id}
            className="btn"
            data-kind={openGroup === id ? 'primary' : 'quiet'}
            aria-current={openGroup === id ? 'true' : undefined}
            href={`#${titleId}-g-${id}`}
            onClick={(e) => {
              e.preventDefault();
              setOpenGroup(id);
              requestAnimationFrame(() => document.getElementById(`${titleId}-g-${id}`)?.scrollIntoView({ block: 'start' }));
            }}
          >
            {title}
          </a>
        ))}
      </nav>
      <Group id="room" title="Room">
        <Row name="Livery" now={currentEntry(livery).name}>{liveryBlock}</Row>
        <Row name="Project folder" now={folderNow ?? folder}><ProjectFolderBlock onChanged={(next) => setFolderNow(folderRowText(next))} /></Row>
        <Row name="Tab name" now={tabName.name ?? tabName.fallback ?? 'not set'}><TabNameBlock /></Row>
        <Row name="Room rules" now={rules}><RoomRulesBlock /></Row>
        <Row name="Closing checklist template" now={template}><RitualTemplateBlock /></Row>
        <Row name="This browser" now="notifications, push, Commissioning">{browserBlock}</Row>
      </Group>
      <Group id="agents" title="Agents">
        <Row name="Consoles" now={`${list.length} staffed`}>{consolesBlock}</Row>
        <Row name="Engine, model and effort" now={model}><ModelDefaultsBlock /></Row>
        <Row name="Tool permissions" now={perms}><PermissionDefaultsBlock /></Row>
        <Row name="Payload: servers and skills" now={payload}><PayloadDefaultsBlock /></Row>
        <Row name="Global MCP servers" now={globalNow}><GlobalMcpBlock /></Row>
        <Row name="Skills registry" now="see Edit"><SkillsBlock /></Row>
        <Row name="Subagents" now={sub}><SubagentsBlock /></Row>
        <Row name="Co-author and PR footer" now={coauthor}><CoauthorBlock /></Row>
        <Row name="Clean Room API key" now={egress}><EgressBlock /></Row>
      </Group>
      <Group id="budget" title="Budget and limits">
        {maxqOn && <Row name="Max Q: agents working at once" now={governor.limit === null ? 'no limit' : `at most ${governor.limit}`}><MaxQ /></Row>}
        <Row name="Propellant: tokens and dollars" now="limits per window"><Propellant /></Row>
      </Group>
      <Group id="auto" title="Automation and connections">
        {!off.includes('launch-window') && <Row name="Schedules" now={`${schedules} ${schedules === 1 ? 'schedule' : 'schedules'}`}><SchedulesBlock /></Row>}
        {!off.includes('uplink') && <Row name="Uplink webhooks" now={`${uplinks} ${uplinks === 1 ? 'uplink' : 'uplinks'}`}><UplinkPanel /></Row>}
        {!off.includes('relay') && <Row name="Relay: Slack, Telegram, GitHub, Linear" now="chat in and out"><RelayPanel /></Row>}
        {!off.includes('docking') && <Row name={DOCKING_ROW.row} now={`${docked} docked`}><DockingPanel /></Row>}
        <Row name="Start again after a restart" now={startup}><StartupBlock /></Row>
      </Group>
      <Group id="knowledge" title="Knowledge">
        <Row name="Switch and repositories" now={know}><KnowledgeBlock /></Row>
        <Row name="Semantic search" now="see Edit"><SemanticBlock /></Row>
      </Group>
      <Group id="security" title="Security">
        <Row name="Login, sessions, API keys, second factor" now="see Edit"><AccountBlock /></Row>
        <Row name="Room keys" now={keys}><RoomKeysBlock /></Row>
        <Row name="Phone approvals" now="see Edit"><PhoneApprovals /></Row>
        <Row name="Hold all agents" now="one key"><AllStopBlock /></Row>
      </Group>
      <Group id="system" title="System and update">
        <Row name="Version and update check" now={version === '' ? null : `${version}`}><VersionCheckBlock /></Row>
        <Row name="Update by itself" now={auto}><AutoUpdateBlock /></Row>
        <Row name="Reload after an update" now="on request"><ReloadBlock /></Row>
        <Row name="Runtime settings" now={runtime}><RuntimeSettingsBlock /></Row>
        <Row name="Features" now={off.length === 0 ? 'all on' : `${off.length} switched off`}><FeaturesBlock /></Row>
      </Group>
    </section>
    </GroupContext.Provider>
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
  flight: { title: 'Staff FLIGHT', detail: 'FLIGHT is created at the first start. It is staffed once it is up and ready: answer a startup question, or sign in, in its terminal if it asks.' },
  brief: { title: 'Brief FLIGHT', detail: 'Type what you want done in the box under the room. The answer shows in FLIGHT\u2019s console.' },
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
  const activity = useStore((s) => s.activity);
  const phone = usePhone();
  /** null: as it comes (a phone shows one line once FLIGHT is staffed, so the console is not pushed below the fold); a press of the key decides. */
  const [asked, setAsked] = useState<boolean | null>(null);
  if (!showCommissioning(list, current)) return null;
  const boss = list.find((a) => a.boss);
  const briefed = boss !== undefined && activity.some((m) => m.from === 'user' && m.to === boss.name);
  const steps = commissioningSteps(list, propellant, livery, current, briefed);
  const open = asked ?? !(phone && steps[0]?.done === true);
  const action: Record<Step['id'], ReactElement | null> = {
    flight: boss === undefined ? null : (
      <button type="button" className="btn" onClick={() => openConsole(boss.name)}>
        Open FLIGHT
      </button>
    ),
    brief: (
      <button
        type="button"
        className="btn"
        onClick={() => {
          // the box is in the room on a desk and at the foot of the loop on a phone (its field has the class `brief-input`)
          (phone ? showLoop : showRoom)();
          requestAnimationFrame(() => document.querySelector<HTMLElement>('.brief-input')?.focus());
        }}
      >
        Open the box
      </button>
    ),
    propellant: (
      <button type="button" className="btn" aria-label="Flight Rules, to set the Propellant limit" onClick={showRules}>
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
        <a className="btn" data-kind="quiet" href={GLOSSARY_URL} target="_blank" rel="noreferrer noopener">
          What do these words mean?
        </a>
        {phone && (
          <button type="button" className="btn" data-kind="quiet" aria-expanded={open} onClick={() => setAsked(!open)}>
            {open ? 'Hide the steps' : 'Show the steps'}
          </button>
        )}
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
      <ol className="commission-steps" hidden={!open}>
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
                  <summary className="btn" data-kind="quiet">
                    Show the note
                  </summary>
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
      <p className="commission-extra" hidden={!open}>
        <a className="btn" data-kind="quiet" href={DOCS_URL} target="_blank" rel="noopener noreferrer">
          Read the docs
        </a>
      </p>
      <p className="hint commission-extra" hidden={!open}>Away from this tab a lot? Flight Rules can turn on notifications for messages to you, T-minus polls and Relief requests.</p>
    </section>
  );
}
