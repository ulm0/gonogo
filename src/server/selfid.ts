/**
 * Which container is this one? The Docker self-update needs its own container through the socket, and `os.hostname()` is only its id by default: a compose
 * `hostname:`, a name the daemon sets differently, or a recreate makes it something else, and "No such container: 4d1c9b7a02ef" left the Update key off.
 *
 * Never a guess between two candidates. The evidence, strongest first:
 *  1. the id in this process's own files: the bind sources of /etc/hostname, /etc/hosts and /etc/resolv.conf in /proc/self/mountinfo
 *     (`.../containers/<64 hex>/hostname`, Docker; `.../overlay-containers/<64 hex>/userdata/hostname`, Podman), or the cgroup path in /proc/self/cgroup
 *     (`/docker/<id>`, `docker-<id>.scope`, `libpod-<id>.scope`, `/kubepods/.../<id>`); exactly one distinct id, and the container Docker answers with
 *     for it must have that very id;
 *  2. the hostname, as before: a container whose id starts with it is this one (the default hostname is the first 12 characters of the id); a container
 *     that only has it as its configured `hostname:` counts only when the files above name nothing else;
 *  3. among the running containers, the one whose network endpoint has this process's MAC address (the address is unique to an endpoint), and only one.
 * When nothing names exactly one container, it says which of these failed, so the Director can see why.
 */
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

type Json = Record<string, unknown>;
const isRecord = (x: unknown): x is Json => typeof x === 'object' && x !== null && !Array.isArray(x);
const asText = (x: unknown): string => (typeof x === 'string' ? x : '');
const HEX64 = /[0-9a-f]{64}/g;

/** One call of the Engine API, as dockerupdate.ts has it. */
export type SelfCall = (method: string, path: string) => Promise<{ status: number; text: string }>;

/** What this process knows about itself: the content of two files and its network addresses. A test hands in fixtures. */
export interface SelfProbe {
  mountinfo(): string;
  cgroup(): string;
  macs(): string[];
}

export const realProbe: SelfProbe = {
  mountinfo: () => readFileSync('/proc/self/mountinfo', 'utf8'),
  cgroup: () => readFileSync('/proc/self/cgroup', 'utf8'),
  macs: () =>
    Object.values(networkInterfaces())
      .flatMap((list) => list ?? [])
      .filter((i) => !i.internal && i.mac !== '00:00:00:00:00:00')
      .map((i) => i.mac.toLowerCase()),
};

/** The container ids that the mounts of /etc/hostname, /etc/hosts and /etc/resolv.conf name (the engine keeps them in the container's own folder). */
export function idsFromMountinfo(text: string): string[] {
  const ids = new Set<string>();
  for (const line of text.split('\n')) {
    // a mountinfo line: ... root mountpoint ... - fstype source ...; the root of a bind mount of a file is that file's path on the host
    const fields = line.split(' ');
    const mountpoint = fields[4] ?? '';
    if (mountpoint !== '/etc/hostname' && mountpoint !== '/etc/hosts' && mountpoint !== '/etc/resolv.conf') continue;
    const root = fields[3] ?? '';
    const m = /\/(?:containers|overlay-containers)\/([0-9a-f]{64})\//.exec(root);
    if (m !== null) ids.add(m[1] as string);
  }
  return [...ids];
}

/** The container ids in the cgroup paths: cgroup v1 (`/docker/<id>`, `/system.slice/docker-<id>.scope`), v2 and Podman (`libpod-<id>.scope`), Kubernetes. */
export function idsFromCgroup(text: string): string[] {
  const ids = new Set<string>();
  for (const line of text.split('\n')) {
    const path = line.split(':').slice(2).join(':');
    // only a path that says it is a container: a 64-hex segment of its own, or `docker-<id>.scope`, `libpod-<id>.scope`, `cri-containerd-<id>.scope`, `crio-<id>.scope`
    for (const segment of path.split('/')) {
      const m = /^(?:(?:docker|libpod|crio|cri-containerd)-)?([0-9a-f]{64})(?:\.scope)?$/.exec(segment);
      if (m !== null) ids.add(m[1] as string);
    }
  }
  return [...ids];
}

export class SelfError extends Error {}

async function inspect(call: SelfCall, ref: string): Promise<Json | null> {
  const answer = await call('GET', `/containers/${encodeURIComponent(ref)}/json`);
  if (answer.status !== 200) return null;
  try {
    const parsed: unknown = JSON.parse(answer.text);
    return isRecord(parsed) && asText(parsed.Id) !== '' ? parsed : null;
  } catch {
    return null;
  }
}

/** The inspect of this container, or a SelfError that says why none could be told. */
export async function resolveSelf(call: SelfCall, hostname: string, probe: SelfProbe = realProbe): Promise<Json> {
  const why: string[] = [];

  // 1. the ids this process's own files name; read first, because the hostname may be the name of any container
  let ids: string[] = [];
  try {
    ids = [...new Set([...idsFromMountinfo(probe.mountinfo()), ...idsFromCgroup(probe.cgroup())])];
  } catch {
    why.push('the files of this process (mountinfo, cgroup) could not be read');
  }
  if (ids.length > 1) why.push(`its own files name ${ids.length} containers (${ids.map((i) => i.slice(0, 12)).join(', ')}): not guessing between them`);
  if (ids.length === 1) {
    const found = await inspect(call, ids[0] as string);
    if (found !== null && asText(found.Id) === ids[0]) return found;
    why.push(`its own files name the container ${(ids[0] as string).slice(0, 12)}, which Docker does not know under that id`);
  } else if (ids.length === 0 && why.length === 0) {
    why.push('its own files (mountinfo, cgroup) name no container');
  }

  // 2. the hostname: the container's id by default. The NAME of another container must not pass for this one.
  if (hostname !== '') {
    const found = await inspect(call, hostname);
    if (found !== null) {
      const id = asText(found.Id);
      const hostnameOf = asText((isRecord(found.Config) ? found.Config : {}).Hostname);
      if (id.startsWith(hostname)) return found;
      if (hostnameOf === hostname) {
        if (ids.length === 0 || ids[0] === id) return found;
        why.push(`the hostname ${hostname} names the container ${id.slice(0, 12)}, but its own files name another`);
      } else {
        why.push(`the hostname ${hostname} is the name of another container (${id.slice(0, 12)})`);
      }
    } else {
      why.push(`Docker answered 404 for the hostname ${hostname}`);
    }
  }

  // 3. the network endpoint: its MAC address is this process's, and no other container has it
  try {
    const macs = new Set(probe.macs().map((m) => m.toLowerCase()));
    if (macs.size === 0) {
      why.push('this process has no network address of its own to match (host network?)');
    } else {
      const list = await call('GET', '/containers/json');
      const rows: unknown = list.status === 200 ? JSON.parse(list.text) : [];
      const hits: string[] = [];
      for (const row of Array.isArray(rows) ? rows : []) {
        if (!isRecord(row)) continue;
        const networks = isRecord(row.NetworkSettings) && isRecord(row.NetworkSettings.Networks) ? Object.values(row.NetworkSettings.Networks) : [];
        if (networks.some((n) => isRecord(n) && macs.has(asText(n.MacAddress).toLowerCase()))) hits.push(asText(row.Id));
      }
      if (hits.length === 1) {
        const found = await inspect(call, hits[0] as string);
        if (found !== null) return found;
        why.push('the container with this network address could not be inspected');
      } else if (hits.length === 0) {
        why.push('no running container has this process\'s network address');
      } else {
        why.push(`${hits.length} containers have this process's network address: not guessing`);
      }
    }
  } catch {
    why.push('the list of containers could not be read');
  }

  throw new SelfError(`this container could not be told from the others through the Docker socket: ${why.join('; ')}`);
}
