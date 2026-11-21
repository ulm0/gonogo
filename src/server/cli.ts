import { randomUUID } from 'node:crypto';
import { accessSync, constants as fsConstants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { stat } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCS_URL, PROTOCOL_VERSION } from '../shared/protocol.js';
import { MAX_AGENTS, providerInfo } from '../shared/protocol.js';
import type { AuditRecord, DownlinkNotify, Hub, HubIo, InstallKind, Logger, ServerInfo, Task, TerminalHost } from '../shared/protocol.js';
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
  AGENTS_DIR,
} from './constants.js';
import type { LogLevel } from './constants.js';
import { audited, AUTOUPDATE_AUDIT, FEATURES_AUDIT, COAUTHOR_AUDIT, RULES_AUDIT, SUBAGENTS_AUDIT, STARTUP_AUDIT, PERMISSIONS_AUDIT, PAYLOAD_DEFAULTS_AUDIT, ROOM_KEYS_AUDIT, BOARD_AUDIT, DOCKING_AUDIT, HUB_AUDIT, LIVERIES_AUDIT, MISSIONS_AUDIT, pollText, PRICES_AUDIT, PROPELLANT_AUDIT, RELAY_AUDIT, RELIEF_AUDIT, REVIEW_AUDIT, ROOM_AUDIT, SCHEDULES_AUDIT, TABNAME_AUDIT, TASKS_AUDIT, tripText, UPLINKS_AUDIT } from './audited.js';
import { createBlackBox } from './blackbox.js';
import { createBoard } from './board.js';
import { createDocking, stationName } from './docking.js';
import { createDownlink } from './downlink.js';
import { createHub } from './hub.js';
import { createHangar, createRoots } from './hangar.js';
import { createRecorder } from './recorder.js';
import { checkCleanRoom } from './cleanroom.js';
import { checkWorktree, removeWorktree, worktreeBranch, worktreePath, worktreeStatus } from './worktree.js';
import { acquireSupervisorLock, openHome } from './home.js';
import { createLauncher, parseAgentCmd } from './launcher.js';
import { createTerminalHost } from './terminal.js';
import { createRemoteTerminalHost } from './remoteterminal.js';
import type { RemoteTerminalHost } from './remoteterminal.js';
import { runDir } from './ptyhost.js';
import { TOKENS_FILE } from './ptyhostproto.js';
import { createHoldStore, relaunch, requestReload, rotateDirectorToken, runPtyHost, spawnHostProcess } from './reload.js';
import { createWebServer } from './web.js';
import { createReported } from './reported.js';
import { createPropellant } from './propellant.js';
import { createQuota } from './quota.js';
import { createTelegramPoll } from './telegrampoll.js';
import { createPrices } from './prices.js';
import { createTelemetry } from './telemetry.js';
import { createFeatureStore } from './features.js';
import { toolsOff } from '../shared/features.js';
import { pushEventOfHub, pushKindOf, pushLineOf } from './push.js';
import type { PushEvent } from './push.js';
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
import { createTriggers } from './triggers.js';
import { createTelegramFiles } from './telegramfiles.js';
import { createUplinks } from './uplinks.js';
import { checkEngines, formatDoctor, installedProviders, onPath } from './providers.js';
import { createClearance } from './clearance.js';
import { createRoomKeys } from './roomkeys.js';
import { createModelDefaults } from './models.js';
import { createPayloadDefaults } from './payloaddefaults.js';
import { createPermissionDefaults } from './permissions.js';
import { createRunState } from './runstate.js';
import { createStartupStore } from './startup.js';
import { createSubagentStore } from './subagents.js';
import { createCoauthorStore, doctorLine, gitVersion } from './coauthor.js';
import { createRules } from './rules.js';
import { doorTable } from './door.js';
import { cachedLatest, createRollout, installKind, installNote, isNewer, updateCheckOff, updateCommand, updateText } from './rollout.js';
import { verifyImage } from './attest.js';
import { createAutoUpdater, createAutoUpdateStore } from './autoupdate.js';
import type { AutoUpdater } from './autoupdate.js';
import { createUpdater } from './updater.js';
import { migrate, planMigration } from './mainmigrate.js';
import { addRoom, loadRooms, mainLayout, MAIN_ROOM, recordedMainHome, NO_SUPERVISOR_HINT, removeRoom, roomHome, supervisorRunning } from './rooms.js';
import { authCommand } from './authcli.js';
import { exposeCommand } from './exposecli.js';
import { startSupervisor } from './supervisor.js';
import type { Supervisor } from './supervisor.js';
import { dockerUpdateStatus, followResult, readResult, settleResult, viewOfResult, socketCall, SOCKET_PATH, STABLE_VERSION, swap, writeResult } from './dockerupdate.js';
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
  /** Addresses of reverse proxies whose X-Forwarded-For is believed (the login's failure buckets use the client address). Default: the split of env GONOGO_TRUSTED_PROXY on ","; none. */
  trustedProxies?: string[];
  /** Where the page is for people outside (docs/expose-spec.md): an https address for a public name. Default env GONOGO_PUBLIC_URL; none. */
  publicUrl?: string;
  /** The header that carries the client address from a trusted proxy: x-forwarded-for (default) or cf-connecting-ip. Default env GONOGO_CLIENT_IP_HEADER. */
  clientIpHeader?: string;
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
  /** Telegram inbound by long polling. Default false here, so that a test never reaches Telegram; `main` turns it on. */
  telegramPoll?: boolean;
  /** Live reload (opt-in for one release): the ptys live in a separate `gonogo ptyhost` process, so `gonogo reload` leaves the agents running. Default env GONOGO_PTY_HOST is "1" or "true". */
  ptyHost?: boolean;
  /** [node, entry] that starts the pty host, default the entry this process was started with. A test hands in its own. */
  ptyHostCommand?: string[];
  /** A room of the rooms supervisor: shut down gracefully when stdin ends, so a supervisor that is killed leaves no room running. */
  exitWithStdin?: boolean;
  /** This process is a room of the supervisor (`gonogo __room`): its browser token is `run/room-token`, new at each start, and it asks for the port it had. */
  roomChild?: boolean;
  /** A room of the supervisor: asks it over the pipe it holds whether another room is busy (a poll or Static fire open), for the Docker update. */
  askBusy?: (idle?: boolean) => Promise<{ busy: string | null; room: string | null }>;
}

export interface Running {
  /** The printed URL, with the #token fragment. */
  url: string;
  /** The bound address. */
  host: string;
  port: number;
  browserToken: string;
  home: string;
  /** A login alert of the supervisor (docs/login-spec.md R4): the Director's inbox and Relay, as a `redline` event. */
  alert(text: string): void;
  /** The open pages hear it (the room's Downlink), and nothing else: no Relay, no phone, no Black Box. */
  notice(text: string): void;
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
       gonogo tui [--room <id>] [--url <address>] [--token <token>] [--home <dir>]
       gonogo rooms add <id> [--name <text>] | list | remove <id> [--home <dir>]
      gonogo rooms migrate-main [--dry-run | --undo] [--home <dir>]
       gonogo token rotate [--home <dir>]
       gonogo auth reset | status | key add|list|revoke | confirm [--home <dir>]
       gonogo expose <tailscale|cloudflare|caddy|funnel|ngrok> --public-url https://<name> [--write]  |  gonogo expose check

Run mission control for Claude Code agents from a browser tab: one front port, one process per room (room "main" is the home itself).

Commands:
  doctor                list the agent CLIs on the PATH with their versions, and the install command of each missing one
  rooms                 add, list or remove rooms (the page's room list does the same); "gonogo rooms" alone is "gonogo", kept for one release
  token rotate          make a new Director token (the old one stops working; not once a login account exists)
  auth                  the login account: reset it, make API keys, confirm after a tamper alarm (gonogo auth --help)
  expose                print (or write) the config that publishes gonogo through a tunnel or proxy, and check the public address (docs: Expose); it runs nothing
  reload                hand over to the installed gonogo without stopping the agents (needs --pty-host; not in Docker)
  tui                   a terminal client of a running gonogo: the room, the inbox, go and no-go, and a console (gonogo tui --help)
  update                print the command that updates gonogo the way it was installed (it never runs it)

Options:
  --port <n>            the front port (default ${DEFAULT_PORT}; env GONOGO_PORT)
  --host <addr>         the front port's bind address (default ${DEFAULT_HOST}; env GONOGO_HOST)
  --home <dir>          state directory (default ~/${DEFAULT_HOME_DIRNAME}; env GONOGO_HOME)
  --pty-host            keep the agents in a separate process so that gonogo reload does not stop them (env GONOGO_PTY_HOST=1)
  --seed-claude         record Claude's folder trust and skip its startup dialogs (env GONOGO_SEED_CLAUDE=1)
  --trusted-proxy <ip>  believe X-Forwarded-For from this reverse proxy's address; repeatable (env GONOGO_TRUSTED_PROXY, comma list)
  --allow-host <name>   accept this Host name too, for a reverse proxy; repeatable (env GONOGO_ALLOWED_HOSTS, comma list).
                        "name:hooks" serves only the webhooks (/uplink, /dock) there: no page, no login
  --public-url <url>    the address other machines reach this gonogo by: its page, or for a name:hooks host its webhooks; https for a public name (env GONOGO_PUBLIC_URL)
  --client-ip-header <h>  x-forwarded-for (default) or cf-connecting-ip: the header a trusted proxy puts the client address in (env GONOGO_CLIENT_IP_HEADER)
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
  | { kind: 'room'; options: StartOptions }
  | { kind: 'token'; home?: string }
  | { kind: 'auth'; args: string[]; home?: string }
  | { kind: 'expose'; args: string[]; home?: string }
  | { kind: 'rooms'; action: 'add' | 'list' | 'remove'; id?: string; name?: string; home?: string }
  | { kind: 'migrate-main'; mode: 'move' | 'dry-run' | 'undo'; home?: string }
  | { kind: 'selfupdate'; target: string; expect: string; home: string; image: string }
  | { kind: 'run'; options: StartOptions }
  | { kind: 'error'; message: string };

const VALUE_FLAGS = ['--port', '--host', '--home', '--allow-host', '--trusted-proxy', '--public-url', '--client-ip-header'];
export const CLIENT_IP_HEADERS = ['x-forwarded-for', 'cf-connecting-ip'] as const;

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
  // the hidden entry of a room: what `gonogo` was before it became the supervisor; main() refuses it without the pipe the supervisor holds
  if (argv[0] === '__room') {
    const room = parseArgs(argv.slice(1));
    return room.kind === 'run' ? { kind: 'room', options: { ...room.options, roomChild: true } } : room;
  }
  if (argv[0] === 'auth' || argv[0] === 'expose') {
    const args: string[] = [];
    let home: string | undefined;
    for (let i = 1; i < argv.length; i += 1) {
      if (argv[i] === '--home') {
        home = argv[i + 1];
        if (home === undefined || home === '') return { kind: 'error', message: '--home needs a directory' };
        i += 1;
      } else args.push(argv[i] as string);
    }
    return { kind: argv[0], args, ...(home === undefined ? {} : { home }) };
  }
  if (argv[0] === 'token') {
    if (argv[1] !== 'rotate') return { kind: 'error', message: 'token needs rotate' };
    if (argv.length === 2) return { kind: 'token' };
    if (argv.length === 4 && argv[2] === '--home' && argv[3] !== '') return { kind: 'token', home: argv[3] };
    return { kind: 'error', message: 'token rotate takes only --home <dir>' };
  }
  if (argv[0] === 'rooms') {
    const action = argv[1];
    if (action === 'migrate-main') {
      const out: { kind: 'migrate-main'; mode: 'move' | 'dry-run' | 'undo'; home?: string } = { kind: 'migrate-main', mode: 'move' };
      const rest = argv.slice(2);
      for (let i = 0; i < rest.length; i += 1) {
        const arg = rest[i] ?? '';
        if (arg === '--dry-run' && out.mode === 'move') out.mode = 'dry-run';
        else if (arg === '--undo' && out.mode === 'move') out.mode = 'undo';
        else if (arg === '--home' && rest[i + 1] !== undefined && rest[i + 1] !== '') {
          out.home = rest[i + 1];
          i += 1;
        } else return { kind: 'error', message: `rooms migrate-main: unexpected ${arg} (use --dry-run or --undo, not both)` };
      }
      return out;
    }
    // `gonogo rooms` alone (or with flags) is what `gonogo` is now; kept for one release
    if (action !== 'add' && action !== 'list' && action !== 'remove') return parseArgs(argv.slice(1));
    const rest = argv.slice(2);
    const out: { kind: 'rooms'; action: 'add' | 'list' | 'remove'; id?: string; name?: string; home?: string } = { kind: 'rooms', action };
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i] ?? '';
      if ((arg === '--home' || arg === '--name') && rest[i + 1] !== undefined && rest[i + 1] !== '') {
        if (arg === '--home') out.home = rest[i + 1];
        else out.name = rest[i + 1];
        i += 1;
      } else if (!arg.startsWith('-') && out.id === undefined && action !== 'list') {
        out.id = arg;
      } else {
        return { kind: 'error', message: `rooms ${action}: unexpected ${arg}` };
      }
    }
    if (action !== 'list' && out.id === undefined) return { kind: 'error', message: `rooms ${action} needs a room id` };
    return out;
  }
  if (argv[0] === 'self-update') {
    // the helper container's command (docs/self-update-spec.md): exactly these five options, nothing else
    const rest = argv.slice(1);
    const got: Record<string, string> = {};
    for (let i = 0; i < rest.length; i += 2) {
      const flag = rest[i] ?? '';
      if (!['--target', '--expect', '--home', '--image'].includes(flag) || rest[i + 1] === undefined || flag in got) return { kind: 'error', message: `self-update takes --target, --expect, --home and --image once each` };
      got[flag] = rest[i + 1] ?? '';
    }
    const { '--target': target, '--expect': expect, '--home': home, '--image': image } = got;
    if (target === undefined || expect === undefined || home === undefined || image === undefined) return { kind: 'error', message: 'self-update needs --target, --expect, --home and --image' };
    if (!/^[0-9a-f]{12,64}$/.test(target) || !STABLE_VERSION.test(expect) || image === '') return { kind: 'error', message: 'self-update: the target must be a container id and the version a release number' };
    return { kind: 'selfupdate', target, expect, home, image };
  }
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
  const trustedProxies: string[] = [];
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
    if (arg === '--exit-with-stdin') {
      options.exitWithStdin = true;
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
        case '--public-url':
          if (value.trim() === '') throw new Error('--public-url needs an address');
          options.publicUrl = value.trim();
          break;
        case '--client-ip-header':
          if (!(CLIENT_IP_HEADERS as readonly string[]).includes(value.trim().toLowerCase())) throw new Error(`--client-ip-header is ${CLIENT_IP_HEADERS.join(' or ')}`);
          options.clientIpHeader = value.trim().toLowerCase();
          break;
        case '--trusted-proxy':
          if (value.trim() === '') throw new Error('--trusted-proxy needs an address');
          trustedProxies.push(value.trim());
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
  if (trustedProxies.length > 0) options.trustedProxies = trustedProxies;
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
  trustedProxies: string[];
  publicUrl: string | null;
  clientIpHeader: string;
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
    trustedProxies:
      options.trustedProxies ??
      (env.GONOGO_TRUSTED_PROXY ?? '')
        .split(',')
        .map((h) => h.trim())
        .filter((h) => h !== ''),
    publicUrl: (options.publicUrl ?? env.GONOGO_PUBLIC_URL ?? '').trim() || null,
    clientIpHeader: (options.clientIpHeader ?? env.GONOGO_CLIENT_IP_HEADER ?? '').trim().toLowerCase() || 'x-forwarded-for',
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

/** Whether this room is main in a home that keeps it in `rooms/main` (the folder says so, and so does the root's rooms.json). */
function mainLivesInRooms(dir: string): boolean {
  const root = dirname(dirname(dir));
  if (basename(dir) !== 'main' || basename(dirname(dir)) !== 'rooms') return false;
  try {
    return recordedMainHome(root) === 'rooms/main';
  } catch {
    return false;
  }
}

/** Room main's folder, where the update check keeps its cache: the root or `rooms/main`. A damaged rooms.json must not break `--version`: the root then. */
function mainHomeOf(env: Env): string {
  try {
    return roomHome(homeOf(env), MAIN_ROOM);
  } catch {
    return homeOf(env);
  }
}

/** The host of the printed URL: a wildcard bind is reached on loopback, an IPv6 address needs brackets (contract 0.5 item 14). */
function displayHost(host: string): string {
  if (['0.0.0.0', '::', '127.0.0.1'].includes(host)) return '127.0.0.1';
  return host.includes(':') ? `[${host}]` : host;
}

/** The port a room listened on last time (`<home>/run/port`), or null. 0.4.x ignores the file; it is harmless there. */
function readStablePort(homeDir: string): number | null {
  try {
    const port = Number(readFileSync(join(homeDir, 'run', 'port'), 'utf8').trim());
    return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

function writeStablePort(homeDir: string, port: number): void {
  try {
    mkdirSync(join(homeDir, 'run'), { recursive: true, mode: 0o700 });
    writeFileSync(join(homeDir, 'run', 'port'), `${port}\n`, { mode: 0o600 });
  } catch {
    // the next start asks for any port: only a reload that keeps agents needs this
  }
}

/** Whether a port can be bound on this host now (a throwaway listener). */
function portFree(port: number, host: string): Promise<boolean> {
  return new Promise((done) => {
    const probe = net.createServer();
    probe.once('error', () => done(false));
    probe.listen(port, host, () => probe.close(() => done(true)));
  });
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

  const home = openHome(settings.home, log, { roomToken: options.roomChild === true });
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

    const roomKeys = createRoomKeys({ dir: home.dir, log: log.child('room-keys') });
    await roomKeys.load();
    const clearance = createClearance({ dir: home.dir, log: log.child('clearance') });
    await clearance.load();
    const modelDefaults = createModelDefaults({ dir: home.dir, log: log.child('models') });
    await modelDefaults.load();
    const payloadDefaults = createPayloadDefaults({ dir: home.dir, log: log.child('payload') });
    await payloadDefaults.load();
    const permissionDefaults = createPermissionDefaults({ dir: home.dir, log: log.child('permissions') });
    await permissionDefaults.load();
    const runState = createRunState({ dir: home.dir, now: () => Date.now(), log: log.child('run state') });
    await runState.load();
    const startupStore = createStartupStore({ dir: home.dir, log: log.child('startup') });
    await startupStore.load();
    const coauthorStore = createCoauthorStore({ dir: home.dir, log: log.child('coauthor') });
    await coauthorStore.load();
    const rulesStore = createRules({ dir: home.dir, now: Date.now, log: log.child('rules') });
    await rulesStore.load();
    const subagentStore = createSubagentStore({ dir: home.dir, log: log.child('subagents') });
    await subagentStore.load();
    const launcher = createLauncher({
      homeDir: home.dir,
      tokensFile: remote ? join(runDir(home.dir), TOKENS_FILE) : null,
      hubUrl: () => baseUrl,
      seed,
      env,
      agentCmd,
      keys: (name) => clearance.values(name),
      roomKeys: (cleanRoom) => roomKeys.values(cleanRoom),
      defaultModel: (provider, position) => modelDefaults.resolve(provider, position),
      toolsOff: () => toolsOff(features.view().off),
      rules: () => rulesStore.text(),
      defaultEffort: () => modelDefaults.effort(),
      defaultPermissions: () => permissionDefaults.get(),
      payloadDefaults: () => payloadDefaults.get(),
      subagents: () => subagentStore.view(),
      coauthor: () => coauthorStore.view(),
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
    // what Claude Code itself says a session cost (its status line): kept beside the ledger, never mixed into it
    const reported = createReported({ dir: home.dir, now: () => Date.now(), log: log.child('reported') });
    await reported.load();
    const propellant = createPropellant({
      reported,
      dir: home.dir,
      plan: () => quota.view(),
      attribute: workingOn,
      prices: () => prices.table(),
      // the 80 % budget warning: the inbox and Relay, not the Black Box (it is not a trip)
      notify: (kind, text) => {
        downlink.post(kind, text);
        if (features.isOn('relay')) relay.event(kind, text);
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
    // stored keys whose name a later version reserves: not given to the agent, and the Director is told which (names only)
    const refusedKeys = [...clearance.refused().map((k) => `${k}`), ...roomKeys.refused().map((k) => `room: ${k}`)];
    if (refusedKeys.length > 0) {
      const head = 'gonogo no longer gives these keys to an agent, because their names are reserved now: ';
      const tail = '. They are kept aside in keys.refused.json and room-keys.refused.json (0600); set them under another name to use them again.';
      // up to 300 characters in all: the names that fit, then "and N more"
      let shown = refusedKeys.length;
      const text = (n: number): string => `${head}${refusedKeys.slice(0, n).join(', ')}${n < refusedKeys.length ? ` and ${refusedKeys.length - n} more` : ''}${tail}`;
      while (shown > 0 && text(shown).length > 300) shown -= 1;
      downlink.post('startup', text(shown));
    }
    // Feature toggles: every gate below asks this store, so a switch is the same for the page, the routes, the tools and the background work
    const features = createFeatureStore({ dir: home.dir, emit: (view) => web?.broadcast({ t: 'features', features: view }), context: () => ({ pollOpen: hubInstance.poll()?.status === 'open', running: hubInstance.views().filter((v) => v.state !== 'stopped').map((v) => v.name) }), changed: () => {
        hubInstance.refreshLimits();
        // a finished poll (go, hold, aborted) that nobody cleared would stay on the wall with its block gone: it goes with T-minus
        if (!features.isOn('tminus') && hubInstance.poll() !== null) {
          try {
            hubInstance.clearPoll();
          } catch (error) {
            log.warn('could not clear the finished poll', error);
          }
        }
      }, log: log.child('features') });
    await features.load();
    const relay = createRelay({
      dir: home.dir,
      now: () => Date.now(),
      fetch: options.fetch ?? ((url, init) => fetch(url, init)),
      sleep: (ms) => new Promise((done) => setTimeout(done, ms).unref()),
      log: log.child('relay'),
    });
    await relay.load();
    // push to the installed app (docs/features/mobile.md): the supervisor holds the key and the devices; this room only says, on its pipe, what waits for the Director
    const push = { send: (ev: PushEvent | null): void => void (ev !== null && options.roomChild === true && options.exitWithStdin === true && process.stdout.write(pushLineOf(ev))) };
    const blackBox = createBlackBox({
      dir: home.dir,
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms).unref(),
      clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
      path: env.PATH,
      log: log.child('black box'),
    });
    /** What the audit tables tell the Black Box (core: it cannot be switched off, so the audit trail has no gap). */
    const audit: AuditRecord = (kind, text) => blackBox.record(kind, text);
    /** What the parts of the server tell the Director's inbox goes to the targets of Relay too; a trip and a poll result go to the Black Box. */
    let phone: Phone | null = null;
    const tell: DownlinkNotify = (kind, text, ref) => {
      downlink.post(kind, text);
      if (features.isOn('relay')) relay.event(kind, text);
      const pushKind = pushKindOf(kind, text);
      if (pushKind !== null) push.send({ kind: pushKind, text });
      if (ref !== undefined) phone?.approval(ref, text);
      if (kind === 'redline') audit('redline', tripText(text));
      else if (kind === 'tminus') audit('poll', pollText(text));
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
      featureOn: (id) => features.isOn(id),
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
        if (features.isOn('relay')) relay.observe(event);
        push.send(pushEventOfHub(event));
      },
      notify: tell,
      log: log.child('hub'),
    };
    const hubInstance = createHub(io, { maxHops, bossDir: cwd, maxWorking, redline, defaultEngine: () => modelDefaults.engine() });
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
      ...(settings.publicUrl === null ? {} : { publicUrl: settings.publicUrl }),
    });
    // the history of triggers: what fired by itself or came in from outside (uplinks, polled Telegram, schedules, docking)
    const triggers = createTriggers({ dir: home.dir, now: io.now, log: log.child('triggers') });
    await triggers.load();
    const schedules = createSchedules({
      dir: home.dir,
      trigger: (entry) => triggers.record(entry),
      now: io.now,
      setTimer: io.setTimer,
      clearTimer: io.clearTimer,
      send: (request) => hubInstance.sendFromUser(request),
      enabled: () => features.isOn('launch-window'),
      emit: (list) => web?.broadcast({ t: 'schedules', schedules: list }),
      notify: tell,
      log: log.child('launch window'),
    });
    const telegramFiles = createTelegramFiles({ fetch: options.fetch ?? ((url, init) => fetch(url, init)), token: () => relay.telegramTarget()?.token ?? null, agentDir: (name) => home.agentDir(name), agentsRoot: join(home.dir, AGENTS_DIR), now: io.now, log: log.child('telegram files') });
    void telegramFiles.prune();
    const uplinks = createUplinks({
      dir: home.dir,
      trigger: (entry) => triggers.record(entry),
      now: io.now,
      send: (request, director) => (director === undefined ? hubInstance.sendFromUser(request) : hubInstance.sendFromDirector(request, director.channel, director.said)),
      emit: (list) => web?.broadcast({ t: 'uplinks', uplinks: list }),
      notify: tell,
      inbound: relay,
      fetchFile: (file, agent) => telegramFiles.fetchFile(file, agent),
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
    }), audit, MISSIONS_AUDIT);
    missionsRef = missions;
    const docking = createDocking({
      dir: home.dir,
      trigger: (entry) => triggers.record(entry),
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
      defaultEngine: () => modelDefaults.engine(),
      checkDirectory: io.checkDirectory,
      now: io.now,
      setTimer: io.setTimer,
      clearTimer: io.clearTimer,
      emit: (frame) => web?.broadcast(frame),
      notify: tell,
      log: log.child('relief'),
    });
    // Telegram inbound by long polling (no public address): room main's process only, one loop per gonogo, off while a Telegram uplink exists
    const telegramPoll = options.telegramPoll === true && (options.roomChild !== true || env.GONOGO_ROOM === 'main') ? createTelegramPoll({
      dir: home.dir,
      target: () => relay.telegramTarget(),
      hasUplink: () => uplinks.secretOf('telegram') !== null,
      deliver: (update, secret) => uplinks.deliverPolled(update, secret),
      fetch: options.fetch ?? ((url, init) => fetch(url, init)),
      sleep: (ms, signal) => new Promise<void>((done) => {
        const timer = setTimeout(done, ms);
        timer.unref();
        signal.addEventListener('abort', () => (clearTimeout(timer), done()), { once: true });
      }),
      now: io.now,
      log: log.child('telegram'),
    }) : null;
    if (telegramPoll !== null) {
      await telegramPoll.load();
      relay.setInbound(() => telegramPoll.state());
    }
    // the buttons of phone approvals are signed by the uplink's secret, or by the polling secret when there is no uplink
    phone = createPhone({ hub: audited(hubInstance, blackBox.record, HUB_AUDIT), relief, relay, secret: () => uplinks.secretOf('telegram') ?? telegramPoll?.secret() ?? null, now: io.now, log: log.child('phone') });
    // Update from the page: npm or pnpm global installs, or a container with an update hook (GONOGO_UPDATE_HOOK, optional GONOGO_UPDATE_HOOK_TOKEN)
    const installed = installInfo(env);
    const hookUrl = (env.GONOGO_UPDATE_HOOK ?? '').trim();
    // Docker self-update: the socket is there and this container can find itself and has a moving tag (docs/self-update-spec.md)
    const socketPath = env.GONOGO_DOCKER_SOCKET || SOCKET_PATH;
    const dockerCall = installed.kind === 'docker' && existsSync(socketPath) ? socketCall(socketPath) : null;
    // every room is a process of one gonogo: an update replaces them all (the container, or the install and a reload), so only room main, whose home
    // is the root where update.json is read after the swap, offers it; the others point to it
    const supervised = options.roomChild === true;
    const isMain = !supervised || env.GONOGO_ROOM === 'main';
    const dockerStatus = dockerCall === null ? undefined : !isMain ? { ready: false, text: 'update from the main room: this container holds every room' } : await dockerUpdateStatus(dockerCall, hostname());
    const canUpdate = isMain && (installed.kind === 'npm' || installed.kind === 'pnpm' || (installed.kind === 'docker' && (dockerStatus?.ready === true || /^https?:\/\//.test(hookUrl))));
    // what the last self-update left: shown until the Director goes on
    const found = dockerCall === null ? null : await readResult(home.dir);
    const lastResult = dockerCall === null || found === null ? null : await settleResult(dockerCall, home.dir, found, hostname());
    const rollout = createRollout({
      dir: home.dir,
      now: io.now,
      fetch: options.fetch ?? ((url, init) => fetch(url, init)),
      enabled: options.updateCheck === true,
      current: version,
      command: installed.command,
      install: installed.kind,
      installNote: isMain ? installNote(installed.kind, canUpdate, dockerStatus) : 'This room is one of several in one gonogo: update from the main room.',
      canUpdate,
      selfUpdate: dockerStatus?.ready === true,
      ...(lastResult === null || Date.now() - lastResult.at > 24 * 3_600_000 ? {} : { update: viewOfResult(lastResult) }),
      emit: (view) => web?.broadcast({ t: 'rollout', rollout: view }),
      log: log.child('rollout'),
    });
    await rollout.load();
    // booted in the middle of a swap: follow update.json to its end, so the strip shows the result and UNDO without a restart
    let closing = false;
    if (dockerCall !== null && lastResult?.state === 'started') {
      void followResult(dockerCall, home.dir, hostname(), lastResult, { onChange: (r) => rollout.setUpdate(viewOfResult(r)), stopped: () => closing }).catch(() => undefined);
    }
    const triggerReload = (): boolean => {
      if (supervised) {
        // a room does not restart itself: it asks its supervisor, which reloads every room and re-executes (docs/single-mode-spec.md, 6)
        const parent = Number(env.GONOGO_SUPERVISOR_PID);
        if (!Number.isInteger(parent) || parent <= 0 || parent !== process.ppid || installed.docker) return false;
        setTimeout(() => process.kill(parent, 'SIGUSR2'), 100).unref();
        return true;
      }
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
      notify: (text) => tell('update', text),
      ...(dockerCall === null || dockerStatus?.ready !== true ? {} : { docker: { call: dockerCall, hostname: hostname(), home: home.dir, mainInRooms: mainLivesInRooms(home.dir), ready: true, verify: (prepared, target) => verifyImage(prepared.repo, prepared.repoDigests, { version: target, ...(existsSync(join(home.dir, 'gh')) ? { configDir: join(home.dir, 'gh') } : {}) }), busy: async () => (hubInstance.poll()?.status === 'open' ? 'a T-minus poll or Static fire is running: wait for its answer, then update' : supervised && options.askBusy !== undefined ? (await options.askBusy()).busy : null) } }),
      hook: /^https?:\/\//.test(hookUrl) ? { url: hookUrl, token: (env.GONOGO_UPDATE_HOOK_TOKEN ?? '').trim() || null } : null,
      fetch: options.fetch ?? ((url, init) => fetch(url, init)),
      log: log.child('update'),
    });
    // auto-update (docs/features/update.md): room main under a Docker install with the socket; nothing here updates by itself unless the Director turned it on
    const autoStore = createAutoUpdateStore({ dir: home.dir, env, log: log.child('autoupdate') });
    await autoStore.load();
    const hubBusy = (): string | null => {
      if (hubInstance.poll()?.status === 'open') return 'a T-minus poll or Static fire is open';
      const active = hubInstance.views().find((v) => v.state === 'working' || v.state === 'needs_you' || v.state === 'starting' || v.transition !== null || v.queued > 0);
      return active === undefined ? null : `${active.name} is ${active.state === 'needs_you' ? 'waiting for you' : active.state === 'working' ? 'working' : 'starting or has mail queued'}`;
    };
    const autoUpdater: AutoUpdater = createAutoUpdater({
      store: autoStore,
      rollout,
      current: version,
      unavailable: () => (!isMain ? 'only room main updates' : installed.kind !== 'docker' ? 'auto-update is for the Docker install' : dockerStatus?.ready === true ? null : (dockerStatus?.text ?? 'needs the Docker socket')),
      busy: async () => hubBusy() ?? (supervised && options.askBusy !== undefined ? (await options.askBusy(true)).busy : null),
      start: (target) => updater.start(target, { auto: true }),
      updating: () => ['running', 'handed-off', 'reloading'].includes(rollout.view().update?.state ?? ''),
      readResult: () => readResult(home.dir),
      notify: (text) => tell('update', text),
      now: () => io.now(),
      log: log.child('autoupdate'),
    });
    const autoApi = isMain
      ? {
          view: () => autoUpdater.view(),
          set: async (input: unknown) => {
            await autoStore.set(input);
            void autoUpdater.tick();
            return autoUpdater.view();
          },
          skip: async (target: string) => {
            await autoStore.skip(target);
            void autoUpdater.tick();
            return autoUpdater.view();
          },
        }
      : undefined;
    // a room under the supervisor asks for the port it had: agents that survive a reload keep the hook and MCP address they were started with
    // (the pty host keeps them running), and a new port would leave them talking to nothing. When it is taken a free port is used, and the agents must be restarted.
    let listenPort = port;
    if (options.roomChild === true && port === 0) {
      const kept = readStablePort(home.dir);
      if (kept !== null && (await portFree(kept, host))) listenPort = kept;
      else if (kept !== null) log.warn(`the port this room had (${kept}) is taken: using another; agents started before must be restarted to find the hub`);
    }
    const webServer = createWebServer({
      statusLine: (name, body) => {
        reported.record(name, body);
        if (quota.report(name, body)) web?.broadcast({ t: 'propellant', propellant: propellant.view() });
      },
      host,
      port: listenPort,
      browserToken: home.browserToken,
      // a room of the supervisor has no TCP credential for its page: the supervisor reaches it by this socket (docs/login-spec.md R8)
      ...(options.roomChild === true ? { localSocket: join(home.dir, 'run', 'room.sock') } : {}),
      allowedHosts,
      staticDir,
      // what the Director does through the browser is told to the Black Box by these copies
      hub: audited(hubInstance, audit, HUB_AUDIT),
      terminals: terminalHost,
      resolveToken: (token) => launcher.resolveToken(token),
      info,
      isReady: () => ready,
      propellant: audited(propellant, audit, PROPELLANT_AUDIT),
      prices: audited(prices, audit, PRICES_AUDIT),
      triggers,
      // a changed price or budget is checked at once, not at the next reply
      spendChanged: () => {
        propellant.recheck();
        for (const v of hub?.views() ?? []) if (v.provider === 'claude') enforce(v.name);
      },
      telemetry,
      schedules: audited(schedules, audit, SCHEDULES_AUDIT),
      uplinks: audited(uplinks, audit, UPLINKS_AUDIT),
      tasks,
      missions,
      room,
      tabName,
      downlink,
      missionLog,
      massBudget,
      board: audited(board, audit, BOARD_AUDIT),
      blackBox,
      liveries: audited(liveries, audit, LIVERIES_AUDIT),
      relay: audited(relay, audit, RELAY_AUDIT),
      models: modelDefaults,
      features: audited(features, audit, FEATURES_AUDIT),
      roomKeys: audited(roomKeys, blackBox.record, ROOM_KEYS_AUDIT),
      payloadDefaults: audited(payloadDefaults, blackBox.record, PAYLOAD_DEFAULTS_AUDIT),
      permissions: audited(permissionDefaults, blackBox.record, PERMISSIONS_AUDIT),
      startup: audited(startupStore, blackBox.record, STARTUP_AUDIT),
      ...(autoApi === undefined ? {} : { autoUpdate: audited(autoApi, blackBox.record, AUTOUPDATE_AUDIT) }),
      subagents: audited(subagentStore, blackBox.record, SUBAGENTS_AUDIT),
      coauthor: audited(coauthorStore, blackBox.record, COAUTHOR_AUDIT),
      rules: audited(rulesStore, blackBox.record, RULES_AUDIT),
      docking: audited(docking, blackBox.record, DOCKING_AUDIT),
      relief: audited(relief, blackBox.record, RELIEF_AUDIT),
      rollout,
      // only a gonogo started from the command line has the signal handler that does the hand-over; a test or an embedder has not
      // only room main updates (and so only main can reach an update hook or the Docker socket through the page); the others answer 409
      ...(isMain ? { update: (version: unknown, how?: { unverified?: boolean }) => updater.start(version, how), undoUpdate: () => updater.undo() } : {}),
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
    if (options.roomChild === true) writeStablePort(home.dir, addr.port);
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
    audit('audit', `gonogo ${version} started`);
    await liveries.load();
    await docking.load();
    hubStarting = true;
    await hubInstance.start();
    await schedules.load();
    await uplinks.load();
    ready = true;
    docking.start();
    rollout.start();
    if (isMain) await autoUpdater.start();
    telegramPoll?.start();

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
      await step('triggers close', () => triggers.close());
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
      audit('audit', 'gonogo stopped');
      await step('black box close', () => blackBox.close());
      await step('livery close', () => liveries.close());
      await step('relief close', async () => relief.close());
      await step('telegram polling close', async () => telegramPoll?.stop());
      await step('relay close', () => relay.close());
      await step('models close', () => modelDefaults.close());
      await step('features close', () => features.close());
      await step('payload defaults close', () => payloadDefaults.close());
      await step('permissions close', () => permissionDefaults.close());
      await step('subagents close', () => subagentStore.close());
      await step('coauthor close', () => coauthorStore.close());
      await step('rules close', () => rulesStore.close());
      await step('startup close', async () => {
        await startupStore.close();
        await runState.close();
      });
      await step('downlink close', () => downlink.close());
      await step('propellant close', () => propellant.close());
      await step('reported close', () => reported.close());
      closing = true;
      await step('quota close', () => quota.close());
      await step('prices close', () => prices.close());
      await step('telemetry close', () => telemetry.close());
      await step('rollout close', () => rollout.close());
      autoUpdater.close();
      await step('autoupdate close', () => autoStore.close());
      await step('room keys close', () => roomKeys.close());
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
      url: `http://${displayHost(host)}:${addr.port}/${options.roomChild === true ? '' : `#token=${home.browserToken}`}`,
      host: addr.host,
      port: addr.port,
      browserToken: home.browserToken,
      home: home.dir,
      alert: (text) => tell('redline', text.slice(0, 300)),
      notice: (text) => downlink.post('redline', text.slice(0, 300)),
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

/**
 * `gonogo rooms migrate-main`: moves room main of an old home into rooms/main (`--undo`: back; `--dry-run`: only says what would move). Moving needs
 * the supervisor lock, so gonogo must be stopped; the page's MIGRATE NOW and UNDO do the same at the next start.
 */
async function runMigrateMainCommand(parsed: Extract<ParsedArgs, { kind: 'migrate-main' }>, env: Env): Promise<void> {
  const root = parsed.home === undefined ? homeOf(env) : resolve(parsed.home);
  const direction = mainLayout(root) === '.' ? 'forward' : 'undo';
  if (parsed.mode === 'dry-run') {
    const plan = await planMigration(root, direction, { running: false });
    process.stdout.write(`${direction === 'forward' ? 'would move' : 'would move back'} ${plan.entries.length} of room main's files from ${plan.from} to ${plan.to}\n`);
    for (const name of plan.entries) process.stdout.write(`  ${name}\n`);
    if (plan.removes.length > 0) process.stdout.write(`first it removes these leftover worktrees (clean, branch merged; git worktree remove, the branches are kept):\n${plan.removes.map((p) => `  ${p}`).join('\n')}\n`);
    if (plan.stays.length > 0) process.stdout.write(`stay where they are (not main's, or not known): ${plan.stays.join(', ')}\n`);
    if (plan.problems.length > 0) process.stdout.write(`it would NOT be done now:\n${plan.problems.map((p) => `  - ${p}`).join('\n')}\n`);
    else process.stdout.write('nothing stops it. Stop gonogo, then run it without --dry-run (or press MIGRATE NOW on the rooms page).\n');
    exit(plan.problems.length > 0 ? 1 : 0);
    return;
  }
  const want = parsed.mode === 'undo' ? 'undo' : 'forward';
  if (want !== direction) {
    process.stderr.write(want === 'undo' ? 'gonogo rooms migrate-main: room main is at the root of this home, there is nothing to undo\n' : 'gonogo rooms migrate-main: room main already lives in rooms/main\n');
    exit(1);
    return;
  }
  let release: () => void;
  try {
    release = acquireSupervisorLock(root);
  } catch (error) {
    process.stderr.write(`gonogo rooms migrate-main: gonogo is running for this home (${error instanceof Error ? error.message : String(error)}). Stop it first, or press ${want === 'undo' ? 'UNDO' : 'MIGRATE NOW'} on the rooms page: it is done at the next start.\n`);
    exit(1);
    return;
  }
  try {
    const result = await migrate(root, want);
    if (result.ok) process.stdout.write(`moved ${result.moved} of room main's files ${want === 'undo' ? `back to ${root}` : `into ${join(root, 'rooms', 'main')}`}. Nothing else was touched.\n`);
    else process.stderr.write(`not moved; the home is as it was:\n${result.problems.map((p) => `  - ${p}`).join('\n')}\n`);
    exit(result.ok ? 0 : 1);
  } finally {
    release();
  }
}

/** `gonogo rooms add|list|remove`: edits rooms.json. */
async function runRoomsCommand(parsed: Extract<ParsedArgs, { kind: 'rooms' }>, env: Env): Promise<void> {
  const root = parsed.home === undefined ? homeOf(env) : resolve(parsed.home);
  if (parsed.action === 'add') {
    const room = addRoom(root, parsed.id, parsed.name);
    process.stdout.write(`added room ${room.id} (${room.name}). A running gonogo starts it within 2 seconds; its files will be in ${roomHome(root, room.id)}\n`);
  } else if (parsed.action === 'remove') {
    removeRoom(root, parsed.id);
    process.stdout.write(`took room ${parsed.id} off the list. Its folder ${roomHome(root, parsed.id as string)} stays; delete it yourself if you want it gone.\n`);
  } else {
    for (const room of loadRooms(root)) process.stdout.write(`${room.id}\t${room.name}\t${roomHome(root, room.id)}\n`);
  }
  // a change that nothing reads is the commonest mistake: nothing acts on rooms.json unless gonogo runs
  if (parsed.action !== 'list' && !(await supervisorRunning(root))) process.stdout.write(`${NO_SUPERVISOR_HINT}\n`);
  exit(0);
}

/** The arguments a room is started with beyond its own (the front port's flags that rooms inherit). */
export function roomArgsOf(options: StartOptions, publicUrl: string | null = null): string[] {
  return [...(publicUrl === null ? [] : ['--public-url', publicUrl]),...(options.ptyHost === true ? ['--pty-host'] : []), ...(options.updateCheck === false ? ['--no-update-check'] : []), ...(options.seed === true ? ['--seed-claude'] : [])];
}

/** `gonogo`: the supervisor. The front port, the room list and one `gonogo __room` process per room. */
async function runSupervisor(parsed: Extract<ParsedArgs, { kind: 'run' }>, env: Env): Promise<void> {
  const settings = resolveSettings(parsed.options);
  const level = logLevel(env.GONOGO_LOG_LEVEL);
  const log = createLogger({ level });
  // started by a reload: the old supervisor may still hold the port for a moment
  const reloaded = env.GONOGO_RELOADED === '1';
  let supervisor: Supervisor | undefined;
  for (let attempt = 0; ; attempt += 1) {
    try {
      supervisor = await startSupervisor({
        home: settings.home,
        host: settings.host,
        port: settings.port,
        allowedHosts: settings.allowedHosts,
        trustedProxies: settings.trustedProxies,
        ...(settings.publicUrl === null ? {} : { publicUrl: settings.publicUrl }),
        clientIpHeader: settings.clientIpHeader,
        inContainer: installInfo(env).docker,
        command: [process.execPath, process.argv[1] ?? 'gonogo'],
        roomArgs: roomArgsOf(parsed.options, settings.publicUrl),
        staticDir: settings.staticDir,
        version: packageVersion(),
        env,
        log,
      });
      break;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (reloaded && attempt < 20 && /another gonogo supervisor is using|EADDRINUSE/.test(message)) {
        await new Promise((done) => setTimeout(done, 500));
        continue;
      }
      throw e;
    }
  }
  const running = supervisor;
  let ending = false;
  const stop = (): void => {
    if (ending) return exit(130);
    ending = true;
    void running.stop().finally(() => exit(0));
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, stop);
  // gonogo reload: every room hands its agents to its pty host and exits; this process lets go of the port and starts the installed gonogo again
  process.on('SIGUSR2', () => {
    if (ending) return;
    ending = true;
    log.info('reloading: every room hands over, then this supervisor starts again');
    void running
      .reload()
      .then(() => running.stop())
      .then(() => {
        relaunch(process.argv.slice(2), process.argv[1]);
        exit(0);
      })
      .catch((error: unknown) => {
        // nothing else is left to serve the port: leave non-zero so the service manager starts gonogo again
        log.error('the reload failed; leaving', error);
        exit(1);
      });
  });
  // announced when main answers (or after 30 s): scripts that read this line and call /api at once must find the room there
  await running.whenReady(30_000);
  process.stdout.write(`gonogo ready: ${running.url}\n`);
  if (running.setupToken !== null) {
    // printed once, when it is made: single use, one hour, answered on this machine or the local network only (docs/login-spec.md R1, R3)
    process.stdout.write(`gonogo setup: open ${running.url.split('#')[0]?.replace(/\/$/, '')}/setup and give this setup token (one use, one hour; it is also in ${join(settings.home, 'setup-token')}): ${running.setupToken}\n`);
  }
  log.info(`docs: ${DOCS_URL}`);
}

function installProcessHandlers(running: Running, log: Logger, argv: string[] = [], entry?: string, supervised = false): void {
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
    log.info(supervised ? 'reloading: handing the agents to their pty host, then leaving for the supervisor to start again' : 'reloading: handing over to a new gonogo');
    void running
      .release()
      .then(
        () => {
          // a room under the supervisor does not start itself again: it exits 75 and the supervisor, which asked, starts it at once
          if (supervised) return exit(75);
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
    const latest = updateCheckOff(env.GONOGO_UPDATE_CHECK) || argv.includes('--no-update-check') ? null : cachedLatest(mainHomeOf(env));
    if (latest !== null && isNewer(latest, packageVersion())) process.stdout.write(`${latest} is out. To update, run: gonogo update\n`);
    exit(0);
    return;
  }
  if (parsed.kind === 'doctor') {
    const checks = await checkEngines(env);
    const { kind } = installInfo(env);
    process.stdout.write(formatDoctor(checks, env.GONOGO_AGENT_CMD?.trim() || null, kind === 'brew' ? `gonogo itself: ${installNote(kind, false)}` : null).replace('\ndoctor never runs', `\n${doctorLine(await gitVersion(env))}\n\n${doorTable()}\n\ndoctor never runs`));
    // Docker self-update: only in a container
    if (installInfo(env).kind === 'docker') {
      const socket = env.GONOGO_DOCKER_SOCKET || SOCKET_PATH;
      const status = existsSync(socket) ? await dockerUpdateStatus(socketCall(socket), hostname()) : { ready: false, text: 'needs the Docker socket (mount /var/run/docker.sock)' };
      process.stdout.write(`${status.ready ? 'ok' : '--'}  Docker self-update  ${status.text}\n`);
    }
    // the same refusal as the start: no claude and nothing in its place
    exit(checks.find((c) => c.provider === 'claude')?.path === null && !env.GONOGO_AGENT_CMD?.trim() ? 1 : 0);
    return;
  }
  if (parsed.kind === 'update') {
    const current = packageVersion();
    const latest = cachedLatest(mainHomeOf(env));
    const { command, docker } = installInfo();
    process.stdout.write(updateText(command, docker, { current, latest, newer: latest !== null && isNewer(latest, current) }));
    exit(0);
    return;
  }
  if (parsed.kind === 'migrate-main') {
    try {
      await runMigrateMainCommand(parsed, env);
    } catch (e) {
      process.stderr.write(`gonogo rooms migrate-main: ${e instanceof Error ? e.message : String(e)}\n`);
      exit(1);
    }
    return;
  }
  if (parsed.kind === 'rooms') {
    try {
      await runRoomsCommand(parsed, env);
    } catch (e) {
      process.stderr.write(`gonogo rooms: ${e instanceof Error ? e.message : String(e)}\n`);
      exit(1);
    }
    return;
  }
  if (parsed.kind === 'auth') {
    const io = {
      out: (text: string) => void process.stdout.write(text),
      err: (text: string) => void process.stderr.write(text),
      readLine: () => new Promise<string>((done) => { let text = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { text += String(c); if (text.includes('\n')) done(text.split('\n')[0] ?? ''); }); process.stdin.on('end', () => done(text.split('\n')[0] ?? '')); }),
    };
    exit(await authCommand(parsed.args, parsed.home === undefined ? homeOf(env) : resolve(parsed.home), io));
    return;
  }
  if (parsed.kind === 'expose') {
    // prints (and with --write, writes files); runs no tunnel and no installer
    exit(await exposeCommand(parsed.args, parsed.home === undefined ? homeOf(env) : resolve(parsed.home), env, { out: (t) => void process.stdout.write(t), err: (t) => void process.stderr.write(t) }));
    return;
  }
  if (parsed.kind === 'token') {
    try {
      process.stdout.write(`${rotateDirectorToken(parsed.home === undefined ? homeOf(env) : resolve(parsed.home))}\n`);
      exit(0);
    } catch (e) {
      process.stderr.write(`gonogo token: ${e instanceof Error ? e.message : String(e)}\n`);
      exit(1);
    }
    return;
  }
  if (parsed.kind === 'run') {
    try {
      await runSupervisor(parsed, env);
    } catch (e) {
      process.stderr.write(`gonogo: ${e instanceof Error ? e.message : String(e)}\n`);
      exit(1);
    }
    return;
  }
  if (parsed.kind === 'selfupdate') {
    // runs in the helper container: recreates the target from the new image, rolls back when it is not healthy, leaves the result for the new gonogo
    const home = resolve(parsed.home);
    const result = await swap(socketCall(env.GONOGO_DOCKER_SOCKET || SOCKET_PATH), { target: parsed.target, image: parsed.image, expect: parsed.expect, home, record: (r) => writeResult(home, r) });
    await writeResult(home, result).catch((e: unknown) => process.stderr.write(`gonogo self-update: could not write the result: ${e instanceof Error ? e.message : String(e)}\n`));
    process.stdout.write(`gonogo self-update: ${result.state}: ${result.note}\n`);
    exit(result.state === 'ok' ? 0 : 1);
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
      process.stdout.write(`${requestReload(parsed.home === undefined ? homeOf(env) : resolve(parsed.home), installInfo(env).docker)}\n`);
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

  // from here on: `gonogo __room`, one room of the supervisor
  if (parsed.options.exitWithStdin !== true || process.stdin.isTTY === true) {
    process.stderr.write('gonogo: __room is internal: run "gonogo"\n');
    exit(2);
    return;
  }
  await runRoom(parsed.options, env);
}

/**
 * The one question a room may put to its supervisor, over the pipes they already share (no route, no port): the room writes the line
 * `gonogo-ask busy` on stdout, the supervisor answers one line `gonogo-answer busy {"busy":<text|null>,"room":<id|null>}` on stdin. One answer per
 * question; a second question while one is out waits for it. No answer in 5 s is "busy", so an update never goes ahead on a guess.
 */
export function createPipeAnswers(write: (line: string) => void, timeoutMs = 5000, onAlert: (text: string) => void = () => undefined, onNotice: (text: string) => void = () => undefined) {
  let waiting: Array<(answer: { busy: string | null; room: string | null }) => void> = [];
  let buffer = '';
  const none = { busy: 'the supervisor did not answer whether another room is busy: try again', room: null };
  return {
    feed(text: string): void {
      buffer += text;
      let at: number;
      while ((at = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        const notice = /^gonogo-notice (".*")$/.exec(line);
        if (notice !== null) {
          try {
            const text: unknown = JSON.parse(notice[1] as string);
            if (typeof text === 'string') onNotice(text);
          } catch {
            // not a line of ours
          }
          continue;
        }
        const alert = /^gonogo-alert (".*")$/.exec(line);
        if (alert !== null) {
          try {
            const text: unknown = JSON.parse(alert[1] as string);
            if (typeof text === 'string') onAlert(text);
          } catch {
            // not a line of ours
          }
          continue;
        }
        const match = /^gonogo-answer busy (\{.*\})$/.exec(line);
        // only a line of the shape of an answer takes the place of a question: other output of the supervisor is ignored
        if (match === null) continue;
        const next = waiting.shift();
        if (next === undefined) continue;
        try {
          const body = JSON.parse(match[1] as string) as { busy?: unknown; room?: unknown };
          next({ busy: typeof body.busy === 'string' ? body.busy.slice(0, 300) : null, room: typeof body.room === 'string' ? body.room.slice(0, 40) : null });
        } catch {
          next(none);
        }
      }
    },
    /** `idle`: the stricter question of auto-update (any agent working, starting or waiting for the Director in another room), where `busy` only asks for an open poll. */
    ask(idle = false): Promise<{ busy: string | null; room: string | null }> {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiting = waiting.filter((w) => w !== done);
          resolve(none);
        }, timeoutMs);
        const done = (answer: { busy: string | null; room: string | null }): void => {
          clearTimeout(timer);
          resolve(answer);
        };
        waiting.push(done);
        write(idle ? 'gonogo-ask idle\n' : 'gonogo-ask busy\n');
      });
    },
  };
}
let onSupervisorAlert: (text: string) => void = () => undefined;
let onSupervisorNotice: (text: string) => void = () => undefined;
const pipeAnswers = createPipeAnswers((line) => process.stdout.write(line), 5000, (text) => onSupervisorAlert(text), (text) => onSupervisorNotice(text));

/** One room: what `gonogo` was before it became the supervisor. `gonogo __room` runs it; the tests run it directly with fakes. */
export async function runRoom(options: StartOptions, env: Env): Promise<void> {
  const level = logLevel(env.GONOGO_LOG_LEVEL);
  const log = createLogger({ level });
  // shortcut: a signal during the start-up (about a second) takes Node's default and ends the process at once; the ptys hang up on their children and the next start replaces the stale lock
  let running: Running;
  // started by a reload: the old gonogo may still hold the home and the port for a moment
  const reloaded = env.GONOGO_RELOADED === '1';
  delete process.env.GONOGO_RELOADED;
  const askBusy = options.roomChild === true && options.exitWithStdin === true ? (idle?: boolean) => pipeAnswers.ask(idle === true) : undefined;
  for (let attempt = 0; ; attempt += 1) {
    try {
      running = await startGonogo({ ...options, ...(askBusy === undefined ? {} : { askBusy }), telegramPoll: true, updateCheck: options.updateCheck ?? !updateCheckOff(env.GONOGO_UPDATE_CHECK), env: reloaded ? { ...env, GONOGO_RELOADED: undefined } : env, log });
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
  onSupervisorAlert = (text) => running.alert(text);
  onSupervisorNotice = (text) => running.notice(text);
  installProcessHandlers(running, log, process.argv.slice(2), process.argv[1], options.roomChild === true);
  if (options.exitWithStdin === true) {
    // the supervisor holds the other end of this pipe: when it dies, for any reason, this ends and the room stops as for SIGTERM
    process.stdin.on('end', () => process.kill(process.pid, 'SIGTERM'));
    process.stdin.on('data', (chunk) => pipeAnswers.feed(String(chunk)));
    process.stdin.on('error', () => process.kill(process.pid, 'SIGTERM'));
    process.stdin.resume();
  }
  process.stdout.write(`gonogo ready: ${running.url}\n`);
  // a log line (stderr, GONOGO_LOG_LEVEL): stdout holds the one `gonogo ready:` line that scripts parse
  log.info(`docs: ${DOCS_URL}`);
}
