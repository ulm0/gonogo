/**
 * The findings behind the banner of an insecure setup (docs/reference/security.md, "The banner"): what the Director should look at, computed from what the supervisor
 * already knows (the login, the bind address, the allowed names, the Docker socket) and from the request that asks. exposureProblem stays the gate at the start;
 * this is the list for what changes later or cannot be known at the start. A finding the Director dismissed stays hidden for good; a NEW id shows again.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { hostClass } from './auth.js';
import { hostIpRange } from './hosts.js';

export const EXPOSURE_DISMISSED_FILE = 'exposure-dismissed.json';
const DISMISSED_MAX = 50;

export interface Finding {
  id: string;
  severity: 'high' | 'medium' | 'info';
  text: string;
  fix: string;
}

export interface FindingsInput {
  /** `account` once the login is set up. */
  account: string;
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
}

const LOOPBACK_BIND = ['127.0.0.1', '::1', 'localhost'];

export function findingsOf(input: FindingsInput): Finding[] {
  const found: Finding[] = [];
  const hasLogin = input.account === 'account';
  const reachedBeyondLoopback = input.requestHost !== undefined && hostClass(input.requestHost) !== 'loopback';
  const beyond = (!input.inContainer && !LOOPBACK_BIND.includes(input.bindHost)) || input.pages.some((name) => hostClass(name) !== 'loopback') || reachedBeyondLoopback;
  if (!hasLogin && beyond) {
    found.push({ id: 'no-login', severity: 'high', text: 'Anyone who can reach this address can open gonogo: there is no login yet.', fix: 'Set up the login: open gonogo from this machine or your local network and choose a name and a password.' });
  }
  if (reachedBeyondLoopback && !input.requestHttps) {
    found.push({ id: 'plain-http', severity: 'medium', text: 'You are on plain http: the password and the token travel in the clear on this network.', fix: 'On a network you trust that is acceptable. For anything wider, use a name with https (see Exposing gonogo safely).' });
  }
  const publicIps = [...input.pages, ...input.hooks].filter((name) => hostIpRange(name) === 'public');
  if (publicIps.length > 0) {
    found.push({ id: 'public-ip-listed', severity: 'high', text: `gonogo answers to the public address ${publicIps[0]}: its page is served from the internet by address, without https.`, fix: `Remove --allow-host ${publicIps[0]} (GONOGO_ALLOWED_HOSTS), or put a name with https in front of it.` });
  }
  const publicName = input.pages.find((name) => hostIpRange(name) === null && hostClass(name) === 'public');
  if (publicName !== undefined && hasLogin && !input.mfa) {
    found.push({ id: 'public-name-no-mfa', severity: 'high', text: `${publicName} is a public address and the login has no second factor.`, fix: 'Turn on the second factor (TOTP) in Flight Rules, LOGIN.' });
  }
  if (input.dockerSocketMounted) {
    found.push({ id: 'docker-socket', severity: 'info', text: 'The Docker socket is mounted: gonogo can control every container on this computer (root over the host).', fix: 'Mount it only if you use the Update key; remove the line from compose.yaml otherwise.' });
  }
  return found;
}

/** The ids the Director dismissed, in `<root>/exposure-dismissed.json` (0600). Whatever is not a short list of short strings is ignored. */
export function readDismissed(root: string): string[] {
  try {
    const ids = (JSON.parse(readFileSync(join(root, EXPOSURE_DISMISSED_FILE), 'utf8')) as { ids?: unknown }).ids;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && /^[a-z0-9-]{1,40}$/.test(id)).slice(0, DISMISSED_MAX) : [];
  } catch {
    return [];
  }
}

export function dismiss(root: string, id: string): void {
  const ids = [...new Set([...readDismissed(root), id])].slice(-DISMISSED_MAX);
  const path = join(root, EXPOSURE_DISMISSED_FILE);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ version: 1, ids })}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temp, path);
}
