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
function engine(boxes: Array<{ id: string; name: string; hostname?: string; mac?: string }>): SelfCall & { asked: string[] } {
  const asked: string[] = [];
  const call = (async (_method: string, path: string) => {
    asked.push(path);
    const route = /^\/containers\/([^/]+)\/json$/.exec(path);
    if (route !== null) {
      const ref = decodeURIComponent(route[1] as string);
      const box = boxes.find((b) => b.id === ref || b.id.startsWith(ref) || b.name === ref);
      return box === undefined ? { status: 404, text: `{"message":"No such container: ${ref}"}` } : { status: 200, text: JSON.stringify({ Id: box.id, Name: `/${box.name}`, Config: { Hostname: box.hostname ?? box.id.slice(0, 12), Image: 'ghcr.io/ulm0/gonogo:latest' } }) };
    }
    if (path === '/containers/json') return { status: 200, text: JSON.stringify(boxes.map((b) => ({ Id: b.id, Names: [`/${b.name}`], NetworkSettings: { Networks: { bridge: { MacAddress: b.mac ?? '' } } } }))) };
    return { status: 404, text: '' };
  }) as SelfCall & { asked: string[] };
  call.asked = asked;
  return call;
}
const probe = (over: Partial<{ mountinfo: string; cgroup: string; macs: string[] }> = {}): SelfProbe => ({ mountinfo: () => over.mountinfo ?? '', cgroup: () => over.cgroup ?? '0::/', macs: () => over.macs ?? [] });

describe('resolveSelf', () => {
  it('the case that was reported: the hostname is not an id (a compose `hostname:`), and its own files name the container', async () => {
    const call = engine([{ id: ID, name: 'gonogo-gonogo-1', hostname: 'zimaos-gonogo' }, { id: OTHER, name: 'other' }]);
    const found = await resolveSelf(call, '4d1c9b7a02ef-typo', probe({ mountinfo: mountinfo(`/var/lib/docker/containers/${ID}`) }));
    expect(found.Id).toBe(ID);
    const viaCgroup = await resolveSelf(call, 'whatever', probe({ cgroup: `0::/docker/${ID}` }));
    expect(viaCgroup.Id).toBe(ID);
  });

  it('the real case on an install: hostname and /etc/hostname say one 12-hex name, mountinfo names the real id, cgroup is "0::/" (a private cgroup namespace)', async () => {
    const real = '805cf0e3ee5132eac4010c48186b5a6d0ca2666ff9eb35fbd408677b21a1b18a';
    // Docker has no container by the hostname's name, and the id the files give is the one it knows
    const call = engine([{ id: real, name: 'gonogo', hostname: '4d1c9b7a02ef' }, { id: OTHER, name: 'other' }]);
    const found = await resolveSelf(call, '4d1c9b7a02ef', probe({ mountinfo: mountinfo(`/DATA/AppData/docker/containers/${real}`), cgroup: '0::/' }));
    expect(found.Id).toBe(real);
    // the mountinfo id is asked for first: the hostname is not even tried when the files answer
    expect(call.asked[0]).toBe(`/containers/${real}/json`);
    expect(call.asked.some((p) => p.includes('4d1c9b7a02ef'))).toBe(false);
    // and when the hostname DOES equal the id's start, the same container comes back
    expect((await resolveSelf(call, real.slice(0, 12), probe({ mountinfo: mountinfo(`/var/lib/docker/containers/${real}`), cgroup: '0::/' }))).Id).toBe(real);
  });

  it('the plain case still works with no help from the files: the hostname is the first 12 of the id', async () => {
    const call = engine([{ id: ID, name: 'gonogo' }, { id: OTHER, name: 'other' }]);
    expect((await resolveSelf(call, ID.slice(0, 12), probe())).Id).toBe(ID);
  });

  it('a hostname that is the NAME of another container is not this container; one that is this container\'s configured hostname is, when the files agree or are silent', async () => {
    const call = engine([{ id: ID, name: 'gonogo', hostname: 'box' }, { id: OTHER, name: 'box', hostname: 'elsewhere' }]);
    // "box" resolves to the container NAMED box (OTHER), whose hostname is not box: refused (no files, no address)
    await expect(resolveSelf(call, 'box', probe())).rejects.toThrow(/name of another container/);
    // the files name this one: found without the hostname
    expect((await resolveSelf(call, 'box', probe({ cgroup: `0::/docker/${ID}` }))).Id).toBe(ID);
    // configured hostname matches and nothing contradicts it
    // a container NAMED like the hostname whose configured hostname is that too: it is this one (compose: container_name and hostname equal)
    const call2 = engine([{ id: ID, name: 'gonogo', hostname: 'gonogo' }]);
    expect((await resolveSelf(call2, 'gonogo', probe())).Id).toBe(ID);
  });

  it('files that name another container than the hostname does are refused when the match is only by configured hostname', async () => {
    const call = engine([{ id: ID, name: 'a', hostname: 'same' }, { id: OTHER, name: 'same-too', hostname: 'same' }]);
    // "a" is found by name; its configured hostname is `same`, not `a`: it is refused whatever
    await expect(resolveSelf(call, 'same', probe({ cgroup: `0::/docker/${THIRD}` }))).rejects.toThrow(SelfError);
  });

  it('never guesses: two ids in its own files, or no evidence at all, say so and name what failed', async () => {
    const call = engine([{ id: ID, name: 'a' }, { id: OTHER, name: 'b' }]);
    const two = `${mountinfo(`/var/lib/docker/containers/${ID}`)}\n1514 1500 8:1 /var/lib/docker/containers/${OTHER}/hosts /etc/hosts rw - ext4 /dev/sda1 rw`;
    await expect(resolveSelf(call, 'nothing', probe({ mountinfo: two }))).rejects.toThrow(/name 2 containers.*not guessing/);
    await expect(resolveSelf(call, 'nothing', probe())).rejects.toThrow(/could not be told from the others.*name no container.*404 for the hostname nothing/);
  });

  it('the network address is the last evidence: exactly one running container has it', async () => {
    const mac = '02:42:ac:11:00:02';
    const one = engine([{ id: ID, name: 'a', mac }, { id: OTHER, name: 'b', mac: '02:42:ac:11:00:03' }]);
    expect((await resolveSelf(one, 'nope', probe({ macs: [mac] }))).Id).toBe(ID);
    // upper case in the file, lower case here
    expect((await resolveSelf(one, 'nope', probe({ macs: [mac.toUpperCase()] }))).Id).toBe(ID);
    const two = engine([{ id: ID, name: 'a', mac }, { id: OTHER, name: 'b', mac }]);
    await expect(resolveSelf(two, 'nope', probe({ macs: [mac] }))).rejects.toThrow(/2 containers have this process's network address: not guessing/);
    const none = engine([{ id: ID, name: 'a', mac: '02:42:ac:11:00:09' }]);
    await expect(resolveSelf(none, 'nope', probe({ macs: [mac] }))).rejects.toThrow(/no running container has this process's network address/);
    await expect(resolveSelf(none, 'nope', probe({ macs: [] }))).rejects.toThrow(/no network address of its own/);
  });

  it('an unreadable /proc says so, and the other evidence still works', async () => {
    const call = engine([{ id: ID, name: 'gonogo' }]);
    const broken: SelfProbe = { mountinfo: () => { throw new Error('no /proc'); }, cgroup: () => { throw new Error('no /proc'); }, macs: () => [] };
    expect((await resolveSelf(call, ID.slice(0, 12), broken)).Id).toBe(ID);
    await expect(resolveSelf(call, 'nope', broken)).rejects.toThrow(/could not be read/);
  });

  it('an id from its files that Docker answers for with another id is not trusted', async () => {
    const lying: SelfCall = async (_m, path) => (path.includes(ID) ? { status: 200, text: JSON.stringify({ Id: OTHER, Config: {} }) } : { status: 404, text: '' });
    await expect(resolveSelf(lying, 'nope', probe({ cgroup: `0::/docker/${ID}` }))).rejects.toThrow(/does not know under that id/);
  });
});
