import { isIP } from 'node:net';

/**
 * The one place a Host is read (docs/expose-spec.md R10). Every check that asks "which name is this?" (the allow-lists, the proxy, the
 * login's class, the hooks-only hosts) goes through `normalizeHost`, and every match is an exact match on its result, so no two checks can
 * disagree about the same header.
 */

/**
 * A Host header (or an allow-list entry) as one lower-case name: the port, the brackets of an IPv6 address and a single trailing dot are gone.
 * null when it is not host[:port] or the name has a character no host name has (a space, a slash, an at sign): such a Host matches nothing.
 */
export function normalizeHost(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (v === '') return null;
  if (v.startsWith('[')) {
    const end = v.indexOf(']');
    if (end < 2) return null;
    const rest = v.slice(end + 1);
    return (rest === '' || /^:\d{1,5}$/.test(rest)) && /^[0-9a-f:.]+$/.test(v.slice(1, end)) ? v.slice(1, end) : null;
  }
  const colon = v.indexOf(':');
  let name = v;
  if (colon !== -1) {
    // an IPv6 address without brackets cannot carry a port, so it is not a valid Host value
    if (v.indexOf(':', colon + 1) !== -1 || !/^\d{1,5}$/.test(v.slice(colon + 1))) return null;
    name = v.slice(0, colon);
  }
  if (name.endsWith('.')) name = name.slice(0, -1);
  // one trailing dot is the same name; an empty label (a leading dot, `..`, a second trailing dot) is no name
  return name !== '' && /^[a-z0-9._-]+$/.test(name) && !name.startsWith('.') && !name.endsWith('.') && !name.includes('..') ? name : null;
}

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`);

/** The range of a dotted IPv4 address: four decimals, 0 to 255, no leading zero (so `017.0.0.1`, `127.1`, `0x7f.0.0.1` and `2130706433` are not addresses here). */
function v4Range(address: string): 'loopback' | 'private' | 'public' | null {
  if (!IPV4.test(address)) return null;
  const [a = 0, b = 0] = address.split('.').map(Number);
  if (a === 127) return 'loopback';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)) return 'private';
  return 'public';
}

/**
 * What a Host is when it is an IP LITERAL (an address, not a name): its range, or null when it is a name or no clean address. IPv6 only in brackets, with no zone id
 * (net.isIP 6); `::ffff:a.b.c.d` is the range of the IPv4 inside. `0.0.0.0` is public here: a page of another site can reach a local gonogo with it.
 */
export function hostIpRange(header: string | undefined): 'loopback' | 'private' | 'public' | null {
  const name = header === undefined ? null : normalizeHost(header);
  if (name === null) return null;
  if (!name.includes(':')) return v4Range(name);
  // normalizeHost only lets a bracketed address through to here, and never a zone id (a %)
  if (isIP(name) !== 6) return null;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(name);
  if (mapped !== null) return v4Range(mapped[1] as string);
  if (name === '::1') return 'loopback';
  return /^f[cd]/.test(name) || /^fe[89ab]/.test(name) ? 'private' : 'public';
}

/**
 * Whether the front port answers to this Host with nothing configured: localhost is handled by the callers, and here an IP address of the computer's own or of its network
 * (loopback, private, link-local, CGNAT such as Tailscale). A PUBLIC address, like a name, must be listed: gonogo must not serve its page from the internet by IP on a
 * `docker compose up`. A browser sends an IP address as the Host only to somebody who went to that address, so a page of another site cannot ride on it (DNS rebinding needs a name).
 */
export function isIpLiteralHost(header: string | undefined): boolean {
  const range = hostIpRange(header);
  return range === 'loopback' || range === 'private';
}

/** The 403 of a Host the front port does not answer to. Starts with the two words older tools look for; names what to do, and echoes only a normalised name (the header is the sender's). */
export function forbiddenHostText(header: string | undefined): string {
  const name = header === undefined ? null : normalizeHost(header);
  const shown = name === null ? 'that name' : name.slice(0, 80);
  const flag = name === null ? '<name>' : shown;
  if (hostIpRange(header) === 'public') return `forbidden host: gonogo does not answer to ${shown}, a public address. Add it with --allow-host ${flag} (or GONOGO_ALLOWED_HOSTS=${flag}), and set up the login first.`;
  return `forbidden host: gonogo does not answer to ${shown}. Open it by its IP address on your network, or allow the name with --allow-host ${flag} (or GONOGO_ALLOWED_HOSTS=${flag}).`;
}

export interface AllowedHosts {
  /** Hosts that serve the page (and everything else). */
  pages: Set<string>;
  /** Hosts that serve only /uplink/* and /dock/* (`name:hooks`): the page never exists there. */
  hooks: Set<string>;
}

/** `--allow-host name` is a page host, `--allow-host name:hooks` a hooks host; a name in both is a page host. An entry that is no host name is an error. */
export function splitAllowed(entries: readonly string[]): AllowedHosts | string {
  const out: AllowedHosts = { pages: new Set(), hooks: new Set() };
  for (const raw of entries) {
    const entry = raw.trim();
    const isHooks = /:hooks$/i.test(entry);
    const name = normalizeHost(isHooks ? entry.slice(0, -':hooks'.length) : entry);
    if (name === null) return `"${entry.slice(0, 80)}" is not a host name (use gonogo.example.com, or gonogo.example.com:hooks for a host that serves only the webhooks)`;
    (isHooks ? out.hooks : out.pages).add(name);
  }
  for (const name of out.pages) out.hooks.delete(name);
  return out;
}
