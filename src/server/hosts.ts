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

/** Whether `header` names an IP address (dotted IPv4, or an IPv6 in brackets), not a name: a browser sends one only to somebody who went to that address, so no page of another site can put it in a Host (DNS rebinding needs a name). */
export function isIpLiteralHost(header: string | undefined): boolean {
  const name = header === undefined ? null : normalizeHost(header);
  return name !== null && isIP(name) !== 0;
}

/** The 403 of a Host the front port does not answer to. Starts with the two words older tools look for; names what to do, and echoes only a normalised name (the header is the sender's). */
export function forbiddenHostText(header: string | undefined): string {
  const name = header === undefined ? null : normalizeHost(header);
  const shown = name === null ? 'that name' : name.slice(0, 80);
  return `forbidden host: gonogo does not answer to ${shown}. Open it by its IP address, or allow the name with --allow-host ${name === null ? '<name>' : shown} (or GONOGO_ALLOWED_HOSTS=${name === null ? '<name>' : shown}).`;
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
