/**
 * Clean Room (docs/clean-room-spec.md): an agent that runs in a container on its own git worktree. This file reads the
 * setting, checks Docker and the repository, makes the worktree once and builds the `docker run` arguments. The launcher
 * puts them together with the files and the environment of a Claude Code start.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { CLEAN_ROOM_DIR, cleanRoomBranch } from '../shared/protocol.js';
import type { AgentRecord, CleanRoom, Provider } from '../shared/protocol.js';
import {
  CLEAN_ROOM_COMMAND_MS,
  CLEAN_ROOM_DEFAULT_IMAGE,
  CLEAN_ROOM_HOME_DIR,
  CLEAN_ROOM_HOST,
  CLEAN_ROOM_IMAGE_ENV,
  CLEAN_ROOM_IMAGE_PATTERN,
  CLEAN_ROOM_NETWORK_ENV,
  CLEAN_ROOM_NETWORK_PATTERN,
  CLEAN_ROOM_NETWORK_SELF,
  DIR_MODE,
  DOCKER_BIN,
  GIT_BIN,
} from './constants.js';

export type CleanRoomCheck = { ok: true; cleanRoom: CleanRoom } | { ok: false; error: string };
type Env = Record<string, string | undefined>;

const IMAGE_RE = new RegExp(CLEAN_ROOM_IMAGE_PATTERN);
const NETWORK_RE = new RegExp(CLEAN_ROOM_NETWORK_PATTERN);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The one reader of a Clean Room setting: the hub uses it for hire and edit, home.ts for the roster file. `{}` is the default image. */
export function parseCleanRoom(value: unknown, provider: Provider | undefined): CleanRoomCheck {
  if (!isRecord(value)) return { ok: false, error: 'cleanRoom must be an object' };
  if ((provider ?? 'claude') !== 'claude') return { ok: false, error: 'a Clean Room runs Claude Code agents only' };
  const unknown = Object.keys(value).find((key) => key !== 'image');
  if (unknown !== undefined) return { ok: false, error: `cleanRoom has no field "${unknown}"` };
  const { image } = value;
  if (image === undefined) return { ok: true, cleanRoom: {} };
  if (typeof image !== 'string' || !IMAGE_RE.test(image)) return { ok: false, error: 'the image must be a Docker image name or id (letters, digits and . _ / : @ -)' };
  return { ok: true, cleanRoom: { image } };
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
export function cleanRoomNetwork(env: Env, host: string = hostname()): string | null {
  const raw = env[CLEAN_ROOM_NETWORK_ENV]?.trim();
  if (!raw) return null;
  const value = raw === CLEAN_ROOM_NETWORK_SELF ? `container:${host}` : raw;
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

/** Runs a program without a shell and answers its output. A failure is an Error whose text is the first line the program printed on stderr. */
function run(file: string, args: string[], env: Env): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env: env as NodeJS.ProcessEnv, timeout: CLEAN_ROOM_COMMAND_MS, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error === null) return resolve(stdout);
      const code = (error as NodeJS.ErrnoException).code;
      const line = stderr.split('\n').find((l) => l.trim() !== '')?.trim() ?? error.message.split('\n')[0] ?? '';
      reject(new Error(code === 'ENOENT' ? `${file} was not found on PATH` : line.slice(0, 300)));
    });
  });
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
export async function repoRoot(dir: string, env: Env): Promise<string> {
  try {
    return (await run(GIT_BIN, ['-C', dir, 'rev-parse', '--show-toplevel'], env)).trim();
  } catch (error) {
    throw new Error(`Clean Room needs the directory to be inside a git repository: ${messageOf(error)}`);
  }
}

/** What the hub asks at hire and edit: null when Docker works and `dir` is in a repository, else why not. */
export async function checkCleanRoom(dir: string, env: Env): Promise<string | null> {
  try {
    cleanRoomNetwork(env);
    await checkDocker(env);
    await repoRoot(dir, env);
    return null;
  } catch (error) {
    return messageOf(error);
  }
}

/** Makes the worktree on its branch the first time and finds it again after that. A folder in its place that git does not know is an error, never reused. */
export async function ensureWorktree(repo: string, path: string, branch: string, env: Env): Promise<void> {
  const git = (...args: string[]): Promise<string> => run(GIT_BIN, ['-C', repo, ...args], env);
  const real = await realpath(path).catch(() => null);
  if (real !== null) {
    const listed = (await git('worktree', 'list', '--porcelain')).split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
    if (!(await Promise.all(listed.map((p) => realpath(p).catch(() => p)))).includes(real)) {
      throw new Error(`${path} exists but is not a worktree of ${repo}; move it away or give the agent a folder of the repository it was made for`);
    }
    return;
  }
  await mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
  try {
    await git('worktree', 'prune'); // a worktree whose folder was deleted still holds its branch
    const known = await git('show-ref', '--verify', '--quiet', `refs/heads/${branch}`).then(() => true, () => false);
    await git('worktree', 'add', ...(known ? [path, branch] : ['-b', branch, path]));
  } catch (error) {
    throw new Error(`could not make the worktree ${path} on ${branch}: ${messageOf(error)}`);
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
  /** `container:<gonogo's container>` from GONOGO_CLEANROOM_NETWORK, or null: the host's network through host.docker.internal. */
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

/** Everything a start needs on disk: Docker checked, the worktree there, the container's home made. `base` is agents/<name>. */
export async function prepareCleanRoom(agent: AgentRecord, homeDir: string, base: string, env: Env): Promise<CleanRoomPlace> {
  const network = cleanRoomNetwork(env);
  await checkDocker(env);
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
    // The Clean Room shares this container's hosts file; keeping the name (not 127.0.0.1) keeps the Host rule: hooks and MCP only.
    const address = await lookup(CLEAN_ROOM_HOST).then((found) => found.address, () => 'nothing');
    if (!address.startsWith('127.')) throw new Error(`${CLEAN_ROOM_HOST} names ${address} in the container ${self}, not 127.0.0.1: start it with --add-host ${CLEAN_ROOM_HOST}:127.0.0.1 (compose.yaml has it)`);
  }
  const top = await realpath(await repoRoot(agent.dir, env));
  const worktree = join(homeDir, CLEAN_ROOM_DIR, agent.name);
  await ensureWorktree(top, worktree, cleanRoomBranch(agent.name), env);
  const inside = relative(top, await realpath(agent.dir));
  const cwd = join(worktree, inside);
  if (!(await stat(cwd).then((info) => info.isDirectory(), () => false))) {
    throw new Error(`${inside} is not in the worktree ${worktree}: the worktree is a copy of the last commit, and that folder is not committed`);
  }
  const container = containerName(worktree);
  await removeContainer(container, env);
  const home = join(base, CLEAN_ROOM_HOME_DIR);
  await mkdir(home, { recursive: true, mode: DIR_MODE });
  // The container can write the agent's folder: a link planted there would make gonogo write trust into a file outside it.
  for (const path of [home, join(home, '.claude.json')]) {
    if ((await lstat(path).catch(() => null))?.isSymbolicLink()) throw new Error(`${path} is a symbolic link, and a Clean Room never follows one out of its folder: delete it`);
  }
  return { worktree, cwd, home, container, network };
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
    '--name', place.container,
    '--user', `${input.uid}:${input.gid}`,
    ...(place.network === null ? ['--add-host', `${CLEAN_ROOM_HOST}:host-gateway`] : ['--network', place.network]),
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
