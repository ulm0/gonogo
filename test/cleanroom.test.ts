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
import {
  buildDockerArgs,
  checkCleanRoom,
  checkDocker,
  cleanRoomImage,
  cleanRoomNetwork,
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

  it('refuses what is not a setting, a field it does not know, an image docker would read as an option, and another engine', () => {
    const refused = (value: unknown, provider?: Parameters<typeof parseCleanRoom>[1]): string => {
      const checked = parseCleanRoom(value, provider);
      if (checked.ok) throw new Error(`expected a refusal, got ${JSON.stringify(checked.cleanRoom)}`);
      return checked.error;
    };
    for (const value of [null, undefined, 'x', 1, true, []]) expect(refused(value)).toBe('cleanRoom must be an object');
    expect(refused({ mount: '/' })).toBe('cleanRoom has no field "mount"');
    for (const image of ['', '-v', '--privileged', 'a b', 'a;b', 'a\nb', 'a'.repeat(201), 3, null]) expect(refused({ image }), String(image)).toMatch(/Docker image name/);
    expect(refused({}, 'gemini')).toBe('a Clean Room runs Claude Code agents only');
    expect(refused({}, 'custom')).toBe('a Clean Room runs Claude Code agents only');
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
      expect(() => cleanRoomNetwork({ GONOGO_CLEANROOM_NETWORK: bad })).toThrow(/GONOGO_CLEANROOM_NETWORK must be container:<name/);
    }
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

  it('on gonogo\'s own network it joins that network in place of the host name', () => {
    const args = buildDockerArgs({ ...input, place: { ...place, network: 'container:gonogo' } });
    expect(args.slice(0, 11)).toEqual(['run', '--rm', '-i', '-t', '--init', '--name', 'gonogo-ana-0123456789ab', '--user', '501:20', '--network', 'container:gonogo']);
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
    expect(await checkCleanRoom(repo, { ...env, GONOGO_CLEANROOM_NETWORK: 'bridge' })).toMatch(/must be container:<name/);
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
    expect(args.slice(args.indexOf('--user'), args.indexOf('--user') + 4)).toEqual(['--user', `${process.getuid?.()}:${process.getgid?.()}`, '--add-host', 'host.docker.internal:host-gateway']);
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
    expect(urls).toHaveLength(8);
    for (const url of urls) expect(url).toMatch(/^http:\/\/host\.docker\.internal:7777\/hook\/ana\/[A-Za-z]+$/);
    expect(settings.apiKeyHelper).toBe('printenv GONOGO_API_KEY');
    const mcp = JSON.parse(await readFile(join(base, 'mcp.json'), 'utf8')) as { mcpServers: { gonogo: { url: string } } };
    expect(mcp.mcpServers.gonogo.url).toBe('http://host.docker.internal:7777/mcp');
    const trust = JSON.parse(await readFile(join(base, 'cleanroom-home', '.claude.json'), 'utf8')) as { projects: Record<string, { hasTrustDialogAccepted: boolean }> };
    expect(trust.projects[join(home, 'cleanroom', 'ana', 'sub')]).toEqual({ hasTrustDialogAccepted: true });
    expect(prepared.spec.env.IS_DEMO).toBe('1');
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

  it('refuses to start when the folder is no longer inside a repository', async () => {
    const outside = join(tmp, 'plain');
    await mkdir(outside);
    const launcher = createLauncher({ homeDir: home, hubUrl: () => 'http://127.0.0.1:7777', seed: false, env });
    await expect(launcher.prepareStart(record({ dir: outside }), { generation: 1, flag: null })).rejects.toThrow(/inside a git repository/);
  });
});
