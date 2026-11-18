/**
 * Docker self-update (docs/self-update-spec.md) against a fake Docker Engine API: an in-memory daemon with scripted answers, plus one
 * test of the real transport over a unix socket. No real Docker daemon and no real image pull ran: that path is not tested here.
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentCounts, updateDialogText } from '../src/client/selfupdate.js';
import { parseArgs } from '../src/server/cli.js';
import { followResult, settleResult, viewOfResult, checkPrevious, copyBody, REF_LABEL, selfRef, dockerUpdateStatus, helperBody, parseImage, pinnedReason, pullAndCheck, readResult, redact, socketCall, startHelper, swap, VERSION_LABEL, writeResult } from '../src/server/dockerupdate.js';
import type { DockerCall } from '../src/server/dockerupdate.js';
import { createUpdater, UpdateError } from '../src/server/updater.js';
import type { UpdateView } from '../src/shared/protocol.js';

const ME = 'a'.repeat(64);
const OLD_IMG = 'sha256:' + '1'.repeat(64);
const NEW_IMG = 'sha256:' + '2'.repeat(64);

interface Fake {
  call: DockerCall;
  log: string[];
  bodies: Record<string, unknown>[];
  /** containers by id */
  boxes: Map<string, { id: string; name: string; running: boolean; image: string; body?: Record<string, unknown>; labels?: Record<string, string> }>;
  script: { pullLabel: string; health: 'healthy' | 'unhealthy' | 'exited' | 'none'; failStart: boolean; failCreate: boolean; failRollbackStart: boolean; imageRef: string; pullStatus: number; logs: string; apiVersion: string; stopThrows: boolean };
}

/** What the old image itself says (the default command, entrypoint, healthcheck, environment and labels). */
const OLD_IMAGE_CONFIG = { Cmd: ['serve'], Entrypoint: ['gonogo'], Healthcheck: { Test: ['CMD', 'old'] }, Env: ['PATH=/x', 'GONOGO_INSTALL=docker'], Labels: { 'org.opencontainers.image.version': '0.3.0' } };
/** The container: the image's values, the owner's env, the compose labels, an id as hostname. */
const OLD_CONFIG = { ...OLD_IMAGE_CONFIG, Image: 'ghcr.io/ulm0/gonogo:latest', Hostname: ME.slice(0, 12), Env: [...OLD_IMAGE_CONFIG.Env, 'MINE=1'], User: '1000:1000', Labels: { ...OLD_IMAGE_CONFIG.Labels, 'com.docker.compose.project': 'room', 'com.docker.compose.service': 'gonogo', 'com.docker.compose.config-hash': 'abc' } };
const INSPECT = {
  Id: ME,
  Name: '/gonogo',
  Image: OLD_IMG,
  Config: OLD_CONFIG,
  HostConfig: { PortBindings: { '7777/tcp': [{ HostIp: '127.0.0.1', HostPort: '7777' }] }, Binds: ['/srv/gonogo:/state', '/var/run/docker.sock:/var/run/docker.sock'], Init: true, ExtraHosts: ['host.docker.internal:127.0.0.1'], GroupAdd: ['999'], RestartPolicy: { Name: 'unless-stopped' }, NetworkMode: 'room_default' },
  NetworkSettings: { Networks: { room_default: { Aliases: ['gonogo', ME.slice(0, 12)], IPAMConfig: null, DriverOpts: null } } },
  Mounts: [
    { Type: 'bind', Source: '/srv/gonogo', Destination: '/state' },
    { Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock' },
  ],
  State: { Running: true },
};

function fake(): Fake {
  const f: Fake = { call: async () => ({ status: 500, text: '' }), log: [], bodies: [], boxes: new Map(), script: { pullLabel: '0.4.0', health: 'healthy', failStart: false, failCreate: false, failRollbackStart: false, imageRef: 'ghcr.io/ulm0/gonogo:latest', pullStatus: 200, logs: 'boom one\nboom two\n', apiVersion: '1.45', stopThrows: false } };
  f.boxes.set(ME, { id: ME, name: 'gonogo', running: true, image: OLD_IMG });
  let n = 0;
  const find = (key: string) => [...f.boxes.values()].find((b) => b.id.startsWith(key) || b.name === key);
  const ok = (text = ''): { status: number; text: string } => ({ status: 204, text });
  f.call = async (method, path, body) => {
    const [route = '', query = ''] = path.split('?');
    const params = new URLSearchParams(query);
    f.log.push(`${method} ${route}${params.get('name') !== null ? `?name=${params.get('name')}` : ''}`);
    if (body !== undefined) f.bodies.push({ route, ...(body as object) } as Record<string, unknown>);
    if (route === '/containers/json') {
      const filters = JSON.parse(params.get('filters') ?? '{}') as { label?: string[]; status?: string[] };
      const all = [...f.boxes.values()].map((b) => ({ Id: b.id, Names: [`/${b.name}`], State: b.running ? 'running' : 'exited', Labels: b.labels ?? {} }));
      return { status: 200, text: JSON.stringify(all.filter((c) => (filters.status === undefined || filters.status.includes(c.State)) && (filters.label === undefined || filters.label.every((l) => c.Labels[l.split('=')[0] ?? ''] === l.split('=')[1])))) };
    }
    const m = /^\/containers\/([^/]+)(?:\/(\w+))?$/.exec(route);
    if (route === '/_ping') return { status: 200, text: 'OK' };
    if (route === '/version') return { status: 200, text: JSON.stringify({ ApiVersion: f.script.apiVersion }) };
    if (route === '/images/create') return { status: f.script.pullStatus, text: '{"status":"Pulling"}\n{"status":"Digest: x"}\n' };
    if (route === '/containers/create') {
      if (f.script.failCreate) return { status: 500, text: '{"message":"no such network"}' };
      const id = `${++n}`.repeat(64).slice(0, 64);
      f.boxes.set(id, { id, name: params.get('name') ?? '', running: false, image: NEW_IMG, body: body as Record<string, unknown> });
      return { status: 201, text: JSON.stringify({ Id: id }) };
    }
    const img = /^\/images\/(.+)\/json$/.exec(route);
    if (img !== null) {
      const ref = decodeURIComponent(img[1] ?? '');
      if (ref === OLD_IMG) return { status: 200, text: JSON.stringify({ Id: OLD_IMG, Config: OLD_IMAGE_CONFIG, RepoTags: [], RepoDigests: ['ghcr.io/ulm0/gonogo@sha256:' + '3'.repeat(64)] }) };
      if (ref === f.script.imageRef || ref === NEW_IMG) return { status: 200, text: JSON.stringify({ Id: NEW_IMG, Config: { Labels: { [VERSION_LABEL]: f.script.pullLabel }, Cmd: ['serve'] } }) };
      return { status: 404, text: '{"message":"no such image"}' };
    }
    if (m === null) return { status: 404, text: '{"message":"unknown route"}' };
    const box = find(decodeURIComponent(m[1] ?? ''));
    if (box === undefined) return { status: 404, text: '{"message":"no such container"}' };
    const verb = m[2] ?? (method === 'DELETE' ? 'rm' : 'json');
    switch (verb) {
      case 'json': {
        if (box.id === ME || box.name.startsWith('gonogo') && box.image === OLD_IMG) return { status: 200, text: JSON.stringify({ ...INSPECT, Id: box.id, Name: `/${box.name}`, State: { Running: box.running } }) };
        const state = f.script.health === 'exited' ? { Running: false, ExitCode: 1 } : f.script.health === 'none' ? { Running: box.running } : { Running: box.running, Health: { Status: f.script.health } };
        return { status: 200, text: JSON.stringify({ Id: box.id, Name: `/${box.name}`, State: state }) };
      }
      case 'stop':
        box.running = false;
        if (f.script.stopThrows) throw new Error('the Docker API did not answer in time');
        return ok();
      case 'rename':
        box.name = params.get('name') ?? '';
        return ok();
      case 'start':
        if (box.image === NEW_IMG && f.script.failStart) return { status: 500, text: '{"message":"port is already allocated"}' };
        if (box.image === OLD_IMG && f.script.failRollbackStart) return { status: 500, text: '{"message":"cannot start the old one"}' };
        box.running = true;
        return ok();
      case 'rm':
        f.boxes.delete(box.id);
        return ok();
      case 'logs':
        return { status: 200, text: f.script.logs.split('\n').filter((l) => l !== '').map((l) => `\u0001\u0000\u0000\u0000\u0000\u0000\u0000${String.fromCharCode(l.length + 1)}${l}\n`).join('') };
      default:
        return { status: 404, text: '' };
    }
  };
  return f;
}
const names = (f: Fake): string[] => [...f.boxes.values()].map((b) => `${b.name}${b.running ? '*' : ''}`).sort();
const sleep = async (): Promise<void> => undefined;
const SWAP = { target: ME, image: NEW_IMG, expect: '0.4.0', home: '/state', sleep, suffix: 'a1b2c3' };

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gonogo-selfupdate-'));
  // the updater tests keep update.json in this folder: it is a mount of the container, as the home is in a real one
  INSPECT.Mounts[2] = { Type: 'bind', Source: '/srv/gonogo-tmp', Destination: dir };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the image reference', () => {
  it('parses a tag, a registry port and a digest', () => {
    expect(parseImage('ghcr.io/ulm0/gonogo:latest')).toEqual({ repo: 'ghcr.io/ulm0/gonogo', tag: 'latest', digest: null });
    expect(parseImage('localhost:5000/x/y')).toEqual({ repo: 'localhost:5000/x/y', tag: null, digest: null });
    expect(parseImage('x@sha256:ab')).toEqual({ repo: 'x', tag: null, digest: 'sha256:ab' });
  });

  it('refuses a pinned tag, a digest and an image id, and takes a moving tag', () => {
    for (const ref of ['ghcr.io/ulm0/gonogo:0.3.0', 'x:v1.2.3', 'x:1.2.3-rc.1', 'x@sha256:' + 'a'.repeat(64), OLD_IMG, 'a'.repeat(64)]) expect(pinnedReason(ref), ref).not.toBeNull();
    for (const ref of ['ghcr.io/ulm0/gonogo:latest', 'ghcr.io/ulm0/gonogo:0.3', 'ghcr.io/ulm0/gonogo:0', 'ghcr.io/ulm0/gonogo', 'localhost:5000/gonogo']) expect(pinnedReason(ref), ref).toBeNull();
    expect(pinnedReason('x:0.3.0')).toContain('pinned to 0.3.0');
  });
});

describe('the copy of the container', () => {
  const body = copyBody(INSPECT, { Config: OLD_IMAGE_CONFIG }, NEW_IMG) as Record<string, unknown> & { HostConfig: typeof INSPECT.HostConfig; Labels: Record<string, string>; Env: string[]; NetworkingConfig: { EndpointsConfig: Record<string, { Aliases?: string[] }> } };

  it('keeps ports, binds, Init, extra hosts, groups, restart policy and every compose label', () => {
    expect(body.HostConfig).toEqual(INSPECT.HostConfig);
    expect(body.Labels).toEqual({ 'com.docker.compose.project': 'room', 'com.docker.compose.service': 'gonogo', 'com.docker.compose.config-hash': 'abc', 'gonogo.self-update.ref': 'ghcr.io/ulm0/gonogo:latest' });
    expect(body.Image).toBe(NEW_IMG);
    expect(body.User).toBe('1000:1000');
  });

  it("drops what the old image gave (its labels, command, entrypoint, healthcheck, env), the id hostname and the old id alias", () => {
    expect(body).not.toHaveProperty('Cmd');
    expect(body).not.toHaveProperty('Entrypoint');
    expect(body).not.toHaveProperty('Healthcheck');
    expect(body).not.toHaveProperty('Hostname');
    expect(body.Labels).not.toHaveProperty(VERSION_LABEL);
    expect(body.Env).toEqual(['MINE=1']);
    expect(body.NetworkingConfig.EndpointsConfig.room_default).toEqual({ Aliases: ['gonogo'] });
  });

  it('keeps a command the owner set himself', () => {
    const own = copyBody({ ...INSPECT, Config: { ...OLD_CONFIG, Cmd: ['serve', '--port', '9'] } }, { Config: OLD_IMAGE_CONFIG }, NEW_IMG);
    expect(own.Cmd).toEqual(['serve', '--port', '9']);
  });
});

describe('after one good update the container runs from an image id', () => {
  // what swap() created: Config.Image is the id, the moving reference is a label
  const created = (): Record<string, unknown> => {
    const body = copyBody(INSPECT, { Config: OLD_IMAGE_CONFIG }, NEW_IMG) as Record<string, unknown>;
    return { ...INSPECT, Id: 'b'.repeat(64), Image: NEW_IMG, Config: { ...body, Image: NEW_IMG } };
  };

  it('keeps the moving reference in a label, so the next update and UNDO are not refused as pinned', async () => {
    const inspect = created();
    expect((inspect.Config as { Labels: Record<string, string> }).Labels[REF_LABEL]).toBe('ghcr.io/ulm0/gonogo:latest');
    expect(selfRef(inspect)).toBe('ghcr.io/ulm0/gonogo:latest');
    expect(pinnedReason(selfRef(inspect))).toBeNull();
    const f = fake();
    const second: DockerCall = async (m, p, b) => (/^\/containers\/[^/]+\/json$/.test(p) ? { status: 200, text: JSON.stringify(inspect) } : f.call(m, p, b));
    expect(await dockerUpdateStatus(second, 'b'.repeat(12))).toEqual({ ready: true, text: 'ready' });
    expect(await pullAndCheck(second, 'b'.repeat(12), '0.4.0')).toMatchObject({ image: NEW_IMG });
    await expect(checkPrevious(second, 'b'.repeat(12), { previousImage: OLD_IMG, from: '0.3.0' })).resolves.toBeUndefined();
    // and the next copy keeps the label
    expect(((copyBody(inspect, { Config: {} }, OLD_IMG) as { Labels: Record<string, string> }).Labels)[REF_LABEL]).toBe('ghcr.io/ulm0/gonogo:latest');
  });

  it('a container run from a bare id with no label is still refused', () => {
    expect(pinnedReason(selfRef({ Config: { Image: NEW_IMG } }))).toMatch(/image id/);
  });
});

describe('the pull and the checks', () => {
  it('pulls the container\'s own tag and returns the new image id with both versions', async () => {
    const f = fake();
    const got = await pullAndCheck(f.call, ME.slice(0, 12), '0.4.0');
    expect(got).toMatchObject({ image: NEW_IMG, previousImage: OLD_IMG, from: '0.3.0' });
    expect(f.log).toContain('POST /images/create');
    expect(f.log.filter((l) => /stop|create$|rename/.test(l)).filter((l) => l !== 'POST /images/create')).toEqual([]);
  });

  it('aborts before anything is created or stopped when the label is not the clicked version', async () => {
    const f = fake();
    f.script.pullLabel = '0.3.9';
    await expect(pullAndCheck(f.call, ME, '0.4.0')).rejects.toThrow(/is version 0\.3\.9, not 0\.4\.0: nothing was changed/);
    expect(f.log.some((l) => /containers\/create|stop|rename|start/.test(l))).toBe(false);
    f.script.pullLabel = '';
    await expect(pullAndCheck(f.call, ME, '0.4.0')).rejects.toThrow(/no version label/);
  });

  it('refuses a pinned container before it pulls, a bad version, and a failed pull', async () => {
    const f = fake();
    const pinned = (inspect: unknown): DockerCall => async (m, p, b) => (/\/containers\/.+\/json$/.test(p) ? { status: 200, text: JSON.stringify(inspect) } : f.call(m, p, b));
    await expect(pullAndCheck(pinned({ ...INSPECT, Config: { ...OLD_CONFIG, Image: 'ghcr.io/ulm0/gonogo:0.3.0' } }), ME, '0.4.0')).rejects.toThrow(/pinned to 0\.3\.0/);
    expect(f.log).toEqual([]);
    await expect(pullAndCheck(f.call, ME, '0.4')).rejects.toThrow(/release number/);
    f.script.pullStatus = 500;
    await expect(pullAndCheck(f.call, ME, '0.4.0')).rejects.toThrow(/pull .* was refused/);
  });

  it('says what is missing for Pad Check: no socket, an old Docker, a pinned tag, ready', async () => {
    const f = fake();
    expect(await dockerUpdateStatus(f.call, ME)).toEqual({ ready: true, text: 'ready' });
    f.script.apiVersion = '1.43';
    expect(await dockerUpdateStatus(f.call, ME)).toEqual({ ready: false, text: 'needs Docker 25 or newer (API 1.44); this daemon speaks 1.43' });
    f.script.apiVersion = '1.45';
    const down: DockerCall = async () => {
      throw new Error('ENOENT');
    };
    expect((await dockerUpdateStatus(down, ME)).text).toMatch(/needs the Docker socket/);
    const pinned: DockerCall = async (m, p, b) => (/\/containers\/.+\/json$/.test(p) ? { status: 200, text: JSON.stringify({ ...INSPECT, Config: { ...OLD_CONFIG, Image: 'x:0.3.0' } }) } : f.call(m, p, b));
    expect(await dockerUpdateStatus(pinned, ME)).toMatchObject({ ready: false, text: expect.stringContaining('pinned to 0.3.0') as string });
  });
});

describe('the helper', () => {
  it('mounts the socket and the home at their own paths, takes the target\'s user and groups, and is removed on exit', () => {
    const body = helperBody({ inspect: INSPECT, image: NEW_IMG, expect: '0.4.0', home: '/state/room', socketPath: '/var/run/docker.sock' }) as Record<string, unknown> & { HostConfig: Record<string, unknown> };
    expect(body.Cmd).toEqual(['self-update', '--target', ME, '--expect', '0.4.0', '--home', '/state/room', '--image', NEW_IMG]);
    expect(body.HostConfig).toEqual({ AutoRemove: true, Init: true, NetworkMode: 'none', Binds: ['/var/run/docker.sock:/var/run/docker.sock', '/srv/gonogo:/state'], GroupAdd: ['999'] });
    expect(body.User).toBe('1000:1000');
    expect(body.Labels).toEqual({ 'gonogo.helper': '1', 'gonogo.helper.target': ME });
  });

  it('is refused without the socket or the home as a mount, and starts after it is created', async () => {
    expect(() => helperBody({ inspect: { ...INSPECT, Mounts: [INSPECT.Mounts[0]] }, image: NEW_IMG, expect: '0.4.0', home: '/state', socketPath: '/var/run/docker.sock' })).toThrow(/socket/);
    expect(() => helperBody({ inspect: INSPECT, image: NEW_IMG, expect: '0.4.0', home: '/elsewhere', socketPath: '/var/run/docker.sock' })).toThrow(/home/);
    const f = fake();
    const id = await startHelper(f.call, { inspect: INSPECT, image: NEW_IMG, expect: '0.4.0', home: '/state' });
    expect(f.log.slice(-2)).toEqual(['POST /containers/create', `POST /containers/${id}/start`]);
  });

  it('refuses a target that is not a container id', () => {
    expect(parseArgs(['self-update', '--target', 'x;rm', '--expect', '0.4.0', '--home', '/h', '--image', 'i'])).toMatchObject({ kind: 'error' });
    expect(parseArgs(['self-update', '--target', ME, '--expect', '0.4', '--home', '/h', '--image', 'i'])).toMatchObject({ kind: 'error' });
    expect(parseArgs(['self-update', '--target', ME, '--expect', '0.4.0', '--home', '/h', '--image', 'i', '--extra', '1'])).toMatchObject({ kind: 'error' });
    expect(parseArgs(['self-update', '--target', ME, '--expect', '0.4.0', '--home', '/h'])).toMatchObject({ kind: 'error' });
    expect(parseArgs(['self-update', '--target', ME, '--expect', '0.4.0', '--home', '/h', '--image', NEW_IMG])).toEqual({ kind: 'selfupdate', target: ME, expect: '0.4.0', home: '/h', image: NEW_IMG });
  });
});

describe('the swap', () => {
  it('creates the copy, stops the old one, renames, starts, waits for healthy and removes the old one', async () => {
    const f = fake();
    const result = await swap(f.call, SWAP);
    const steps = f.log.filter((l) => !/\/json$|_ping/.test(l));
    expect(steps).toEqual([
      'POST /containers/create?name=gonogo-next-a1b2c3',
      `POST /containers/${ME}/stop`,
      `POST /containers/${ME}/rename?name=gonogo-prev-a1b2c3`,
      `POST /containers/${'1'.repeat(64)}/rename?name=gonogo`,
      `POST /containers/${'1'.repeat(64)}/start`,
      `DELETE /containers/${ME}`,
    ]);
    expect(result).toMatchObject({ state: 'ok', from: '0.3.0', to: '0.4.0', previousImage: OLD_IMG });
    expect(names(f)).toEqual(['gonogo*']);
  });

  it('with no healthcheck it takes 10 seconds of running as good', async () => {
    const f = fake();
    f.script.health = 'none';
    let t = 0;
    expect((await swap(f.call, { ...SWAP, now: () => t, sleep: async () => void (t += 2000) })).state).toBe('ok');
  });

  it('rolls back when the copy is unhealthy: the old one runs again under its own name, the copy is gone, the log tail is kept', async () => {
    const f = fake();
    f.script.health = 'unhealthy';
    const result = await swap(f.call, SWAP);
    expect(result).toMatchObject({ state: 'rolled-back', previousImage: '', tail: ['boom one', 'boom two'] });
    expect(result.note).toMatch(/unhealthy.*old container is running again/);
    expect(names(f)).toEqual(['gonogo*']);
    expect(f.boxes.get(ME)?.image).toBe(OLD_IMG);
  });

  it('rolls back when the copy exits, when it does not start, and when health never comes in time', async () => {
    const exited = fake();
    exited.script.health = 'exited';
    expect((await swap(exited.call, SWAP)).note).toMatch(/stopped \(exit 1\)/);
    expect(names(exited)).toEqual(['gonogo*']);
    const failed = fake();
    failed.script.failStart = true;
    expect((await swap(failed.call, SWAP)).state).toBe('rolled-back');
    expect(names(failed)).toEqual(['gonogo*']);
    // a copy that is up but never reports healthy runs out of time (the fake always answers "starting")
    const slow = fake();
    const starting: DockerCall = async (m, p, b) => (/^\/containers\/1+\/json$/.test(p) ? { status: 200, text: JSON.stringify({ Id: '1'.repeat(64), Name: '/gonogo', State: { Running: true, Health: { Status: 'starting' } } }) } : slow.call(m, p, b));
    let t = 0;
    const r = await swap(starting, { ...SWAP, healthMs: 1000, now: () => t, sleep: async () => void (t += 600) });
    expect(r.note).toMatch(/not healthy after 1 s/);
    expect(names(slow)).toEqual(['gonogo*']);
  });

  it('keeps no browser token and no bearer value in the log lines it saves', async () => {
    const f = fake();
    f.script.health = 'unhealthy';
    f.script.logs = 'gonogo ready: http://127.0.0.1:7777/#token=abc123SECRET\nGET /x?token=zzz&a=1\nAuthorization: Bearer eyJhbGciOi.secret\nplain line\n';
    const result = await swap(f.call, SWAP);
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/abc123SECRET|zzz|eyJhbGciOi/);
    expect(result.tail).toEqual(expect.arrayContaining(['gonogo ready: http://127.0.0.1:7777/#token=[redacted]', 'Authorization: Bearer [redacted]', 'plain line']));
    expect(redact('a token=x&b=1')).toBe('a token=[redacted]&b=1');
  });

  it('starts the old container again when its stop timed out on our side but did stop it', async () => {
    const f = fake();
    f.script.stopThrows = true;
    const result = await swap(f.call, SWAP);
    expect(result.state).toBe('rolled-back');
    expect(names(f)).toEqual(['gonogo*']);
  });

  it('a leftover -prev or -next of an earlier try never blocks a new one, and a good update removes the stopped ones of the same compose service', async () => {
    const f = fake();
    const mine = { 'com.docker.compose.project': 'room', 'com.docker.compose.service': 'gonogo' };
    const box = (c: string, name: string, over: Record<string, unknown> = {}): void => void f.boxes.set(c.repeat(64), { id: c.repeat(64), name, running: false, image: OLD_IMG, labels: mine, ...over });
    box('c', 'gonogo-prev-d4e5f6');
    box('d', 'gonogo-next-0a0b0c');
    box('e', 'gonogo-prev-d4e5f6x'); // not the pattern
    box('f', 'gonogo-prev-aaaaaa', { labels: { 'com.docker.compose.project': 'other', 'com.docker.compose.service': 'gonogo' } }); // another project
    box('9', 'gonogo-prev-bbbbbb', { running: true }); // running: never touched
    box('8', 'other-prev-cccccc'); // another name
    expect((await swap(f.call, SWAP)).state).toBe('ok');
    expect(names(f)).toEqual(['gonogo*', 'gonogo-prev-aaaaaa', 'gonogo-prev-bbbbbb*', 'gonogo-prev-d4e5f6x', 'other-prev-cccccc']);
    // a failed update removes nothing of the leftovers
    const g = fake();
    g.script.health = 'unhealthy';
    g.boxes.set('c'.repeat(64), { id: 'c'.repeat(64), name: 'gonogo-prev-d4e5f6', running: false, image: OLD_IMG, labels: mine });
    expect((await swap(g.call, SWAP)).state).toBe('rolled-back');
    expect(names(g)).toEqual(['gonogo*', 'gonogo-prev-d4e5f6']);
    expect(f.log).toContain('POST /containers/create?name=gonogo-next-a1b2c3');
  });

  it('changes nothing when the copy cannot be created', async () => {
    const f = fake();
    f.script.failCreate = true;
    const result = await swap(f.call, SWAP);
    expect(result).toMatchObject({ state: 'failed' });
    expect(result.note).toMatch(/no such network.*Nothing was changed/);
    expect(f.log.some((l) => /stop|rename/.test(l))).toBe(false);
    expect(names(f)).toEqual(['gonogo*']);
  });

  it('says loudly, and leaves both names, when the rollback fails too', async () => {
    const f = fake();
    f.script.health = 'unhealthy';
    f.script.failRollbackStart = true;
    const result = await swap(f.call, SWAP);
    expect(result.state).toBe('failed');
    expect(result.note).toMatch(/rollback failed too .*cannot start the old one.*gonogo-prev-a1b2c3 or gonogo.*fix it by hand/);
  });

  it('refuses a target that is not an id and calls nothing', async () => {
    const f = fake();
    expect((await swap(f.call, { ...SWAP, target: 'gonogo; rm' })).state).toBe('failed');
    expect(f.log).toEqual([]);
  });
});

describe('a helper that is killed half way', () => {
  it('leaves a started record before anything is stopped, and the final result replaces it', async () => {
    const f = fake();
    const seen: string[] = [];
    const record = async (r: { state: string; previousImage: string; note: string }): Promise<void> => {
      f.log.push('RECORD ' + r.state);
      seen.push(r.state + '|' + r.previousImage + '|' + r.note);
    };
    const result = await swap(f.call, { ...SWAP, record });
    const steps = f.log.filter((l) => /create\?|RECORD|stop/.test(l));
    expect(steps).toEqual(['POST /containers/create?name=gonogo-next-a1b2c3', 'RECORD started', `POST /containers/${ME}/stop`]);
    expect(seen[0]).toContain('started|' + OLD_IMG);
    expect(seen[0]).toContain('gonogo-prev-a1b2c3');
    expect(result.state).toBe('ok');
  });

  it('writes no started record when the copy cannot be created (nothing was stopped, nothing to find)', async () => {
    const f = fake();
    f.script.failCreate = true;
    const seen: string[] = [];
    await swap(f.call, { ...SWAP, record: async (r) => void seen.push(r.state) });
    expect(seen).toEqual([]);
  });

  const started = { version: 1 as const, at: 1_000_000, state: 'started' as const, from: '0.3.0', to: '0.4.0', previousImage: OLD_IMG, note: 'working', tail: [] };

  it('a new server finding started and no helper marks it interrupted: no UNDO, the recovery text, the leftover -prev- listed, written back once', async () => {
    const f = fake();
    f.boxes.set('c'.repeat(64), { id: 'c'.repeat(64), name: 'gonogo-prev-a1b2c3', running: false, image: OLD_IMG, labels: { 'com.docker.compose.project': 'room', 'com.docker.compose.service': 'gonogo' } });
    await writeResult(dir, started);
    const settled = await settleResult(f.call, dir, started, ME, 1_000_000 + 60_000);
    expect(settled).toMatchObject({ state: 'interrupted', previousImage: '' });
    expect(settled.note).toMatch(/interrupted.*docker compose up -d.*gonogo-prev-a1b2c3.*No UNDO is offered/);
    expect((await readResult(dir))?.state).toBe('interrupted');
    // an interrupted record is never undone
    const updater = createUpdater({ kind: 'docker', cwd: dir, current: '0.4.0', rollout: { view: () => ({ enabled: true, current: '0.4.0', latest: null, checkedAt: 1, newer: false, command: 'x' }), setUpdate: () => undefined }, reload: () => false, keepsAgents: false, hook: null, docker: { call: f.call, hostname: ME, home: dir, ready: true, busy: () => null }, fetch: (() => Promise.reject(new Error('no'))) as typeof fetch });
    await expect(updater.undo()).rejects.toThrow(/no update to undo/);
    // settled once: asking again changes nothing
    expect(await settleResult(f.call, dir, settled, ME, 1_000_000 + 120_000)).toBe(settled);
  });

  it('with the helper still running it is an update in progress, until 15 minutes pass', async () => {
    const f = fake();
    f.boxes.set('d'.repeat(64), { id: 'd'.repeat(64), name: 'helper', running: true, image: NEW_IMG, labels: { 'gonogo.helper': '1' } });
    expect(await settleResult(f.call, dir, started, ME, 1_000_000 + 60_000)).toBe(started);
    expect((await settleResult(f.call, dir, started, ME, 1_000_000 + 16 * 60_000)).state).toBe('interrupted');
  });

  it("another gonogo's helper on the same host does not count: only the helper of this target does", async () => {
    const f = fake();
    f.boxes.set('d'.repeat(64), { id: 'd'.repeat(64), name: 'helper', running: true, image: NEW_IMG, labels: { 'gonogo.helper': '1', 'gonogo.helper.target': 'f'.repeat(64) } });
    expect((await settleResult(f.call, dir, { ...started, target: ME }, ME, 1_000_000 + 60_000)).state).toBe('interrupted');
    f.boxes.get('d'.repeat(64))!.labels = { 'gonogo.helper': '1', 'gonogo.helper.target': ME };
    expect((await settleResult(f.call, dir, { ...started, target: ME }, ME, 1_000_000 + 60_000)).state).toBe('started');
  });

  it('a server that boots during the swap follows update.json: the helper writes ok and the view becomes done with UNDO, without a restart', async () => {
    const f = fake();
    f.boxes.set('d'.repeat(64), { id: 'd'.repeat(64), name: 'helper', running: true, image: NEW_IMG, labels: { 'gonogo.helper': '1', 'gonogo.helper.target': ME } });
    const first = { ...started, target: ME };
    await writeResult(dir, first);
    const changes: UpdateView[] = [];
    let t = first.at + 1000;
    let tick = 0;
    await followResult(f.call, dir, ME, first, {
      onChange: (r) => changes.push(viewOfResult(r)),
      stopped: () => false,
      now: () => t,
      sleep: async () => {
        t += 5000;
        tick += 1;
        if (tick === 3) await writeResult(dir, { ...first, at: t, state: 'ok', note: 'Updated 0.3.0 to 0.4.0.' });
      },
    });
    expect(tick).toBe(3);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ state: 'done', undo: true, version: '0.4.0' });
  });

  it('follows a rolled-back end, a helper that dies (interrupted), a stop request and the 15 minute limit', async () => {
    const f = fake();
    const first = { ...started, target: ME };
    let t = first.at;
    const run = async (extra: Partial<Parameters<typeof followResult>[4]>, write?: (t: number) => Promise<void>): Promise<UpdateView[]> => {
      await writeResult(dir, first);
      const out: UpdateView[] = [];
      t = first.at;
      await followResult(f.call, dir, ME, first, { onChange: (r) => out.push(viewOfResult(r)), stopped: () => false, now: () => t, sleep: async () => { t += 5000; await write?.(t); }, ...extra });
      return out;
    };
    // no helper at all: interrupted on the first look
    expect((await run({}))[0]).toMatchObject({ state: 'failed' });
    expect((await readResult(dir))?.state).toBe('interrupted');
    // rolled back
    f.boxes.set('d'.repeat(64), { id: 'd'.repeat(64), name: 'helper', running: true, image: NEW_IMG, labels: { 'gonogo.helper': '1', 'gonogo.helper.target': ME } });
    const rolled = await run({}, async (at) => writeResult(dir, { ...first, at, state: 'rolled-back', previousImage: '', note: 'unhealthy' }));
    expect(rolled[0]).toMatchObject({ state: 'failed' });
    expect(rolled[0]?.note).toContain('did not take');
    // stopped by the server closing: no change is reported
    expect(await run({ stopped: () => true })).toEqual([]);
    // 15 minutes of nothing new: it gives up quietly (the record stays `started` until a restart settles it)
    let looks = 0;
    await writeResult(dir, first);
    t = first.at;
    await followResult(f.call, dir, ME, first, { onChange: () => undefined, stopped: () => false, now: () => t, sleep: async () => { looks += 1; t += 5 * 60_000; } });
    expect(looks).toBeLessThanOrEqual(4);
  });

  it('any other record is left as it is', async () => {
    const f = fake();
    const ok = { ...started, state: 'ok' as const };
    expect(await settleResult(f.call, dir, ok, ME)).toBe(ok);
  });
});

describe('update.json', () => {
  it('is written with mode 0600 and read back, and a damaged one reads as none', async () => {
    const result = { version: 1 as const, at: 5, state: 'ok' as const, from: '0.3.0', to: '0.4.0', previousImage: OLD_IMG, note: 'Updated 0.3.0 to 0.4.0.', tail: [] };
    await writeResult(dir, result);
    expect((await stat(join(dir, 'run', 'update.json'))).mode & 0o777).toBe(0o600);
    expect(await readResult(dir)).toEqual(result);
    await writeResult(dir, { ...result, state: 'rolled-back', tail: ['a', 'b'] });
    expect((await readResult(dir))?.tail).toEqual(['a', 'b']);
    expect(await readFile(join(dir, 'run', 'update.json'), 'utf8')).not.toContain('token');
    expect(await readResult(join(dir, 'nowhere'))).toBeNull();
  });
});

describe('the updater in a container with the socket', () => {
  const build = (f: Fake, busy: string | null = null) => {
    const seen: UpdateView[] = [];
    const updater = createUpdater({
      kind: 'docker',
      cwd: dir,
      current: '0.3.0',
      rollout: { view: () => ({ enabled: true, current: '0.3.0', latest: '0.4.0', checkedAt: 1, newer: true, command: 'x' }), setUpdate: (u) => void seen.push(u) },
      reload: () => false,
      keepsAgents: false,
      hook: null,
      docker: { call: f.call, hostname: ME.slice(0, 12), home: dir, ready: true, busy: () => busy },
      fetch: (() => Promise.reject(new Error('no network'))) as typeof fetch,
    });
    return { updater, seen };
  };
  const settle = async (seen: UpdateView[], state: UpdateView['state']): Promise<void> => {
    for (let i = 0; i < 100 && seen.at(-1)?.state !== state; i += 1) await new Promise((r) => setTimeout(r, 5));
  };

  it('pulls, checks, starts the helper from the new image and says it handed over', async () => {
    const f = fake();
    const { updater, seen } = build(f);
    expect(updater.start('0.4.0').state).toBe('running');
    await settle(seen, 'handed-off');
    expect(seen.at(-1), JSON.stringify(seen.at(-1))).toMatchObject({ state: 'handed-off', version: '0.4.0' });
    expect(f.bodies.find((b) => b.route === '/containers/create')).toMatchObject({ Image: NEW_IMG, Labels: { 'gonogo.helper': '1' } });
    // this container is not touched by the server itself: only the helper stops it
    expect(f.log.some((l) => l.includes(`${ME}/stop`))).toBe(false);
  });

  it('UNDO from a running image that differs from the previous one starts the helper from the running one', async () => {
    const f = fake();
    const running = 'sha256:' + '5'.repeat(64);
    const call: DockerCall = async (m, p, b) => (/^\/containers\/[^/]+\/json$/.test(p) && f.boxes.has(ME) ? { status: 200, text: JSON.stringify({ ...INSPECT, Image: running }) } : f.call(m, p, b));
    const { updater, seen } = build({ ...f, call });
    await writeResult(dir, { version: 1, at: 1, state: 'ok', from: '0.3.0', to: '0.4.0', previousImage: OLD_IMG, note: 'ok', tail: [] });
    await updater.undo();
    await settle(seen, 'handed-off');
    expect(f.bodies.find((b) => b.route === '/containers/create')).toMatchObject({ Image: running, Cmd: expect.arrayContaining(['--image', OLD_IMG]) as string[] });
  });

  it('says so when the helper never answers', async () => {
    const f = fake();
    const seen: UpdateView[] = [];
    const updater = createUpdater({ kind: 'docker', cwd: dir, current: '0.3.0', rollout: { view: () => ({ enabled: true, current: '0.3.0', latest: '0.4.0', checkedAt: 1, newer: true, command: 'x' }), setUpdate: (u) => void seen.push(u) }, reload: () => false, keepsAgents: false, hook: null, handoffMs: 30, docker: { call: f.call, hostname: ME.slice(0, 12), home: dir, ready: true, busy: () => null }, fetch: (() => Promise.reject(new Error('no'))) as typeof fetch });
    updater.start('0.4.0');
    await settle(seen, 'handed-off');
    await settle(seen, 'failed');
    expect(seen.at(-1)).toMatchObject({ state: 'failed' });
    expect(seen.at(-1)?.note).toMatch(/did not answer.*docker compose up -d/);
  });

  it('is refused while a poll or Static fire is running, and when a label mismatch stops it nothing is created', async () => {
    const f = fake();
    expect(() => build(f, 'a T-minus poll or Static fire is running').updater.start('0.4.0')).toThrow(UpdateError);
    expect(f.log).toEqual([]);
    f.script.pullLabel = '0.3.9';
    const { updater, seen } = build(f);
    updater.start('0.4.0');
    await settle(seen, 'failed');
    expect(seen.at(-1)?.note).toMatch(/not 0\.4\.0.*Nothing was changed/);
    expect(f.log.some((l) => l.includes('containers/create'))).toBe(false);
  });

  it('UNDO puts the previous image back through the same helper, and only after a good update', async () => {
    const f = fake();
    const { updater, seen } = build(f);
    await expect(updater.undo()).rejects.toThrow(/no update to undo/);
    await writeResult(dir, { version: 1, at: 1, state: 'ok', from: '0.3.0', to: '0.4.0', previousImage: OLD_IMG, note: 'ok', tail: [] });
    await updater.undo();
    await settle(seen, 'handed-off');
    // the helper runs from the RUNNING image (the old one may have no self-update command) and is told the old one as --image
    expect(f.bodies.find((b) => b.route === '/containers/create')).toMatchObject({ Image: OLD_IMG, Cmd: expect.arrayContaining(['--expect', '0.3.0', '--image', OLD_IMG]) as string[] });
    await writeResult(dir, { version: 1, at: 1, state: 'ok', from: '0.3.0', to: '0.4.0', previousImage: 'sha256:' + '9'.repeat(64), note: 'ok', tail: [] });
    await expect(build(f).updater.undo()).rejects.toThrow(/no longer on this host/);
  });

  it('UNDO trusts nothing in update.json: a planted image id, label or repository is refused and nothing is created', async () => {
    const f = fake();
    const foreign = 'sha256:' + '7'.repeat(64);
    const planted = (image: Record<string, unknown>): DockerCall => async (m, p, b) => (p === `/images/${encodeURIComponent(foreign)}/json` ? { status: 200, text: JSON.stringify(image) } : f.call(m, p, b));
    const last = { previousImage: foreign, from: '0.3.0' };
    const label = { Config: { Labels: { [VERSION_LABEL]: '0.3.0' } } };
    await expect(checkPrevious(planted({ ...label, RepoTags: ['evil/gonogo:0.3.0'] }), ME, last)).rejects.toThrow(/not one of ghcr\.io\/ulm0\/gonogo/);
    await expect(checkPrevious(planted({ ...label, RepoTags: [], RepoDigests: [] }), ME, last)).rejects.toThrow(/not one of/);
    await expect(checkPrevious(planted({ Config: { Labels: { [VERSION_LABEL]: '9.9.9' } }, RepoTags: ['ghcr.io/ulm0/gonogo:latest'] }), ME, last)).rejects.toThrow(/not version 0\.3\.0/);
    await expect(checkPrevious(planted({ RepoTags: ['ghcr.io/ulm0/gonogo:latest'] }), ME, last)).rejects.toThrow(/not version 0\.3\.0/);
    for (const bad of ['evil:latest', 'sha256:abc', '../../x', '']) await expect(checkPrevious(f.call, ME, { previousImage: bad, from: '0.3.0' })).rejects.toThrow(/not an image id/);
    await expect(checkPrevious(planted({ ...label, RepoTags: ['ghcr.io/ulm0/gonogo:0.3.0'] }), ME, last)).resolves.toBeUndefined();
    await expect(checkPrevious(f.call, ME, { previousImage: OLD_IMG, from: '0.3.0' })).resolves.toBeUndefined();
    // through the updater: a planted record is a conflict and no helper is created
    await writeResult(dir, { version: 1, at: 1, state: 'ok', from: '0.3.0', to: '0.4.0', previousImage: foreign, note: 'ok', tail: [] });
    const { updater } = build({ ...f, call: planted({ ...label, RepoTags: ['evil/x:1'] }) });
    await expect(updater.undo()).rejects.toThrow(/not one of/);
    expect(f.log.some((l) => l.includes('containers/create'))).toBe(false);
  });
});

describe('the transport', () => {
  it('speaks HTTP over a unix socket, with a JSON body and the whole answer text', async () => {
    const path = join(dir, 'docker.sock');
    const seen: string[] = [];
    const server = createServer((req, res) => {
      let b = '';
      req.on('data', (c: Buffer) => (b += c.toString())).on('end', () => {
        seen.push(`${req.method} ${req.url} ${b}`);
        res.writeHead(201, { 'Content-Type': 'application/json' }).end('{"Id":"x"}');
      });
    });
    await new Promise<void>((r) => server.listen(path, r));
    const out = await socketCall(path)('POST', '/containers/create?name=a', { Image: 'i' });
    server.close();
    expect(out).toEqual({ status: 201, text: '{"Id":"x"}' });
    expect(seen).toEqual(['POST /containers/create?name=a {"Image":"i"}']);
    await expect(socketCall(join(dir, 'none.sock'))('GET', '/_ping')).rejects.toThrow();
  });
});

describe('the dialog words', () => {
  it('counts working and idle agents and says what autostart will do', () => {
    expect(agentCounts(['working', 'needs_you', 'idle', 'starting', 'stopped'])).toEqual({ working: 2, idle: 2 });
    const text = updateDialogText('0.4.0', { working: 2, idle: 1 }, 'running');
    expect(text).toContain('2 agents are working and 1 is idle: they will all stop.');
    expect(text).toContain('start again by themselves');
    expect(text).toContain("image publisher's code");
    expect(updateDialogText('0.4.0', { working: 0, idle: 0 }, 'off')).toContain('No agent is running.');
    expect(updateDialogText('0.4.0', { working: 1, idle: 0 }, 'boss')).toContain('only the boss');
  });
});
