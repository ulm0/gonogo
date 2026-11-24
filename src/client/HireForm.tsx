import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactElement, ReactNode } from 'react';
import { CLEAN_ROOM_FLAVORS, EFFORTS, KEY_SUGGESTIONS, KEYS_MAX, keyWarning, MAX_AGENTS, providerInfo, ROLE_MAX_CHARS, takesCleanRoom, takesEffort, takesPermissions } from '../shared/protocol.js';
import type { AgentView, CleanRoomFlavors, EngineCheck, PermissionMode, PhoneMode, Provider } from '../shared/protocol.js';
import { POSITIONS, positionById } from '../shared/positions.js';
import type { Position } from '../shared/positions.js';
import * as api from './api.js';
import { PermissionsEditor } from './PermissionsEditor.js';
import { effectiveEffort, effectiveModel as startModel } from '../shared/details.js';
import { FLAVOR_TEXT, modelNames, modelNote, useEngineModels, useModelDefaults } from './models.js';
import { ModelListStatus } from './EngineModelList.js';
import { hasServer, mergeServer } from './registry.js';
import { RegistryPicker } from './RegistryPicker.js';
import {
  BOSS_POSITION,
  callOf,
  chooseCustom,
  chooseEngine,
  chooseEngineAgain,
  withRoomDefaults,
  choosePosition,
  editRequest,
  engineHint,
  engineNote,
  engineOptions,
  FIELDS,
  hireRequest,
  differsFromDefault,
  initialValues,
  needsBypassConfirm,
  positionShort,
  payloadRows,
  positionTag,
  submitLabel,
  validate,
} from './form.js';
import type { EngineNote, Field, PayloadRow, Problems, Values } from './form.js';
import type { GlobalMcpView, PayloadDefaults } from '../shared/protocol.js';
import { legendOf } from './loop.js';
import { store, useStore } from './store.js';
import { copyText } from './uplink.js';
import type { ClientState } from './store.js';
import './forms.css';

const MODES: ReadonlyArray<{ value: PermissionMode; label: string; hint: string }> = [
  { value: 'default', label: 'ASK', hint: 'Asks you for a go before a tool runs' },
  { value: 'acceptEdits', label: 'ACCEPT EDITS', hint: 'Edits files without asking' },
  { value: 'auto', label: 'AUTO', hint: 'Claude decides which tool calls are safe to run without asking and asks about the rest' },
  { value: 'bypassPermissions', label: 'BYPASS', hint: 'Runs every tool without asking' },
];
const SEED_NOTE =
  'Folders added here are trusted automatically: repository hooks and settings run with your credential. Add only repositories you trust.';
const ALL_TOUCHED: Partial<Record<Field, boolean>> = { name: true, role: true, dir: true, mode: true, confirmBypass: true, command: true, 'payload.mcpServers': true, 'payload.skills': true, model: true, keys: true };
const SERVERS_EXAMPLE = '{"files": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]}}';

type Target = NonNullable<ClientState['form']>;

function closeForm(): void {
  store.setState((s) => (s.form === null ? s : { ...s, form: null }));
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** What a control points `aria-describedby` at: its hint and its error, when they are on screen. */
const describedBy = (id: string, hint: boolean, error: boolean): string | undefined =>
  [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;

function Control({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="field" data-invalid={error !== undefined ? '' : undefined}>
      <label htmlFor={id}>{label}</label>
      {children}
      {error !== undefined && (
        <p className="error" id={`${id}-error`}>
          {error}
        </p>
      )}
      {hint !== undefined && (
        <p className="hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
    </div>
  );
}

function PositionTile({
  position,
  picked,
  seated,
  n,
  onPick,
}: {
  position: Position;
  picked: boolean;
  seated: boolean;
  n: number;
  onPick(id: string): void;
}): ReactElement {
  const boss = position.id === BOSS_POSITION;
  const tag = positionTag(position, picked, seated);
  return (
    <button
      type="button"
      className="tile staff-pos"
      data-kind={boss ? 'stopped' : picked ? 'working' : seated ? undefined : 'open'}
      aria-pressed={boss ? undefined : picked}
      aria-label={`${position.callSign}, ${position.title}, ${tag.toLowerCase()}`}
      disabled={boss}
      onClick={() => onPick(position.id)}
    >
      <span className="staff-tile-head">
        <span className="led" data-on={picked ? 'true' : undefined} aria-hidden="true" />
        <span className="tile-legend">{position.callSign}</span>
        <span className="staff-tile-num" aria-hidden="true">
          {String(n).padStart(2, '0')}
        </span>
      </span>
      <span className="tile-sub staff-pos-short">
        {positionShort(position.summary)}
      </span>
      <span className="tile-state staff-pos-tag">{tag}</span>
    </button>
  );
}

/** Pad Check under the engine select: whether its program is there and, when it is not, the vendor's install command to copy. gonogo never runs it. */
function EngineNoteView({ note, id }: { note: EngineNote; id: string }): ReactElement {
  const [copied, setCopied] = useState<boolean | null>(null);
  const field = useRef<HTMLInputElement | null>(null);
  const install = note.install;
  const copy = (): void => {
    if (install === null) return;
    // Over plain http from another machine the browser has no clipboard: the command is selected in its field, to copy by hand.
    void copyText(install).then((ok) => {
      setCopied(ok);
      if (!ok) field.current?.select();
    });
  };
  return (
    <div className="staff-engine-note">
      <p className="staff-engine-state" id={id} role="status">
        <span className="led" data-on={note.found ? 'true' : undefined} aria-hidden="true" />
        {note.text}
      </p>
      {install !== null && (
        <div className="staff-install">
          <label htmlFor={`${id}-cmd`} className="label">
            Install command
          </label>
          <input ref={field} id={`${id}-cmd`} className="input" type="text" readOnly value={install} spellCheck={false} onFocus={(event) => event.currentTarget.select()} />
          <button type="button" className="btn" onClick={copy}>
            {copied === null ? 'Copy' : copied ? 'Copied' : 'Not copied'}
          </button>
        </div>
      )}
      {!note.found && (
        <p className="hint">
          {install === null ? 'No install command was checked for it. ' : 'The vendor documents it here: '}
          <a href={note.docs} target="_blank" rel="noreferrer">
            install page
          </a>
          . gonogo never installs an agent CLI.
        </p>
      )}
    </div>
  );
}

function RoomFull(): ReactElement {
  return (
    <section className="staff-full module" aria-labelledby="staff-full-title">
      <h2 id="staff-full-title" className="disp">
        <span className="led" data-on="true" aria-hidden="true" />
        ROOM FULL
      </h2>
      <p>All {MAX_AGENTS} consoles are staffed. Remove one to staff another.</p>
    </section>
  );
}

function Page({ title, count, children }: { title: string; count: number | null; children: ReactNode }): ReactElement {
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement | null>(null);
  // The page replaces the room: the keyboard starts at its title, not on a button that is gone.
  useEffect(() => heading.current?.focus(), []);
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) closeForm();
  };
  return (
    <main className="staff" aria-labelledby={titleId} onKeyDown={onKeyDown}>
      <header className="staff-head">
        <h1 id={titleId} ref={heading} tabIndex={-1} className="disp staff-title">
          {title}
        </h1>
        {count !== null && (
          <p className="staff-count">
            <span className="lcd staff-lcd">
              <span className="lcd-num">{count}</span>
            </span>{' '}
            of {MAX_AGENTS} consoles staffed
          </p>
        )}
        <button type="button" className="btn" data-kind="quiet" onClick={closeForm}>
          Cancel
        </button>
      </header>
      {children}
    </main>
  );
}

function Staff({ form }: { form: Target }): ReactElement {
  const [roomDefaults, setRoomDefaults] = useState<PayloadDefaults | null>(null);
  const [globalServers, setGlobalServers] = useState<GlobalMcpView | null>(null);
  useEffect(() => {
    let live = true;
    api.payloadDefaults().then((found) => live && setRoomDefaults(found), () => undefined);
    api.globalMcp().then((found) => live && setGlobalServers(found), () => undefined);
    return () => {
      live = false;
    };
  }, []);
  const id = useId();
  const agents = useStore((s) => s.agents);
  const info = useStore((s) => s.info);
  const editing = form.mode === 'edit';
  const current = form.mode === 'edit' && Object.hasOwn(agents, form.name) ? agents[form.name] : null;
  const lastSeen = useRef<AgentView | null>(null);
  if (current !== null) lastSeen.current = current;

  const [values, setValues] = useState<Values>(() => initialValues(form, current, agents, info?.cwd ?? ''));
  // what the form opened with: an edit that picks the engine back gets its settings back
  const [opened] = useState<Values>(values);
  const [touched, setTouched] = useState<Partial<Record<Field, boolean>>>({});
  const [busy, setBusy] = useState(false);
  const [topError, setTopError] = useState<string | null>(null);
  const [serverProblems, setServerProblems] = useState<Problems>({});
  const [attempts, setAttempts] = useState(0);
  const [foldOpen, setFoldOpen] = useState(() => values.servers !== '' || values.skills !== '');
  const [keysOpen, setKeysOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(() => form.mode === 'edit' && differsFromDefault(values, Object.keys(current?.keys ?? {}).length));
  const [checks, setChecks] = useState<EngineCheck[]>([]);
  const roomModels = useModelDefaults();
  const engineModels = useEngineModels(values.provider);
  const [flavors, setFlavors] = useState<CleanRoomFlavors | null>(null);
  useEffect(() => {
    let live = true;
    api.cleanRoomFlavors().then((found) => live && setFlavors(found), () => undefined);
    return () => {
      live = false;
    };
  }, []);
  // The room's default engine preselects a new hire, once the defaults are known and only while the form is still as it opened.
  const preselected = useRef(false);
  useEffect(() => {
    if (preselected.current || form.mode !== 'hire' || roomModels === null) return;
    preselected.current = true;
    setValues((v) => withRoomDefaults(v, roomModels));
  }, [roomModels, form.mode]);
  const formRef = useRef<HTMLFormElement | null>(null);
  const bypassTile = useRef<HTMLButtonElement | null>(null);
  const confirmBox = useRef<HTMLInputElement | null>(null);

  // A rename removes the old name before the answer of the request arrives: keep the form while it is waiting for it.
  const original = current ?? (busy ? lastSeen.current : null);
  const nameLocked = original !== null && original.state !== 'stopped';
  const problems = validate(values, agents, original, nameLocked);
  const valid = Object.keys(problems).length === 0;
  const confirming = needsBypassConfirm(values, original);

  // The fieldset is disabled while the request runs, which drops the focus to the page: a refused request puts it back on the field it names, else on the alert.
  useEffect(() => {
    if (busy || topError === null) return;
    const el = formRef.current;
    (el?.querySelector<HTMLElement>('[aria-invalid="true"]') ?? el?.querySelector<HTMLElement>('.staff-alert'))?.focus();
  }, [busy, topError]);

  // A press on the big button while the form is invalid shows every problem and lands on the first.
  useEffect(() => {
    if (attempts > 0) formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [attempts]);

  // Pad Check: where each engine's program is, asked once when a hire opens. Without an answer the note falls back to what the server saw at start.
  useEffect(() => {
    if (editing) return;
    let live = true;
    api.engines().then(
      (list) => live && setChecks(list),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [editing]);

  // BYPASS opens the confirmation: the keyboard goes to its checkbox.
  useEffect(() => {
    if (confirming) confirmBox.current?.focus();
  }, [confirming]);

  if (editing && original === null) {
    return (
      <Page title="NO SUCH CONSOLE" count={null}>
        <section className="staff-full module" role="alert">
          <p>{form.mode === 'edit' ? form.name : ''} no longer exists.</p>
        </section>
      </Page>
    );
  }
  const count = Object.keys(agents).length;
  if (!editing && count >= MAX_AGENTS) {
    return (
      <Page title="STAFF A CONSOLE" count={count}>
        <RoomFull />
      </Page>
    );
  }

  const shown = (field: Field): string | undefined => serverProblems[field] ?? (touched[field] === true ? problems[field] : undefined);
  const change = (patch: Partial<Values>, field: Field): void => {
    setValues((v) => ({ ...v, ...patch }));
    setServerProblems((p) => ({ ...p, [field]: undefined }));
  };
  const touch = (field: Field) => (): void => setTouched((t) => ({ ...t, [field]: true }));
  const custom = values.provider === 'custom';
  const position = positionById(values.position);
  const noPosition = !custom && position === null;
  const call = callOf(values);
  const seated = new Set<string>();
  for (const agent of Object.values(agents)) if (agent.position !== null) seated.add(agent.position);

  const pick = (apply: (v: Values) => Values): void => {
    setValues(apply);
    setServerProblems((p) => ({ ...p, position: undefined, name: undefined, role: undefined, command: undefined }));
  };
  const backFromBypass = (): void => {
    const was = original?.mode ?? 'default';
    change({ mode: was === 'bypassPermissions' ? 'default' : was, confirm: false }, 'mode');
    bypassTile.current?.focus();
  };

  async function submit(restartAsked: boolean): Promise<void> {
    let restart = restartAsked;
    if (busy) return;
    if (!valid) {
      setTouched(ALL_TOUCHED);
      setAttempts((n) => n + 1);
      if (problems['payload.mcpServers'] !== undefined || problems['payload.skills'] !== undefined) setFoldOpen(true);
      if (problems.keys !== undefined) setKeysOpen(true);
      return;
    }
    setBusy(true);
    setTopError(null);
    setServerProblems({});
    try {
      let view: AgentView;
      if (original === null) {
        view = await api.hire(hireRequest(values));
      } else {
        // Only what changed: the server answers 400 to an edit with nothing in it, and a name is a rename.
        const changes = editRequest(values, original, nameLocked);
        // a switch of engine restarts the console itself: now with SAVE AND RESTART, else when its turn ends
        const switching = changes?.provider !== undefined;
        if (changes !== null && switching && restart) changes.switchNow = true;
        if (switching) restart = false;
        if (changes === null) {
          if (!restart) {
            closeForm();
            return;
          }
          view = original;
        } else view = await api.edit(original.name, changes);
      }
      if (restart) {
        try {
          await api.restart(view.name);
        } catch (e) {
          throw new Error(`Saved, but it did not restart: ${messageOf(e)}`);
        }
      }
      // After a rename the old name's removal has already moved the selection to the boss: select the new name.
      store.setState((s) => ({ ...s, form: null, selected: view.name }));
    } catch (e) {
      const field = e instanceof Error && 'field' in e ? (e as api.ApiFailure).field : undefined;
      setTopError(messageOf(e));
      if (field !== undefined && FIELDS.includes(field)) setServerProblems({ [field]: messageOf(e) });
      if (field?.startsWith('payload')) setFoldOpen(true);
      if (field === 'keys') setKeysOpen(true);
      setBusy(false);
    }
  }

  /** The engine switch that waits for the end of a turn: now (switchNow) or not at all (the engine it runs on). */
  async function switchPending(now: boolean): Promise<void> {
    if (busy || original === null) return;
    setBusy(true);
    setTopError(null);
    try {
      await api.edit(original.name, now ? { switchNow: true } : { provider: original.provider });
      store.setState((s) => ({ ...s, form: null, selected: original.name }));
    } catch (e) {
      setTopError(messageOf(e));
      setBusy(false);
    }
  }

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    void submit(false);
  };

  const nameError = shown('name');
  const roleError = shown('role');
  const dirError = shown('dir');
  const commandError = shown('command');
  const confirmError = shown('confirmBypass');
  const serversError = shown('payload.mcpServers');
  const skillsError = shown('payload.skills');
  const cleanError = shown('cleanRoom');
  const rulesError = shown('permissions');
  const [roomDeny, setRoomDeny] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    api.permissionDefaults().then((found) => live && setRoomDeny(found.permissions.deny ?? []), () => undefined);
    return () => {
      live = false;
    };
  }, []);
  // the box is shown when the room starts the consoles that were running again
  const [startsAgain, setStartsAgain] = useState(false);
  useEffect(() => {
    let live = true;
    api.startupSettings().then((found) => live && setStartsAgain(found.policy === 'running'), () => undefined);
    return () => {
      live = false;
    };
  }, []);
  const remoteError = shown('remoteControl');
  // offered only when Flight Rules chose a phone path that uses the Claude app (or the agent has it on already)
  const [phoneMode, setPhoneMode] = useState<PhoneMode>('off');
  useEffect(() => {
    let live = true;
    api.getRelay().then((view) => live && setPhoneMode(view.phone), () => undefined);
    return () => {
      live = false;
    };
  }, []);
  const worktreeError = shown('worktree');
  const modelError = shown('model');
  const keysError = shown('keys');
  const modelHints = providerInfo(values.provider).model === null ? null : modelNames(values.provider, engineModels);
  const storedKeys = Object.keys(original?.keys ?? {}).sort();
  const setRows = (keys: Values['keys']): void => change({ keys }, 'keys');
  const toggleRemoved = (name: string): void =>
    change({ keysRemoved: values.keysRemoved.includes(name) ? values.keysRemoved.filter((n) => n !== name) : [...values.keysRemoved, name] }, 'keys');
  const payloadKind = providerInfo(values.provider).payload;
  const roleLength = values.role.trim().length;
  const title = editing ? `EDIT ${legendOf(original?.name ?? '', agents)}` : 'STAFF A CONSOLE';

  const nameField = (
    <Control
      id={`${id}-name`}
      label="Name"
      hint={nameLocked ? 'Stop the console to rename it.' : 'A short name. You and the other agents reach this console by it: lowercase letters, digits and hyphens.'}
      error={nameError}
    >
      <input
        id={`${id}-name`}
        className="input"
        type="text"
        value={values.name}
        readOnly={nameLocked}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        aria-invalid={nameError !== undefined}
        aria-describedby={describedBy(`${id}-name`, true, nameError !== undefined)}
        onChange={(event) => change({ name: event.target.value }, 'name')}
        onBlur={touch('name')}
      />
    </Control>
  );
  const dirField = (
    <Control
      id={`${id}-dir`}
      label="Working directory"
      hint={
        custom ? (
          'The command is saved in plain text. Keep secrets out of it: set them as keys below.'
        ) : (
          <>
            The project folder this agent works in, on the machine where gonogo runs. It starts as the room’s Project folder.
            {info?.seed === true && <span className="staff-block">{SEED_NOTE}</span>}
          </>
        )
      }
      error={dirError}
    >
      <input
        id={`${id}-dir`}
        className="input"
        type="text"
        value={values.dir}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        aria-invalid={dirError !== undefined}
        aria-describedby={describedBy(`${id}-dir`, true, dirError !== undefined)}
        onChange={(event) => change({ dir: event.target.value }, 'dir')}
        onBlur={touch('dir')}
      />
    </Control>
  );
  const commandField = custom && (
    <Control
      id={`${id}-command`}
      label="Command"
      hint={'Words split on spaces, or a JSON array when an argument has spaces. No shell: pipes and quotes need the array form, for example ["sh","-c","make watch"].'}
      error={commandError}
    >
      <input
        id={`${id}-command`}
        className="input"
        type="text"
        value={values.command}
        placeholder={'htop   or   ["node","server.js"]'}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        aria-invalid={commandError !== undefined}
        aria-describedby={describedBy(`${id}-command`, true, commandError !== undefined)}
        onChange={(event) => change({ command: event.target.value }, 'command')}
        onBlur={touch('command')}
      />
    </Control>
  );
  const engineField = !custom && (
    <>
      <Control id={`${id}-engine`} label="Engine" hint={engineHint(values.provider)}>
        <select
          id={`${id}-engine`}
          className="input staff-engine"
          value={values.provider}
          aria-describedby={`${id}-engine-hint ${id}-engine-note`}
          onChange={(event) => pick((v) => (editing ? chooseEngineAgain(v, event.target.value as Provider, opened) : chooseEngine(v, event.target.value as Provider)))}
        >
          {engineOptions(info?.installed ?? []).map((option) => (
            <option key={option.provider} value={option.provider}>
              {option.text}
            </option>
          ))}
        </select>
      </Control>
      <EngineNoteView key={values.provider} id={`${id}-engine-note`} note={engineNote(values.provider, info?.installed ?? [], checks.find((c) => c.provider === values.provider))} />
    </>
  );
  const modelField = modelHints !== null && (
    <Control
      id={`${id}-model`}
      label="Model"
      hint={
        <>
          {`Passed to ${providerInfo(values.provider).label} as --model. ${modelNote(values.model, roomModels, values.provider, providerInfo(values.provider).label, values.position === '' ? null : values.position)}`} <ModelListStatus provider={values.provider} state={engineModels} />
        </>
      }
      error={modelError}
    >
      <input
        id={`${id}-model`}
        className="input"
        type="text"
        list={`${id}-models`}
        value={values.model}
        placeholder={startModel({ model: null, provider: values.provider, position: values.position === '' ? null : values.position }, roomModels)?.name ?? 'its default'}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        aria-invalid={modelError !== undefined}
        aria-describedby={describedBy(`${id}-model`, true, modelError !== undefined)}
        onChange={(event) => change({ model: event.target.value }, 'model')}
        onBlur={touch('model')}
      />
      <datalist id={`${id}-models`}>
        {modelHints.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
    </Control>
  );
  const roomEffort = effectiveEffort({ provider: values.provider, effort: null }, roomModels);
  // how each engine takes the level: Claude Code's flag, pi's thinking level, opencode's variant of its model
  const EFFORT_FLAG: Partial<Record<Provider, string>> = { claude: '--effort', pi: '--thinking', opencode: 'the variant of its model (only with a model set)' };
  const effortField = takesEffort(values.provider) && (
    <Control id={`${id}-effort`} label="Effort" hint={`Passed to ${providerInfo(values.provider).label} as ${EFFORT_FLAG[values.provider] ?? '--effort'}. ${roomEffort === null ? 'Empty uses its own.' : `Empty: the room's default ${roomEffort.level} applies.`} A setting changed inside the console only changes that session.`} error={undefined}>
      <select id={`${id}-effort`} className="input" value={values.effort} onChange={(event) => change({ effort: event.target.value }, 'effort')}>
        <option value="">{roomEffort === null ? 'its own' : `room default (${roomEffort.level})`}</option>
        {/* a stored level this page does not know (a newer server) stays selected instead of falling back to blank, which a save would clear */}
        {values.effort !== '' && !(EFFORTS as readonly string[]).includes(values.effort) && <option value={values.effort}>{values.effort}</option>}
        {EFFORTS.map((level) => (
          <option key={level} value={level}>
            {level}
          </option>
        ))}
      </select>
    </Control>
  );
  const roleField = !custom && (
    <Control
      id={`${id}-role`}
      label="Role"
      hint={`${position !== null && !editing ? `The default for ${position.callSign}. Yours to rewrite. ` : ''}${roleLength} / ${ROLE_MAX_CHARS}`}
      error={roleError}
    >
      <textarea
        id={`${id}-role`}
        className="textarea staff-role"
        value={values.role}
        aria-invalid={roleError !== undefined}
        aria-describedby={describedBy(`${id}-role`, true, roleError !== undefined)}
        onChange={(event) => change({ role: event.target.value }, 'role')}
        onBlur={touch('role')}
      />
    </Control>
  );
  const modes = providerInfo(values.provider).modes && (
    <fieldset className="staff-modes">
      <legend className="label">{editing ? 'Permissions' : 'C · Permissions'}</legend>
      <div className="staff-mode-tiles">
        {MODES.map((mode) => {
          const pressed = values.mode === mode.value;
          const danger = mode.value === 'bypassPermissions';
          return (
            <button
              key={mode.value}
              ref={danger ? bypassTile : undefined}
              type="button"
              className="tile staff-mode"
              data-kind={pressed && !danger ? 'working' : undefined}
              data-danger={danger ? '' : undefined}
              aria-pressed={pressed}
              onClick={() => change({ mode: mode.value, confirm: false }, 'mode')}
            >
              <span className="staff-tile-head">
                <span className="led" data-on={pressed ? 'true' : undefined} aria-hidden="true" />
                <span className="tile-legend">{mode.label}</span>
              </span>
              <span className="tile-sub staff-mode-hint">{mode.hint}</span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
  const confirmPanel = confirming && (
    <section className="staff-confirm flood" data-tone="nogo" role="alertdialog" aria-labelledby={`${id}-bypass`} aria-describedby={`${id}-bypass-text`}>
      <h2 id={`${id}-bypass`} className="disp">
        <span className="led" data-on="true" aria-hidden="true" />
        BYPASS PERMISSIONS?
      </h2>
      <p id={`${id}-bypass-text`}>
        {call === 'A CONSOLE' ? 'This console' : call} will run every tool without asking: shell commands, file edits, the network. It runs as you, with your {providerInfo(values.provider).label} login.
      </p>
      <div className="staff-check">
        <input
          id={`${id}-ok`}
          ref={confirmBox}
          type="checkbox" className="check"
          checked={values.confirm}
          aria-invalid={confirmError !== undefined}
          aria-describedby={confirmError !== undefined ? `${id}-ok-error` : undefined}
          onChange={(event) => change({ confirm: event.target.checked }, 'confirmBypass')}
          onBlur={touch('confirmBypass')}
        />
        <label htmlFor={`${id}-ok`}>I understand. Let it run without asking.</label>
      </div>
      {confirmError !== undefined && (
        <p className="error" id={`${id}-ok-error`}>
          {confirmError}
        </p>
      )}
      <button type="button" className="btn" data-kind="quiet" onClick={backFromBypass}>
        Back
      </button>
    </section>
  );
  const sandboxSelect = values.cleanRoom && (
    <Control id={`${id}-sandbox`} label="Sandbox" hint={`How the container is walled off. Docker is the default wall; gVisor and a microVM need their runtime installed in Docker (docker info lists it). The room's default is ${FLAVOR_TEXT[roomModels?.sandbox ?? 'docker']}. gVisor with gonogo's container network is not verified yet. The microVM cannot start yet: it needs a network mode gonogo does not have.`}>
      <select id={`${id}-sandbox`} className="input" value={values.sandbox} onChange={(event) => change({ sandbox: event.target.value as Values['sandbox'] }, 'cleanRoom')}>
        <option value="">Room default ({FLAVOR_TEXT[roomModels?.sandbox ?? 'docker']})</option>
        {CLEAN_ROOM_FLAVORS.map((flavor) => {
          const missing = flavors !== null && !flavors.available[flavor];
          return (
            <option key={flavor} value={flavor} disabled={missing && values.sandbox !== flavor}>
              {FLAVOR_TEXT[flavor]}
              {missing ? ' (not installed)' : ''}
            </option>
          );
        })}
      </select>
    </Control>
  );
  const cleanRoomBox = takesCleanRoom(values.provider) && (
    <div className="staff-clean" data-invalid={cleanError !== undefined ? '' : undefined}>
      <div className="staff-check">
        <input
          id={`${id}-clean`}
          type="checkbox" className="check"
          checked={values.cleanRoom}
          aria-invalid={cleanError !== undefined}
          aria-describedby={describedBy(`${id}-clean`, true, cleanError !== undefined)}
          onChange={(event) => change({ cleanRoom: event.target.checked }, 'cleanRoom')}
        />
        <label htmlFor={`${id}-clean`}>Clean Room</label>
      </div>
      {cleanError !== undefined && (
        <p className="error" id={`${id}-clean-error`}>
          {cleanError}
        </p>
      )}
      {values.cleanRoom && (
        <div className="field">
          <label htmlFor={`${id}-clean-egress`}>Anthropic API key</label>
          <select id={`${id}-clean-egress`} className="input" value={values.egress} onChange={(event) => change({ egress: event.target.value as Values['egress'] }, 'cleanRoom')}>
            <option value="">Follow the room's setting</option>
            <option value="on">Keep it out of the container (a proxy holds it)</option>
            <option value="off">Leave it in the container</option>
          </select>
        </div>
      )}
      <p className="hint" id={`${id}-clean-hint`}>
        Runs in a Docker container that holds only a copy of the project (a git worktree on the branch gonogo/{values.name === '' ? 'name' : values.name}) and this console's own files. Docker must be running and the folder must be inside a git repository. To
        take the work back, commit in the worktree and merge the branch.
      </p>
      {sandboxSelect}
    </div>
  );
  // a Clean Room has a worktree already
  const worktreeBox = !(takesCleanRoom(values.provider) && values.cleanRoom) && (
    <div className="staff-clean" data-invalid={worktreeError !== undefined ? '' : undefined}>
      <div className="staff-check">
        <input
          id={`${id}-worktree`}
          type="checkbox" className="check"
          checked={values.worktree}
          aria-invalid={worktreeError !== undefined}
          aria-describedby={describedBy(`${id}-worktree`, true, worktreeError !== undefined)}
          onChange={(event) => change({ worktree: event.target.checked }, 'worktree')}
        />
        <label htmlFor={`${id}-worktree`}>Own git worktree</label>
      </div>
      {worktreeError !== undefined && (
        <p className="error" id={`${id}-worktree-error`}>
          {worktreeError}
        </p>
      )}
      <p className="hint" id={`${id}-worktree-hint`}>
        Starts in its own copy of the project on the branch gonogo/{values.name === '' ? 'name' : values.name}, so it does not step on other consoles. The folder must be inside a git repository. Commit in the worktree, then merge the branch.
      </p>
    </div>
  );
  const autostartBox = (startsAgain || !values.autostart) && (
    <div className="staff-clean">
      <div className="staff-check">
        <input id={`${id}-autostart`} type="checkbox" className="check" checked={values.autostart} onChange={(event) => change({ autostart: event.target.checked }, 'autostart')} aria-describedby={`${id}-autostart-hint`} />
        <label htmlFor={`${id}-autostart`}>Start with gonogo</label>
      </div>
      <p className="hint" id={`${id}-autostart-hint`}>
        After a restart of gonogo, start this console again if it was running (Flight Rules sets the policy). Unticked: it stays stopped.
      </p>
    </div>
  );
  // a Clean Room has no git of the Director's inside: nothing to mark
  const coauthorBox = !values.cleanRoom && (
    <div className="staff-clean">
      <div className="staff-check">
        <input id={`${id}-coauthor`} type="checkbox" className="check" checked={values.coauthor} onChange={(event) => change({ coauthor: event.target.checked }, 'coauthor')} aria-describedby={`${id}-coauthor-hint`} />
        <label htmlFor={`${id}-coauthor`}>Co-author line in its commits</label>
      </div>
      <p className="hint" id={`${id}-coauthor-hint`}>
        Its commits end with a Co-Authored-By line naming this console (gonogo), so you can tell its work in the history. Flight Rules turns it off for the room. Applies at its next start.
      </p>
    </div>
  );
  const remoteBox = values.provider === 'claude' && !values.cleanRoom && (values.remoteControl || phoneMode === 'remote-control' || phoneMode === 'both') && (
    <div className="staff-clean" data-invalid={remoteError !== undefined ? '' : undefined}>
      <div className="staff-check">
        <input
          id={`${id}-remote`}
          type="checkbox" className="check"
          checked={values.remoteControl}
          aria-invalid={remoteError !== undefined}
          aria-describedby={describedBy(`${id}-remote`, true, remoteError !== undefined)}
          onChange={(event) => change({ remoteControl: event.target.checked }, 'remoteControl')}
        />
        <label htmlFor={`${id}-remote`}>Approve in the Claude app</label>
      </div>
      {remoteError !== undefined && (
        <p className="error" id={`${id}-remote-error`}>
          {remoteError}
        </p>
      )}
      <p className="hint" id={`${id}-remote-hint`}>
        Starts Claude Code with --remote-control, so its session shows in the Claude app as gonogo-{values.name === '' ? 'name' : values.name} and you can approve there. Needs a claude.ai login on this machine: it does not work with an API key or a token. gonogo does not see what you answer in the app.
      </p>
    </div>
  );
  // Claude Code, pi and opencode take rules gonogo can set: the others say so
  const rulesFold = (
    <details className="staff-fold">
      <summary className="label">TOOL PERMISSIONS</summary>
      {takesPermissions(values.provider) ? (
        <PermissionsEditor id={`${id}-rules`} value={values.rules} onChange={(next) => change({ rules: next }, 'permissions')} error={rulesError} inheritedDeny={roomDeny} />
      ) : (
        <p className="hint">Not supported for {providerInfo(values.provider).label}: only Claude Code, pi and opencode have rules gonogo can set.</p>
      )}
    </details>
  );
  const rows = payloadRows(roomDefaults, values, globalServers);
  const toggle = (row: PayloadRow, on: boolean): void => {
    const key = row.kind === 'server' ? 'offServers' : 'offSkills';
    const rest = values[key].filter((name) => name !== row.name);
    change({ [key]: on ? rest : [...rest, row.name] }, 'payload.mcpServers');
  };
  const roomPayload = rows.length > 0 && (
    <div className="staff-room" role="group" aria-label="In this console's Payload">
      <p className="hint">
        What this console starts with, and where each item comes from. The room&apos;s defaults (Flight Rules) are in it unless you switch one off here; an item of this console&apos;s own with the same name replaces the room&apos;s. This console wins.
      </p>
      <ul className="staff-room-list">
        {rows.map((row) => (
          <li key={`${row.from}-${row.kind}-${row.name}`}>
            {row.from !== 'agent' ? (
              <label>
                <input type="checkbox" role="switch" className="switch" checked={row.on} disabled={!row.canSwitch} onChange={(event) => toggle(row, event.target.checked)} /> {row.name}
              </label>
            ) : (
              <span>{row.name}</span>
            )}{' '}
            <span className="chip" data-tone="quiet">
              {row.from === 'global' ? 'GLOBAL' : row.from === 'room' ? 'ROOM' : 'THIS CONSOLE'} · {row.kind}
            </span>
            {row.note !== '' && <span className="hint"> {row.note}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
  const payloadFold = payloadKind !== null && (
    <details className="staff-fold" open={foldOpen} onToggle={(event) => setFoldOpen(event.currentTarget.open)}>
      <summary className="label">PAYLOAD</summary>
      <div className="staff-fold-body">
        {takesCleanRoom(values.provider) && values.cleanRoom && roomDefaults !== null && (roomDefaults.mcpServers.length > 0 || roomDefaults.skills.length > 0) && <p className="hint">A Clean Room console gets none of the room's Payload defaults: their env and headers hold keys. Only what is written below.</p>}
        {roomPayload}
        <Control
          id={`${id}-servers`}
          label="MCP servers"
          hint="One JSON object: a server name, then its command, args and env, or type http or sse with url and headers. The values are saved in plain text, keys and tokens included. Their tools are not allowed in advance: the permission mode decides."
          error={serversError}
        >
          <textarea
            id={`${id}-servers`}
            className="textarea staff-servers"
            value={values.servers}
            placeholder={SERVERS_EXAMPLE}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-invalid={serversError !== undefined}
            aria-describedby={describedBy(`${id}-servers`, true, serversError !== undefined)}
            onChange={(event) => change({ servers: event.target.value }, 'payload.mcpServers')}
            onBlur={touch('payload.mcpServers')}
          />
        </Control>
        <RegistryPicker
          payload={payloadKind}
          has={(serverId) => hasServer(values.servers, serverId)}
          onAdd={(entry) => {
            const merged = mergeServer(values.servers, entry);
            if (merged.ok) change({ servers: merged.text }, 'payload.mcpServers');
            else setServerProblems((p) => ({ ...p, 'payload.mcpServers': 'The servers box is not a JSON object: fix it, then add from the list.' }));
          }}
        />
        {payloadKind === 'all' && (
          <Control
            id={`${id}-skills`}
            label="Skill folders"
            hint={`One absolute folder per line, each with a SKILL.md. ${providerInfo(values.provider).label} loads them for this console only.`}
            error={skillsError}
          >
            <textarea
              id={`${id}-skills`}
              className="textarea staff-skills"
              value={values.skills}
              placeholder="/Users/you/skills/my-skill"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              aria-invalid={skillsError !== undefined}
              aria-describedby={describedBy(`${id}-skills`, true, skillsError !== undefined)}
              onChange={(event) => change({ skills: event.target.value }, 'payload.skills')}
              onBlur={touch('payload.skills')}
            />
          </Control>
        )}
      </div>
    </details>
  );
  const keysFold = (
    <details className="staff-fold" open={keysOpen} onToggle={(event) => setKeysOpen(event.currentTarget.open)}>
      <summary className="label">CLEARANCE · KEYS{storedKeys.length > 0 ? ` · ${storedKeys.length} SET` : ''}</summary>
      <div className="staff-fold-body">
        <p className="hint" id={`${id}-keys-hint`}>
          Environment variables for this console only, such as an API key. They are saved on the gonogo machine (keys.json, mode 0600), given only to this console's process and never shown again: a saved key says SET. A name typed again
          replaces its value; the console picks changes up at its next start. At most {KEYS_MAX}.
        </p>
        {storedKeys.length > 0 && (
          <ul className="staff-keys" aria-label="Keys that are set">
            {storedKeys.map((name) => {
              const removed = values.keysRemoved.includes(name);
              return (
                <li key={name}>
                  <code>{name}</code>
                  <span className="chip" data-tone={removed ? 'amber' : 'go'}>
                    {removed ? 'REMOVED ON SAVE' : 'SET'}
                  </span>
                  <button type="button" className="btn" data-kind="quiet" aria-pressed={removed} aria-label={`${removed ? 'Keep' : 'Remove'} ${name}`} onClick={() => toggleRemoved(name)}>
                    {removed ? 'Keep' : 'Remove'}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {values.keys.map((row, i) => (
          <div className="staff-key-row" key={i}>
            <div className="field">
              <label htmlFor={`${id}-key-name-${i}`}>Key name</label>
              <input
                id={`${id}-key-name-${i}`}
                className="input"
                type="text"
                list={`${id}-key-names`}
                value={row.name}
                placeholder="OPENAI_API_KEY"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                aria-invalid={keysError !== undefined}
                aria-describedby={`${id}-keys-hint`}
                onChange={(event) => setRows(values.keys.map((r, j) => (j === i ? { ...r, name: event.target.value } : r)))}
                onBlur={touch('keys')}
              />
            </div>
            <div className="field">
              <label htmlFor={`${id}-key-value-${i}`}>Value</label>
              <input
                id={`${id}-key-value-${i}`}
                className="input"
                type="password"
                value={row.value}
                autoComplete="new-password"
                spellCheck={false}
                aria-invalid={keysError !== undefined}
                aria-describedby={`${id}-keys-hint`}
                onChange={(event) => setRows(values.keys.map((r, j) => (j === i ? { ...r, value: event.target.value } : r)))}
                onBlur={touch('keys')}
              />
            </div>
            <button type="button" className="btn" data-kind="quiet" aria-label={`Drop key row ${i + 1}`} onClick={() => setRows(values.keys.filter((_, j) => j !== i))}>
              Drop
            </button>
          </div>
        ))}
        {values.keys.map((row, i) => {
          const warning = keyWarning(row.name.trim());
          return warning === null ? null : (
            <p className="hint" role="status" key={`warn-${i}`}>
              {warning}
            </p>
          );
        })}
        <datalist id={`${id}-key-names`}>
          {KEY_SUGGESTIONS.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        {keysError !== undefined && (
          <p className="error" id={`${id}-keys-error`} role="alert">
            {keysError}
          </p>
        )}
        <div>
          <button type="button" className="btn" onClick={() => setRows([...values.keys, { name: '', value: '' }])}>
            Add a key
          </button>
        </div>
      </div>
    </details>
  );
  // Up front: engine, name, folder (and the role of an agent with no position, which has none yet). The rest is optional and sits under MORE SETTINGS, which opens by itself for a problem in it, a bypass to confirm, or an agent that already has something set there.
  const roleUp = noPosition && !custom;
  const inMore: Field[] = ['role', 'model', 'effort', 'mode', 'confirmBypass', 'cleanRoom', 'worktree', 'remoteControl', 'permissions', 'payload.mcpServers', 'payload.skills', 'keys'];
  const moreShown = moreOpen || confirming || inMore.some((f) => (f !== 'role' || !roleUp) && shown(f) !== undefined);
  const more = (children: ReactElement): ReactElement => (
    <details className="staff-fold staff-more" open={moreShown} onToggle={(event) => setMoreOpen(event.currentTarget.open)}>
      <summary className="label">MORE SETTINGS · OPTIONAL</summary>
      <div className="staff-fold-body">{children}</div>
    </details>
  );
  const alert = topError !== null && (
    <p className="error staff-alert" role="alert" tabIndex={-1}>
      {topError}
    </p>
  );

  if (editing && original !== null) {
    const running = original.state !== 'stopped';
    return (
      <Page title={title} count={null}>
        <div className="staff-body">
          <form className="staff-form module" data-edit="" aria-label="Edit a console" noValidate ref={formRef} onSubmit={onSubmit}>
            <h2 className="label">A · Console</h2>
            {running && (
              <p className="staff-notice" data-lit="">
                <span className="led" data-on="true" data-blink="true" aria-hidden="true" />
                <span>
                  {legendOf(original.name, agents)} is running. Changes apply at its next start.
                  {values.provider !== original.provider && ` Saving moves it to ${providerInfo(values.provider).label}: it restarts when its turn ends, in a new session.`}
                </span>
              </p>
            )}
            {original.pendingEngine != null && (
              <p className="staff-notice" data-lit="">
                <span>{`Switches to ${providerInfo(original.pendingEngine).label} when its turn ends; its mail waits until then.`}</span>
                <button type="button" className="btn" disabled={busy} onClick={() => void switchPending(true)}>
                  SWITCH NOW
                </button>
                <button type="button" className="btn" disabled={busy} onClick={() => void switchPending(false)}>
                  CANCEL SWITCH
                </button>
              </p>
            )}
            <fieldset className="staff-fields" disabled={busy}>
              {nameField}
              {commandField}
              {roleUp && roleField}
              {dirField}
              {engineField}
              {more(
                <>
                  {!roleUp && roleField}
                  {modelField}
                  {effortField}
                  {cleanRoomBox}
                  {worktreeBox}
                  {remoteBox}
                  {coauthorBox}
                  {autostartBox}
                  {modes}
                  {confirmPanel}
                  {payloadFold}
                  {rulesFold}
                  {keysFold}
                </>,
              )}
            </fieldset>
            {alert}
            <div className="staff-foot">
              <div className="staff-actions">
                <button type="submit" className="btn" data-size="big" data-kind={running ? undefined : 'primary'} aria-disabled={!valid || busy}>
                  {busy ? 'SAVING…' : 'SAVE'}
                </button>
                {running && (
                  <button type="button" className="btn" data-size="big" data-kind="primary" aria-disabled={!valid || busy} onClick={() => void submit(true)}>
                    SAVE AND RESTART
                  </button>
                )}
              </div>
            </div>
          </form>
        </div>
      </Page>
    );
  }

  return (
    <Page title={title} count={count}>
      <div className="staff-body">
        <section className="staff-pick module" aria-label="Position">
          <h2 className="label">A · Position</h2>
          <div className="staff-matrix-scroll">
            <div className="staff-matrix">
              {POSITIONS.map((p, i) => (
                <PositionTile
                  key={p.id}
                  position={p}
                  n={i + 1}
                  picked={!custom && values.position === p.id}
                  seated={seated.has(p.id)}
                  onPick={(positionId) => pick((v) => choosePosition(v, positionId, agents, true))}
                />
              ))}
            </div>
          </div>
          <div className="staff-wide-row">
            <button
              type="button"
              className="tile staff-wide"
              data-kind={noPosition ? 'working' : undefined}
              aria-pressed={noPosition}
              onClick={() => pick((v) => choosePosition(v, '', agents, true))}
            >
              <span className="staff-tile-head">
                <span className="led" data-on={noPosition ? 'true' : undefined} aria-hidden="true" />
                <span className="tile-legend">NO POSITION</span>
              </span>
              <span className="tile-sub">An agent with your own name and role</span>
            </button>
            <button
              type="button"
              className="tile staff-wide"
              data-kind={custom ? 'working' : undefined}
              aria-pressed={custom}
              onClick={() => pick((v) => chooseCustom(v, agents))}
            >
              <span className="staff-tile-head">
                <span className="led" data-on={custom ? 'true' : undefined} aria-hidden="true" />
                <span className="tile-legend">CUSTOM COMMAND</span>
              </span>
              <span className="tile-sub">Any program in a terminal. No hooks, no mail.</span>
            </button>
          </div>
          {custom ? (
            <p className="staff-notice">Any program in a terminal. No position, no permissions, no hooks and no mail.</p>
          ) : (
            position !== null && (
              <section className="staff-picked ink flood" data-tone="lit" aria-label="Picked position">
                <span className="led" data-on="true" aria-hidden="true" />
                <span className="disp staff-picked-name">{position.callSign}</span>
                <span className="staff-picked-title">{position.title}</span>
                <span className="staff-picked-text">{position.summary}.</span>
              </section>
            )
          )}
        </section>
        <form className="staff-form module" aria-label="Console" noValidate ref={formRef} onSubmit={onSubmit}>
          <h2 className="label">B · Console</h2>
          <p className="hint staff-lead">Pick a position or No position, name it and point it at a folder. Everything else can wait.</p>
          <fieldset className="staff-fields" disabled={busy}>
            {engineField}
            {nameField}
            {commandField}
            {roleUp && roleField}
            {dirField}
            {more(
              <>
                {!roleUp && roleField}
                {modelField}
                {effortField}
                {cleanRoomBox}
                {worktreeBox}
                {remoteBox}
                {coauthorBox}
                {modes}
                {confirmPanel}
                {payloadFold}
                {rulesFold}
                {keysFold}
              </>,
            )}
          </fieldset>
          {alert}
          <div className="staff-foot">
            <button
              type="submit"
              className="btn staff-go"
              data-size="big"
              data-kind="primary"
              data-tone={confirming && valid ? 'nogo' : undefined}
              aria-disabled={!valid || busy}
            >
              {busy ? 'STAFFING…' : submitLabel(problems, call, confirming)}
            </button>
          </div>
        </form>
      </div>
    </Page>
  );
}

/** The staffing screen: hire, edit and the custom command, a full page that replaces the room while `store.form` is set. */
export function HireForm(): ReactElement | null {
  const form = useStore((s) => s.form);
  if (form === null) return null;
  const key = form.mode === 'edit' ? `edit:${form.name}` : `hire:${form.position ?? ''}:${form.custom === true}`;
  return <Staff key={key} form={form} />;
}
