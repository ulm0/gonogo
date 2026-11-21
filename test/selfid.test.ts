// Which container is this one (selfid.ts)? Fixtures of /proc/self/mountinfo and /proc/self/cgroup of the engines and cgroup versions people run, and
// the order of evidence: its own files, the hostname, its network address; never a guess between two.
import { describe, expect, it } from 'vitest';
import { idsFromCgroup, idsFromMountinfo, resolveSelf, SelfError } from '../src/server/selfid.js';
import type { SelfCall, SelfProbe } from '../src/server/selfid.js';

const ID = '4d1c9b7a02ef' + 'a'.repeat(52);
const OTHER = '0123456789ab' + 'c'.repeat(52);
const THIRD = 'f'.repeat(64);

const mountinfo = (root: string): string =>
  [
    '1500 1400 0:80 / / rw,relatime master:500 - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/l/ABC',
    '1501 1500 0:81 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw',
    `1510 1500 8:1 ${root}/resolv.conf /etc/resolv.conf rw,relatime - ext4 /dev/sda1 rw`,
    `1511 1500 8:1 ${root}/hostname /etc/hostname rw,relatime - ext4 /dev/sda1 rw`,
    `1512 1500 8:1 ${root}/hosts /etc/hosts rw,relatime - ext4 /dev/sda1 rw`,
    '1513 1500 8:1 /srv/gonogo/state /state rw,relatime - ext4 /dev/sda1 rw',
  ].join('\n');

describe('the id in /proc/self/mountinfo', () => {
  it('reads the folder the engine keeps for the container: Docker, rootless Docker, Podman', () => {
    expect(idsFromMountinfo(mountinfo(`/var/lib/docker/containers/${ID}`))).toEqual([ID]);
    expect(idsFromMountinfo(mountinfo(`/home/user/.local/share/docker/containers/${ID}`))).toEqual([ID]);
    expect(idsFromMountinfo(mountinfo(`/home/user/.local/share/containers/storage/overlay-containers/${ID}/userdata`))).toEqual([ID]);
    // a Docker data root somewhere else (ZimaOS, a NAS) is the same shape
    expect(idsFromMountinfo(mountinfo(`/DATA/.docker/containers/${ID}`))).toEqual([ID]);
  });

  it('ignores every other mount, even one whose path holds a 64-hex name, and a file that says nothing', () => {
    const text = `${mountinfo('/srv/other')}\n1520 1500 8:1 /var/lib/docker/containers/${OTHER}/hostname /srv/not-etc/hostname rw - ext4 /dev/sda1 rw\n1521 1500 8:1 /data/${OTHER}/x /data rw - ext4 /dev/sda1 rw`;
    expect(idsFromMountinfo(text)).toEqual([]);
    expect(idsFromMountinfo('')).toEqual([]);
    expect(idsFromMountinfo('garbage\n\n   \n')).toEqual([]);
  });

  it('two different ids are both returned (and the resolver then refuses)', () => {
    const text = `${mountinfo(`/var/lib/docker/containers/${ID}`)}\n1514 1500 8:1 /var/lib/docker/containers/${OTHER}/hosts /etc/hosts rw - ext4 /dev/sda1 rw`;
    expect(idsFromMountinfo(text).sort()).toEqual([ID, OTHER].sort());
  });
});

describe('the id in /proc/self/cgroup', () => {
  it('reads cgroup v1 (docker/<id>), systemd scopes (docker-, libpod-, crio-, cri-containerd-) and cgroup v2 paths', () => {
    expect(idsFromCgroup(`12:cpuset:/docker/${ID}\n11:memory:/docker/${ID}\n0::/docker/${ID}`)).toEqual([ID]);
    expect(idsFromCgroup(`1:name=systemd:/system.slice/docker-${ID}.scope`)).toEqual([ID]);
    expect(idsFromCgroup(`0::/user.slice/user-1000.slice/user@1000.service/user.slice/libpod-${ID}.scope/container`)).toEqual([ID]);
    expect(idsFromCgroup(`0::/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod1234.slice/cri-containerd-${ID}.scope`)).toEqual([ID]);
    expect(idsFromCgroup(`0::/kubepods/burstable/pod1234abcd/${ID}`)).toEqual([ID]);
    expect(idsFromCgroup(`0::/system.slice/crio-${ID}.scope`)).toEqual([ID]);
  });

  it('a private cgroup namespace shows "/" and names nothing; a host path with no container says nothing', () => {
    expect(idsFromCgroup('0::/')).toEqual([]);
    expect(idsFromCgroup('12:cpuset:/\n11:memory:/')).toEqual([]);
    expect(idsFromCgroup('0::/user.slice/user-1000.slice/session-3.scope')).toEqual([]);
    expect(idsFromCgroup('')).toEqual([]);
    // 64 hex that is not a whole segment of its own is not an id
    expect(idsFromCgroup(`0::/docker/prefix${ID}`)).toEqual([]);
  });
});

/** A fake Engine: the containers it knows by id (full or the first 12), by name, and the list with network addresses. */
interface Box {
  id: string;
  name: string;
  hostname?: string;
  mac?: string;
  ip?: string;
}
function engine(boxes: Box[]): SelfCall & { asked: string[] } {
  const asked: string[] = [];
  const nets = (b: Box) => ({ bridge: { MacAddress: b.mac ?? '', IPAddress: b.ip ?? '' } });
  const call = (async (_method: string, path: string) => {
    asked.push(path);
    const route = /^\/containers\/([^/]+)\/json$/.exec(path);
    if (route !== null) {
      const ref = decodeURIComponent(route[1] as string);
      const box = boxes.find((b) => b.id === ref || b.id.startsWith(ref) || b.name === ref);
      return box === undefined ? { status: 404, text: `{"message":"No such container: ${ref}"}` } : { status: 200, text: JSON.stringify({ Id: box.id, Name: `/${box.name}`, Config: { Hostname: box.hostname ?? box.id.slice(0, 12), Image: 'ghcr.io/ulm0/gonogo:latest' }, NetworkSettings: { Networks: nets(box) } }) };
    }
    if (path === '/containers/json') return { status: 200, text: JSON.stringify(boxes.map((b) => ({ Id: b.id, Names: [`/${b.name}`], NetworkSettings: { Networks: nets(b) } }))) };
    return { status: 404, text: '' };
  }) as SelfCall & { asked: string[] };
  call.asked = asked;
  return call;
}
const probe = (over: Partial<{ mountinfo: string; cgroup: string; macs: string[]; ips: string[] }> = {}): SelfProbe => ({ mountinfo: () => over.mountinfo ?? '', cgroup: () => over.cgroup ?? '0::/', macs: () => over.macs ?? [], ips: () => over.ips ?? [] });
const docker = (id: string): string => mountinfo(`/var/lib/docker/containers/${id}`);
const MAC = '02:42:ac:11:00:02';
const IP = '172.17.0.2';

describe('resolveSelf: its own files first, and when they name an id nothing else counts', () => {
  it('the real case on an install: hostname and /etc/hostname say one 12-hex name, mountinfo names the real id, cgroup is "0::/" (a private cgroup namespace)', async () => {
    const real = '805cf0e3ee5132eac4010c48186b5a6d0ca2666ff9eb35fbd408677b21a1b18a';
    const call = engine([{ id: real, name: 'gonogo', hostname: '4d1c9b7a02ef' }, { id: OTHER, name: 'other' }]);
    const found = await resolveSelf(call, '4d1c9b7a02ef', probe({ mountinfo: mountinfo(`/DATA/AppData/docker/containers/${real}`), cgroup: '0::/' }));
    expect(found.Id).toBe(real);
    // the id of the files is asked for first and alone: the hostname is not even tried when they answer
    expect(call.asked).toEqual([`/containers/${real}/json`]);
  });

  it('a compose hostname and the cgroup form work the same', async () => {
    const call = engine([{ id: ID, name: 'gonogo-gonogo-1', hostname: 'zimaos-gonogo' }, { id: OTHER, name: 'other' }]);
    expect((await resolveSelf(call, 'zimaos-gonogo', probe({ cgroup: `0::/docker/${ID}` }))).Id).toBe(ID);
    expect((await resolveSelf(call, 'zimaos-gonogo', probe({ mountinfo: docker(ID) }))).Id).toBe(ID);
  });

  it('two ids in its own files: refused, with no fallback to the hostname or the address', async () => {
    const call = engine([{ id: ID, name: 'a', hostname: 'h', mac: MAC, ip: IP }, { id: OTHER, name: 'b' }]);
    const two = `${docker(ID)}\n1514 1500 8:1 /var/lib/docker/containers/${OTHER}/hosts /etc/hosts rw - ext4 /dev/sda1 rw`;
    await expect(resolveSelf(call, ID.slice(0, 12), probe({ mountinfo: two, macs: [MAC], ips: [IP] }))).rejects.toThrow(/name 2 containers.*not guessing/);
    expect(call.asked).toEqual([]);
  });

  it('one id that this Docker does not know (the socket of another daemon): refused even when the hostname or the address would match', async () => {
    const call = engine([{ id: ID, name: 'a', hostname: 'h', mac: MAC, ip: IP }]);
    // the files name THIRD; the hostname is ID's own start and the MAC and IP are ID's: none of it may be used
    await expect(resolveSelf(call, ID.slice(0, 12), probe({ mountinfo: docker(THIRD), macs: [MAC], ips: [IP] }))).rejects.toThrow(/does not know under that id/);
    expect(call.asked).toEqual([`/containers/${THIRD}/json`]);
    // and Docker answering for that id with another id is not trusted either
    const lying: SelfCall = async (_m, path) => (path.includes(ID) ? { status: 200, text: JSON.stringify({ Id: OTHER, Config: {} }) } : { status: 404, text: '' });
    await expect(resolveSelf(lying, 'nope', probe({ cgroup: `0::/docker/${ID}` }))).rejects.toThrow(/does not know under that id/);
  });
});

describe('resolveSelf: with the files silent, the hostname only as an id', () => {
  it('the plain case: the default hostname is the first 12 hex characters of the id (or the whole id)', async () => {
    const call = engine([{ id: ID, name: 'gonogo' }, { id: OTHER, name: 'other' }]);
    expect((await resolveSelf(call, ID.slice(0, 12), probe())).Id).toBe(ID);
    expect((await resolveSelf(call, ID, probe())).Id).toBe(ID);
  });

  it('a hostname that is a NAME ("db") never stands for a container, even one named so', async () => {
    const call = engine([{ id: ID, name: 'gonogo', hostname: 'db' }, { id: OTHER, name: 'db', hostname: 'db' }]);
    await expect(resolveSelf(call, 'db', probe())).rejects.toThrow(/the hostname db is not a container id/);
    expect(call.asked.some((p) => p.includes('/db/'))).toBe(false);
  });

  it('hex shorter than 12 is not an id; a 12-hex name that is not the start of an id is not either', async () => {
    const call = engine([{ id: ID, name: 'gonogo' }]);
    await expect(resolveSelf(call, ID.slice(0, 8), probe())).rejects.toThrow(/not a container id/);
    await expect(resolveSelf(call, 'abcdef012345', probe())).rejects.toThrow(/Docker answered 404 for the hostname abcdef012345/);
  });

  it('a hostname that is the id of one container and the NAME of another goes to the id only', async () => {
    const call = engine([{ id: ID, name: 'x' }, { id: OTHER, name: ID.slice(0, 12) }]);
    // the fake resolves ids before names, as Docker does
    expect((await resolveSelf(call, ID.slice(0, 12), probe())).Id).toBe(ID);
  });
});

describe('resolveSelf: the network address, and only with the hostname and the IP', () => {
  const me = (over: Partial<Box> = {}): Box => ({ id: ID, name: 'a', hostname: 'zimaos-gonogo', mac: MAC, ip: IP, ...over });

  it('MAC, IP and configured hostname all agree on exactly one container: found', async () => {
    const call = engine([me(), { id: OTHER, name: 'b', hostname: 'other', mac: '02:42:ac:11:00:03', ip: '172.17.0.3' }]);
    expect((await resolveSelf(call, 'zimaos-gonogo', probe({ macs: [MAC.toUpperCase()], ips: [IP] }))).Id).toBe(ID);
  });

  it('a MAC collision with a different hostname (MACs derive from IPs and collide across daemons): refused', async () => {
    const call = engine([me({ hostname: 'someone-else' })]);
    await expect(resolveSelf(call, 'zimaos-gonogo', probe({ macs: [MAC], ips: [IP] }))).rejects.toThrow(/no running container has this process's network address, hostname and MAC together/);
  });

  it('the same MAC and hostname but another IP: refused', async () => {
    const call = engine([me({ ip: '172.17.0.9' })]);
    await expect(resolveSelf(call, 'zimaos-gonogo', probe({ macs: [MAC], ips: [IP] }))).rejects.toThrow(/no running container/);
  });

  it('two containers with the same configured hostname and no ids: refused unless the MAC and the IP also agree (and then it is the one that agrees)', async () => {
    const same = engine([me({ id: ID, name: 'a', mac: '02:42:ac:11:00:07', ip: '172.17.0.7' }), me({ id: OTHER, name: 'b', mac: '02:42:ac:11:00:08', ip: '172.17.0.8' })]);
    await expect(resolveSelf(same, 'zimaos-gonogo', probe({ macs: [MAC], ips: [IP] }))).rejects.toThrow(SelfError);
    const both = engine([me({ id: ID, name: 'a' }), me({ id: OTHER, name: 'b' })]);
    await expect(resolveSelf(both, 'zimaos-gonogo', probe({ macs: [MAC], ips: [IP] }))).rejects.toThrow(/2 containers have this process's address, hostname and MAC: not guessing/);
    const one = engine([me({ id: ID, name: 'a' }), me({ id: OTHER, name: 'b', mac: '02:42:ac:11:00:08', ip: '172.17.0.8' })]);
    expect((await resolveSelf(one, 'zimaos-gonogo', probe({ macs: [MAC], ips: [IP] }))).Id).toBe(ID);
  });

  it('no address of its own to match: refused with that reason', async () => {
    const call = engine([me()]);
    await expect(resolveSelf(call, 'zimaos-gonogo', probe())).rejects.toThrow(/no network address of its own/);
  });

  it('an unreadable /proc says so, and the hostname as an id still works', async () => {
    const call = engine([{ id: ID, name: 'gonogo' }]);
    const broken: SelfProbe = { mountinfo: () => { throw new Error('no /proc'); }, cgroup: () => { throw new Error('no /proc'); }, macs: () => [], ips: () => [] };
    expect((await resolveSelf(call, ID.slice(0, 12), broken)).Id).toBe(ID);
    await expect(resolveSelf(call, 'nope', broken)).rejects.toThrow(/could not be read/);
  });
});
