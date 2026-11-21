/**
 * Docker self-update (docs/self-update-spec.md, docs/features/update.md): gonogo in a container replaces itself with the newer image.
 *
 * The server pulls its own moving tag, checks the image's version label against the version the Director clicked, and starts a
 * short-lived HELPER container from the new image. The helper (`gonogo self-update`) drives the Docker Engine API over the socket:
 * it creates a copy of the running container from `inspect` on the new image, stops the old one, starts the copy, waits for Docker's
 * `healthy`, and rolls back when it does not come up. It touches one container (the target it was started for) and creates only a
 * copy of it. Trust: the socket is root on the host and the new image's code runs with it at once, so trusting an update is trusting
 * the image's publisher (the same as `docker compose pull`).
 *
 * shortcut: no socket proxy and no registry credentials (a private image needs the host's own `docker pull`), see the spec.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import type { UpdateView } from '../shared/protocol.js';
import { FILE_MODE } from './constants.js';

export const SOCKET_PATH = '/var/run/docker.sock';
export const VERSION_LABEL = 'org.opencontainers.image.version';
/** The copy runs from an image id, so the moving reference it was started from (`ghcr.io/ulm0/gonogo:latest`) is kept in this label for the next update and for UNDO. */
export const REF_LABEL = 'gonogo.self-update.ref';
export const RESULT_FILE = 'update.json';
export const STABLE_VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;

/**
 * The version an image's label says, as x.y.z. Every image published up to 0.11.0 says `v0.11.0` (docker/metadata-action took the git tag, with its v);
 * one `v` before a release number is read as that number, anything else is returned as it is (and so never equals a version).
 */
export function labelVersion(label: string): string {
  const m = /^v(\d{1,6}\.\d{1,6}\.\d{1,6})$/.exec(label);
  return m === null ? label : (m[1] as string);
}
const labelOf = (image: Json): string => labelVersion(asText(asRecord(asRecord(image.Config).Labels)[VERSION_LABEL]));
const CONTAINER_ID = /^[0-9a-f]{12,64}$/;
const HEALTH_MS = 3 * 60_000;
const HEALTH_POLL_MS = 2_000;
const NO_HEALTHCHECK_STABLE_MS = 10_000;
const PULL_MS = 10 * 60_000;
const API_MS = 60_000;

/** One call of the Engine API: the status and the whole body as text. */
export type DockerCall = (method: string, path: string, body?: unknown, timeoutMs?: number) => Promise<{ status: number; text: string }>;

export function socketCall(socketPath: string = SOCKET_PATH): DockerCall {
  return (method, path, body, timeoutMs = API_MS) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = request(
        { socketPath, method, path, timeout: timeoutMs, headers: payload === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error(`the Docker API did not answer ${method} ${path} in time`)));
      req.on('error', reject);
      req.end(payload);
    });
}

type Json = Record<string, unknown>;
const isRecord = (x: unknown): x is Json => typeof x === 'object' && x !== null && !Array.isArray(x);
const asRecord = (x: unknown): Json => (isRecord(x) ? x : {});
const asText = (x: unknown): string => (typeof x === 'string' ? x : '');
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export class DockerUpdateError extends Error {}

async function json(call: DockerCall, method: string, path: string, body?: unknown, timeoutMs?: number, ok: readonly number[] = [200, 201, 204]): Promise<Json> {
  const res = await call(method, path, body, timeoutMs);
  if (!ok.includes(res.status)) {
    let why = res.text.slice(0, 200);
    try {
      why = asText(asRecord(JSON.parse(res.text)).message) || why;
    } catch {
      // not JSON: the text stands
    }
    throw new DockerUpdateError(`Docker answered ${res.status} to ${method} ${path.split('?')[0]}: ${why}`);
  }
  try {
    return res.text === '' ? {} : asRecord(JSON.parse(res.text));
  } catch {
    return {};
  }
}

/* ---------------------------------------------------------------- the image reference */

export interface ImageRef {
  repo: string;
  tag: string | null;
  digest: string | null;
}

/** `ghcr.io/ulm0/gonogo:latest`, `host:5000/x/y`, `x@sha256:...`: the tag is after the last colon only when no slash follows it. */
export function parseImage(ref: string): ImageRef {
  const at = ref.indexOf('@');
  const digest = at === -1 ? null : ref.slice(at + 1);
  const rest = at === -1 ? ref : ref.slice(0, at);
  const colon = rest.lastIndexOf(':');
  if (colon > rest.lastIndexOf('/')) return { repo: rest.slice(0, colon), tag: rest.slice(colon + 1), digest };
  return { repo: rest, tag: null, digest };
}

/** The moving reference this container updates from: its image reference, or the label a self-update left when it runs from an image id. */
export function selfRef(inspect: Json): string {
  const config = asRecord(inspect.Config);
  const image = asText(config.Image);
  const kept = asText(asRecord(config.Labels)[REF_LABEL]);
  return /^(sha256:)?[0-9a-f]{64}$/.test(image) && kept !== '' ? kept : image;
}

/** Why this container cannot update itself, or null when its image is a moving tag. */
export function pinnedReason(ref: string): string | null {
  if (/^(sha256:)?[0-9a-f]{64}$/.test(ref)) return 'this container runs from an image id, not a tag: change its image to a tag in your compose file';
  const image = parseImage(ref);
  if (image.digest !== null) return 'this container is pinned by a digest: change the image in your compose file';
  if (image.tag !== null && /^v?\d+\.\d+\.\d+([-+].*)?$/.test(image.tag)) return `this container is pinned to ${image.tag}: change the tag in your compose file (a moving tag such as latest is updated from here)`;
  return null;
}

/* ---------------------------------------------------------------- the copy */

/**
 * The body of `POST /containers/create` for a copy of the inspected container on `image`: Config and HostConfig as they are (ports,
 * binds, Init, ExtraHosts, GroupAdd, restart policy, labels with the compose ones), the networks with their aliases. What the OLD
 * image gave (its labels, command, entrypoint, healthcheck and environment) is left out so the new image's own apply. The hostname is
 * left to Docker when it was the container's id, because gonogo finds itself by it.
 */
export function copyBody(inspect: Json, oldImage: Json, image: string, ref: string = selfRef(inspect)): Json {
  const config = { ...asRecord(inspect.Config) };
  const base = asRecord(oldImage.Config);
  const id = asText(inspect.Id);
  config.Image = image;
  if (asText(config.Hostname) === id.slice(0, 12) || asText(config.Hostname) === id) delete config.Hostname;
  // `User` too: an older image said `USER node` and its container carries it; the new image starts as root (to fix a bind folder) and drops itself
  for (const key of ['Cmd', 'Entrypoint', 'Healthcheck', 'User']) if (same(config[key], base[key])) delete config[key];
  const baseEnv: unknown[] = Array.isArray(base.Env) ? base.Env : [];
  if (Array.isArray(config.Env)) config.Env = config.Env.filter((e) => !baseEnv.includes(e));
  const labels = asRecord(config.Labels);
  const baseLabels = asRecord(base.Labels);
  config.Labels = { ...Object.fromEntries(Object.entries(labels).filter(([k, v]) => !(k in baseLabels && baseLabels[k] === v))), [REF_LABEL]: ref };
  const endpoints: Json = {};
  for (const [name, raw] of Object.entries(asRecord(asRecord(inspect.NetworkSettings).Networks))) {
    const net = asRecord(raw);
    const aliases = (Array.isArray(net.Aliases) ? net.Aliases : []).filter((a) => typeof a === 'string' && !id.startsWith(a));
    endpoints[name] = { ...(aliases.length > 0 ? { Aliases: aliases } : {}), ...(net.IPAMConfig == null ? {} : { IPAMConfig: net.IPAMConfig }), ...(net.DriverOpts == null ? {} : { DriverOpts: net.DriverOpts }) };
  }
  return { ...config, HostConfig: asRecord(inspect.HostConfig), NetworkingConfig: { EndpointsConfig: endpoints } };
}

/* ---------------------------------------------------------------- helper container */

/** The mount of the target that holds `path` (its destination is the path or a parent), as a bind string for the helper, or null. */
function mountOf(inspect: Json, path: string): string | null {
  let best: { dest: string; spec: string } | null = null;
  for (const raw of Array.isArray(inspect.Mounts) ? inspect.Mounts : []) {
    const m = asRecord(raw);
    const dest = asText(m.Destination);
    if (dest === '' || !(path === dest || path.startsWith(dest.endsWith('/') ? dest : `${dest}/`))) continue;
    const from = asText(m.Type) === 'volume' ? asText(m.Name) : asText(m.Source);
    if (from !== '' && (best === null || dest.length > best.dest.length)) best = { dest, spec: `${from}:${dest}` };
  }
  return best?.spec ?? null;
}

/** The user of the helper: the target's own when it names one that is not root, else uid 1000 (the image's `node`). */
function helperUser(user: string): string {
  return user === '' || /^(root|0)(:|$)/.test(user) ? '1000:1000' : user;
}

/**
 * The helper: the new image, `gonogo self-update` for one target, the socket and the target's home mounted at the same paths, the
 * target's user and groups (to reach the socket), removed when it exits. Nothing else reaches it but the version and the image.
 */
export function helperBody(input: { inspect: Json; image: string; /** The image the helper runs from: the NEW image on an update, the RUNNING one on UNDO (the old one may have no `self-update`). */ helperImage?: string; expect: string; home: string; socketPath: string }): Json {
  const { inspect } = input;
  const socket = mountOf(inspect, input.socketPath);
  const home = mountOf(inspect, input.home);
  if (socket === null) throw new DockerUpdateError(`the Docker socket ${input.socketPath} is not mounted in this container`);
  if (home === null) throw new DockerUpdateError(`gonogo's home ${input.home} is not a mount of this container: the update result has nowhere to be kept`);
  const host = asRecord(inspect.HostConfig);
  return {
    Image: input.helperImage ?? input.image,
    Cmd: ['self-update', '--target', asText(inspect.Id), '--expect', input.expect, '--home', input.home, '--image', input.image],
    // a container that starts as root (the image's own USER, since the entrypoint drops privileges itself) gets a helper of uid 1000: update.json is written by it and read by gonogo
    User: helperUser(asText(asRecord(inspect.Config).User)),
    // the target id lets a new gonogo tell its own helper from another gonogo's on the same host
    Labels: { 'gonogo.helper': '1', 'gonogo.helper.target': asText(inspect.Id) },
    // no network: it talks to the socket only
    HostConfig: { AutoRemove: true, Init: true, NetworkMode: 'none', Binds: [socket, home], GroupAdd: Array.isArray(host.GroupAdd) ? host.GroupAdd : [] },
  };
}

/* ---------------------------------------------------------------- the pull and the checks (the server, before anything stops) */

export interface Prepared {
  /** The id of the new image, which the helper and the copy use (not the tag, which could move again). */
  image: string;
  /** The image the container runs now, kept for UNDO. */
  previousImage: string;
  from: string;
  inspect: Json;
  /** The repository the tag belongs to (`ghcr.io/ulm0/gonogo`) and the registry digests the pulled image carries for it: what the attestation is checked against. */
  repo: string;
  repoDigests: string[];
}

/** The running container's own inspect: its id is the hostname. */
export async function inspectSelf(call: DockerCall, hostname: string): Promise<Json> {
  const found = await json(call, 'GET', `/containers/${encodeURIComponent(hostname)}/json`);
  if (asText(found.Id) === '') throw new DockerUpdateError('this container could not be found through the Docker socket');
  return found;
}

/** Whether Docker self-update can work here, and what to say when not (Pad Check, the strip). */
export async function dockerUpdateStatus(call: DockerCall, hostname: string): Promise<{ ready: boolean; text: string }> {
  try {
    const ping = await call('GET', '/_ping');
    if (ping.status !== 200) return { ready: false, text: 'needs the Docker socket (mount /var/run/docker.sock)' };
    // the copy may join several networks in one create call, which Docker takes from API 1.44 (Docker 25)
    const api = asText(asRecord(JSON.parse((await call('GET', '/version')).text || '{}')).ApiVersion);
    const [major = 0, minor = 0] = api.split('.').map(Number);
    if (api !== '' && (major < 1 || (major === 1 && minor < 44))) return { ready: false, text: `needs Docker 25 or newer (API 1.44); this daemon speaks ${api}` };
  } catch {
    return { ready: false, text: 'needs the Docker socket (mount /var/run/docker.sock)' };
  }
  try {
    const self = await inspectSelf(call, hostname);
    const why = pinnedReason(selfRef(self));
    return why === null ? { ready: true, text: 'ready' } : { ready: false, text: why };
  } catch (error) {
    return { ready: false, text: error instanceof Error ? error.message : 'this container could not be found through the socket' };
  }
}

/** Pulls the container's own moving tag and refuses unless the image's version label is the version that was clicked. */
export async function pullAndCheck(call: DockerCall, hostname: string, expect: string): Promise<Prepared> {
  if (!STABLE_VERSION.test(expect)) throw new DockerUpdateError('version must be a release number like 1.2.3');
  const inspect = await inspectSelf(call, hostname);
  const ref = selfRef(inspect);
  const pinned = pinnedReason(ref);
  if (pinned !== null) throw new DockerUpdateError(pinned);
  const { repo, tag } = parseImage(ref);
  const pull = await call('POST', `/images/create?fromImage=${encodeURIComponent(repo)}&tag=${encodeURIComponent(tag ?? 'latest')}`, undefined, PULL_MS);
  if (pull.status !== 200) throw new DockerUpdateError(`the pull of ${ref} was refused (${pull.status}); a private image needs \`docker compose pull\` on the host`);
  for (const line of pull.text.split('\n')) {
    try {
      const failed = asText(asRecord(JSON.parse(line)).error);
      if (failed !== '') throw new DockerUpdateError(`the pull of ${ref} failed: ${failed.slice(0, 200)}`);
    } catch (error) {
      if (error instanceof DockerUpdateError) throw error;
    }
  }
  const pulled = await json(call, 'GET', `/images/${encodeURIComponent(ref)}/json`);
  const label = labelOf(pulled);
  if (label !== expect) throw new DockerUpdateError(`the image ${ref} is version ${label === '' ? 'unknown (no version label)' : label}, not ${expect}: nothing was changed. The registry may not have it yet; try again later.`);
  const previousImage = asText(inspect.Image);
  const running = await json(call, 'GET', `/images/${encodeURIComponent(previousImage)}/json`);
  const from = labelOf(running);
  const repoDigests = (Array.isArray(pulled.RepoDigests) ? pulled.RepoDigests : []).filter((d): d is string => typeof d === 'string' && d.startsWith(`${repo}@`)).map((d) => d.slice(repo.length + 1));
  return { image: asText(pulled.Id), previousImage, from, inspect, repo, repoDigests };
}

/**
 * UNDO trusts nothing in update.json: the image must be a sha256 id, carry the version label the update recorded as "from", and have a tag
 * or digest of the repository this container runs from. Throws a DockerUpdateError saying which check failed.
 */
export async function checkPrevious(call: DockerCall, hostname: string, last: { previousImage: string; from: string }): Promise<void> {
  if (!/^sha256:[0-9a-f]{64}$/.test(last.previousImage)) throw new DockerUpdateError('the recorded previous image is not an image id: nothing was changed');
  const self = await inspectSelf(call, hostname);
  const repo = parseImage(selfRef(self)).repo;
  const found = await call('GET', `/images/${encodeURIComponent(last.previousImage)}/json`);
  if (found.status !== 200) throw new DockerUpdateError('the previous image is no longer on this host (was it pruned?): pull the older tag by hand');
  let image: Json = {};
  try {
    image = asRecord(JSON.parse(found.text));
  } catch {
    // answered below: no label, no names
  }
  if (labelOf(image) !== last.from) throw new DockerUpdateError(`the previous image is not version ${last.from}: nothing was changed`);
  const names = [...(Array.isArray(image.RepoTags) ? image.RepoTags : []), ...(Array.isArray(image.RepoDigests) ? image.RepoDigests : [])].filter((n): n is string => typeof n === 'string');
  if (!names.some((n) => parseImage(n).repo === repo)) throw new DockerUpdateError(`the previous image is not one of ${repo}: nothing was changed`);
}

/** The pull and the checks passed: starts the helper and returns its id. The helper does the rest. */
export async function startHelper(call: DockerCall, input: { inspect: Json; image: string; helperImage?: string; expect: string; home: string; socketPath?: string }): Promise<string> {
  const body = helperBody({ ...input, socketPath: input.socketPath ?? SOCKET_PATH });
  const made = await json(call, 'POST', '/containers/create', body);
  const id = asText(made.Id);
  if (id === '') throw new DockerUpdateError('the helper container was not created');
  await json(call, 'POST', `/containers/${id}/start`, undefined, undefined, [204, 304]);
  return id;
}

/* ---------------------------------------------------------------- the helper's work */

export interface UpdateResult {
  version: 1;
  at: number;
  /** `started`: the helper wrote it before it stopped anything and has not finished; `interrupted`: a new server found that and no helper running. */
  state: 'started' | 'ok' | 'rolled-back' | 'failed' | 'interrupted';
  from: string;
  to: string;
  /** The id of the container the helper replaces: the helper's label `gonogo.helper.target` carries it. Absent in an older record. */
  target?: string;
  /** The image that ran before, for UNDO; empty after an UNDO or a failure. */
  previousImage: string;
  note: string;
  tail: string[];
}

export interface SwapOptions {
  target: string;
  /** The image id (or reference) of the copy. */
  image: string;
  /** The version the image must carry, for the result. */
  expect: string;
  home: string;
  /** Makes the names of the old and the new container unique, so a leftover of an earlier try never blocks this one. Default random. */
  suffix?: string;
  sleep?(ms: number): Promise<void>;
  now?(): number;
  healthMs?: number;
  /** Called with the `started` record before anything is stopped, so a helper that is killed leaves a trace (update.json). Best effort. */
  record?(result: UpdateResult): Promise<void>;
}

/** The page's URL in a start-up line carries the browser token (`#token=...`), and a log may show a bearer header: neither is kept in update.json or sent to the page. */
export const redact = (line: string): string => line.replace(/token=[^\s&#]+/gi, 'token=[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');

/** Docker's multiplexed log stream: frames of an 8-byte header (stream, 3 zero bytes, size) and the text; text with no header (a tty) is returned as it is. */
function demux(text: string): string {
  const out: string[] = [];
  let at = 0;
  while (at + 8 <= text.length && text.charCodeAt(at) <= 2 && text.slice(at + 1, at + 4) === '\u0000\u0000\u0000') {
    const size = text.charCodeAt(at + 4) * 16_777_216 + (text.charCodeAt(at + 5) << 16) + (text.charCodeAt(at + 6) << 8) + text.charCodeAt(at + 7);
    out.push(text.slice(at + 8, at + 8 + size));
    at += 8 + size;
  }
  return at === 0 ? text : out.join('');
}

/** The last lines of a container's log (Docker's multiplexed stream: an 8-byte header before each frame when there is no tty). */
async function logTail(call: DockerCall, id: string): Promise<string[]> {
  try {
    const res = await call('GET', `/containers/${id}/logs?stdout=1&stderr=1&tail=8`);
    const text = demux(res.text).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ');
    return text.split('\n').map((l) => redact(l.trim()).slice(0, 200)).filter((l) => l !== '').slice(-8);
  } catch {
    return [];
  }
}

/**
 * Stopped containers of earlier tries (`<name>-prev-<6 hex>`, `<name>-next-<6 hex>`) with the same compose project and service as the
 * target. Never a running one, one with another name or other compose labels, or the target itself.
 */
export async function listLeftovers(call: DockerCall, name: string, target: Json): Promise<{ id: string; name: string }[]> {
  const mine = asRecord(asRecord(target.Config).Labels);
  const same = (labels: Json): boolean => ['com.docker.compose.project', 'com.docker.compose.service'].every((k) => (mine[k] ?? '') === (labels[k] ?? ''));
  const pattern = new RegExp(`^/${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(prev|next)-[0-9a-f]{6}$`);
  const found: { id: string; name: string }[] = [];
  try {
    const res = await call('GET', `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ status: ['exited', 'created', 'dead'] }))}`);
    const list: unknown = JSON.parse(res.text);
    for (const raw of Array.isArray(list) ? list : []) {
      const c = asRecord(raw);
      const id = asText(c.Id);
      const stopped = ['exited', 'created', 'dead'].includes(asText(c.State));
      const hit = (Array.isArray(c.Names) ? c.Names : []).find((n): n is string => typeof n === 'string' && pattern.test(n));
      if (id !== '' && id !== asText(target.Id) && stopped && same(asRecord(c.Labels)) && hit !== undefined) found.push({ id, name: hit.slice(1) });
    }
  } catch {
    // a failed listing is an empty one
  }
  return found;
}

/** Removes them after a good update: one with a restart policy could come back after a daemon restart on the same /state, which is two writers. Best effort. */
export async function removeLeftovers(call: DockerCall, name: string, target: Json): Promise<void> {
  for (const c of await listLeftovers(call, name, target)) await call('DELETE', `/containers/${c.id}?force=0`).catch(() => undefined);
}

/** Creates the copy, stops the old one, starts the copy and waits for `healthy`; on failure puts the old one back. Never throws: the result says. */
export async function swap(call: DockerCall, options: SwapOptions): Promise<UpdateResult> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const done = (state: UpdateResult['state'], note: string, from: string, previousImage: string, tail: string[] = []): UpdateResult => ({ version: 1, at: now(), state, from, to: options.expect, target: options.target, previousImage, note, tail });
  if (!CONTAINER_ID.test(options.target)) return done('failed', 'the target is not a container id', '', '');
  let inspect: Json;
  let fresh = '';
  let name = '';
  const suffix = options.suffix ?? randomBytes(3).toString('hex');
  let previousImage = '';
  let from = '';
  try {
    inspect = await json(call, 'GET', `/containers/${options.target}/json`);
    if (asText(inspect.Id) !== options.target && !asText(inspect.Id).startsWith(options.target)) throw new DockerUpdateError('the target answered with another id');
    name = asText(inspect.Name).replace(/^\//, '');
    previousImage = asText(inspect.Image);
    const old = await json(call, 'GET', `/images/${encodeURIComponent(previousImage)}/json`);
    from = labelOf(old);
    const made = await json(call, 'POST', `/containers/create?name=${encodeURIComponent(`${name}-next-${suffix}`)}`, copyBody(inspect, old, options.image));
    fresh = asText(made.Id);
    if (fresh === '') throw new DockerUpdateError('the new container was not created');
    // a trace before anything is stopped: a helper that is killed from here on is found by the next server (settleResult)
    await options.record?.(done('started', `The update helper was working: the copy is ${name}-next-${suffix}, the old container becomes ${name}-prev-${suffix}.`, from, previousImage)).catch(() => undefined);
  } catch (error) {
    // nothing was stopped yet
    return done('failed', `${error instanceof Error ? error.message : String(error)}. Nothing was changed.`, from, '');
  }
  const stopTimeout = typeof asRecord(inspect.Config).StopTimeout === 'number' ? (asRecord(inspect.Config).StopTimeout as number) : 20;
  let stopped = false;
  try {
    // before the call: a stop that timed out on our side may still have stopped it, and then it must be started again
    stopped = true;
    await json(call, 'POST', `/containers/${options.target}/stop?t=${stopTimeout}`, undefined, (stopTimeout + 30) * 1000, [204, 304]);
    await json(call, 'POST', `/containers/${options.target}/rename?name=${encodeURIComponent(`${name}-prev-${suffix}`)}`, undefined, undefined, [204]);
    await json(call, 'POST', `/containers/${fresh}/rename?name=${encodeURIComponent(name)}`, undefined, undefined, [204]);
    await json(call, 'POST', `/containers/${fresh}/start`, undefined, undefined, [204, 304]);
    const bad = await waitHealthy(call, fresh, options.healthMs ?? HEALTH_MS, sleep, now);
    if (bad === null) {
      await call('DELETE', `/containers/${options.target}?force=1`).catch(() => undefined);
      await removeLeftovers(call, name, inspect);
      return done('ok', `Updated ${from === '' ? 'to' : `${from} to`} ${options.expect}.`, from, previousImage);
    }
    throw new DockerUpdateError(bad);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    const tail = await logTail(call, fresh);
    try {
      await call('DELETE', `/containers/${fresh}?force=1`).catch(() => undefined);
      if (stopped) {
        // the old one may already carry its -prev name, or still its own
        await call('POST', `/containers/${options.target}/rename?name=${encodeURIComponent(name)}`).catch(() => undefined);
        await json(call, 'POST', `/containers/${options.target}/start`, undefined, undefined, [204, 304]);
      }
      return done('rolled-back', `${why}. The old container is running again.`, from, '', tail);
    } catch (back) {
      return done('failed', `${why}. The rollback failed too (${back instanceof Error ? back.message : String(back)}): the old container is ${name}-prev-${suffix} or ${name}, the new one ${name}-next-${suffix} or ${name}; fix it by hand.`, from, '', tail);
    }
  }
}

/** null when the container is healthy (or has no healthcheck and stayed up), else why not. */
async function waitHealthy(call: DockerCall, id: string, limitMs: number, sleep: (ms: number) => Promise<void>, now: () => number): Promise<string | null> {
  const start = now();
  let upSince: number | null = null;
  for (;;) {
    const state = asRecord(asRecord(await json(call, 'GET', `/containers/${id}/json`)).State);
    const health = asText(asRecord(state.Health).Status);
    if (state.Running !== true) return `the new container stopped (exit ${String(state.ExitCode ?? '?')})`;
    if (health === 'healthy') return null;
    if (health === 'unhealthy') return 'the new container reported unhealthy';
    if (health === '' && state.Health === undefined) {
      upSince ??= now();
      if (now() - upSince >= NO_HEALTHCHECK_STABLE_MS) return null;
    }
    if (now() - start >= limitMs) return `the new container was not healthy after ${Math.round(limitMs / 1000)} s`;
    await sleep(HEALTH_POLL_MS);
  }
}

/* ---------------------------------------------------------------- update.json */

export async function writeResult(home: string, result: UpdateResult): Promise<void> {
  const dir = join(home, 'run');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.${RESULT_FILE}.${process.pid}.tmp`);
  await writeFile(temp, JSON.stringify(result, null, 2), { mode: FILE_MODE });
  await rename(temp, join(dir, RESULT_FILE));
}

export async function readResult(home: string): Promise<UpdateResult | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(home, 'run', RESULT_FILE), 'utf8'));
    if (!isRecord(raw) || raw.version !== 1 || !['started', 'ok', 'rolled-back', 'failed', 'interrupted'].includes(asText(raw.state))) return null;
    return {
      version: 1,
      at: typeof raw.at === 'number' ? raw.at : 0,
      state: raw.state as UpdateResult['state'],
      from: asText(raw.from).slice(0, 40),
      to: asText(raw.to).slice(0, 40),
      ...(CONTAINER_ID.test(asText(raw.target)) ? { target: asText(raw.target) } : {}),
      previousImage: asText(raw.previousImage).slice(0, 100),
      note: asText(raw.note).slice(0, 400),
      tail: (Array.isArray(raw.tail) ? raw.tail : []).filter((l): l is string => typeof l === 'string').slice(-8).map((l) => l.slice(0, 200)),
    };
  } catch {
    return null;
  }
}

/**
 * What a new server makes of update.json. A `started` record with a helper still running is an update in progress; with none (or older
 * than 15 minutes) the helper was killed: it becomes `interrupted` (written back, so it is settled once), no UNDO is offered, and the
 * note lists the stopped containers an earlier try left, which may hold the only copy of the old version.
 */
export async function settleResult(call: DockerCall, home: string, last: UpdateResult, hostname: string, now: number = Date.now()): Promise<UpdateResult> {
  if (last.state !== 'started') return last;
  let running = false;
  try {
    const res = await call('GET', `/containers/json?filters=${encodeURIComponent(JSON.stringify({ label: ['gonogo.helper=1', ...(last.target === undefined ? [] : [`gonogo.helper.target=${last.target}`])], status: ['running'] }))}`);
    const list: unknown = JSON.parse(res.text);
    running = Array.isArray(list) && list.length > 0;
  } catch {
    running = now - last.at < 15 * 60_000;
  }
  if (running && now - last.at < 15 * 60_000) return last;
  let left = '';
  try {
    const self = await inspectSelf(call, hostname);
    const names = (await listLeftovers(call, asText(self.Name).replace(/^\//, ''), self)).map((c) => c.name);
    left = names.length === 0 ? '' : ` Stopped containers it left: ${names.join(', ')}; a -prev one may hold the old version: \`docker start\` it only after stopping this one, or remove it with \`docker rm\` when you are sure.`;
  } catch {
    // no list is told
  }
  const result: UpdateResult = { ...last, at: now, state: 'interrupted', previousImage: '', note: `The update to ${last.to} was interrupted: the helper stopped before it finished. Whatever runs now is this gonogo; check \`docker ps -a\`, and run \`docker compose up -d\` if gonogo is not up.${left} No UNDO is offered.`, tail: [] };
  await writeResult(home, result).catch(() => undefined);
  return result;
}

/** The page's view of a result: what the strip shows (and UNDO only after a good update with an image to go back to). */
export function viewOfResult(r: UpdateResult): UpdateView {
  if (r.state === 'started') return { state: 'handed-off', version: r.to, note: r.note, tail: [], rollback: null };
  if (r.state === 'ok') return { state: 'done', version: r.to, note: r.note, tail: [], rollback: null, undo: r.previousImage !== '' };
  return { state: 'failed', version: r.to, note: r.state === 'rolled-back' ? `The update to ${r.to} did not take: ${r.note}` : r.state === 'interrupted' ? r.note : `The update to ${r.to} failed: ${r.note}`, tail: r.tail, rollback: null };
}

/**
 * The server that boots DURING the swap reads `started` once and would never see the end: it looks again every 5 s, for at most 15 minutes,
 * settles what it finds (a helper that died becomes `interrupted`) and calls `onChange` with each new record until there is an end.
 */
export async function followResult(call: DockerCall, home: string, hostname: string, first: UpdateResult, options: { onChange(result: UpdateResult): void; stopped(): boolean; sleep?(ms: number): Promise<void>; now?(): number; stepMs?: number; maxMs?: number }): Promise<void> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref()));
  const now = options.now ?? Date.now;
  const begin = now();
  let last = first;
  while (last.state === 'started' && !options.stopped() && now() - begin < (options.maxMs ?? 15 * 60_000)) {
    await sleep(options.stepMs ?? 5_000);
    if (options.stopped()) return;
    const found = await readResult(home);
    if (found === null) continue;
    const settled = await settleResult(call, home, found, hostname, now());
    if (settled.state !== last.state || settled.at !== last.at) options.onChange(settled);
    last = settled;
  }
}
