/**
 * Clean Room (docs/clean-room-spec.md): the setting reader, the checks, the worktree and the `docker run` arguments, with a
 * real git repository in a temp folder and the fake docker of test/fake-docker.mjs. No Docker, no image, no model.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRecord } from '../src/shared/protocol.js';
import { CLEAN_ROOM_RUNTIMES } from '../src/shared/protocol.js';
import {
  cleanRoomHostProblem,
  buildDockerArgs,
  cleanRoomFlavor,
  cleanRoomFlavors,
  createVerified,
  dockerRuntimes,
  flavorProblem,
  checkCleanRoom,
  checkDocker,
  cleanRoomImage,
  cleanRoomNetwork,
  ownContainerRef,
  containerName,
  containerUrl,
  ensureWorktree,
  parseCleanRoom,
  prepareCleanRoom,
  repoRoot,
  sameMountError,
} from '../src/server/cleanroom.js';
import { CLEAN_ROOM_NOTE } from '../src/server/constants.js';
import { createLauncher } from '../src/server/launcher.js';
import { cleanRoomEnv, fakeDockerBin, makeRepo } from './clean-room-helpers.js';

const SID = '0b2f5c1e-6d3a-4f7e-9a1b-2c3d4e5f6a7b';

let tmp: string;
let home: string;
let repo: string;
let bin: string;
let env: Record<string, string>;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'gonogo-'));
  home = join(tmp, 'home');
  repo = await realpath(await mkdir(join(tmp, 'repo'), { recursive: true }).then(() => join(tmp, 'repo')));
  await mkdir(home);
  await makeRepo(repo);
  bin = await fakeDockerBin(tmp);
  env = cleanRoomEnv(bin);
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env }).trim();
const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);
const record = (patch: Partial<AgentRecord> = {}): AgentRecord => ({
  name: 'ana',
  role: 'reviews',
  dir: repo,
  mode: 'default',
  sessionId: SID,
  desk: 1,
  boss: false,
  createdAt: 1,
  cleanRoom: {},
  ...patch,
});

describe('parseCleanRoom', () => {
  it('takes {} (the default image) and an image name', () => {
    expect(parseCleanRoom({}, undefined)).toEqual({ ok: true, cleanRoom: {} });
    expect(parseCleanRoom({}, 'claude')).toEqual({ ok: true, cleanRoom: {} });
    for (const image of ['gonogo', 'gonogo:1.2', 'ghcr.io/me/gonogo:latest', 'localhost:5000/a/b@sha256:ab12', 'a', 'a'.repeat(200)]) {
      expect(parseCleanRoom({ image }, 'claude'), image).toEqual({ ok: true, cleanRoom: { image } });
    }
  });

  it('takes egress as a boolean beside the image, and nothing else for it', () => {
    expect(parseCleanRoom({ egress: true }, 'claude')).toEqual({ ok: true, cleanRoom: { egress: true } });
    expect(parseCleanRoom({ egress: false, image: 'gonogo' }, 'claude')).toEqual({ ok: true, cleanRoom: { image: 'gonogo', egress: false } });
    for (const egress of ['yes', 1, null, {}]) expect(parseCleanRoom({ egress }, 'claude'), String(egress)).toEqual({ ok: false, error: 'cleanRoom.egress must be true or false' });
  });

  it('refuses what is not a setting, a field it does not know, an image docker would read as an option, and another engine', () => {
    const refused = (value: unknown, provider?: Parameters<typeof parseCleanRoom>[1]): string => {
      const checked = parseCleanRoom(value, provider);
      if (checked.ok) throw new Error(`expected a refusal, got ${JSON.stringify(checked.cleanRoom)}`);
      return checked.error;
    };
    for (const value of [null, undefined, 'x', 1, true, []]) expect(refused(value)).toBe('cleanRoom must be an object');
    expect(refused({ mount: '/' })).toBe('cleanRoom has no field "mount"');
    for (const image of ['', '-v', '--privileged', 'a b', 'a;b', 'a\nb', 'a'.repeat(201), 3, null]) expect(refused({ image }), String(image)).toMatch(/Docker image name/);
    expect(refused({}, 'gemini')).toBe('a Clean Room runs Claude Code, pi and opencode agents only');
    expect(refused({}, 'custom')).toBe('a Clean Room runs Claude Code, pi and opencode agents only');
  });
});

describe('the sandbox flavor', () => {
  it('parse: a flavor is one of docker, gvisor, microvm, with or without an image; anything else is refused', () => {
    for (const flavor of ['docker', 'gvisor', 'microvm']) expect(parseCleanRoom({ flavor }, 'claude'), flavor).toEqual({ ok: true, cleanRoom: { flavor } });
    expect(parseCleanRoom({ image: 'gonogo', flavor: 'gvisor' }, 'claude')).toEqual({ ok: true, cleanRoom: { image: 'gonogo', flavor: 'gvisor' } });
    for (const flavor of ['runc', 'kata', '', 'GVISOR', 3, null]) expect(parseCleanRoom({ flavor }, 'claude'), String(flavor)).toMatchObject({ ok: false, error: 'the flavor must be one of: docker, gvisor, microvm' });
  });

  it('the runtime table: docker has none (runc), gvisor is runsc, microvm is Kata', () => {
    expect(CLEAN_ROOM_RUNTIMES).toEqual({ docker: null, gvisor: 'runsc', microvm: 'io.containerd.kata.v2' });
  });

  it('resolution: the agent\'s own flavor, else the room\'s default, else docker', () => {
    expect(cleanRoomFlavor({}, undefined)).toBe('docker');
    expect(cleanRoomFlavor({}, 'gvisor')).toBe('gvisor');
    expect(cleanRoomFlavor({ flavor: 'docker' }, 'gvisor')).toBe('docker');
    expect(cleanRoomFlavor({ flavor: 'microvm' }, 'gvisor')).toBe('microvm');
  });

  it('availability reads the Runtimes of docker info: a flavor without its runtime is not available; a stopped Docker makes every flavor but docker unavailable, with the reason', async () => {
    expect(await dockerRuntimes(env)).toEqual({ names: ['runc', 'io.containerd.runc.v2'] });
    expect(await cleanRoomFlavors(env, undefined)).toEqual({ available: { docker: true, gvisor: false, microvm: false }, default: 'docker' });
    const withRunsc = { ...env, FAKE_DOCKER_RUNTIMES: 'runc,runsc,io.containerd.kata.v2' };
    expect(await cleanRoomFlavors(withRunsc, 'gvisor')).toEqual({ available: { docker: true, gvisor: true, microvm: true }, default: 'gvisor' });
    const down = await cleanRoomFlavors({ ...env, FAKE_DOCKER_FAIL: '1' }, undefined);
    expect(down.available).toEqual({ docker: true, gvisor: false, microvm: false });
    expect(down.note).toMatch(/docker info" failed: Cannot connect/);
  });

  it('a flavor whose runtime is missing is refused with its name; the microVM is refused on gonogo\'s network (the bridge mode is not built), whatever is installed', () => {
    expect(flavorProblem('docker', [], 'container:gng')).toBeNull();
    expect(flavorProblem('gvisor', ['runc'], null)).toBe('the gvisor Clean Room needs the Docker runtime runsc, and "docker info" does not list it: not installed');
    expect(flavorProblem('gvisor', ['runsc'], 'container:gng')).toBeNull();
    expect(flavorProblem('microvm', ['runc'], null)).toMatch(/needs the Docker runtime io.containerd.kata.v2.*not installed/);
    for (const network of [null, 'host', 'container:gng']) expect(flavorProblem('microvm', ['io.containerd.kata.v2'], network), String(network)).toMatch(/bridge network mode.*not built/);
  });

  it('argv: docker adds no --runtime, gvisor adds --runtime runsc, microvm --runtime io.containerd.kata.v2, right after the run options', () => {
    const place = { worktree: '/h/cleanroom/ana', cwd: '/h/cleanroom/ana', home: '/h/agents/ana/cleanroom-home', container: 'gonogo-ana-0123456789ab', network: null };
    const args = (flavor?: 'docker' | 'gvisor' | 'microvm'): string[] => buildDockerArgs({ image: 'gonogo', ...(flavor === undefined ? {} : { flavor }), uid: 1, gid: 1, place, agentDir: '/h/agents/ana', names: [], command: ['claude'] });
    expect(args()).not.toContain('--runtime');
    expect(args('docker')).not.toContain('--runtime');
    expect(args('gvisor').slice(0, 7)).toEqual(['run', '--rm', '-i', '-t', '--init', '--runtime', 'runsc']);
    expect(args('microvm').slice(5, 7)).toEqual(['--runtime', 'io.containerd.kata.v2']);
    expect(args('gvisor').filter((a) => a === '--runtime')).toHaveLength(1);
  });

  it('a runtime the operator declares counts as there although docker info does not list it, and the start still has to be verified', async () => {
    const declared = { ...env, GONOGO_CLEANROOM_RUNTIMES: 'io.containerd.kata.v2, bad name' };
    expect((await dockerRuntimes(declared)).names).toEqual(['runc', 'io.containerd.runc.v2', 'io.containerd.kata.v2']);
    expect((await cleanRoomFlavors(declared, undefined)).available).toEqual({ docker: true, gvisor: false, microvm: true });
    expect((await dockerRuntimes({ ...declared, FAKE_DOCKER_FAIL: '1' })).names).toEqual(['io.containerd.kata.v2']);
  });

  it('createVerified: create, inspect the runtime Docker chose, and only then a start by name; a lie, a refusal and a failed inspect remove the container and stop the start', async () => {
    const state = join(tmp, 'state');
    const log = join(tmp, 'docker.log');
    const base = { ...env, FAKE_DOCKER_STATE: state, FAKE_DOCKER_LOG: log, GONOGO_CLEANROOM_RUNTIMES: 'runsc' };
    const place = { worktree: repo, cwd: repo, home: join(home, 'h'), container: 'gonogo-ana-0123456789ab', network: null as string | null };
    const run = buildDockerArgs({ image: 'gonogo', flavor: 'gvisor', uid: 1, gid: 1, place, agentDir: home, names: [], command: ['node', '-e', ''] });
    await mkdir(home, { recursive: true });
    expect(await createVerified(run, 'runsc', place.container, { ...base, FAKE_DOCKER_RUNTIMES: 'runc,runsc' })).toEqual(['start', '-a', '-i', place.container]);
    const lines = (await readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { verb?: string; argv: string[] });
    expect(lines[0]).toMatchObject({ verb: 'create', runtime: 'runsc' });
    expect(lines[0]?.argv.slice(0, 3)).toEqual(['--rm', '-i', '-t']);
    // Docker chose another runtime: removed, refused, the reason names both
    await expect(createVerified(run, 'runsc', place.container, { ...base, FAKE_DOCKER_RUNTIMES: 'runc,runsc', FAKE_DOCKER_RUNTIME_ACTUAL: 'runc' })).rejects.toThrow('has the runtime "runc", not runsc: it was removed and nothing started');
    expect((await readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { verb?: string; argv: string[] }).at(-1)).toMatchObject({ verb: 'rm', argv: ['-f', place.container] });
    // Docker refuses the runtime outright (declared by the operator, not there): its words reach the message, and nothing is run by runc
    await expect(createVerified(run, 'runsc', place.container, { ...base, FAKE_DOCKER_RUNTIMES: 'runc' })).rejects.toThrow(/could not create the Clean Room container with the runtime runsc: .*unknown or invalid runtime name: runsc/);
  });

  it('checkCleanRoom: a named flavor needs its runtime; docker and no flavor do not', async () => {
    expect(await checkCleanRoom(repo, env, 'docker')).toBeNull();
    expect(await checkCleanRoom(repo, env)).toBeNull();
    expect(await checkCleanRoom(repo, env, 'gvisor')).toMatch(/needs the Docker runtime runsc.*not installed/);
    expect(await checkCleanRoom(repo, { ...env, FAKE_DOCKER_RUNTIMES: 'runc,runsc' }, 'gvisor')).toBeNull();
  });

  it('prepare fails closed: a flavor with no runtime, and the microVM, stop the start with the reason, and nothing falls back to runc', async () => {
    const base = join(home, 'agents', 'ana');
    await expect(prepareCleanRoom(record({ cleanRoom: { flavor: 'gvisor' } }), home, base, env)).rejects.toThrow(/gvisor Clean Room needs the Docker runtime runsc/);
    await expect(prepareCleanRoom(record(), home, base, env, 'gvisor')).rejects.toThrow(/gvisor Clean Room needs the Docker runtime runsc/); // the room default
    const kata = { ...env, FAKE_DOCKER_RUNTIMES: 'runc,io.containerd.kata.v2' };
    await expect(prepareCleanRoom(record({ cleanRoom: { flavor: 'microvm' } }), home, base, kata)).rejects.toThrow(/bridge network mode.*not built/);
    expect(await exists(join(home, 'cleanroom', 'ana'))).toBe(false); // refused before the worktree
    const runsc = { ...env, FAKE_DOCKER_RUNTIMES: 'runc,runsc' };
    await expect(prepareCleanRoom(record({ cleanRoom: { flavor: 'gvisor' } }), home, base, runsc)).resolves.toMatchObject({ network: null });
    await expect(prepareCleanRoom(record(), home, join(home, 'agents', 'ben'), env)).resolves.toBeDefined(); // docker: as before
  });
});

describe('cleanRoomImage', () => {
  it('the agent\'s own image, else GONOGO_CLEANROOM_IMAGE, else ghcr.io/ulm0/gonogo', () => {
    expect(cleanRoomImage({ image: 'mine' }, { GONOGO_CLEANROOM_IMAGE: 'env' })).toBe('mine');
    expect(cleanRoomImage({}, { GONOGO_CLEANROOM_IMAGE: ' env:2 ' })).toBe('env:2');
    expect(cleanRoomImage({}, { GONOGO_CLEANROOM_IMAGE: '' })).toBe('ghcr.io/ulm0/gonogo');
    expect(cleanRoomImage({}, {})).toBe('ghcr.io/ulm0/gonogo');
  });

  it('a variable that is not an image name stops the start with its name in the message', () => {
    expect(() => cleanRoomImage({}, { GONOGO_CLEANROOM_IMAGE: '--privileged' })).toThrow(/GONOGO_CLEANROOM_IMAGE is not a Docker image name/);
  });
});

describe('containerUrl', () => {
  it('only the loopback host of the server URL becomes the host\'s name for containers', () => {
    expect(containerUrl('http://127.0.0.1:7777')).toBe('http://host.docker.internal:7777');
    expect(containerUrl('http://[::1]:7777')).toBe('http://host.docker.internal:7777');
    expect(containerUrl('http://example.test:7777')).toBe('http://example.test:7777');
  });
});

describe('cleanRoomNetwork', () => {
  it('is null when unset or blank, and only container:<name> otherwise', () => {
    expect(cleanRoomNetwork({})).toBeNull();
    expect(cleanRoomNetwork({ GONOGO_CLEANROOM_NETWORK: ' ' })).toBeNull();
    expect(cleanRoomNetwork({ GONOGO_CLEANROOM_NETWORK: ' container:gonogo ' })).toBe('container:gonogo');
    for (const bad of ['host', 'bridge', 'mynet', 'container:', 'container:-x', 'container:a b']) {
      expect(() => cleanRoomNetwork({ GONOGO_CLEANROOM_NETWORK: bad })).toThrow(/GONOGO_CLEANROOM_NETWORK must be container:self or container:<name/);
    }
  });

  it('ownContainerRef: exactly one id of its own files; two ids are refused; with none only a host name that is itself a container id counts, anything else is refused with what to set', () => {
    const id = 'd857cec6be89'.padEnd(64, '1');
    const files = (root: string) => ({ mountinfo: () => `1 2 0:1 ${root} /etc/hosts rw - ext4 /dev/sda rw`, cgroup: () => '0::/', macs: () => [], ips: () => [] });
    expect(ownContainerRef(files(`/var/lib/docker/containers/${id}/hosts`), 'the-hosts-name')).toBe(id);
    expect(ownContainerRef({ ...files('/x'), mountinfo: () => '' }, '3f2a9c1b7e04')).toBe('3f2a9c1b7e04'); // Docker's default host name is the short id
    expect(() => ownContainerRef({ ...files('/x'), mountinfo: () => '' }, 'the-hosts-name')).toThrow(/cannot tell which container is gonogo's own: its files name none and the host name "the-hosts-name" is not a container id; set GONOGO_CLEANROOM_NETWORK=container:<the name of gonogo's own container>/);
    expect(() => ownContainerRef({ ...files('/x'), cgroup: () => { throw new Error('unreadable'); } }, 'nas')).toThrow(/none/);
    const two = { ...files(`/var/lib/docker/containers/${id}/hosts`), cgroup: () => `0::/docker/${'e'.repeat(64)}` };
    expect(() => ownContainerRef(two, '3f2a9c1b7e04')).toThrow(/its files name 2 \(d857cec6be89, eeeeeeeeeeee\)/); // nothing is guessed
    expect(cleanRoomNetwork({ GONOGO_CLEANROOM_NETWORK: 'container:self' }, ownContainerRef(files(`/var/lib/docker/containers/${id}/hosts`), 'x'))).toBe(`container:${id}`);
    // only the self value asks the files: an unset or a named network never throws for them
    expect(cleanRoomNetwork({})).toBeNull();
    expect(cleanRoomNetwork({ GONOGO_CLEANROOM_NETWORK: 'container:gonogo' })).toBe('container:gonogo');
  });

  it('reads container:self as gonogo own container, by its host name', () => {
    expect(cleanRoomNetwork({ GONOGO_CLEANROOM_NETWORK: 'container:self' }, '3f2a9c1b7e04')).toBe('container:3f2a9c1b7e04');
    expect(() => cleanRoomNetwork({ GONOGO_CLEANROOM_NETWORK: 'container:self' }, 'bad host')).toThrow(/"container:self"/);
  });
});

describe('sameMountError', () => {
  const bind = (path: string, source = path) => ({ Type: 'bind', Source: source, Destination: path });
  it('passes when the closest mount over the home is a bind mount from the same host path', () => {
    expect(sameMountError([bind('/var/run/docker.sock'), bind('/srv/gonogo')], '/srv/gonogo/state', 'gonogo')).toBeNull();
    expect(sameMountError([bind('/srv/gonogo/state')], '/srv/gonogo/state', 'gonogo')).toBeNull();
  });
  it('fails for another host path, a named volume, no mount, or a mount that only shares a prefix', () => {
    const text = /gonogo's home \/srv\/gonogo\/state is not mounted into the container gonogo from the same path .* -v \/srv\/gonogo\/state:\/srv\/gonogo\/state/;
    expect(sameMountError([bind('/srv/gonogo', '/home/me/data')], '/srv/gonogo/state', 'gonogo')).toMatch(text);
    expect(sameMountError([{ Type: 'volume', Source: '/var/lib/docker/volumes/x/_data', Destination: '/srv/gonogo' }], '/srv/gonogo/state', 'gonogo')).toMatch(text);
    expect(sameMountError([bind('/srv/gonogo'), { Type: 'volume', Source: '/v', Destination: '/srv/gonogo/state' }], '/srv/gonogo/state', 'gonogo')).toMatch(text);
    expect(sameMountError([], '/srv/gonogo/state', 'gonogo')).toMatch(text);
    expect(sameMountError(null, '/srv/gonogo/state', 'gonogo')).toMatch(text);
    expect(sameMountError([bind('/srv/gono')], '/srv/gonogo/state', 'gonogo')).toMatch(text);
  });
});

describe('buildDockerArgs', () => {
  const place = { worktree: '/h/cleanroom/ana', cwd: '/h/cleanroom/ana/sub', home: '/h/agents/ana/cleanroom-home', container: 'gonogo-ana-0123456789ab', network: null };
  const input = { image: 'gonogo', uid: 501, gid: 20, place, agentDir: '/h/agents/ana', names: ['GONOGO_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'], command: ['claude', '--resume', 'x'] as [string, ...string[]] };

  it('is one named `docker run --rm -i -t` with the two mounts at their own paths, .git read-only, the user, the host name, the variables by name and the program as the entrypoint', () => {
    expect(buildDockerArgs(input)).toEqual([
      'run', '--rm', '-i', '-t', '--init',
      '--name', 'gonogo-ana-0123456789ab',
      '--user', '501:20',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--add-host', 'host.docker.internal:host-gateway',
      '-e', 'HOME=/h/agents/ana/cleanroom-home',
      '-e', 'CLAUDE_CONFIG_DIR=/h/agents/ana/cleanroom-home',
      '-e', 'GONOGO_TOKEN',
      '-e', 'CLAUDE_CODE_OAUTH_TOKEN',
      '-v', '/h/cleanroom/ana:/h/cleanroom/ana',
      '-v', '/h/cleanroom/ana/.git:/h/cleanroom/ana/.git:ro',
      '-v', '/h/agents/ana:/h/agents/ana',
      '-w', '/h/cleanroom/ana/sub',
      '--entrypoint', 'claude',
      'gonogo',
      '--resume', 'x',
    ]);
  });

  it('never mounts gonogo\'s <home>/run (its sockets: api.sock, room.sock, the pty host) nor the home itself, nor anything above or inside them, on either network', () => {
    const home = '/h';
    for (const network of [null, 'container:gonogo']) {
      const args = buildDockerArgs({ ...input, place: { ...place, network } });
      const sources = args.flatMap((a, i) => (args[i - 1] === '-v' ? [a.split(':')[0] as string] : []));
      expect(sources).toEqual(['/h/cleanroom/ana', '/h/cleanroom/ana/.git', '/h/agents/ana']);
      for (const source of sources) {
        const inside = (dir: string, path: string): boolean => path === dir || path.startsWith(`${dir}/`);
        expect(inside(`${home}/run`, source), source).toBe(false); // not inside run/
        expect(inside(source, `${home}/run`), source).toBe(false); // not a folder that holds run/ (the home, or /)
        expect(source, source).not.toBe(home);
      }
    }
  });

  it('drops every capability and forbids gaining one (the container shares gonogo\'s network namespace), on either network, and adds nothing else of that kind', () => {
    for (const network of [null, 'container:gonogo']) {
      const args = buildDockerArgs({ ...input, place: { ...place, network } });
      expect(args.filter((a) => a === '--cap-drop')).toHaveLength(1);
      expect(args[args.indexOf('--cap-drop') + 1]).toBe('ALL');
      expect(args[args.indexOf('--security-opt') + 1]).toBe('no-new-privileges');
      expect(args.filter((a) => a === '--security-opt')).toHaveLength(1);
      for (const forbidden of ['--privileged', '--cap-add', '--pid', '--ipc', '--userns', '--device']) expect(args, forbidden).not.toContain(forbidden);
      // all of them come before the image, where docker reads its options
      expect(args.indexOf('--cap-drop')).toBeLessThan(args.indexOf(input.image));
    }
  });

  it('on gonogo\'s own network it joins that network in place of the host name', () => {
    const args = buildDockerArgs({ ...input, place: { ...place, network: 'container:gonogo' } });
    expect(args.slice(0, 13)).toEqual(['run', '--rm', '-i', '-t', '--init', '--name', 'gonogo-ana-0123456789ab', '--user', '501:20', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges']);
    expect(args.slice(13, 15)).toEqual(['--network', 'container:gonogo']);
    expect(args).not.toContain('--add-host');
  });

  it('a path with a colon cannot be mounted, and says so', () => {
    expect(() => buildDockerArgs({ ...input, agentDir: '/h/a:b' })).toThrow(/colon/);
    expect(() => buildDockerArgs({ ...input, place: { ...place, worktree: '/h/c:d' } })).toThrow(/colon/);
  });
});

describe('Docker and the repository', () => {
  it('checkDocker passes when `docker version` exits 0', async () => {
    await expect(checkDocker(env)).resolves.toBeUndefined();
  });

  it('checkDocker says what docker said when the daemon does not answer', async () => {
    await expect(checkDocker({ ...env, FAKE_DOCKER_FAIL: '1' })).rejects.toThrow(/Clean Room needs Docker, and "docker version" failed: Cannot connect to the Docker daemon/);
  });

  it('checkDocker says docker is not on PATH when it is not', async () => {
    await expect(checkDocker({ ...env, PATH: join(tmp, 'nowhere') })).rejects.toThrow('"docker version" failed: docker was not found on PATH');
  });

  it('repoRoot is the top of the repository, from any folder below it, and a folder outside one is refused', async () => {
    expect(await repoRoot(join(repo, 'sub'), env)).toBe(repo);
    await expect(repoRoot(tmp, env)).rejects.toThrow(/inside a git repository: fatal: not a git repository/);
  });

  it('checkCleanRoom answers null, or the one-line reason', async () => {
    expect(await checkCleanRoom(join(repo, 'sub'), env)).toBeNull();
    expect(await checkCleanRoom(tmp, env)).toMatch(/inside a git repository/);
    expect(await checkCleanRoom(repo, { ...env, FAKE_DOCKER_FAIL: '1' })).toMatch(/docker version/);
  });
});

describe('ensureWorktree', () => {
  it('makes the worktree on a new branch from HEAD, once, and finds it again', async () => {
    const path = join(home, 'cleanroom', 'ana');
    await ensureWorktree(repo, path, 'gonogo/ana', env);
    expect(await readFile(join(path, 'a.txt'), 'utf8')).toBe('a\n');
    expect(git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('gonogo/ana');
    await writeFile(join(path, 'work.txt'), 'kept\n');
    await ensureWorktree(repo, path, 'gonogo/ana', env);
    expect(await readFile(join(path, 'work.txt'), 'utf8')).toBe('kept\n');
    expect(git(repo, 'branch', '--list', 'gonogo/*').replace(/^[*+ ]+/, '')).toBe('gonogo/ana');
  });

  it('a worktree whose folder was deleted is made again on the branch it had', async () => {
    const path = join(home, 'cleanroom', 'ana');
    await ensureWorktree(repo, path, 'gonogo/ana', env);
    git(path, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '--allow-empty', '-m', 'agent work');
    await rm(path, { recursive: true });
    await ensureWorktree(repo, path, 'gonogo/ana', env);
    expect(git(path, 'log', '-1', '--format=%s')).toBe('agent work');
  });

  it('a folder in its place that is not a worktree of this repository is an error and is left alone', async () => {
    const path = join(home, 'cleanroom', 'ana');
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'mine.txt'), 'x');
    await expect(ensureWorktree(repo, path, 'gonogo/ana', env)).rejects.toThrow(/exists but is not a worktree of/);
    expect(await exists(join(path, 'mine.txt'))).toBe(true);
    // a worktree of another repository is no better
    const other = await realpath(await mkdir(join(tmp, 'other'), { recursive: true }).then(() => join(tmp, 'other')));
    await makeRepo(other);
    const foreign = join(home, 'cleanroom', 'bea');
    await ensureWorktree(other, foreign, 'gonogo/bea', env);
    await expect(ensureWorktree(repo, foreign, 'gonogo/bea', env)).rejects.toThrow(/exists but is not a worktree of/);
  });

  it('a branch that is checked out somewhere else is an error that names the worktree and the branch', async () => {
    git(repo, 'checkout', '-q', '-b', 'gonogo/ana');
    await expect(ensureWorktree(repo, join(home, 'cleanroom', 'ana'), 'gonogo/ana', env)).rejects.toThrow(/could not make the worktree .*cleanroom\/ana on gonogo\/ana/);
  });
});

describe('prepareCleanRoom', () => {
  it('the agent starts in the same folder of the worktree as it has in the repository, and has a home of its own', async () => {
    const base = join(home, 'agents', 'ana');
    const place = await prepareCleanRoom(record({ dir: join(repo, 'sub') }), home, base, env);
    const worktree = join(home, 'cleanroom', 'ana');
    expect(place).toEqual({ worktree, cwd: join(worktree, 'sub'), home: join(base, 'cleanroom-home'), container: containerName(worktree), network: null });
    expect(place.container).toMatch(/^gonogo-ana-[0-9a-f]{12}$/);
    expect((await stat(place.cwd)).isDirectory()).toBe(true);
    expect(((await stat(place.home)).mode & 0o777).toString(8)).toBe('700');
  });

  it('a folder that is not committed is not in the worktree, and the error says why', async () => {
    await mkdir(join(repo, 'draft'));
    await expect(prepareCleanRoom(record({ dir: join(repo, 'draft') }), home, join(home, 'agents', 'ana'), env)).rejects.toThrow(/draft is not in the worktree .*not committed/);
  });

  it('removes a container of that name left by an earlier start before the new one', async () => {
    const log = join(tmp, 'docker.jsonl');
    const place = await prepareCleanRoom(record(), home, join(home, 'agents', 'ana'), { ...env, FAKE_DOCKER_LOG: log });
    expect((await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as unknown)).toEqual([{ verb: 'rm', argv: ['-f', place.container] }]);
  });

  it('refuses a symbolic link the container could plant in its home, so trust is never written outside it', async () => {
    const base = join(home, 'agents', 'ana');
    await mkdir(join(base, 'cleanroom-home'), { recursive: true });
    await writeFile(join(tmp, 'owner.json'), '{}');
    await symlink(join(tmp, 'owner.json'), join(base, 'cleanroom-home', '.claude.json'));
    await expect(prepareCleanRoom(record(), home, base, env)).rejects.toThrow(/\.claude\.json is a symbolic link/);
    await rm(join(base, 'cleanroom-home'), { recursive: true });
    await symlink(tmp, join(base, 'cleanroom-home'));
    await expect(prepareCleanRoom(record(), home, base, env)).rejects.toThrow(/cleanroom-home is a symbolic link/);
    expect(await readFile(join(tmp, 'owner.json'), 'utf8')).toBe('{}');
  });

  it('with GONOGO_CLEANROOM_NETWORK it inspects gonogo\'s container before it touches the repository, and a bad value stops the hire', async () => {
    await expect(prepareCleanRoom(record(), home, join(home, 'agents', 'ana'), { ...env, GONOGO_CLEANROOM_NETWORK: 'container:gonogo' })).rejects.toThrow(
      /names the container gonogo, and "docker inspect" failed: fake-docker: unknown command inspect/,
    );
    expect(await exists(join(home, 'cleanroom'))).toBe(false);
    expect(await checkCleanRoom(repo, { ...env, GONOGO_CLEANROOM_NETWORK: 'bridge' })).toMatch(/must be container:self or container:<name/);
  });

  it('with gonogo in network_mode: host the Clean Room is joined as --network host, with host.docker.internal on 127.0.0.1; in another mode nothing changes', async () => {
    const id = 'd857cec6be89'.padEnd(64, '1');
    const mounts = JSON.stringify([{ Type: 'bind', Source: home, Destination: home }]);
    const place = await prepareCleanRoom(record(), home, join(home, 'agents', 'ana'), { ...env, GONOGO_CLEANROOM_NETWORK: `container:${id}`, FAKE_DOCKER_INSPECT_MOUNTS: mounts, FAKE_DOCKER_NETMODE: 'host', FAKE_DOCKER_ID: id });
    expect(place.network).toBe('host');
    const args = buildDockerArgs({ image: 'gonogo', uid: 1, gid: 1, place, agentDir: join(home, 'agents', 'ana'), names: [], command: ['claude'] });
    expect(args.slice(args.indexOf('--network'), args.indexOf('--network') + 4)).toEqual(['--network', 'host', '--add-host', 'host.docker.internal:127.0.0.1']);
    expect(args).not.toContain('host.docker.internal:host-gateway');
    // docker answering with ANOTHER container's id for that reference is refused
    await expect(prepareCleanRoom(record(), home, join(home, 'agents', 'cy'), { ...env, GONOGO_CLEANROOM_NETWORK: `container:${id}`, FAKE_DOCKER_INSPECT_MOUNTS: mounts, FAKE_DOCKER_NETMODE: 'host', FAKE_DOCKER_ID: 'f'.repeat(64) })).rejects.toThrow(/Docker answered with another container \(ffffffffffff\)/);
    // a mount that is not the same path still stops it, as before
    await expect(prepareCleanRoom(record(), home, join(home, 'agents', 'ben'), { ...env, GONOGO_CLEANROOM_NETWORK: `container:${id}`, FAKE_DOCKER_INSPECT_MOUNTS: '[]', FAKE_DOCKER_NETMODE: 'host' })).rejects.toThrow(/is not mounted into the container/);
  });

  it('checks Docker before it touches the repository', async () => {
    await expect(prepareCleanRoom(record(), home, join(home, 'agents', 'ana'), { ...env, FAKE_DOCKER_FAIL: '1' })).rejects.toThrow(/docker version/);
    expect(await exists(join(home, 'cleanroom'))).toBe(false);
  });
});

describe('the launcher starts a Clean Room agent through docker', () => {
  const SECRET = 'sk-ant-oat-the-secret-value';
  const KEY = 'sk-ant-api-the-other-secret';
  const start = async (agent: AgentRecord, extra: Record<string, string> = {}) => {
    const launcher = createLauncher({ homeDir: home, hubUrl: () => 'http://127.0.0.1:7777', seed: false, env: { ...env, ...extra } });
    return { launcher, prepared: await launcher.prepareStart(agent, { generation: 1, flag: null }) };
  };

  it('runs `docker run` as this user with the worktree and the agent\'s own folder, at their own paths', async () => {
    const { prepared } = await start(record({ dir: join(repo, 'sub') }), { CLAUDE_CODE_OAUTH_TOKEN: SECRET });
    const { spec } = prepared;
    const base = join(home, 'agents', 'ana');
    const worktree = join(home, 'cleanroom', 'ana');
    expect(spec.file).toBe('docker');
    expect(spec.cwd).toBe(worktree);
    const args = spec.args;
    expect(args.slice(0, 7)).toEqual(['run', '--rm', '-i', '-t', '--init', '--name', containerName(worktree)]);
    expect(args.slice(args.indexOf('--user'), args.indexOf('--user') + 8)).toEqual(['--user', `${process.getuid?.()}:${process.getgid?.()}`, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--add-host', 'host.docker.internal:host-gateway']);
    const mounts = args.flatMap((arg, i) => (args[i - 1] === '-v' ? [arg] : []));
    expect(mounts).toEqual([`${worktree}:${worktree}`, `${worktree}/.git:${worktree}/.git:ro`, `${base}:${base}`]);
    expect(args[args.indexOf('-w') + 1]).toBe(join(worktree, 'sub'));
    // the image's own entrypoint is gonogo, and its CLAUDE_CONFIG_DIR is a folder of the image's own user
    expect(args).toContain('HOME=' + join(base, 'cleanroom-home'));
    expect(args).toContain('CLAUDE_CONFIG_DIR=' + join(base, 'cleanroom-home'));
    expect(args.slice(args.indexOf('--entrypoint'), args.indexOf('--entrypoint') + 3)).toEqual(['--entrypoint', 'claude', 'ghcr.io/ulm0/gonogo']);
    expect(prepared.flag).toBe('session-id');
  });

  it('gives the program the argv of a Claude Code start after the image name, and the Clean Room note in the role', async () => {
    const { prepared } = await start(record());
    const args = prepared.spec.args;
    const after = args.slice(args.indexOf('ghcr.io/ulm0/gonogo') + 1);
    expect(after.slice(0, 2)).toEqual(['--session-id', SID]);
    expect(after).toContain('--strict-mcp-config');
    const role = after[after.indexOf('--append-system-prompt') + 1];
    expect(role).toContain(CLEAN_ROOM_NOTE.replace('{branch}', 'gonogo/ana'));
    expect(role).toContain('You are "ana"');
  });

  it('the image is the agent\'s own, else the variable, else gonogo', async () => {
    const image = async (agent: AgentRecord, extra: Record<string, string> = {}): Promise<string> => {
      const args = (await start(agent, extra)).prepared.spec.args;
      return args[args.indexOf('--entrypoint') + 2] ?? '';
    };
    expect(await image(record())).toBe('ghcr.io/ulm0/gonogo');
    expect(await image(record(), { GONOGO_CLEANROOM_IMAGE: 'from-env' })).toBe('from-env');
    expect(await image(record({ cleanRoom: { image: 'mine' } }), { GONOGO_CLEANROOM_IMAGE: 'from-env' })).toBe('mine');
  });

  it('gives the container the credentials and the token by name only: no value is on the command line', async () => {
    const { prepared } = await start(record(), { CLAUDE_CODE_OAUTH_TOKEN: SECRET, ANTHROPIC_API_KEY: KEY, AWS_SECRET_ACCESS_KEY: 'not-for-the-container' });
    const { args, env: childEnv } = prepared.spec;
    const named = args.flatMap((arg, i) => (args[i - 1] === '-e' && !arg.includes('=') ? [arg] : []));
    expect(named.sort()).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'COLORTERM', 'GONOGO_API_KEY', 'GONOGO_TOKEN', 'IS_DEMO', 'TERM']);
    expect(childEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe(SECRET);
    expect(childEnv.GONOGO_API_KEY).toBe(KEY);
    expect(childEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(childEnv.GONOGO_TOKEN).toBe(prepared.token);
    const line = args.join('\n');
    for (const secret of [SECRET, KEY, prepared.token, 'not-for-the-container']) expect(line).not.toContain(secret);
  });

  it('writes the hook and MCP URLs with the host\'s name for containers, and records trust for the container\'s home, not the owner\'s', async () => {
    const { prepared } = await start(record({ dir: join(repo, 'sub') }), { ANTHROPIC_API_KEY: KEY });
    const base = join(home, 'agents', 'ana');
    const settings = JSON.parse(await readFile(join(base, 'settings.json'), 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ url: string }> }>>; apiKeyHelper?: string };
    const urls = Object.values(settings.hooks).map((groups) => groups[0]?.hooks[0]?.url ?? '');
    expect(urls).toHaveLength(10);
    for (const url of urls) expect(url).toMatch(/^http:\/\/host\.docker\.internal:7777\/hook\/ana\/[A-Za-z]+$/);
    expect(settings.apiKeyHelper).toBe('printenv GONOGO_API_KEY');
    const mcp = JSON.parse(await readFile(join(base, 'mcp.json'), 'utf8')) as { mcpServers: { gonogo: { url: string } } };
    expect(mcp.mcpServers.gonogo.url).toBe('http://host.docker.internal:7777/mcp');
    const trust = JSON.parse(await readFile(join(base, 'cleanroom-home', '.claude.json'), 'utf8')) as { projects: Record<string, { hasTrustDialogAccepted: boolean }> };
    expect(trust.projects[join(home, 'cleanroom', 'ana', 'sub')]).toEqual({ hasTrustDialogAccepted: true });
    expect(prepared.spec.env.IS_DEMO).toBe('1');
  });

  describe('global MCP servers in a Clean Room', () => {
    const SERVER_TOKEN = 'Bearer ghp_secret-of-a-global-server';
    const mcpOf = async (cleanRoomOn: boolean, extra: Partial<AgentRecord> = {}): Promise<Record<string, unknown>> => {
      await mkdir(join(tmp, 'claude'), { recursive: true });
      await writeFile(join(tmp, 'claude', '.claude.json'), JSON.stringify({ mcpServers: { pulsar: { type: 'http', url: 'https://gamma.pulsar.codes/mcp', headers: { Authorization: SERVER_TOKEN } } } }));
      const launcher = createLauncher({ homeDir: home, hubUrl: () => 'http://127.0.0.1:7777', seed: false, env: { ...env, CLAUDE_CONFIG_DIR: join(tmp, 'claude') }, globalMcp: { enabled: (cleanRoom) => (cleanRoom ? cleanRoomOn : true) } });
      await launcher.prepareStart(record(extra), { generation: 1, flag: null });
      return (JSON.parse(await readFile(join(home, 'agents', 'ana', 'mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> }).mcpServers;
    };

    it('are not in a Clean Room\'s mcp.json unless the room says so: a global server can carry a header or a token into the container', async () => {
      const off = await mcpOf(false);
      expect(Object.keys(off)).toEqual(['gonogo']);
      expect(JSON.stringify(off)).not.toContain(SERVER_TOKEN);
    });

    it('are, with the room\'s switch on, and the agent can still switch one off by name', async () => {
      expect(Object.keys(await mcpOf(true))).toEqual(['pulsar', 'gonogo']);
      expect(Object.keys(await mcpOf(true, { payloadOff: { mcpServers: ['pulsar'] } }))).toEqual(['gonogo']);
    });
  });

  describe('egress: the Anthropic key stays out of the container', () => {
    const SECRET_OAUTH = 'sk-ant-oat-the-oauth-secret';
    interface Calls {
      issued: Array<{ agent: string; key: string | undefined }>;
      revoked: string[];
    }
    const withEgress = async (agent: AgentRecord, room: boolean, extra: Record<string, string> = {}, keys?: Record<string, string>) => {
      const calls: Calls = { issued: [], revoked: [] };
      const launcher = createLauncher({
        homeDir: home,
        hubUrl: () => 'http://127.0.0.1:7777',
        seed: false,
        env: { ...env, ...extra },
        ...(keys === undefined ? {} : { keys: () => keys }),
        egress: {
          enabled: () => room,
          issue: (name, key) => (calls.issued.push({ agent: name, key: key() }), 'f'.repeat(64)),
          revoke: (name) => void calls.revoked.push(name),
          basePath: (token) => `/egress/${token}/anthropic`,
        },
      });
      return { launcher, calls, prepared: await launcher.prepareStart(agent, { generation: 1, flag: null }) };
    };
    const named = (args: string[]): string[] => args.flatMap((arg, i) => (args[i - 1] === '-e' && !arg.includes('=') ? [arg] : [])).sort();

    it('on for the room: no real key by any name, in the container, the command line or the docker process; a placeholder and the base URL instead', async () => {
      const { prepared, calls } = await withEgress(record(), true, { ANTHROPIC_API_KEY: KEY, CLAUDE_CODE_OAUTH_TOKEN: SECRET_OAUTH, AWS_SECRET_ACCESS_KEY: 'not-for-the-container' });
      const { args, env: childEnv } = prepared.spec;
      expect(named(args)).toEqual(['ANTHROPIC_BASE_URL', 'COLORTERM', 'GONOGO_API_KEY', 'GONOGO_TOKEN', 'IS_DEMO', 'TERM']);
      expect(childEnv.ANTHROPIC_BASE_URL).toBe(`http://host.docker.internal:7777/egress/${'f'.repeat(64)}/anthropic`);
      expect(childEnv.GONOGO_API_KEY).toMatch(/^gnp_[0-9a-f]{32}$/);
      expect(childEnv.ANTHROPIC_API_KEY).toBeUndefined();
      expect(childEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      // nowhere in what the launcher hands to docker: the real key is only in the proxy's closure
      for (const secret of [KEY, SECRET_OAUTH]) expect(JSON.stringify(prepared.spec), secret).not.toContain(secret);
      expect(calls.issued).toEqual([{ agent: 'ana', key: KEY }]);
    });

    it('the proxy gets the key at request time, from the agent\'s Clearance first, else gonogo\'s own environment', async () => {
      const own = await withEgress(record(), true, { ANTHROPIC_API_KEY: KEY }, { ANTHROPIC_API_KEY: 'sk-ant-from-clearance' });
      expect(own.calls.issued[0]?.key).toBe('sk-ant-from-clearance');
      expect(JSON.stringify(own.prepared.spec)).not.toContain('sk-ant-from-clearance');
      expect(named(own.prepared.spec.args)).not.toContain('ANTHROPIC_API_KEY');
    });

    it('the agent\'s own setting wins over the room\'s, either way, and with nothing set the room decides', async () => {
      const off = await withEgress(record({ cleanRoom: { egress: false } }), true, { ANTHROPIC_API_KEY: KEY });
      expect(off.calls.issued).toEqual([]);
      expect(off.prepared.spec.env.GONOGO_API_KEY).toBe(KEY);
      const on = await withEgress(record({ cleanRoom: { egress: true } }), false, { ANTHROPIC_API_KEY: KEY });
      expect(on.calls.issued).toHaveLength(1);
      expect(on.prepared.spec.env.GONOGO_API_KEY).not.toBe(KEY);
      const inherit = await withEgress(record({ cleanRoom: {} }), false, { ANTHROPIC_API_KEY: KEY });
      expect(inherit.calls.issued).toEqual([]);
    });

    it('off (the default): the start is exactly what it was, credentials and all', async () => {
      const plain = await start(record(), { CLAUDE_CODE_OAUTH_TOKEN: SECRET_OAUTH, ANTHROPIC_API_KEY: KEY });
      const { prepared, calls } = await withEgress(record(), false, { CLAUDE_CODE_OAUTH_TOKEN: SECRET_OAUTH, ANTHROPIC_API_KEY: KEY });
      expect(calls.issued).toEqual([]);
      expect(named(prepared.spec.args)).toEqual(named(plain.prepared.spec.args));
      expect(prepared.spec.env.GONOGO_API_KEY).toBe(KEY);
      expect(prepared.spec.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(SECRET_OAUTH);
      expect(prepared.spec.env.ANTHROPIC_BASE_URL).toBeUndefined();
    });

    it('on with no API key (a subscription token only) changes nothing and says so; the token stays as it was', async () => {
      const { prepared, calls } = await withEgress(record(), true, { CLAUDE_CODE_OAUTH_TOKEN: SECRET_OAUTH });
      expect(calls.issued).toEqual([]);
      expect(named(prepared.spec.args)).toContain('CLAUDE_CODE_OAUTH_TOKEN');
      expect(prepared.spec.env.ANTHROPIC_BASE_URL).toBeUndefined();
    });

    it('the proxy token goes when the agent\'s does: at the stop, and when the start fails', async () => {
      const { launcher, calls } = await withEgress(record(), true, { ANTHROPIC_API_KEY: KEY });
      launcher.revoke('ana', 1);
      expect(calls.revoked).toEqual(['ana']);
      // a revoke of another generation is not this start's
      launcher.revoke('ana', 7);
      expect(calls.revoked).toEqual(['ana']);
      const again = await launcher.prepareStart(record(), { generation: 2, flag: null });
      expect(again.spec.env.ANTHROPIC_BASE_URL).toContain('/egress/');
      launcher.keepTokens([]);
      expect(calls.revoked).toEqual(['ana', 'ana']);
    });
  });

  it('a restart resumes the session that the container\'s own home holds', async () => {
    const { launcher } = await start(record());
    const projects = join(home, 'agents', 'ana', 'cleanroom-home', 'projects', 'p');
    await mkdir(projects, { recursive: true });
    await writeFile(join(projects, `${SID}.jsonl`), '{}\n');
    const again = await launcher.prepareStart(record(), { generation: 2, flag: null });
    expect(again.flag).toBe('resume');
    expect(again.spec.args).toContain('--resume');
  });

  it('the end of a start removes its container, and the next start waits for that removal', async () => {
    const log = join(tmp, 'docker.jsonl');
    const { launcher, prepared } = await start(record(), { FAKE_DOCKER_LOG: log });
    const name = prepared.spec.args[prepared.spec.args.indexOf('--name') + 1];
    const removals = async (): Promise<number> => (await readFile(log, 'utf8')).trim().split('\n').filter((line) => line.includes('"rm"')).length;
    expect(await removals()).toBe(1); // the one before the start
    launcher.revoke('ana', 2); // another generation: not this start
    launcher.revoke('ana', 1);
    await launcher.prepareStart(record(), { generation: 2, flag: null });
    const lines = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { argv: string[] });
    expect(lines.map((line) => line.argv)).toEqual([['-f', name], ['-f', name], ['-f', name]]);
  });

  it('an agent without the setting still runs on the host, with loopback URLs', async () => {
    const plain = record();
    delete plain.cleanRoom;
    const { prepared } = await start(plain);
    expect(prepared.spec.file).toBe('claude');
    expect(prepared.spec.cwd).toBe(repo);
    expect(await exists(join(home, 'cleanroom'))).toBe(false);
    const settings = await readFile(join(home, 'agents', 'ana', 'settings.json'), 'utf8');
    expect(settings).toContain('http://127.0.0.1:7777/hook/ana/');
    expect(settings).not.toContain('host.docker.internal');
  });

  it('refuses to start when Docker does not answer, with the reason, and leaves no token behind', async () => {
    const launcher = createLauncher({ homeDir: home, hubUrl: () => 'http://127.0.0.1:7777', seed: false, env: { ...env, FAKE_DOCKER_FAIL: '1' } });
    await expect(launcher.prepareStart(record(), { generation: 1, flag: null })).rejects.toThrow(/Clean Room needs Docker, and "docker version" failed: Cannot connect/);
    expect(await exists(join(home, 'agents', 'ana', 'token'))).toBe(false);
  });

  describe('the sandbox flavor at a start', () => {
    const flavored = (extra: Record<string, string>, roomDefault?: 'gvisor' | 'microvm' | 'docker') =>
      createLauncher({ homeDir: home, hubUrl: () => 'http://127.0.0.1:7777', seed: false, env: { ...env, FAKE_DOCKER_STATE: join(tmp, 'state'), FAKE_DOCKER_LOG: join(tmp, 'flavor.log'), ...extra }, ...(roomDefault === undefined ? {} : { defaultSandbox: () => roomDefault }) });
    const prepare = (launcher: ReturnType<typeof flavored>, agent: AgentRecord) => launcher.prepareStart(agent, { generation: 1, flag: null });

    it('docker: one docker run, as always; no create, no --runtime', async () => {
      const { spec } = await prepare(flavored({}), record());
      expect(spec.args[0]).toBe('run');
      expect(spec.args).not.toContain('--runtime');
    });

    it('gvisor (own, or the room\'s default): created with --runtime runsc, the runtime verified, then started by name', async () => {
      for (const [agent, roomDefault] of [[record({ cleanRoom: { flavor: 'gvisor' } }), undefined], [record(), 'gvisor' as const]] as const) {
        const { spec } = await prepare(flavored({ FAKE_DOCKER_RUNTIMES: 'runc,runsc' }, roomDefault), agent);
        expect(spec.args).toEqual(['start', '-a', '-i', containerName(join(home, 'cleanroom', 'ana'))]);
      }
      const created = (await readFile(join(tmp, 'flavor.log'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { verb?: string; runtime?: string; argv: string[] }).filter((l) => l.verb === 'create');
      expect(created.map((c) => c.runtime)).toEqual(['runsc', 'runsc']);
      expect(created[0]?.argv).toContain('--runtime');
    });

    it('fails closed: no runtime, a runtime Docker lied about, and the microVM, each refuse the start with the reason and nothing runs', async () => {
      await expect(prepare(flavored({}), record({ cleanRoom: { flavor: 'gvisor' } }))).rejects.toThrow(/needs the Docker runtime runsc.*not installed/);
      await expect(prepare(flavored({ FAKE_DOCKER_RUNTIMES: 'runc,runsc', FAKE_DOCKER_RUNTIME_ACTUAL: 'runc' }), record({ cleanRoom: { flavor: 'gvisor' } }))).rejects.toThrow(/has the runtime "runc", not runsc/);
      await expect(prepare(flavored({ FAKE_DOCKER_RUNTIMES: 'runc,io.containerd.kata.v2' }), record({ cleanRoom: { flavor: 'microvm' } }))).rejects.toThrow(/bridge network mode/);
      // declared by the operator but not there: Docker refuses, and so does the start
      await expect(prepare(flavored({ GONOGO_CLEANROOM_RUNTIMES: 'runsc' }), record({ cleanRoom: { flavor: 'gvisor' } }))).rejects.toThrow(/unknown or invalid runtime name: runsc/);
      expect(await exists(join(home, 'agents', 'ana', 'token'))).toBe(false);
    });
  });

  it('refuses to start when the folder is no longer inside a repository', async () => {
    const outside = join(tmp, 'plain');
    await mkdir(outside);
    const launcher = createLauncher({ homeDir: home, hubUrl: () => 'http://127.0.0.1:7777', seed: false, env });
    await expect(launcher.prepareStart(record({ dir: outside }), { generation: 1, flag: null })).rejects.toThrow(/inside a git repository/);
  });
});

describe("the room's keys and a Clean Room", () => {
  it('a Clean Room agent gets only the room keys marked for it, by name, never the value on the command line; its own key still wins', async () => {
    const asked: boolean[] = [];
    const roomKeys = (cleanRoom: boolean): Record<string, string> => {
      asked.push(cleanRoom);
      return cleanRoom ? { MARKED_KEY: 'marked-secret' } : { MARKED_KEY: 'marked-secret', OTHER_KEY: 'other-secret' };
    };
    const launcher = createLauncher({ homeDir: home, hubUrl: () => 'http://127.0.0.1:7777', seed: false, env, roomKeys, keys: () => ({ MARKED_KEY: 'own-secret' }) });
    const { spec } = await launcher.prepareStart(record(), { generation: 1, flag: null });
    expect(asked).toEqual([true]);
    const named = spec.args.flatMap((arg, i) => (spec.args[i - 1] === '-e' && !arg.includes('=') ? [arg] : []));
    expect(named).toContain('MARKED_KEY');
    expect(named).not.toContain('OTHER_KEY');
    expect(spec.env.MARKED_KEY).toBe('own-secret');
    expect(spec.env.OTHER_KEY).toBeUndefined();
    for (const secret of ['marked-secret', 'other-secret', 'own-secret']) expect(spec.args.join('\n')).not.toContain(secret);
  });
});

describe("the room's Payload defaults and a Clean Room", () => {
  it('a Clean Room agent gets its own servers and none of the room\'s (their env and headers hold keys); a plain agent gets both', async () => {
    const roomServer = { command: 'room-server', env: { TOKEN: 'room-secret' } };
    const own = { command: 'own-server' };
    const launcher = createLauncher({ homeDir: home, hubUrl: () => 'http://127.0.0.1:7777', seed: false, env, payloadDefaults: () => ({ mcpServers: { roomone: roomServer } }) });
    await launcher.prepareStart(record({ payload: { mcpServers: { own } } }), { generation: 1, flag: null });
    const text = await readFile(join(home, 'agents', 'ana', 'mcp.json'), 'utf8');
    expect(Object.keys((JSON.parse(text) as { mcpServers: object }).mcpServers)).toEqual(['own', 'gonogo']);
    expect(text).not.toContain('room-secret');
    await launcher.prepareStart(record({ cleanRoom: undefined, payload: { mcpServers: { own } } }), { generation: 2, flag: null });
    expect(Object.keys((JSON.parse(await readFile(join(home, 'agents', 'ana', 'mcp.json'), 'utf8')) as { mcpServers: object }).mcpServers)).toEqual(['roomone', 'own', 'gonogo']);
  });
});

describe('Clean Room under the rooms supervisor', () => {
  it('is refused on Linux outside a container without a network to join, and only for a room of the supervisor', () => {
    const room = { GONOGO_SUPERVISOR_PID: '42' };
    expect(cleanRoomHostProblem(room, 'linux', false, null)).toMatch(/Clean Room needs gonogo in Docker/);
    expect(cleanRoomHostProblem(room, 'linux', true, null)).toBeNull();
    expect(cleanRoomHostProblem(room, 'linux', false, 'container:gonogo')).toBeNull();
    expect(cleanRoomHostProblem(room, 'darwin', false, null)).toBeNull();
    expect(cleanRoomHostProblem(room, 'win32', false, null)).toBeNull();
    // a gonogo that is not a room of the supervisor (a library user, the tests) is not touched
    expect(cleanRoomHostProblem({}, 'linux', false, null)).toBeNull();
  });
});
