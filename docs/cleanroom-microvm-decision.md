# Decision note: a microVM runtime for the Clean Room (draft)

By FIDO, 2026-11-23, for FLIGHT and the Director. Read-only research: **no code changed, nothing installed on the host**. Facts marked *host* come from read-only queries through the Docker socket and `/sys` from inside the gonogo container; facts marked *docs* come from vendor pages read through a fetch helper (second-hand); *not verified* means nobody ran it.

## 1. Short answer

- **Pick (a): Kata Containers, with cloud-hypervisor or QEMU as the hypervisor, not Firecracker**, as the target; **gVisor (c) is the fallback** if the host cannot give Kata KVM access or a runtime path. **Drop (b), firecracker-containerd:** its own README says it is archived and no longer maintained (docs, read 2026-11-23).
- **The runtime flag is the easy part (S, about 80 lines). The hard part is networking:** today's Clean Room joins gonogo's own network namespace so that hooks reach `127.0.0.1`. **Kata documents that it cannot do that** (docs, section 3). A microVM Clean Room needs one new piece in gonogo: a listener for `/hook` and `/mcp` that a VM can reach (M, about 250 lines, RSO review).
- **Whether ZimaOS can host any of this is unknown from here.** Three read-only commands the Director runs on the host decide it (section 6). Nothing is to be installed until they pass.

## 2. What is true of the host (read-only)

| Fact | Value | Source |
|---|---|---|
| OS, kernel | ZimaOS v1.8.0, Linux 6.18.9 | `docker info` |
| CPU and RAM | Intel i7-8705G, 8 cores / 16 threads, `vmx` present; 64 GB RAM, 21 GB swap | `/proc` |
| KVM in the kernel | `kvm` and `kvm_intel` modules **loaded** (`/sys/module/kvm_intel`, nested virtualization `Y`); `/sys/devices/virtual/misc/kvm` exists. **`/dev/kvm` is not mapped into this container**, so KVM probably works on the host and just isn't passed in | *host* |
| Docker | 27.5.1, cgroup v2 (systemd driver), `overlay2`, AppArmor and seccomp on, data root `/media/Data/docker` (the persistent data volume) | `docker info` |
| Runtimes | `runc`, `io.containerd.runc.v2`, `nvidia` only | `docker info` |
| Root filesystem, sysext, `daemon.json` location, persistence across an OS update | **not found**: the ZimaOS repository README says "built using Buildroot", OTA updates and `rauc.txt`; its pages do not say whether `/etc` or `/usr` can be changed or survive an update. FLIGHT's note (read-only root of 1.6 GB, sysext `/usr`) is not confirmed by anything I could read | docs |

## 3. How the Clean Room starts a container today, and what breaks

`prepareCleanRoom` and `buildDockerArgs` (`src/server/cleanroom.ts`, around `:167` and `:218`) build one `docker run --rm -i -t --init --user <uid>:<gid> --cap-drop ALL --security-opt no-new-privileges`, with **`--network container:<gonogo's container>`** (`GONOGO_CLEANROOM_NETWORK=container:self`, or `host`), `-v <worktree>:<worktree>`, `-v <worktree>/.git:...:ro` and `-v <agent dir>:<agent dir>`, at the same paths as on the host. The agent's hook and MCP URLs are `http://host.docker.internal:<port>` and that name maps to `127.0.0.1` in the shared network.

| Question | (a) Kata | (c) gVisor | (b) firecracker-containerd |
|---|---|---|---|
| **Is it a VM?** | yes (QEMU, cloud-hypervisor, Firecracker) | no: a user-space kernel (syscall interception); a smaller wall than a VM, bigger than runc | yes, but **archived by its owner on 2026-11-10** (docs) |
| **Needs KVM** | yes (`/dev/kvm` for the containerd/shim user; "requires nested virtualization or bare metal", docs) | no for the default `systrap` platform (docs imply it; the KVM platform is optional) | yes |
| **`--network container:<other>`** (what we do now) | **not supported**: "If a Kata Container is setup to share the network namespace of a `runc` container, the runtime effectively takes over all the network interfaces ... and binds them to the VM. Consequently, the `runc` container loses its network connectivity" (docs). **It would cut gonogo off.** | **not stated** in the pages read; must be tried | not stated |
| **`--net=host`** | not supported ("Do not use") | only as a runtime flag that "decreases the isolation" (docs) | n/a |
| **Docker socket** | the Clean Room never mounts it; not an issue | same | same |
| **Agent mounts** (worktree rw, `.git` ro, agent dir) | shared into the guest with **virtio-fs** by default; works for directories; **single-file bind mounts and the `.git` read-only overlay need testing** (not verified); virtio-fs is slower for `git status` over many files (not measured) | through a gofer (`directfs` on by default; "shared" file access): works, slower than native (docs give no number) | block devices only |
| **Firecracker specifically** | "requires a block device as the backing store ... `devmapper` snapshotter" and no mention of virtio-fs (docs): **our shared worktree mounts do not fit Firecracker** | n/a | same |
| **Egress control** | with its own network the VM gets a NAT'd interface on a Docker network: you can control egress with host firewall rules or an `internal` network; today's Clean Room has gonogo's full egress, so nothing is lost | netstack, own stack; `--network=none` possible | n/a |
| **Docker integration** | the two Kata pages **disagree**: one says "Docker supports Kata Containers since 22.06: `docker run --runtime io.containerd.kata.v2`", the other that Docker "can no longer be used" (linked issue). **Not verified; the first thing to try** | `runsc install` then `docker run --runtime=runsc` (docs); edits `daemon.json` | none stated |
| **Install size** | the static tarball for 4.4.0 (2026-11-17) is **998 MB** (amd64); contents not stated (my reading: hypervisors, guest kernel, rootfs) | one `runsc` binary plus shim (size not read) | n/a |
| **RAM per sandbox, boot time** | **not stated in anything I could read; not measured.** From general knowledge, not verified: a Kata VM boots in about a second and reserves a few hundred MB plus the guest's memory; Firecracker's README says the default is 128 MiB and 1 vCPU (docs) but gives no boot figure on the page read | not read | n/a |
| **Fits 64 GB and 8 cores?** | yes for a handful of agents | yes | n/a |

## 4. The smallest change in gonogo to pick a runtime

1. **A setting:** `GONOGO_CLEANROOM_RUNTIME` (env, like the image and network) and an optional `CleanRoom.runtime` per agent (`src/shared/protocol.ts:401`, a field next to `image`), value checked against `^[A-Za-z0-9._-]{1,64}$`; `buildDockerArgs` adds `--runtime <value>`. About 80 lines with tests. It also serves gVisor (`runsc`).
2. **Fail closed, not fall back.** "Fall back to runc" silently turns a VM into a plain container: the Director thinks the agent is walled and it is not. When a runtime is set and Docker answers "unknown runtime", the start is **refused with that message**; a deliberate `fallback: runc` is a separate explicit value that **shows a warning on the console**. (The runtime list of `docker info` will not show a shim runtime such as `io.containerd.kata.v2`, so the check is "try it and read the error", not "look in the list".)
3. **Networking for a VM** (the real work): a new network mode, `GONOGO_CLEANROOM_NETWORK=bridge:<docker network>`: the Clean Room joins a user-defined bridge instead of gonogo's namespace, and **each room child also listens on that network's address, serving only `/hook` and `/mcp`** (the "bridge listener" already named as a follow-up in `docs/single-mode-spec.md`). The agent tokens already protect those routes; the Host rule already accepts `host.docker.internal` for them. Said honestly: this widens the reach of those two routes to the bridge, which is the same reach a Clean Room has today through the shared namespace. About 250 lines plus RSO.
4. **Not changed:** the worktree, the `.git:ro` mount, the user, the capability drop. A VM adds a wall, it does not replace these.

## 5. Cost

| | Effort |
|---|---|
| Runtime setting, fail-closed check, docs | S, ~80 lines |
| Bridge network mode and the `/hook`+`/mcp` listener | M, ~250 lines + RSO review |
| Host install and tuning (Kata + `containerd-shim-kata-v2` on the daemon's PATH, devices, network) | the Director's day, unknown until section 6 |
| Compatibility work if Claude Code or `git` misbehaves in the guest | unknown; found only by trying |

## 6. What survives an OS update, and what to check before anything is installed

**Unknown from here.** ZimaOS is Buildroot with RAUC OTA updates (its README); an OTA update normally replaces the root image, so anything placed on the root filesystem or in a read-only `/usr` is lost, while the data volume (`/media/Data`, where Docker keeps its data) persists. So the **only install that probably survives is one that lives entirely under `/media/Data`** (the Kata tree and the shim) plus whatever small registration file Docker needs (its `daemon.json` or a symlink to the shim in a directory on the daemon's `PATH`): **whether those two can live on persistent storage is exactly what is unknown.**

The Director runs, on the **host** (not in a container), and sends the output; I changed nothing:
1. `ls -l /dev/kvm; lsmod | grep -E 'kvm|vhost|vsock'; id` (is `/dev/kvm` there and who may open it)
2. `mount | grep -E ' / | /etc | /usr '; ls -ld /etc /usr /usr/local/bin; cat /etc/docker/daemon.json; systemd-sysext status` (what is writable, where Docker is configured, and whether sysext exists)
3. `ps -o pid,args -C dockerd,containerd; cat /proc/$(pidof containerd | cut -d' ' -f1)/environ | tr '\\0' '\\n' | grep ^PATH` (which PATH the shim must be on)

## 7. Plan, with a go/no-go at each step

0. Ship the runtime setting (S) so the experiment is one env var. **Go** always.
1. Host check above. **No-go for Kata** if `/dev/kvm` is missing, or neither a writable persistent `PATH` entry nor a `daemon.json` can be had; then try gVisor.
2. By hand, reversible (files under `/media/Data` and one config line): install Kata, `docker run --rm --runtime io.containerd.kata.v2 alpine uname -r` (the kernel string must differ from the host's). **No-go** if Docker cannot drive it.
3. Mount a worktree (with `.git:ro`) and run `git status`, `node` and `claude --version` in the guest; compare `git status` time with runc on a large repo. **No-go** on a clear regression or a mount that does not work.
4. Build the bridge mode and listener (RSO reviews), then one real Clean Room agent end to end.
5. Only then document it as supported, with the not-verified list.

If step 1 or 2 fails: **gVisor** needs no KVM, installs by `runsc install`, and whether `--network container:` works is a one-minute test. It is a weaker wall (not a VM) and the Director should hear that before choosing it.

**Cheap hardening available today with runc, if no VM comes:** `--read-only` root with a `tmpfs` for `/tmp`, `--pids-limit`, `--memory`, and Docker's user-namespace remapping. None of these is a VM.
