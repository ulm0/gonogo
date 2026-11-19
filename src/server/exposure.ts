/**
 * Exposure rules (docs/expose-spec.md): what must be true before gonogo answers on a name that is not this machine's. Pure: the supervisor asks
 * at start and refuses to start with one message that says what to do first. A name is public or private only by the Director's own flags and
 * by the shape of the name (`hostClass`), never by what it resolves to or by anything a request says.
 */
import { hostClass } from './auth.js';
import type { AccountState } from './auth.js';
import { normalizeHost } from './hosts.js';

/** `--public-url`: where the page is for people outside. An origin only (no path, query, credentials); null when it is not one. */
export function parsePublicUrl(text: string): { origin: string; host: string } | string {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return `--public-url "${text.trim().slice(0, 80)}" is not a URL (use https://gonogo.example.com)`;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return '--public-url must start with https:// (or http:// for a private name)';
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || !['', '/'].includes(url.pathname)) return '--public-url is an address only: no path, query, fragment or password';
  const host = normalizeHost(url.host);
  if (host === null) return '--public-url has no usable host name';
  return { origin: url.origin, host };
}

export interface ExposureInput {
  /** Page hosts and hooks hosts, normalized. */
  pages: readonly string[];
  hooks: readonly string[];
  /** The address gonogo listens on (`--host`). */
  bindHost: string;
  inContainer: boolean;
  publicUrl: { origin: string; host: string } | null;
  account: AccountState;
  mfa: boolean;
}

const LOOPBACK_BIND = ['127.0.0.1', '::1', 'localhost'];
const FIRST = 'Set the login up first: open gonogo from this machine (http://127.0.0.1:7777/) or your local network, make the account, and turn on the second factor (Flight Rules, LOGIN). Then start again with this option.';

/** The first reason gonogo must not start with these settings, or null. */
export function exposureProblem(input: ExposureInput): string | null {
  const publicPages = input.pages.filter((name) => hostClass(name) === 'public');
  for (const name of [...input.pages, ...input.hooks]) {
    if (hostClass(name) === 'loopback' && input.hooks.includes(name)) return `${name} is this machine: a hooks-only host must be a name other machines use`;
  }
  if (publicPages.length > 0) {
    if (input.account !== 'account') return `${publicPages[0]} is a public page address, but the login is not set up. ${FIRST}`;
    if (!input.mfa) return `${publicPages[0]} is a public page address, and a public login needs the second factor (TOTP), which is not on. ${FIRST}`;
    if (input.publicUrl === null || !input.publicUrl.origin.startsWith('https://')) return `${publicPages[0]} is a public page address: give its https address with --public-url https://${publicPages[0]} (gonogo does not guess from headers whether TLS happened).`;
  }
  if (input.publicUrl !== null) {
    if (hostClass(input.publicUrl.host) === 'public' && !input.publicUrl.origin.startsWith('https://')) return `--public-url ${input.publicUrl.origin} is a public name and must be https://`;
    if (hostClass(input.publicUrl.host) !== 'loopback' && !input.pages.includes(input.publicUrl.host) && !input.hooks.includes(input.publicUrl.host)) {
      return `--public-url names ${input.publicUrl.host}, which is not an allowed host: add --allow-host ${input.publicUrl.host} (or ${input.publicUrl.host}:hooks for a host that serves only the webhooks)`;
    }
  }
  // a bind that other machines can reach, outside a container (where the wildcard bind is normal), needs the login
  if (!input.inContainer && !LOOPBACK_BIND.includes(input.bindHost) && input.account !== 'account') {
    return `gonogo would listen on ${input.bindHost}, which other machines can reach, and the login is not set up. ${FIRST}`;
  }
  return null;
}
