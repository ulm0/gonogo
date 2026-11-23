/**
 * The findings behind the banner of an insecure setup (docs/reference/security.md, "The banner"): what the Director should look at, computed from what the
 * supervisor already knows (the login, the bind address, the allowed names, the keys, the agents of the rooms, the Docker socket) and from the request that asks.
 * exposureProblem stays the gate at the start; this is the list for what changes later or cannot be known at the start. A finding carries names, hosts and counts,
 * never a secret. A dismissed finding stays hidden for good; its id is a hash of its kind and its subject (a host, a key, an agent), so a NEW host, key or agent shows again.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hostClass } from './auth.js';
import { hostIpRange } from './hosts.js';

export const EXPOSURE_DISMISSED_FILE = 'exposure-dismissed.json';
const DISMISSED_MAX = 50;
const DAY_MS = 24 * 3600_000;
/** Modes in which an agent works without asking the Director. */
const UNATTENDED_MODES = new Set(['auto', 'bypassPermissions']);

export interface Finding {
  id: string;
  /** What kind of finding: the id without its subject. */
  kind: string;
  severity: 'high' | 'medium' | 'info';
  text: string;
  fix: string;
}

export interface FindingsInput {
  /** `account` once the login is set up. */
  account: string;
  /** When the account was set up (0 when there never was one): a new account or a reset is a new situation for `no-login`. */
  accountEpoch: number;
  mfa: boolean;
  bindHost: string;
  inContainer: boolean;
  /** The names (and addresses) of --allow-host, pages and hooks. */
  pages: readonly string[];
  hooks: readonly string[];
  /** The Host this very request came to, and whether it came over https (or through a trusted proxy that says so). */
  requestHost: string | undefined;
  requestHttps: boolean;
  dockerSocketMounted: boolean;
  /** The addresses --trusted-proxy believes. */
  trustedProxies: readonly string[];
  /** The API keys: names and times, never the secret. */
  keys: ReadonlyArray<{ id: string; name: string; scope: string; remote: boolean; created: number; expires: number }>;
  now: number;
  /** The agents of the running rooms. */
  agents: ReadonlyArray<{ room: string; name: string; mode: string; cleanRoom: boolean }>;
  /** Rooms whose project folder is or holds gonogo's home. */
  folders: ReadonlyArray<{ room: string }>;
  updateChecksOff: boolean;
  /** The running version, and the newest release the daily check saw when it is newer. */
  behind: { running: string; latest: string } | null;
}

const LOOPBACK_BIND = ['127.0.0.1', '::1', 'localhost'];

/** The id of a finding: its kind and a hash of its subject (kind alone when it has none). */
export const findingId = (kind: string, subject = ''): string => (subject === '' ? kind : `${kind}-${createHash('sha256').update(`${kind}\0${subject}`).digest('hex').slice(0, 12)}`);

/** A trusted proxy is one host the Director runs: a public address, or a range, makes every client address believable. */
const proxyTooWide = (entry: string): boolean => entry.includes('/') || entry.includes('*') || hostIpRange(entry) === 'public' || hostIpRange(entry) === null;

export function findingsOf(input: FindingsInput): Finding[] {
  const found: Finding[] = [];
  const add = (kind: string, severity: Finding['severity'], text: string, fix: string, subject = ''): void => void found.push({ id: findingId(kind, subject), kind, severity, text, fix });
  const hasLogin = input.account === 'account';
  const reachedBeyondLoopback = input.requestHost !== undefined && hostClass(input.requestHost) !== 'loopback';
  const beyond = (!input.inContainer && !LOOPBACK_BIND.includes(input.bindHost)) || input.pages.some((name) => hostClass(name) !== 'loopback') || reachedBeyondLoopback;
  if (!hasLogin && beyond) {
    add('no-login', 'high', 'Anyone who can reach this address can open gonogo: there is no login yet.', 'Set up the login: open gonogo from this machine or your local network and choose a name and a password.', String(input.accountEpoch));
  }
  if (reachedBeyondLoopback && !input.requestHttps) {
    add('plain-http', 'medium', 'You are on plain http: the password and the token travel in the clear on this network.', 'On a network you trust that is acceptable. For anything wider, use a name with https (see Exposing gonogo safely).', input.requestHost ?? '');
  }
  for (const address of [...new Set([...input.pages, ...input.hooks].filter((name) => hostIpRange(name) === 'public'))]) {
    add('public-ip-listed', 'high', `gonogo answers to the public address ${address}: its page is served from the internet by address, without https.`, `Remove --allow-host ${address} (GONOGO_ALLOWED_HOSTS), or put a name with https in front of it.`, address);
  }
  const publicName = input.pages.find((name) => hostIpRange(name) === null && hostClass(name) === 'public');
  if (publicName !== undefined && hasLogin && !input.mfa) {
    add('public-name-no-mfa', 'high', `${publicName} is a public address and the login has no second factor.`, 'Turn on the second factor (TOTP) in Flight Rules, LOGIN.', publicName);
  }
  for (const entry of input.trustedProxies.filter(proxyTooWide)) {
    add('trusted-proxy-wide', 'high', `${entry} is trusted to say who a visitor is, and it is a public address or a range wider than one host: anybody there can pretend to be anyone.`, 'Name only the one host of your own proxy in --trusted-proxy.', entry);
  }
  for (const agent of input.agents.filter((a) => UNATTENDED_MODES.has(a.mode) && !a.cleanRoom)) {
    add('agent-unattended', 'medium', `${agent.name} (room ${agent.room}) works without asking (${agent.mode}) outside a Clean Room: it can change anything its user can.`, `Put ${agent.name} in a Clean Room, or set its mode to ask first.`, `${agent.room}/${agent.name}`);
  }
  for (const folder of input.folders) {
    add('folder-holds-home', 'medium', `The project folder of room ${folder.room} is or holds gonogo's own folder: its agents can read and change gonogo's settings and keys without asking.`, 'Choose your project folder in Flight Rules, Room, Project folder.', folder.room);
  }
  for (const key of input.keys.filter((k) => k.remote && k.scope === 'full' && (input.now - k.created > 90 * DAY_MS || k.expires - k.created > 366 * DAY_MS))) {
    add('old-remote-key', 'medium', `The API key "${key.name}" can do everything, works from other computers, and ${input.now - key.created > 90 * DAY_MS ? 'is more than 90 days old' : 'never expires for practical purposes'}.`, `Make a new key with a shorter life and remove "${key.name}" (Flight Rules, LOGIN).`, key.id);
  }
  if (input.updateChecksOff) add('update-checks-off', 'info', 'gonogo does not check for new versions: it will not tell you about a fix.', 'Remove GONOGO_UPDATE_CHECK=0 (or turn it on in the runtime settings).');
  else if (input.behind !== null) add('version-behind', 'info', `gonogo ${input.behind.running} is running and ${input.behind.latest} is out.`, 'Update from the Update key or your install method.', input.behind.latest);
  if (input.dockerSocketMounted) {
    add('docker-socket', 'info', 'The agents can reach the Docker socket too, which is root on this host; the Update key and Clean Room need it.', 'If you use neither, remove the mount from compose.yaml.');
  }
  return found;
}

/** The ids the Director dismissed, in `<root>/exposure-dismissed.json` (0600). Whatever is not a short list of short strings is ignored: a hostile file dismisses nothing. */
export function readDismissed(root: string): string[] {
  try {
    const ids = (JSON.parse(readFileSync(join(root, EXPOSURE_DISMISSED_FILE), 'utf8')) as { ids?: unknown }).ids;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && /^[a-z0-9-]{1,40}$/.test(id)).slice(-DISMISSED_MAX) : [];
  } catch {
    return [];
  }
}

/** Adds an id; at DISMISSED_MAX the OLDEST goes. */
export function dismiss(root: string, id: string): void {
  const ids = [...new Set([...readDismissed(root), id])].slice(-DISMISSED_MAX);
  const path = join(root, EXPOSURE_DISMISSED_FILE);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ version: 1, ids })}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temp, path);
}
