import { randomUUID } from 'node:crypto';
import { accessSync, constants as fsConstants, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCS_URL, PROTOCOL_VERSION } from '../shared/protocol.js';
import { MAX_AGENTS, providerInfo } from '../shared/protocol.js';
import type { DownlinkNotify, Hub, HubIo, InstallKind, Logger, ServerInfo, Task, TerminalHost } from '../shared/protocol.js';
import {
  CLAUDE_BIN,
  DEFAULT_HOME_DIRNAME,
  DEFAULT_HOST,
  DEFAULT_MAX_HOPS,
  DEFAULT_PORT,
  DOWNLINK_HISTORY,
  MAX_HOPS_LIMIT,
  MAX_WORKING_ENV,
  REDLINE_ENV,
  ROSTER_ROLE_CHARS,
  SHUTDOWN_MAX_MS,
  STATION_ENV,
  TRANSIENT_ERROR_CODES,
  TRANSIENT_ERROR_PREFIXES,
  createLogger,
  nullLogger,
} from './constants.js';
import type { LogLevel } from './constants.js';
import { audited, STARTUP_AUDIT, PERMISSIONS_AUDIT, BOARD_AUDIT, DOCKING_AUDIT, HUB_AUDIT, LIVERIES_AUDIT, MISSIONS_AUDIT, pollText, PRICES_AUDIT, PROPELLANT_AUDIT, RELAY_AUDIT, RELIEF_AUDIT, REVIEW_AUDIT, ROOM_AUDIT, SCHEDULES_AUDIT, TABNAME_AUDIT, TASKS_AUDIT, tripText, UPLINKS_AUDIT } from './audited.js';
import { createBlackBox } from './blackbox.js';
import { createBoard } from './board.js';
import { createDocking, stationName } from './docking.js';
import { createDownlink } from './downlink.js';
import { createHub } from './hub.js';
import { createHangar, createRoots } from './hangar.js';
import { createRecorder } from './recorder.js';
import { checkCleanRoom } from './cleanroom.js';
import { checkWorktree, removeWorktree, worktreeBranch, worktreePath, worktreeStatus } from './worktree.js';
import { openHome } from './home.js';
import { createLauncher, parseAgentCmd } from './launcher.js';
import { createTerminalHost } from './terminal.js';
import { createRemoteTerminalHost } from './remoteterminal.js';
import type { RemoteTerminalHost } from './remoteterminal.js';
import { runDir } from './ptyhost.js';
import { TOKENS_FILE } from './ptyhostproto.js';
import { createHoldStore, relaunch, requestReload, runPtyHost, spawnHostProcess } from './reload.js';
import { createWebServer } from './web.js';
import { createPropellant } from './propellant.js';
import { createQuota } from './quota.js';
import { createPrices } from './prices.js';
import { createTelemetry } from './telemetry.js';
import { createRelay } from './relay.js';
import { createSchedules } from './schedules.js';
import { createLiveries } from './livery.js';
import { createPhone } from './phone.js';
import type { Phone } from './phone.js';
import { createRelief } from './relief.js';
import { createMassBudget } from './massbudget.js';
import { createMissionLog } from './missionlog.js';
import { createMissions } from './missions.js';
import { createReview } from './review.js';
import { createRoomLayout } from './roomlayout.js';
import { createTabName } from './tabname.js';
import { createTasks } from './tasks.js';
import { createUplinks } from './uplinks.js';
import { checkEngines, formatDoctor, installedProviders, onPath } from './providers.js';
import { createClearance } from './clearance.js';
import { createModelDefaults } from './models.js';
import { createPermissionDefaults } from './permissions.js';
import { createRunState } from './runstate.js';
import { createStartupStore } from './startup.js';
import { cachedLatest, createRollout, installKind, installNote, isNewer, updateCheckOff, updateCommand, updateText } from './rollout.js';
import { createUpdater } from './updater.js';
import type { Updater } from './updater.js';
import type { WebServer } from './web.js';

type Env = Record<string, string | undefined>;

export interface StartOptions {
  /** Default env GONOGO_HOST or DEFAULT_HOST; "localhost" and "" mean 127.0.0.1. */
  host?: string;
  /** Default env GONOGO_PORT or DEFAULT_PORT; 0 = any. */
  port?: number;
  /** Default env GONOGO_HOME or ~/.gonogo. */
  home?: string;
  /** Default: env GONOGO_SEED_CLAUDE is "1" or "true". */
  seed?: boolean;
  /** Default parseAgentCmd(env.GONOGO_AGENT_CMD). */
  agentCmd?: string[] | null;
  /** The boss's directory. Default process.cwd(). */
  cwd?: string;
  /** Default env GONOGO_MAX_HOPS, else DEFAULT_MAX_HOPS (1..MAX_HOPS_LIMIT, else warn and default). */
  maxHops?: number;
  /** Max Q at start. Default env GONOGO_MAX_WORKING (1..MAX_AGENTS, else warn and off). */
  maxWorking?: number;
  /** Default: the split of env GONOGO_ALLOWED_HOSTS on ",". */
  allowedHosts?: string[];
  /** Default: dist/client when it has index.html, else null. */
  staticDir?: string | null;
  /** Default process.env; the base of the claude children's environment too. */
  env?: Env;
  /** Default nullLogger. */
  log?: Logger;
  /** Default true; ignored (no check) when agentCmd is set. */
  checkClaude?: boolean;
  /** What Relay posts with and Docking calls with. Default the global fetch; a test hands in a fake, so that nothing leaves the machine. */
  fetch?: typeof fetch;
  /** Rollout, the daily check for a newer gonogo. Default false here, so that a test never reaches the registry: `main` turns it on unless GONOGO_UPDATE_CHECK=0 or --no-update-check. */
  updateCheck?: boolean;
  /** Live reload (opt-in for one release): the ptys live in a separate `gonogo ptyhost` process, so `gonogo reload` leaves the agents running. Default env GONOGO_PTY_HOST is "1" or "true". */
  ptyHost?: boolean;
  /** [node, entry] that starts the pty host, default the entry this process was started with. A test hands in its own. */
  ptyHostCommand?: string[];
}

export interface Running {
  /** The printed URL, with the #token fragment. */
  url: string;
  /** The bound address. */
  host: string;
  port: number;
  browserToken: string;
  home: string;
  /** Idempotent graceful shutdown. */
  stop(): Promise<void>;
  /** Live reload: ends this server and leaves the agents running in the pty host (a hold stays saved). Only with ptyHost; else it stops. */
  release(): Promise<void>;
}

/* ---------------------------------------------------------------- arguments */

export const USAGE = `Usage: gonogo [options]
       gonogo doctor
       gonogo update
       gonogo reload
       gonogo tui [--url <address>] [--token <token>] [--home <dir>]

Run a mission-control room of Claude Code agents from a browser tab.

Commands:
  doctor                list the agent CLIs on the PATH with their versions, and the install command of each missing one
  reload                hand over to the installed gonogo without stopping the agents (needs --pty-host on the running one)
  update                print the command that updates gonogo the way it was installed (it never runs it)
  tui                   a terminal client of a running gonogo: the room, the inbox, go and no-go, and a console (gonogo tui --help)

Options:
  --port <n>            listen port (default ${DEFAULT_PORT}; env GONOGO_PORT)
  --host <addr>         bind address (default ${DEFAULT_HOST}; env GONOGO_HOST)
  --home <dir>          state directory (default ~/${DEFAULT_HOME_DIRNAME}; env GONOGO_HOME)
  --pty-host            keep the agents in a separate process so that gonogo reload does not stop them (env GONOGO_PTY_HOST=1)
  --seed-claude         record Claude's folder trust and skip its startup dialogs (env GONOGO_SEED_CLAUDE=1)
  --allow-host <name>   accept this Host name too, for a reverse proxy; repeatable (env GONOGO_ALLOWED_HOSTS, comma list)
  --no-update-check     do not ask the npm registry once a day whether a newer gonogo exists (env GONOGO_UPDATE_CHECK=0)
  -h, --help            show this help
  -v, --version         show the version

Docs: ${DOCS_URL}

Environment:
  GONOGO_MAX_HOPS         hop cap for messages between agents (default ${DEFAULT_MAX_HOPS})
  GONOGO_MAX_WORKING      Max Q: at most this many Claude agents work at once, 1 to ${MAX_AGENTS} (default off)
  GONOGO_STATION          this station's name for Docking (default: the host name)
  GONOGO_AGENT_CMD        command that replaces claude
  GONOGO_CLEANROOM_IMAGE  Docker image of a Clean Room console (default ghcr.io/ulm0/gonogo)
  GONOGO_LOG_LEVEL        debug, info, warn or error (default info)
  GONOGO_SCRUB_ENV        extra variables to keep out of the agents (comma list; a name ending in _ is a prefix)
  GONOGO_UPDATE_CHECK     0, off, false or no: do not check for a newer gonogo (default on)
`;

export type ParsedArgs =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'doctor' }
  | { kind: 'update' }
  | { kind: 'reload'; home?: string }
  | { kind: 'ptyhost'; home: string }
  | { kind: 'run'; options: StartOptions }
  | { kind: 'error'; message: string };

const VALUE_FLAGS = ['--port', '--host', '--home', '--allow-host'];

function parsePort(value: string, label: string): number {
  const port = /^\d{1,5}$/.test(value) ? Number(value) : -1;
  if (port < 0 || port > 65535) throw new Error(`invalid ${label} "${value}" (use a number from 0 to 65535)`);
  return port;
}

/** Flags only; the environment fallbacks are applied by startGonogo, so a flag always wins. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  if (argv.includes('--help') || argv.includes('-h')) return { kind: 'help' };
  if (argv.includes('--version') || argv.includes('-v')) return { kind: 'version' };
  if (argv[0] === 'doctor' || argv[0] === 'update') return argv.length === 1 ? { kind: argv[0] } : { kind: 'error', message: `${argv[0]} takes no arguments` };
  if (argv[0] === 'reload' || argv[0] === 'ptyhost') {
    const rest = argv.slice(1);
    let home: string | undefined;
    if (rest.length === 2 && rest[0] === '--home' && rest[1] !== '') home = rest[1];
    else if (rest.length > 0) return { kind: 'error', message: `${argv[0]} takes only --home <dir>` };
    if (argv[0] === 'ptyhost') return home === undefined ? { kind: 'error', message: 'ptyhost needs --home <dir>' } : { kind: 'ptyhost', home };
    return home === undefined ? { kind: 'reload' } : { kind: 'reload', home };
  }
  const options: StartOptions = {};
  const allowedHosts: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--seed-claude') {
      options.seed = true;
      continue;
    }
    if (arg === '--pty-host') {
      options.ptyHost = true;
      continue;
    }
    if (arg === '--no-update-check') {
      options.updateCheck = false;
      continue;
    }
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (!VALUE_FLAGS.includes(flag)) return { kind: 'error', message: `unknown option ${arg}` };
    let value: string;
    if (eq !== -1) {
      value = arg.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) return { kind: 'error', message: `${flag} needs a value` };
      value = next;
      i += 1;
    }
    try {
      switch (flag) {
        case '--port':
          options.port = parsePort(value, 'port');
          break;
        case '--host':
          options.host = value;
          break;
        case '--home':
          if (value === '') throw new Error('--home needs a directory');
          options.home = value;
          break;
        default:
          if (value.trim() === '') throw new Error('--allow-host needs a host name');
          allowedHosts.push(value.trim());
      }
    } catch (e) {
      return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
    }
  }
  // any --allow-host replaces the GONOGO_ALLOWED_HOSTS list, like every other flag replaces its variable
  if (allowedHosts.length > 0) options.allowedHosts = allowedHosts;
  return { kind: 'run', options };
}

/* ---------------------------------------------------------------- settings */

interface Settings {
  host: string;
  port: number;
  home: string;
  seed: boolean;
  agentCmd: string[] | null;
  cwd: string;
  maxHops: number;
  maxWorking: number | null;
  /** Redline's automatic detectors; GONOGO_REDLINE=off turns them off. */
  redline: boolean;
  allowedHosts: string[];
  staticDir: string | null;
  env: Env;
  checkClaude: boolean;
  ptyHost: boolean;
}

/** "localhost" would bind whichever address the resolver lists first, often ::1 only, and every 127.0.0.1 URL handed to the agents would be refused. */
function bindHost(raw: string): string {
  const host = raw.trim().replace(/^\[|\]$/g, '');
  return host === '' || host.toLowerCase() === 'localhost' ? '127.0.0.1' : host;
}

function defaultStaticDir(): string | null {
  const dir = fileURLToPath(new URL('../client/', import.meta.url));
  return existsSync(join(dir, 'index.html')) ? dir : null;
}

export function resolveSettings(options: StartOptions, log: Logger = nullLogger): Settings {
  const env = options.env ?? process.env;
  const port = options.port ?? (env.GONOGO_PORT ? parsePort(env.GONOGO_PORT, 'GONOGO_PORT') : DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid port "${port}" (use a number from 0 to 65535)`);

  const hopsText = options.maxHops !== undefined ? String(options.maxHops) : env.GONOGO_MAX_HOPS;
  let maxHops = DEFAULT_MAX_HOPS;
  if (hopsText !== undefined && hopsText !== '') {
    const hops = /^\d{1,4}$/.test(hopsText) ? Number(hopsText) : 0;
    if (hops >= 1 && hops <= MAX_HOPS_LIMIT) maxHops = hops;
    else log.warn(`ignoring max hops "${hopsText}": use a whole number from 1 to ${MAX_HOPS_LIMIT}; using ${DEFAULT_MAX_HOPS}`);
  }

  const workingText = options.maxWorking !== undefined ? String(options.maxWorking) : env[MAX_WORKING_ENV];
  let maxWorking: number | null = null;
  if (workingText !== undefined && workingText !== '') {
    const working = /^\d{1,3}$/.test(workingText) ? Number(workingText) : 0;
    if (working >= 1 && working <= MAX_AGENTS) maxWorking = working;
    else log.warn(`ignoring ${MAX_WORKING_ENV} "${workingText}": use a whole number from 1 to ${MAX_AGENTS}; the load limit stays off`);
  }

  const redlineText = env[REDLINE_ENV]?.trim().toLowerCase();
  const redline = !(redlineText === 'off' || redlineText === '0' || redlineText === 'false');

  const seedText = env.GONOGO_SEED_CLAUDE?.toLowerCase();
  return {
    host: bindHost(options.host ?? env.GONOGO_HOST ?? DEFAULT_HOST),
    port,
    home: resolve(options.home ?? (env.GONOGO_HOME || join(homedir(), DEFAULT_HOME_DIRNAME))),
    seed: options.seed ?? (seedText === '1' || seedText === 'true'),
    agentCmd: options.agentCmd !== undefined ? options.agentCmd : parseAgentCmd(env.GONOGO_AGENT_CMD),
    cwd: resolve(options.cwd ?? process.cwd()),
    maxHops,
    maxWorking,
    redline,
    allowedHosts:
      options.allowedHosts ??
      (env.GONOGO_ALLOWED_HOSTS ?? '')
        .split(',')
        .map((h) => h.trim())
        .filter((h) => h !== ''),
    staticDir: options.staticDir !== undefined ? options.staticDir : defaultStaticDir(),
    env,
    checkClaude: options.checkClaude ?? true,
    ptyHost: options.ptyHost ?? (env.GONOGO_PTY_HOST === '1' || env.GONOGO_PTY_HOST?.toLowerCase() === 'true'),
  };
}

function packageVersion(): string {
  try {
    const pkg: unknown = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    if (typeof pkg === 'object' && pkg !== null && 'version' in pkg && typeof pkg.version === 'string') return pkg.version;
  } catch {
    // an unreadable package.json only costs the version string
  }
  return '0.0.0';
}

/** How this gonogo was installed, from where its own file is: in a container, a git checkout, or one of the package managers (Rollout). */
function installInfo(env: Env = process.env): { command: string; docker: boolean; kind: InstallKind } {
  // the image sets GONOGO_INSTALL=docker; the files cover a container run from another image
  const docker = env.GONOGO_INSTALL === 'docker' || existsSync('/.dockerenv') || existsSync('/run/.containerenv');
  const clone = existsSync(fileURLToPath(new URL('../../.git', import.meta.url)));
  const where = { file: fileURLToPath(import.meta.url), docker, clone };
  return { docker, command: updateCommand(where), kind: installKind(where) };
}

/** The home as `gonogo --version` and `gonogo update` find it: GONOGO_HOME or the default, with no flag read (they read the cache only). */
const homeOf = (env: Env): string => resolve(env.GONOGO_HOME || join(homedir(), DEFAULT_HOME_DIRNAME));

/** The host of the printed URL: a wildcard bind is reached on loopback, an IPv6 address needs brackets (contract 0.5 item 14). */
function displayHost(host: string): string {
  if (['0.0.0.0', '::', '127.0.0.1'].includes(host)) return '127.0.0.1';
  return host.includes(':') ? `[${host}]` : host;
}

function listenError(e: unknown, host: string, port: number): Error {
  const code = typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string' ? e.code : undefined;
  const where = `${host.includes(':') ? `[${host}]` : host}:${port}`;
  if (code === 'EADDRINUSE') return new Error(`cannot listen on ${where}: the port is already in use (EADDRINUSE). Stop whatever uses it, or pass --port.`);
  if (code === 'EACCES') return new Error(`cannot listen on ${where}: permission denied (EACCES). Ports below 1024 need extra rights; pass --port.`);
  if (code === 'EADDRNOTAVAIL') return new Error(`cannot listen on ${where}: that address does not belong to this machine (EADDRNOTAVAIL). Check --host.`);
  return e instanceof Error ? e : new Error(String(e));
}

/* ---------------------------------------------------------------- start */

export async function startGonogo(options: StartOptions = {}): Promise<Running> {
  const log = options.log ?? nullLogger;
  const settings = resolveSettings(options, log);
  const { host, port, seed, agentCmd, cwd, maxHops, maxWorking, redline, allowedHosts, staticDir, env } = settings;
  if (agentCmd === null && settings.checkClaude && !onPath(CLAUDE_BIN, env.PATH)) {
    throw new Error('the claude CLI was not found on PATH. Install Claude Code and sign in, or set GONOGO_AGENT_CMD.');
  }

  const home = openHome(settings.home, log);
  let hub: Hub | undefined;
  let hubStarting = false;
  let web: WebServer | undefined;
  let terminals: TerminalHost | undefined;
  let baseUrl = '';
  let ready = false;
  let running: Running;
  const startedAt = Date.now();
  const version = packageVersion();
  const bound = { host, port };

  try {
    // a corrupt agents.json stops the start here, before anything listens
    home.loadRoster();
    // Live reload: the ptys live in a pty host process of their own; this gonogo is only its client
    const entry = process.argv[1];
    const remote: RemoteTerminalHost | null = settings.ptyHost
      ? createRemoteTerminalHost({
          homeDir: home.dir,
          log: log.child('ptyhost'),
          startHost: () => spawnHostProcess(home.dir, options.ptyHostCommand ?? (entry === undefined ? ['gonogo'] : [process.execPath, entry])),
        })
      : null;
    const holdStore = remote ? createHoldStore(home.dir, log.child('holds')) : null;
    if (remote) {
      let hello = await remote.connect();
      if (!hello.ok && hello.reason === 'version') {
        // the host on this home speaks another protocol: its agents cannot be taken over, so they are stopped and resume (restart with --resume)
        log.warn(`the pty host is of another version (${hello.detail}): stopping its agents; they will resume`);
        await remote.quitHost();
        await new Promise((done) => setTimeout(done, 500));
        hello = await remote.connect();
      }
      if (!hello.ok) throw new Error(`could not reach the pty host: ${hello.detail}`);
      log.info(`pty host connected (pid ${hello.pid}); ${hello.agents.filter((a) => a.running).length} agent(s) running there`);
    }
    const terminalHost = remote ?? createTerminalHost({ log: log.child('terminal') });
    terminals = terminalHost;
    for (const dir of new Set([home.dir, cwd])) {
      try {
        accessSync(dir, fsConstants.W_OK);
      } catch {
        log.warn(`${dir} is not writable by uid ${process.getuid?.() ?? '?'}; chown it to that uid`);
      }
    }

    const clearance = createClearance({ dir: home.dir, log: log.child('clearance') });
    await clearance.load();
    const modelDefaults = createModelDefaults({ dir: home.dir, log: log.child('models') });
    await modelDefaults.load();
    const permissionDefaults = createPermissionDefaults({ dir: home.dir, log: log.child('permissions') });
    await permissionDefaults.load();
    const runState = createRunState({ dir: home.dir, now: () => Date.now(), log: log.child('run state') });
    await runState.load();
    const startupStore = createStartupStore({ dir: home.dir, log: log.child('startup') });
    await startupStore.load();
    const launcher = createLauncher({
      homeDir: home.dir,
      tokensFile: remote ? join(runDir(home.dir), TOKENS_FILE) : null,
      hubUrl: () => baseUrl,
      seed,
      env,
      agentCmd,
      keys: (name) => clearance.values(name),
      defaultModel: (provider, position) => modelDefaults.resolve(provider, position),
      defaultPermissions: () => permissionDefaults.get(),
      log: log.child('launcher'),
    });

    const prices = createPrices({ dir: home.dir, log: log.child('prices') });
    await prices.load();
    /** The Flight Plan, once it exists: Propellant asks it what an agent is working on. */
    let flightPlan: () => Task[] = () => [];
    /** Cost attribution: the mission and task of the agent's `doing` task now, if it has one. */
    const workingOn = (agent: string): { mission?: string; task?: string } => {
      const doing = flightPlan().find((t) => t.assignee === agent && t.status === 'doing');
      return doing === undefined ? {} : { task: doing.id, ...(doing.missionId === undefined ? {} : { mission: doing.missionId }) };
    };
    const quota = createQuota({
      dir: home.dir,
      now: () => Date.now(),
      // the 80 and 95 % alerts: the inbox and Relay, not the Black Box (nothing was tripped)
      notify: (kind, text) => {
        downlink.post(kind, text);
        relay.event(kind, text);
      },
      log: log.child('quota'),
    });
    await quota.load();
    const propellant = createPropellant({
      dir: home.dir,
      plan: () => quota.view(),
      attribute: workingOn,
      prices: () => prices.table(),
      // the 80 % budget warning: the inbox and Relay, not the Black Box (it is not a trip)
      notify: (kind, text) => {
        downlink.post(kind, text);
        relay.event(kind, text);
      },
      projectsRoot: join(env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude'), 'projects'),
      now: () => Date.now(),
      log: log.child('propellant'),
    });
    await propellant.load();
    const telemetry = createTelemetry({ dir: home.dir, now: () => Date.now(), log: log.child('telemetry') });
    await telemetry.load();
    const downlink = createDownlink({
      dir: home.dir,
      now: () => Date.now(),
      history: () => home.loadRecentMessages(DOWNLINK_HISTORY),
      emit: (view) => web?.broadcast({ t: 'downlink', downlink: view }),
      log: log.child('downlink'),
    });
    await downlink.load();
    const relay = createRelay({
      dir: home.dir,
      now: () => Date.now(),
      fetch: options.fetch ?? ((url, init) => fetch(url, init)),
      sleep: (ms) => new Promise((done) => setTimeout(done, ms).unref()),
      log: log.child('relay'),
    });
    await relay.load();
    const blackBox = createBlackBox({
      dir: home.dir,
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms).unref(),
      clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
      path: env.PATH,
      log: log.child('black box'),
    });
    /** What the parts of the server tell the Director's inbox goes to the targets of Relay too; a trip and a poll result go to the Black Box. */
    let phone: Phone | null = null;
    const tell: DownlinkNotify = (kind, text, ref) => {
      downlink.post(kind, text);
      relay.event(kind, text);
      if (ref !== undefined) phone?.approval(ref, text);
      if (kind === 'redline') blackBox.record('redline', tripText(text));
      else if (kind === 'tminus') blackBox.record('poll', pollText(text));
    };

    /** Stops what Propellant says is over its limit or budget: a room limit every Claude agent, a mission's budget the agents working on it, an agent's own only that agent. */
    const enforce = (name: string): void => {
      const over = propellant.over(name);
      if (over === null || !hub) return;
      const claude = hub.views().filter((v) => v.provider === 'claude').map((v) => v.name);
      const names = over.scope === 'room' ? claude : over.scope === 'mission' ? claude.filter((n) => workingOn(n).mission === over.mission) : [name];
      for (const n of names) {
        try {
          hub.trip(n, over.reason);
        } catch (e) {
          log.debug(`could not trip ${n}`, e);
        }
      }
    };

    let seq = home.lastMessageSeq();
    // arrow functions on purpose: nothing here relies on `this` of the object it came from
    const io: HubIo = {
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms).unref(),
      clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
      newMessageId: () => 'm' + ++seq,
      newSessionId: () => randomUUID(),
      checkDirectory: async (p) => {
        if (!isAbsolute(p)) return { ok: false, error: 'directory must be an absolute path' };
        let info;
        try {
          info = await stat(p);
        } catch {
          return { ok: false, error: `directory does not exist: ${p}` };
        }
        if (!info.isDirectory()) return { ok: false, error: `not a directory: ${p}` };
        return { ok: true, path: resolve(p) };
      },
      checkCleanRoom: (dir) => checkCleanRoom(dir, env),
      checkWorktree: (dir) => checkWorktree(dir, env),
      loadRoster: async () => home.loadRoster(),
      startup: () => startupStore.view(),
      runSet: () => runState.previous(),
      markRun: (name, running, working) => runState.mark(name, running, working),
      saveRoster: (r) => home.saveRoster(r),
      loadHistory: async (n) => home.loadRecentMessages(n),
      logMessage: (r) => home.appendMessage(r),
      renameAgentFiles: async (oldName, newName) => {
        await launcher.renameAgentFiles(oldName, newName);
        try {
          await clearance.rename(oldName, newName);
        } catch (error) {
          await launcher.renameAgentFiles(newName, oldName).catch(() => undefined);
          throw error;
        }
        terminalHost.rename(oldName, newName);
      },
      keys: clearance,
      spawn: async (req) => {
        const prepared = await launcher.prepareStart(req.agent, { generation: req.generation, flag: req.flag });
        try {
          const { pid } = await (terminalHost.spawnAsync?.(req.agent.name, req.generation, prepared.spec) ?? Promise.resolve(terminalHost.spawn(req.agent.name, req.generation, prepared.spec)));
          return { generation: req.generation, flag: prepared.flag, pid };
        } catch (e) {
          launcher.revoke(req.agent.name, req.generation);
          throw e;
        }
      },
      stop: (name, generation) => terminalHost.stop(name, generation),
      saveHolds: holdStore ? (holds) => holdStore.save(holds) : undefined,
      adoptable: remote
        ? async () => {
            const running = remote.list().filter((item) => item.running).map((item) => ({ name: item.name, generation: item.generation }));
            // only the agents still running there keep a token
            launcher.keepTokens(running);
            return { running, holds: holdStore?.load() ?? {} };
          }
        : undefined,
      typePointer: (name, generation, text) => terminalHost.submit(name, generation, text),
      // TerminalHost.write has no generation: only keys for the running process of that generation may be typed.
      press: (name, generation, data) => {
        const info = terminalHost.info(name);
        return info !== null && info.running && info.generation === generation && terminalHost.write(name, data);
      },
      meter: (name, _generation, transcriptPath) => {
        void propellant.record(name, transcriptPath).then((used) => {
          if (used === 0 || !hub) return;
          web?.broadcast({ t: 'propellant', propellant: propellant.view() });
          enforce(name);
        });
      },
      toolHook: (name, event, payload) => telemetry.hook(name, event, payload),
      screen: (name) => terminalHost.screen(name),
      title: (name) => terminalHost.title(name),
      outputBytes: (name) => terminalHost.outputBytes(name),
      forget: (name) => terminalHost.forget?.(name),
      emit: (event) => {
        web?.broadcast(event);
        downlink.observe(event);
        relay.observe(event);
      },
      notify: tell,
      log: log.child('hub'),
    };
    const hubInstance = createHub(io, { maxHops, bossDir: cwd, maxWorking, redline });
    hub = hubInstance;

    // subscribed before the first spawn; the revoke comes first so a hook that is still in flight after the exit gets a 401
    terminalHost.onEvent((event) => {
      if (event.kind === 'exit') launcher.revoke(event.name, event.generation);
      hubInstance.onTerminalEvent(event);
    });

    const info = (): ServerInfo => ({
      protocol: PROTOCOL_VERSION,
      version,
      cwd,
      home: home.dir,
      host: bound.host,
      port: bound.port,
      seed,
      agentCmd: agentCmd ? agentCmd.join(' ') : null,
      maxHops,
      startedAt,
      installed: installedProviders(env.PATH, agentCmd !== null),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    const schedules = createSchedules({
      dir: home.dir,
      now: io.now,
      setTimer: io.setTimer,
      clearTimer: io.clearTimer,
      send: (request) => hubInstance.sendFromUser(request),
      emit: (list) => web?.broadcast({ t: 'schedules', schedules: list }),
      notify: tell,
      log: log.child('launch window'),
    });
    const uplinks = createUplinks({
      dir: home.dir,
      now: io.now,
      send: (request) => hubInstance.sendFromUser(request),
      emit: (list) => web?.broadcast({ t: 'uplinks', uplinks: list }),
      notify: tell,
      inbound: relay,
      press: (secret, pressed) => void phone?.press(secret, pressed).catch((error: unknown) => log.warn('phone approvals: a button failed', error instanceof Error ? error.message : String(error))),
      log: log.child('uplink'),
    });
    // tasks and missions know each other: a task checks its missionId, a mission counts and unlinks its tasks
    let missionsRef: ReturnType<typeof createMissions> | null = null;
    const tasks = audited(createTasks({
      dir: home.dir,
      now: io.now,
      hasMission: (id) => missionsRef?.has(id) ?? false,
      afterChange: (list) => missionsRef?.observe(list),
      isAgent: (name) => hubInstance.views().some((v) => v.name === name),
      send: (actor, request) =>
        actor.kind === 'user'
          ? hubInstance.sendFromUser(request)
          : actor.kind === 'agent'
            ? hubInstance.sendFromAgent(actor.name, actor.generation, request)
            : hubInstance.sendFromStation(actor.station, { from: 'director', to: request.to, subject: request.subject ?? '', body: request.body, hops: 0 }),
      emit: (list) => web?.broadcast({ t: 'tasks', tasks: list }),
      notify: tell,
      log: log.child('flight plan'),
    }), blackBox.record, TASKS_AUDIT);
    flightPlan = () => tasks.list();
    const missions = audited(createMissions({
      dir: home.dir,
      now: io.now,
      isAgent: (name) => hubInstance.views().some((v) => v.name === name),
      boss: () => hubInstance.views().find((v) => v.boss)?.name ?? null,
      tasks: () => tasks.list(),
      unlink: (id) => tasks.unlinkMission(id),
      send: (actor, request) => (actor.kind === 'user' ? hubInstance.sendFromUser(request) : hubInstance.sendFromAgent(actor.name, actor.generation, request)),
      emit: (list) => web?.broadcast({ t: 'missions', missions: list }),
      notify: tell,
      log: log.child('missions'),
    }), blackBox.record, MISSIONS_AUDIT);
    missionsRef = missions;
    const docking = createDocking({
      dir: home.dir,
      name: stationName(env[STATION_ENV], hostname()),
      now: io.now,
      fetch: options.fetch ?? ((url, init) => fetch(url, init)),
      deliver: (station, message) => hubInstance.sendFromStation(station, message),
      roster: () => hubInstance.views().map((v) => ({ name: v.name, role: v.role.slice(0, ROSTER_ROLE_CHARS), state: v.state, boss: v.boss })),
      tasks,
      emit: (view) => web?.broadcast({ t: 'docking', docking: view }),
      log: log.child('docking'),
    });
    io.dock = docking;
    const missionLog = createMissionLog({
      dir: home.dir,
      now: io.now,
      emit: (frame) => web?.broadcast(frame),
      log: log.child('mission log'),
    });
    const board = createBoard({ dir: home.dir, now: io.now });
    const massBudget = createMassBudget({
      memoryPath: (name) => launcher.memoryPath(name),
      agent: (name) => hubInstance.views().find((v) => v.name === name),
      send: (request) => hubInstance.sendFromUser(request),
      log: log.child('mass budget'),
    });
    const liveries = createLiveries({
      dir: home.dir,
      send: (request) => hubInstance.sendFromUser(request),
      emit: (frame) => web?.broadcast(frame),
      notify: tell,
      log: log.child('livery'),
    });
    const roots = createRoots({
      home: home.dir,
      agent: (name) => {
        const view = hubInstance.views().find((v) => v.name === name);
        return view === undefined ? null : { dir: view.dir, cleanRoom: view.cleanRoom !== null, worktree: view.worktree !== null };
      },
    });
    const recorder = createRecorder(roots, env);
    const review = audited(createReview({
      dir: home.dir,
      now: io.now,
      agent: (name) => {
        const view = hubInstance.views().find((v) => v.name === name);
        return view === undefined ? null : { mailable: providerInfo(view.provider).mcp };
      },
      diff: (name) => recorder.reviewDiff(name),
      send: (request) => hubInstance.sendFromUser(request),
      notify: tell,
      log: log.child('review'),
    }), blackBox.record, REVIEW_AUDIT);
    const room = audited(createRoomLayout({ dir: home.dir, emit: (view) => web?.broadcast({ t: 'room', room: view }), log: log.child('room') }), blackBox.record, ROOM_AUDIT);
    const tabName = audited(createTabName({ dir: home.dir, fallback: (env[STATION_ENV] ?? '').trim() === '' ? null : stationName(env[STATION_ENV], hostname()), emit: (view) => web?.broadcast({ t: 'tabname', tabName: view }), log: log.child('tabname') }), blackBox.record, TABNAME_AUDIT);
    const relief = createRelief({
      hub: hubInstance,
      checkDirectory: io.checkDirectory,
      now: io.now,
      setTimer: io.setTimer,
      clearTimer: io.clearTimer,
      emit: (frame) => web?.broadcast(frame),
      notify: tell,
      log: log.child('relief'),
    });
    phone = createPhone({ hub: audited(hubInstance, blackBox.record, HUB_AUDIT), relief, relay, secret: () => uplinks.secretOf('telegram'), now: io.now, log: log.child('phone') });
    // Update from the page: npm or pnpm global installs, or a container with an update hook (GONOGO_UPDATE_HOOK, optional GONOGO_UPDATE_HOOK_TOKEN)
    const installed = installInfo(env);
    const hookUrl = (env.GONOGO_UPDATE_HOOK ?? '').trim();
    const canUpdate = installed.kind === 'npm' || installed.kind === 'pnpm' || (installed.kind === 'docker' && /^https?:\/\//.test(hookUrl));
    const rollout = createRollout({
      dir: home.dir,
      now: io.now,
      fetch: options.fetch ?? ((url, init) => fetch(url, init)),
      enabled: options.updateCheck === true,
      current: version,
      command: installed.command,
      install: installed.kind,
      installNote: installNote(installed.kind, canUpdate),
      canUpdate,
      emit: (view) => web?.broadcast({ t: 'rollout', rollout: view }),
      log: log.child('rollout'),
    });
    await rollout.load();
    const triggerReload = (): boolean => {
      if (process.listenerCount('SIGUSR2') === 0) return false;
      setTimeout(() => process.kill(process.pid, 'SIGUSR2'), 100).unref();
      return true;
    };
    mkdirSync(runDir(home.dir), { recursive: true, mode: 0o700 });
    const updater: Updater = createUpdater({
      kind: installed.kind,
      cwd: runDir(home.dir),
      current: version,
      rollout,
      reload: triggerReload,
      keepsAgents: remote !== null,
      hook: /^https?:\/\//.test(hookUrl) ? { url: hookUrl, token: (env.GONOGO_UPDATE_HOOK_TOKEN ?? '').trim() || null } : null,
      fetch: options.fetch ?? ((url, init) => fetch(url, init)),
      log: log.child('update'),
    });
    const webServer = createWebServer({
      statusLine: (name, body) => {
        if (quota.report(name, body)) web?.broadcast({ t: 'propellant', propellant: propellant.view() });
      },
      host,
      port,
      browserToken: home.browserToken,
      allowedHosts,
      staticDir,
      // what the Director does through the browser is told to the Black Box by these copies
      hub: audited(hubInstance, blackBox.record, HUB_AUDIT),
      terminals: terminalHost,
      resolveToken: (token) => launcher.resolveToken(token),
      info,
      isReady: () => ready,
      propellant: audited(propellant, blackBox.record, PROPELLANT_AUDIT),
      prices: audited(prices, blackBox.record, PRICES_AUDIT),
      // a changed price or budget is checked at once, not at the next reply
      spendChanged: () => {
        propellant.recheck();
        for (const v of hub?.views() ?? []) if (v.provider === 'claude') enforce(v.name);
      },
      telemetry,
      schedules: audited(schedules, blackBox.record, SCHEDULES_AUDIT),
      uplinks: audited(uplinks, blackBox.record, UPLINKS_AUDIT),
      tasks,
      missions,
      room,
      tabName,
      downlink,
      missionLog,
      massBudget,
      board: audited(board, blackBox.record, BOARD_AUDIT),
      blackBox,
      liveries: audited(liveries, blackBox.record, LIVERIES_AUDIT),
      relay: audited(relay, blackBox.record, RELAY_AUDIT),
      models: modelDefaults,
      permissions: audited(permissionDefaults, blackBox.record, PERMISSIONS_AUDIT),
      startup: audited(startupStore, blackBox.record, STARTUP_AUDIT),
      docking: audited(docking, blackBox.record, DOCKING_AUDIT),
      relief: audited(relief, blackBox.record, RELIEF_AUDIT),
      rollout,
      // only a gonogo started from the command line has the signal handler that does the hand-over; a test or an embedder has not
      update: (version) => updater.start(version),
      reload: () => {
        if (!triggerReload()) return { ok: false, reason: 'reload is only available in a gonogo started from the command line' };
        return { ok: true, note: remote ? 'reloading: the agents keep running' : 'reloading: no pty host here (start gonogo with --pty-host to keep agents running), so the agents stop and resume' };
      },
      engines: () => checkEngines(env),
      hangar: createHangar(roots),
      worktrees: {
        has: (name) => hubInstance.views().some((v) => v.name === name && v.worktree !== null),
        status: (name) => worktreeStatus(worktreePath(home.dir, name), worktreeBranch(name), env),
        discard: async (name) => {
          const done = await removeWorktree(worktreePath(home.dir, name), worktreeBranch(name), env);
          if (done.reason !== undefined) log.warn(`worktree of ${name} kept: ${done.reason}`);
          return done;
        },
      },
      recorder,
      review,
      log: log.child('web'),
    });
    web = webServer;

    let addr: { host: string; port: number };
    try {
      addr = await webServer.listen();
    } catch (e) {
      throw listenError(e, host, port);
    }
    bound.host = addr.host;
    bound.port = addr.port;
    // agents are handed a loopback URL whatever the bind address is: claude blocks http hooks to private addresses (contract 2.8 step 8)
    baseUrl = `http://${host === '::1' ? '[::1]' : '127.0.0.1'}:${addr.port}`;

    // before the hub starts any agent: a task_create that came first would take an id of the file and lose that task
    await tasks.load();
    await missions.load();
    await room.load();
    await tabName.load();
    // the open count of each active mission is seeded here, so the last task done after a restart is announced
    missions.observe(tasks.list());
    await missionLog.load();
    await board.load();
    await blackBox.load();
    blackBox.record('audit', `gonogo ${version} started`);
    await liveries.load();
    await docking.load();
    hubStarting = true;
    await hubInstance.start();
    await schedules.load();
    await uplinks.load();
    ready = true;
    docking.start();
    rollout.start();

    let stopping: Promise<void> | undefined;
    const step = async (what: string, run: () => Promise<void>): Promise<void> => {
      try {
        await run();
      } catch (e) {
        log.error(`${what} failed`, e);
      }
    };
    const shutdown = async (leave: boolean): Promise<void> => {
      // no schedule fires from here on
      await step('schedules close', () => schedules.close());
      // the hub first: it refuses new lifecycle calls from here on, while hooks, MCP and open sockets keep working so the agents can finish
      // a reload leaves the agents running in the pty host (their holds are in the saved file); an ordinary stop ends them and the host
      if (leave && remote) {
        await step('hub release', async () => hubInstance.release());
        remote.disconnect();
      } else {
        await step('hub shutdown', () => hubInstance.shutdown());
        await step('terminal shutdown', () => terminalHost.stopAll());
        if (remote) await step('pty host quit', async () => void (await remote.quitHost()));
      }
      await step('web server close', () => webServer.close());
      await step('docking close', () => docking.close());
      await step('uplinks close', () => uplinks.close());
      await step('tasks close', () => tasks.close());
      await step('missions close', () => missions.close());
      await step('room close', () => room.close());
      await step('tab name close', () => tabName.close());
      await step('mission log close', () => missionLog.close());
      await step('board close', () => board.close());
      blackBox.record('audit', 'gonogo stopped');
      await step('black box close', () => blackBox.close());
      await step('livery close', () => liveries.close());
      await step('relief close', async () => relief.close());
      await step('relay close', () => relay.close());
      await step('models close', () => modelDefaults.close());
      await step('permissions close', () => permissionDefaults.close());
      await step('startup close', async () => {
        await startupStore.close();
        await runState.close();
      });
      await step('downlink close', () => downlink.close());
      await step('propellant close', () => propellant.close());
      await step('quota close', () => quota.close());
      await step('prices close', () => prices.close());
      await step('telemetry close', () => telemetry.close());
      await step('rollout close', () => rollout.close());
      await step('clearance close', () => clearance.close());
      await step('home close', () => home.close());
    };
    const stopWith = (leave: boolean): Promise<void> => {
      stopping ??= (async () => {
        let timer: NodeJS.Timeout | undefined;
        const tooLong = new Promise<void>((done) => {
          timer = setTimeout(() => {
            log.warn(`shutdown did not finish within ${SHUTDOWN_MAX_MS} ms`);
            done();
          }, SHUTDOWN_MAX_MS);
        });
        await Promise.race([shutdown(leave), tooLong]);
        clearTimeout(timer);
      })();
      return stopping;
    };
    const stop = (): Promise<void> => stopWith(false);
    const release = async (): Promise<void> => {
      // fails closed: a hold that is not on disk would be released by the new server
      if (remote !== null) hubInstance.saveHoldsNow();
      await stopWith(remote !== null);
    };

    log.info(`listening on ${addr.host.includes(':') ? `[${addr.host}]` : addr.host}:${addr.port}, home ${home.dir}`);
    running = {
      url: `http://${displayHost(host)}:${addr.port}/#token=${home.browserToken}`,
      host: addr.host,
      port: addr.port,
      browserToken: home.browserToken,
      home: home.dir,
      stop,
      release,
    };
  } catch (e) {
    // a failed start leaves no listening port, no process and no lock
    const quietly = async (what: string, run: () => Promise<void> | undefined): Promise<void> => {
      try {
        await run();
      } catch (err) {
        log.error(`${what} failed`, err);
      }
    };
    // with a pty host, a failed start leaves the agents running there (they may be ones a reload meant to keep)
    const leave = terminals !== undefined && 'disconnect' in terminals;
    if (hubStarting) await quietly('hub shutdown', async () => (leave ? hub?.release() : hub?.shutdown()));
    await quietly('web server close', () => web?.close());
    await quietly('terminal shutdown', async () => (leave ? (terminals as RemoteTerminalHost).disconnect() : terminals?.stopAll()));
    await quietly('home close', () => home.close());
    throw e;
  }
  return running;
}

/* ---------------------------------------------------------------- the CLI */

/** An error a client or a vanished terminal can cause: logged, never fatal (contract 2.8). */
export function isTransientError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null || !('code' in e) || typeof e.code !== 'string') return false;
  const code = e.code;
  return (TRANSIENT_ERROR_CODES as readonly string[]).includes(code) || TRANSIENT_ERROR_PREFIXES.some((p) => code.startsWith(p));
}

function exit(code: number): void {
  process.exit(code);
}

let streamsGuarded = false;

/** A closed terminal or pipe must not end the agents: the logger and the fatal handler write to these same streams. */
function guardStreams(): void {
  if (streamsGuarded) return;
  streamsGuarded = true;
  process.stdout.on('error', () => undefined);
  process.stderr.on('error', () => undefined);
}

function logLevel(value: string | undefined): LogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error' ? value : 'info';
}

function installProcessHandlers(running: Running, log: Logger, argv: string[] = [], entry?: string): void {
  let signalled = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (signalled) {
      exit(130);
      return;
    }
    signalled = true;
    log.info(`${signal} received; stopping`);
    void running
      .stop()
      .catch((e: unknown) => log.error('stop failed', e))
      .finally(() => exit(0));
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, onSignal);

  // gonogo reload: this server lets go of the home and the port (the agents keep running in the pty host, or resume when there is none),
  // then the installed gonogo starts with the same arguments
  let reloading = false;
  process.on('SIGUSR2', () => {
    if (reloading || signalled) return;
    reloading = true;
    log.info('reloading: handing over to a new gonogo');
    void running
      .release()
      .then(
        () => {
          relaunch(argv, entry);
          exit(0);
        },
        (e: unknown) => {
          // nothing was let go of: this server goes on
          reloading = false;
          log.error('reload refused', e);
        },
      );
  });

  // the last resort, not the policy: every agent dies with the server
  let failing = false;
  const onFatal = (what: string, error: unknown): void => {
    if (isTransientError(error)) {
      log.warn(`${what} ignored: a client or a terminal caused it`, error);
      return;
    }
    log.error(`${what}; stopping`, error);
    if (failing) return;
    failing = true;
    void running
      .stop()
      .catch((e: unknown) => log.error('stop failed', e))
      .finally(() => exit(1));
  };
  process.on('uncaughtException', (error) => onFatal('uncaught exception', error));
  process.on('unhandledRejection', (reason) => onFatal('unhandled rejection', reason));
}

export async function main(argv: string[], env: Env = process.env): Promise<void> {
  guardStreams();

  // `gonogo tui` is a client of a server that runs already: it starts nothing here
  if (argv[0] === 'tui') {
    const { tuiMain } = await import('./tui-cli.js');
    exit(await tuiMain(argv.slice(1), env));
    return;
  }

  const parsed = parseArgs(argv);
  if (parsed.kind === 'help') {
    process.stdout.write(USAGE);
    exit(0);
    return;
  }
  if (parsed.kind === 'version') {
    process.stdout.write(`gonogo ${packageVersion()}\n`);
    // From the file the last check left, never from the network; nothing when the check is off.
    const latest = updateCheckOff(env.GONOGO_UPDATE_CHECK) || argv.includes('--no-update-check') ? null : cachedLatest(homeOf(env));
    if (latest !== null && isNewer(latest, packageVersion())) process.stdout.write(`${latest} is out. To update, run: gonogo update\n`);
    exit(0);
    return;
  }
  if (parsed.kind === 'doctor') {
    const checks = await checkEngines(env);
    process.stdout.write(formatDoctor(checks, env.GONOGO_AGENT_CMD?.trim() || null));
    // the same refusal as the start: no claude and nothing in its place
    exit(checks.find((c) => c.provider === 'claude')?.path === null && !env.GONOGO_AGENT_CMD?.trim() ? 1 : 0);
    return;
  }
  if (parsed.kind === 'update') {
    const current = packageVersion();
    const latest = cachedLatest(homeOf(env));
    const { command, docker } = installInfo();
    process.stdout.write(updateText(command, docker, { current, latest, newer: latest !== null && isNewer(latest, current) }));
    exit(0);
    return;
  }
  if (parsed.kind === 'ptyhost') {
    try {
      await runPtyHost(resolve(parsed.home), createLogger({ level: logLevel(env.GONOGO_LOG_LEVEL) }));
    } catch (e) {
      process.stderr.write(`gonogo ptyhost: ${e instanceof Error ? e.message : String(e)}\n`);
      exit(1);
    }
    return;
  }
  if (parsed.kind === 'reload') {
    try {
      process.stdout.write(`${requestReload(parsed.home === undefined ? homeOf(env) : resolve(parsed.home))}\n`);
      exit(0);
    } catch (e) {
      process.stderr.write(`gonogo reload: ${e instanceof Error ? e.message : String(e)}\n`);
      exit(1);
    }
    return;
  }
  if (parsed.kind === 'error') {
    process.stderr.write(`gonogo: ${parsed.message}\n\n${USAGE}`);
    exit(2);
    return;
  }

  const level = logLevel(env.GONOGO_LOG_LEVEL);
  const log = createLogger({ level });
  // shortcut: a signal during the start-up (about a second) takes Node's default and ends the process at once; the ptys hang up on their children and the next start replaces the stale lock
  let running: Running;
  // started by a reload: the old gonogo may still hold the home and the port for a moment
  const reloaded = env.GONOGO_RELOADED === '1';
  delete process.env.GONOGO_RELOADED;
  for (let attempt = 0; ; attempt += 1) {
    try {
      running = await startGonogo({ ...parsed.options, updateCheck: parsed.options.updateCheck ?? !updateCheckOff(env.GONOGO_UPDATE_CHECK), env: reloaded ? { ...env, GONOGO_RELOADED: undefined } : env, log });
      break;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (reloaded && attempt < 20 && /another gonogo is using|EADDRINUSE/.test(message)) {
        await new Promise((done) => setTimeout(done, 500));
        continue;
      }
      process.stderr.write(`gonogo: ${message}\n`);
      if (level === 'debug' && e instanceof Error && e.stack) process.stderr.write(e.stack + '\n');
      exit(1);
      return;
    }
  }
  installProcessHandlers(running, log, process.argv.slice(2), process.argv[1]);
  process.stdout.write(`gonogo ready: ${running.url}\n`);
  // a log line (stderr, GONOGO_LOG_LEVEL): stdout holds the one `gonogo ready:` line that scripts parse
  log.info(`docs: ${DOCS_URL}`);
}
