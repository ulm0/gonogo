// Stand-in for `docker` (Clean Room). `docker version` answers like a working daemon, or like a stopped one when
// FAKE_DOCKER_FAIL is set. `docker rm -f <name>` only appends {verb: 'rm', argv} to FAKE_DOCKER_LOG. `docker run` reads its arguments the way docker does, appends what it saw to the file named by
// FAKE_DOCKER_LOG (one JSON object per line) and runs the entrypoint with its arguments on this machine with only what a container would
// have: the variables named with -e, HOME, and the stand-in's own FAKE_* switches. There is no container, no image and no
// network: the agent that runs under it is test/fake-claude.mjs, told by FAKE_CLAUDE_BEHIND_DOCKER to reach the hub
// at host.docker.internal. It proves the arguments and what the launcher wrote, never what Docker does with them.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// `create` keeps what `run` would have done, by container name, in FAKE_DOCKER_STATE (default: next to the log); `inspect --format {{.HostConfig.Runtime}}` answers with the runtime that was
// asked for, or with FAKE_DOCKER_RUNTIME_ACTUAL when that is set (what a daemon that chose another runtime would say); `start -a -i <name>` then does the run.
const stateDir = process.env.FAKE_DOCKER_STATE ?? process.env.FAKE_DOCKER_LOG_DIR ?? '/tmp';
const stateFile = (name) => join(stateDir, `fake-docker-${name}.json`);
let [verb, ...args] = process.argv.slice(2);
let creating = false;
if (verb === 'create') {
  creating = true;
  verb = 'run';
} else if (verb === 'start') {
  const name = args.at(-1);
  let stored;
  try {
    stored = JSON.parse(readFileSync(stateFile(name), 'utf8'));
  } catch {
    process.stderr.write(`Error response from daemon: No such container: ${String(name)}\n`);
    process.exit(1);
  }
  for (const [key, value] of Object.entries(stored.env)) process.env[key] = value;
  args = stored.argv;
  verb = 'run';
}

if (verb === 'version') {
  if (process.env.FAKE_DOCKER_FAIL) {
    process.stderr.write('Cannot connect to the Docker daemon at unix:///fake/docker.sock. Is the docker daemon running?\n');
    process.exit(1);
  }
  process.stdout.write('Client:\n Version: fake\n');
  process.exit(0);
}
// `docker info --format '{{json .Runtimes}}'`: the runtimes of FAKE_DOCKER_RUNTIMES (names, comma separated; default runc), or a stopped daemon
if (verb === 'info') {
  if (process.env.FAKE_DOCKER_FAIL) {
    process.stderr.write('Cannot connect to the Docker daemon at unix:///fake/docker.sock. Is the docker daemon running?\n');
    process.exit(1);
  }
  const names = (process.env.FAKE_DOCKER_RUNTIMES ?? 'runc,io.containerd.runc.v2').split(',').filter(Boolean);
  process.stdout.write(`${JSON.stringify(Object.fromEntries(names.map((n) => [n, { path: n }])))}\n`);
  process.exit(0);
}
if (verb === 'inspect' && (args[args.indexOf('--format') + 1] ?? '') === '{{.HostConfig.Runtime}}') {
  try {
    const stored = JSON.parse(readFileSync(stateFile(args.at(-1)), 'utf8'));
    process.stdout.write(`${process.env.FAKE_DOCKER_RUNTIME_ACTUAL ?? stored.runtime ?? 'runc'}\n`);
    process.exit(0);
  } catch {
    process.stderr.write(`Error: No such object: ${String(args.at(-1))}\n`);
    process.exit(1);
  }
}
if (verb === 'rm') {
  rmSync(stateFile(args.at(-1)), { force: true });
  if (process.env.FAKE_DOCKER_LOG) appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify({ verb, argv: args }) + '\n');
  process.exit(0);
}
// `docker inspect --format <f> <name>` for gonogo's own container, only when FAKE_DOCKER_INSPECT_MOUNTS (the JSON of .Mounts) is set
if (verb === 'inspect' && process.env.FAKE_DOCKER_INSPECT_MOUNTS !== undefined) {
  const format = args[args.indexOf('--format') + 1] ?? '';
  process.stdout.write(format.includes('NetworkMode') ? `${process.env.FAKE_DOCKER_ID ?? ''} ${process.env.FAKE_DOCKER_NETMODE ?? 'bridge'}\n` : `${process.env.FAKE_DOCKER_INSPECT_MOUNTS}\n`);
  process.exit(0);
}
if (verb !== 'run') {
  process.stderr.write(`fake-docker: unknown command ${String(verb)}\n`);
  process.exit(125);
}

const refuse = (message) => {
  process.stderr.write(`fake-docker: ${message}\n`);
  process.exit(125);
};

const seen = { verb, runtime: null, flags: [], name: null, user: null, capDrop: [], securityOpt: [], addHost: null, env: [], volumes: [], workdir: null, entrypoint: null, image: null, args: [] };
const BOOLEAN = new Set(['--rm', '-i', '-t', '--init']);
let i = 0;
for (; i < args.length; i += 1) {
  const arg = args[i];
  if (BOOLEAN.has(arg)) {
    seen.flags.push(arg);
    continue;
  }
  if (!['--runtime', '--name', '--user', '--cap-drop', '--security-opt', '--add-host', '--entrypoint', '-e', '-v', '-w'].includes(arg)) break;
  const value = args[(i += 1)];
  if (value === undefined) refuse(`${arg} needs a value`);
  if (arg === '--runtime') {
    seen.runtime = value;
    // docker's own answer for a runtime it does not have: the start is refused, never run by runc
    if (!(process.env.FAKE_DOCKER_RUNTIMES ?? 'runc,io.containerd.runc.v2').split(',').includes(value)) refuse(`Error response from daemon: unknown or invalid runtime name: ${value}`);
  } else if (arg === '--name') seen.name = value;
  else if (arg === '--user') seen.user = value;
  else if (arg === '--cap-drop') seen.capDrop.push(value);
  else if (arg === '--security-opt') seen.securityOpt.push(value);
  else if (arg === '--add-host') seen.addHost = value;
  else if (arg === '-e') seen.env.push(value);
  else if (arg === '-v') seen.volumes.push(value);
  else if (arg === '--entrypoint') seen.entrypoint = value;
  else seen.workdir = value;
}
seen.image = args[i] ?? null;
seen.args = args.slice(i + 1);
if (seen.image === null || seen.image.startsWith('-')) refuse(`no image, or an option docker does not know: ${String(seen.image)}`);
if (seen.entrypoint === null) refuse('no --entrypoint: the image would run its own entrypoint, which is gonogo');

for (const volume of seen.volumes) {
  const [from, to, extra, more] = volume.split(':');
  if ((extra !== undefined && extra !== 'ro') || more !== undefined || from !== to || !statSync(from, { throwIfNoEntry: false })) refuse(`bad mount ${volume}`);
}
if (seen.workdir === null || !statSync(seen.workdir, { throwIfNoEntry: false })?.isDirectory()) refuse(`bad workdir ${String(seen.workdir)}`);

// -e NAME takes the value from docker's own environment; -e NAME=value is literal.
const env = { PATH: process.env.PATH, FAKE_CLAUDE_BEHIND_DOCKER: '1' };
for (const [key, value] of Object.entries(process.env)) if (key.startsWith('FAKE_CLAUDE_') && value !== undefined) env[key] = value;
for (const entry of seen.env) {
  const at = entry.indexOf('=');
  if (at === -1) {
    if (process.env[entry] !== undefined) env[entry] = process.env[entry];
  } else env[entry.slice(0, at)] = entry.slice(at + 1);
}
if (creating) {
  mkdirSync(stateDir, { recursive: true });
  const names = Object.fromEntries(seen.env.filter((e) => !e.includes('=')).map((e) => [e, process.env[e]]).filter(([, v]) => v !== undefined));
  writeFileSync(stateFile(seen.name), JSON.stringify({ argv: args, runtime: seen.runtime, env: names }));
  if (process.env.FAKE_DOCKER_LOG) appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify({ verb: 'create', argv: args, runtime: seen.runtime }) + '\n');
  process.stdout.write(`${seen.name}\n`);
  process.exit(0);
}
if (process.env.FAKE_DOCKER_LOG) {
  // what the container would have been given, by name: a test checks that no secret is in `argv`
  appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify({ argv: args, ...seen, uid: process.getuid?.(), childEnvNames: Object.keys(env) }) + '\n');
}

const child = spawn(seen.entrypoint, seen.args, { cwd: seen.workdir, env, stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', (error) => refuse(`could not run ${seen.entrypoint}: ${error.message}`));
child.on('exit', (code, signal) => process.exit(code ?? (signal === 'SIGKILL' ? 137 : 143)));
