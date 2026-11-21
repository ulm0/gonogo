/**
 * Which container is this one? The Docker self-update needs its own container through the socket, and `os.hostname()` is only its id by default: a compose
 * `hostname:`, a name the daemon sets differently, or a recreate makes it something else ("No such container: <hostname>" left the Update key off).
 * A wrong answer is worse than none (the update stops the container it found), so this is strict:
 *  1. the id in this process's own files: the bind sources of /etc/hostname, /etc/hosts and /etc/resolv.conf in /proc/self/mountinfo
 *     (`.../containers/<64 hex>/hostname`, Docker; `.../overlay-containers/<64 hex>/userdata/hostname`, Podman) and the cgroup path in /proc/self/cgroup
 *     (`/docker/<id>`, `docker-<id>.scope`, `libpod-<id>.scope`, Kubernetes forms). If they name any id, ONLY a container with exactly that one id is this
 *     one: two ids, or one this Docker does not know (another daemon's socket), is a refusal, and nothing below is tried;
 *  2. with the files silent, the hostname, but only as an id: 12 to 64 hex characters that start the id of the container Docker finds. A name, or a
 *     hostname that was set, proves nothing;
 *  3. with that failing too, the one running container with this process's MAC address AND IP address whose configured hostname is this hostname (a MAC
 *     derives from an IP and collides between daemons, so it never stands alone).
 * When nothing names exactly one container, the reason says which of these failed.
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
  /** The IP addresses of this process's own interfaces. */
  ips(): string[];
}

const ownInterfaces = () =>
  Object.values(networkInterfaces())
    .flatMap((list) => list ?? [])
    .filter((i) => !i.internal && i.mac !== '00:00:00:00:00:00');

export const realProbe: SelfProbe = {
  mountinfo: () => readFileSync('/proc/self/mountinfo', 'utf8'),
  cgroup: () => readFileSync('/proc/self/cgroup', 'utf8'),
  macs: () => ownInterfaces().map((i) => i.mac.toLowerCase()),
  ips: () => ownInterfaces().map((i) => i.address),
};

/** What resolveSelf reads by default: the real files. A test sets `current` to a probe of its own, because a test of this room runs inside a container of its own. */
export const selfProbe: { current: SelfProbe } = { current: realProbe };

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

/** The inspect of this container, or a SelfError that says why none could be told. Strict on purpose: a wrong container would be stopped by the update. */
export async function resolveSelf(call: SelfCall, hostname: string, probe: SelfProbe = selfProbe.current): Promise<Json> {
  // 1. the ids this process's own files name: when they name any, ONLY a container with exactly that one id is this one, and nothing else is tried
  let ids: string[] = [];
  let unreadable = false;
  try {
    ids = [...new Set([...idsFromMountinfo(probe.mountinfo()), ...idsFromCgroup(probe.cgroup())])];
  } catch {
    unreadable = true;
  }
  if (ids.length > 1) throw new SelfError(`this container could not be told from the others through the Docker socket: its own files name ${ids.length} containers (${ids.map((i) => i.slice(0, 12)).join(', ')}): not guessing between them`);
  if (ids.length === 1) {
    const found = await inspect(call, ids[0] as string);
    if (found !== null && asText(found.Id) === ids[0]) return found;
    throw new SelfError(`this container could not be told from the others through the Docker socket: its own files name the container ${(ids[0] as string).slice(0, 12)}, which this Docker does not know under that id (a socket of another daemon?)`);
  }
  const why = [unreadable ? 'the files of this process (mountinfo, cgroup) could not be read' : 'its own files (mountinfo, cgroup) name no container'];

  // 2. the hostname, only as the id (or its start) that Docker gives a container by default: 12 to 64 hex characters. A name, or a hostname that was set, is not evidence.
  if (/^[0-9a-f]{12,64}$/.test(hostname)) {
    const found = await inspect(call, hostname);
    if (found !== null && asText(found.Id).startsWith(hostname)) return found;
    why.push(`Docker answered 404 for the hostname ${hostname}`);
  } else {
    why.push(`the hostname ${hostname} is not a container id`);
  }

  // 3. the network endpoint: a running container with this process's MAC address, whose configured hostname is this hostname and one of whose addresses is ours.
  //    A MAC derives from the IP and collides between daemons, so the address alone is not enough, and exactly one container must pass all three.
  try {
    const macs = new Set(probe.macs().map((m) => m.toLowerCase()));
    const ips = new Set(probe.ips());
    if (macs.size === 0 || ips.size === 0) {
      why.push('this process has no network address of its own to match (host network?)');
    } else {
      const list = await call('GET', '/containers/json');
      const rows: unknown = list.status === 200 ? JSON.parse(list.text) : [];
      const hits: Json[] = [];
      for (const row of Array.isArray(rows) ? rows : []) {
        if (!isRecord(row)) continue;
        const networks = isRecord(row.NetworkSettings) && isRecord(row.NetworkSettings.Networks) ? Object.values(row.NetworkSettings.Networks) : [];
        if (!networks.some((n) => isRecord(n) && macs.has(asText(n.MacAddress).toLowerCase()))) continue;
        const found = await inspect(call, asText(row.Id));
        if (found === null) continue;
        const own = isRecord(found.NetworkSettings) && isRecord(found.NetworkSettings.Networks) ? Object.values(found.NetworkSettings.Networks) : [];
        const sameIp = own.some((n) => isRecord(n) && (ips.has(asText(n.IPAddress)) || ips.has(asText(n.GlobalIPv6Address))));
        if (asText((isRecord(found.Config) ? found.Config : {}).Hostname) === hostname && sameIp) hits.push(found);
      }
      if (hits.length === 1) return hits[0] as Json;
      why.push(hits.length === 0 ? 'no running container has this process\'s network address, hostname and MAC together' : `${hits.length} containers have this process's address, hostname and MAC: not guessing`);
    }
  } catch {
    why.push('the list of containers could not be read');
  }

  throw new SelfError(`this container could not be told from the others through the Docker socket: ${why.join('; ')}`);
}
