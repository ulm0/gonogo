/**
 * Clean Room (docs/clean-room-spec.md): an agent that runs in a container on its own git worktree. This file reads the
 * setting, checks Docker and the repository, makes the worktree once and builds the `docker run` arguments. The launcher
 * puts them together with the files and the environment of a Claude Code start.
 */
import { idsFromCgroup, idsFromMountinfo, selfProbe } from './selfid.js';
import type { SelfProbe } from './selfid.js';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
import { CLEAN_ROOM_DIR, CLEAN_ROOM_FLAVORS, CLEAN_ROOM_RUNTIMES, cleanRoomBranch } from '../shared/protocol.js';
import type { AgentRecord, CleanRoom, CleanRoomFlavor, CleanRoomFlavors, Provider } from '../shared/protocol.js';
import { cwdInWorktree, ensureWorktree, messageOf, run, topOf } from './worktree.js';
export { ensureWorktree };
import type { Env } from './worktree.js';
import {
  CLEAN_ROOM_DEFAULT_IMAGE,
  CLEAN_ROOM_HOME_DIR,
  CLEAN_ROOM_HOST,
  CLEAN_ROOM_IMAGE_ENV,
  CLEAN_ROOM_IMAGE_PATTERN,
  CLEAN_ROOM_NETWORK_ENV,
  CLEAN_ROOM_NETWORK_PATTERN,
  CLEAN_ROOM_NETWORK_SELF,
  CLEAN_ROOM_RUNTIMES_ENV,
  DIR_MODE,
  DOCKER_BIN,
} from './constants.js';

export type CleanRoomCheck = { ok: true; cleanRoom: CleanRoom } | { ok: false; error: string };

const IMAGE_RE = new RegExp(CLEAN_ROOM_IMAGE_PATTERN);
const NETWORK_RE = new RegExp(CLEAN_ROOM_NETWORK_PATTERN);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The one reader of a Clean Room setting: the hub uses it for hire and edit, home.ts for the roster file. `{}` is the default image. */
export function parseCleanRoom(value: unknown, provider: Provider | undefined): CleanRoomCheck {
  if (!isRecord(value)) return { ok: false, error: 'cleanRoom must be an object' };
  if ((provider ?? 'claude') !== 'claude') return { ok: false, error: 'a Clean Room runs Claude Code agents only' };
  const unknown = Object.keys(value).find((key) => key !== 'image' && key !== 'flavor');
  if (unknown !== undefined) return { ok: false, error: `cleanRoom has no field "${unknown}"` };
  const { image, flavor } = value;
  if (image !== undefined && (typeof image !== 'string' || !IMAGE_RE.test(image))) return { ok: false, error: 'the image must be a Docker image name or id (letters, digits and . _ / : @ -)' };
  if (flavor !== undefined && !(CLEAN_ROOM_FLAVORS as readonly unknown[]).includes(flavor)) return { ok: false, error: `the flavor must be one of: ${CLEAN_ROOM_FLAVORS.join(', ')}` };
  return { ok: true, cleanRoom: { ...(image === undefined ? {} : { image }), ...(flavor === undefined ? {} : { flavor: flavor as CleanRoomFlavor }) } };
}

/** The flavor an agent runs in: its own, else the room's default, else docker. */
export const cleanRoomFlavor = (cleanRoom: CleanRoom, roomDefault: CleanRoomFlavor | undefined): CleanRoomFlavor => cleanRoom.flavor ?? roomDefault ?? 'docker';

/** The Docker runtime names `docker info` lists (Runtimes) plus the ones the operator declares (GONOGO_CLEANROOM_RUNTIMES), or why `docker info` could not be read. `docker` itself needs none. */
export async function dockerRuntimes(env: Env): Promise<{ names: string[]; note?: string }> {
  const declared = (env[CLEAN_ROOM_RUNTIMES_ENV] ?? '').split(',').map((n) => n.trim()).filter((n) => /^[A-Za-z0-9._-]{1,64}$/.test(n));
  try {
    const parsed: unknown = JSON.parse(await run(DOCKER_BIN, ['info', '--format', '{{json .Runtimes}}'], env));
    return { names: [...new Set([...(isRecord(parsed) ? Object.keys(parsed) : []), ...declared])] };
  } catch (error) {
    return { names: declared, note: `"docker info" failed: ${messageOf(error)}` };
  }
}

/** What the page shows: each flavor, whether Docker has its runtime. */
export async function cleanRoomFlavors(env: Env, roomDefault: CleanRoomFlavor | undefined): Promise<CleanRoomFlavors> {
  const { names, note } = await dockerRuntimes(env);
  const available = Object.fromEntries(CLEAN_ROOM_FLAVORS.map((f) => [f, CLEAN_ROOM_RUNTIMES[f] === null || names.includes(CLEAN_ROOM_RUNTIMES[f] as string)])) as Record<CleanRoomFlavor, boolean>;
  return { available, default: roomDefault ?? 'docker', ...(note === undefined ? {} : { note }) };
}

/** Why a flavor cannot be used, or null: its runtime is not one Docker lists, or it is the microVM, which cannot share gonogo's network (the bridge mode that it needs is not built yet). Never a fallback to runc. */
export function flavorProblem(flavor: CleanRoomFlavor, runtimes: readonly string[], network: string | null): string | null {
  const runtime = CLEAN_ROOM_RUNTIMES[flavor];
  if (runtime === null) return null;
  if (!runtimes.includes(runtime)) return `the ${flavor} Clean Room needs the Docker runtime ${runtime}, and "docker info" does not list it: not installed`;
  if (flavor === 'microvm' && (network === null || network === 'host' || network.startsWith('container:'))) return 'the microvm Clean Room cannot start yet: Kata cannot join gonogo\'s network (GONOGO_CLEANROOM_NETWORK=container:<gonogo>), and the bridge network mode it needs (GONOGO_CLEANROOM_NETWORK=bridge:<network>) is not built';
  return null;
}

/**
 * A flavor with a runtime is created, then checked, and only then started: `docker create` with the arguments of the run, `docker inspect` of what Docker
 * really chose (HostConfig.Runtime), and the start is `docker start -a -i <container>`. A container whose runtime is not the one asked for (or that Docker
 * refused to create) is removed and the start is refused with the reason: never runc in place of the wall that was chosen. `args` is the output of buildDockerArgs.
 */
export async function createVerified(args: readonly string[], runtime: string, container: string, env: Env): Promise<string[]> {
  if (args[0] !== 'run') throw new Error('createVerified takes the arguments of docker run');
  try {
    await run(DOCKER_BIN, ['create', ...args.slice(1)], env);
  } catch (error) {
    await removeContainer(container, env);
    throw new Error(`Docker could not create the Clean Room container with the runtime ${runtime}: ${messageOf(error)}`);
  }
  let got = '';
  try {
    got = (await run(DOCKER_BIN, ['inspect', '--format', '{{.HostConfig.Runtime}}', container], env)).trim();
  } catch (error) {
    await removeContainer(container, env);
    throw new Error(`could not check the runtime of the Clean Room container: ${messageOf(error)}`);
  }
  if (got !== runtime) {
    await removeContainer(container, env);
    throw new Error(`the Clean Room container has the runtime ${JSON.stringify(got)}, not ${runtime}: it was removed and nothing started`);
  }
  return ['start', '-a', '-i', container];
}

/** The agent's own image, else GONOGO_CLEANROOM_IMAGE, else the project's `ghcr.io/ulm0/gonogo`. */
export function cleanRoomImage(cleanRoom: CleanRoom, env: Env): string {
  const image = cleanRoom.image ?? (env[CLEAN_ROOM_IMAGE_ENV]?.trim() || CLEAN_ROOM_DEFAULT_IMAGE);
  if (!IMAGE_RE.test(image)) throw new Error(`${CLEAN_ROOM_IMAGE_ENV} is not a Docker image name: ${JSON.stringify(image)}`);
  return image;
}

/**
 * GONOGO_CLEANROOM_NETWORK, or null when unset. Only `container:<name>`: the container shares gonogo's network and its
 * hosts file, where host.docker.internal must name 127.0.0.1. Another network would need a private address, and Claude
 * Code blocks HTTP hooks to those. `container:self` is gonogo's own container by its host name, which Docker sets to the
 * container's short id unless `hostname` is set, so compose needs no fixed container name.
 */
/**
 * gonogo's own container, by the rule of the update path (selfid.ts): the id its own files name (mountinfo, cgroup), and only when they name exactly ONE. Two ids are two
 * containers and nothing is guessed. With none, the host name counts only when it is itself a container id (12 to 64 hex characters, what Docker sets by default): under
 * `network_mode: host` the host name is the HOST's. Anything else is refused with what to set.
 */
const ownContainerFix = "set GONOGO_CLEANROOM_NETWORK=container:<the name of gonogo's own container>";

export function ownContainerRef(probe: SelfProbe = selfProbe.current, host: string = hostname()): string {
  const fix = `set ${CLEAN_ROOM_NETWORK_ENV}=container:<the name of gonogo's own container> instead of container:self`;
  let ids: string[] = [];
  try {
    ids = [...new Set([...idsFromMountinfo(probe.mountinfo()), ...idsFromCgroup(probe.cgroup())])];
  } catch {
    // the files cannot be read: below
  }
  if (ids.length > 1) throw new Error(`${CLEAN_ROOM_NETWORK_ENV}=container:self cannot tell which container is gonogo's own: its files name ${ids.length} (${ids.map((id) => id.slice(0, 12)).join(', ')}); ${fix}`);
  if (ids.length === 1) return ids[0] as string;
  if (/^[0-9a-f]{12,64}$/.test(host)) return host;
  throw new Error(`${CLEAN_ROOM_NETWORK_ENV}=container:self cannot tell which container is gonogo's own: its files name none and the host name ${JSON.stringify(host.slice(0, 40))} is not a container id; ${fix}`);
}

export function cleanRoomNetwork(env: Env, host?: string): string | null {
  const raw = env[CLEAN_ROOM_NETWORK_ENV]?.trim();
  if (!raw) return null;
  const value = raw === CLEAN_ROOM_NETWORK_SELF ? `container:${host ?? ownContainerRef()}` : raw;
  if (!NETWORK_RE.test(value)) throw new Error(`${CLEAN_ROOM_NETWORK_ENV} must be ${CLEAN_ROOM_NETWORK_SELF} or container:<name of gonogo's own container>, not ${JSON.stringify(raw)}`);
  return value;
}

/**
 * With gonogo in a container, the host's Docker mounts a Clean Room's folders by their paths on the host, so gonogo's
 * home must be a bind mount from the same path of the host. `mounts` is `.Mounts` of `docker inspect`. Null when it is.
 */
export function sameMountError(mounts: unknown, homeDir: string, container: string): string | null {
  const covers = (dest: string): boolean => homeDir === dest || homeDir.startsWith(dest.endsWith('/') ? dest : `${dest}/`);
  const mount = (Array.isArray(mounts) ? mounts : [])
    .filter(isRecord)
    .filter((m) => typeof m.Destination === 'string' && covers(m.Destination))
    .sort((a, b) => String(b.Destination).length - String(a.Destination).length)[0];
  if (mount?.Type === 'bind' && mount.Source === mount.Destination) return null;
  return `gonogo's home ${homeDir} is not mounted into the container ${container} from the same path of the host: the host's Docker mounts a Clean Room's folders by their host paths, so mount it as -v ${homeDir}:${homeDir}`;
}

/** Docker is there and its daemon answers: `docker version` exits 0 only then. */
export async function checkDocker(env: Env): Promise<void> {
  try {
    await run(DOCKER_BIN, ['version'], env);
  } catch (error) {
    throw new Error(`Clean Room needs Docker, and "docker version" failed: ${messageOf(error)}`);
  }
}

/** The top folder of the git repository that holds `dir`. */
export const repoRoot = (dir: string, env: Env): Promise<string> => topOf(dir, env, 'Clean Room needs');

/** What the hub asks at hire and edit: null when Docker works and `dir` is in a repository, else why not. */
export async function checkCleanRoom(dir: string, env: Env, flavor?: CleanRoomFlavor): Promise<string | null> {
  try {
    cleanRoomNetwork(env);
    await checkDocker(env);
    // a flavor asked for by name: its runtime must be there (the room's default is checked when it is set, and again at every start, where the microVM's missing network mode is refused too)
    const runtime = flavor === undefined ? null : CLEAN_ROOM_RUNTIMES[flavor];
    if (flavor !== undefined && runtime !== null && !(await dockerRuntimes(env)).names.includes(runtime)) return `the ${flavor} Clean Room needs the Docker runtime ${runtime}, and "docker info" does not list it: not installed`;
    await repoRoot(dir, env);
    return null;
  } catch (error) {
    return messageOf(error);
  }
}

export interface CleanRoomPlace {
  /** The worktree, on the host and in the container. */
  worktree: string;
  /** Where the agent starts: the worktree, plus the agent's own folder below the repository's top. */
  cwd: string;
  /** The container's HOME and CLAUDE_CONFIG_DIR: its Claude config, trust and sessions. */
  home: string;
  /** The container's name, one per worktree: a start or an exit removes the container of that name. */
  container: string;
  /** `container:<gonogo's container>` from GONOGO_CLEANROOM_NETWORK, `host` when that container runs with `network_mode: host`, or null: the host's network through host.docker.internal. */
  network: string | null;
}

/** `gonogo-<name>-<hash of the worktree path>`: two gonogo homes on one Docker never share a name. */
export const containerName = (worktree: string): string =>
  `gonogo-${basename(worktree)}-${createHash('sha256').update(worktree).digest('hex').slice(0, 12)}`;

/**
 * `docker rm -f`: with `-t` the docker CLI does not pass signals on, so a stopped console's container would keep running
 * after its docker process ended. Called after every exit and before every start. Never fails: no such container is fine.
 */
export async function removeContainer(name: string, env: Env): Promise<void> {
  await run(DOCKER_BIN, ['rm', '-f', name], env).catch(() => undefined);
}

/**
 * Why a Clean Room cannot start here, or null. Rooms of the supervisor listen on loopback only, which the Docker bridge cannot reach from a
 * host on Linux (it only worked when gonogo ran with --host 0.0.0.0): outside a container, on Linux, without GONOGO_CLEANROOM_NETWORK, it is
 * refused (docs/single-mode-spec.md, 8). Docker Desktop forwards host.docker.internal to the host's loopback (not tried), and gonogo in Docker
 * joins its own network. Only a room under the supervisor (GONOGO_SUPERVISOR_PID) is refused.
 */
export function cleanRoomHostProblem(env: Env, platform: string, inContainer: boolean, network: string | null): string | null {
  if (env.GONOGO_SUPERVISOR_PID === undefined || network !== null || inContainer || platform !== 'linux') return null;
  return 'Clean Room needs gonogo in Docker (it joins gonogo\'s network), or Docker Desktop: a room listens on loopback only, which the Docker bridge on Linux cannot reach';
}

/** Everything a start needs on disk: Docker checked, the worktree there, the container's home made. `base` is agents/<name>. */
export async function prepareCleanRoom(agent: AgentRecord, homeDir: string, base: string, env: Env, roomDefault?: CleanRoomFlavor): Promise<CleanRoomPlace> {
  const network = cleanRoomNetwork(env);
  const refused = cleanRoomHostProblem(env, process.platform, existsSync('/.dockerenv') || existsSync('/run/.containerenv'), network);
  if (refused !== null) throw new Error(refused);
  await checkDocker(env);
  // fail closed: a flavor whose runtime is gone, or the microVM, is refused here; the start never falls back to runc
  const flavor = cleanRoomFlavor(agent.cleanRoom ?? {}, roomDefault);
  const problem = flavorProblem(flavor, (await dockerRuntimes(env)).names, network);
  if (problem !== null) throw new Error(problem);
  let hostNet = false;
  if (network !== null) {
    const self = network.slice('container:'.length);
    let mounts: unknown;
    try {
      mounts = JSON.parse(await run(DOCKER_BIN, ['inspect', '--format', '{{json .Mounts}}', self], env));
    } catch (error) {
      throw new Error(`${CLEAN_ROOM_NETWORK_ENV} names the container ${self}, and "docker inspect" failed: ${messageOf(error)}`);
    }
    const error = sameMountError(mounts, homeDir, self);
    if (error !== null) throw new Error(error);
    // with `network_mode: host` gonogo has the host's network and so a Clean Room that joins gonogo's network gets the host's: it is joined as `--network host` (the same reach as gonogo itself), with the name host.docker.internal on 127.0.0.1
    // inspected by the id that was resolved, and what Docker answers must be that very container (an Id that starts with it): a name or a short prefix never stands for another
    const answer = await run(DOCKER_BIN, ['inspect', '--format', '{{.Id}} {{.HostConfig.NetworkMode}}', self], env).then((out) => out.trim().split(/\s+/), () => ['', '']);
    if (/^[0-9a-f]{12,64}$/.test(self) && !(answer[0] ?? '').startsWith(self)) throw new Error(`${CLEAN_ROOM_NETWORK_ENV} names the container ${self}, and Docker answered with another container (${(answer[0] ?? '').slice(0, 12) || 'none'}): ${ownContainerFix}`);
    hostNet = answer[1] === 'host';
    // The Clean Room shares this container's hosts file; keeping the name (not 127.0.0.1) keeps the Host rule: hooks and MCP only. (With host networking it is told the name by --add-host.)
    const address = hostNet ? '127.0.0.1' : await lookup(CLEAN_ROOM_HOST).then((found) => found.address, () => 'nothing');
    if (!address.startsWith('127.')) throw new Error(`${CLEAN_ROOM_HOST} names ${address} in the container ${self}, not 127.0.0.1: start it with --add-host ${CLEAN_ROOM_HOST}:127.0.0.1 (compose.yaml has it)`);
  }
  const top = await realpath(await repoRoot(agent.dir, env));
  const worktree = join(homeDir, CLEAN_ROOM_DIR, agent.name);
  await ensureWorktree(top, worktree, cleanRoomBranch(agent.name), env);
  const cwd = await cwdInWorktree(top, worktree, agent.dir);
  const container = containerName(worktree);
  await removeContainer(container, env);
  const home = join(base, CLEAN_ROOM_HOME_DIR);
  await mkdir(home, { recursive: true, mode: DIR_MODE });
  // The container can write the agent's folder: a link planted there would make gonogo write trust into a file outside it.
  for (const path of [home, join(home, '.claude.json')]) {
    if ((await lstat(path).catch(() => null))?.isSymbolicLink()) throw new Error(`${path} is a symbolic link, and a Clean Room never follows one out of its folder: delete it`);
  }
  return { worktree, cwd, home, container, network: hostNet ? 'host' : network };
}

/** The URL an agent in a container reaches gonogo by: the loopback host of the server's URL becomes the host's name. */
export const containerUrl = (hubUrl: string): string => hubUrl.replace(/^http:\/\/(?:127\.0\.0\.1|\[::1\])/, `http://${CLEAN_ROOM_HOST}`);

/**
 * `docker run` for one agent: the worktree and the agent's own folder at the same paths, nothing else, as the owner's
 * uid. The worktree's `.git` file is read-only: rewritten, it could point the owner's next git command in the worktree
 * at a config (core.fsmonitor) that runs a program on the host. Variables are named without a value, so docker reads them from its own environment and no secret is on the
 * command line. `command` is the program to run inside and its arguments: the program goes in `--entrypoint`, because the
 * project's own image has `gonogo` as its entrypoint, and HOME and CLAUDE_CONFIG_DIR are set because the image points the
 * second one at a folder this user cannot write.
 */
export function buildDockerArgs(input: {
  image: string;
  /** The sandbox flavor: gvisor and microvm add `--runtime <name>`, docker adds nothing. */
  flavor?: CleanRoomFlavor;
  uid: number;
  gid: number;
  place: CleanRoomPlace;
  agentDir: string;
  /** Names of variables of docker's own environment to pass on. */
  names: readonly string[];
  command: readonly [string, ...string[]];
}): string[] {
  const { place } = input;
  for (const path of [place.worktree, input.agentDir]) {
    if (path.includes(':')) throw new Error(`the path ${path} has a colon, which docker cannot mount`);
  }
  return [
    'run', '--rm', '-i', '-t', '--init',
    ...(CLEAN_ROOM_RUNTIMES[input.flavor ?? 'docker'] === null ? [] : ['--runtime', CLEAN_ROOM_RUNTIMES[input.flavor ?? 'docker'] as string]),
    '--name', place.container,
    '--user', `${input.uid}:${input.gid}`,
    // the container shares gonogo's network namespace (and so its edge network): it needs no capability, and a setuid program in the image must not gain one
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    ...(place.network === null ? ['--add-host', `${CLEAN_ROOM_HOST}:host-gateway`] : place.network === 'host' ? ['--network', 'host', '--add-host', `${CLEAN_ROOM_HOST}:127.0.0.1`] : ['--network', place.network]),
    '-e', `HOME=${place.home}`,
    '-e', `CLAUDE_CONFIG_DIR=${place.home}`,
    ...input.names.flatMap((name) => ['-e', name]),
    '-v', `${place.worktree}:${place.worktree}`,
    '-v', `${join(place.worktree, '.git')}:${join(place.worktree, '.git')}:ro`,
    '-v', `${input.agentDir}:${input.agentDir}`,
    '-w', place.cwd,
    '--entrypoint', input.command[0],
    input.image,
    ...input.command.slice(1),
  ];
}
