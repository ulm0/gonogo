/**
 * The body of a 403 for a Host name gonogo does not answer to. Programs (the docking check, tests, scripts) get exactly `forbidden host`;
 * a browser (it asks for text/html) also gets what to set, because on a fresh install this is the first thing it sees.
 */
import { hostIpRange } from './hosts.js';

export function forbiddenHostText(host: string | undefined, accept: string | undefined): string {
  if (accept === undefined || !accept.includes('text/html')) return 'forbidden host';
  // the name as the browser typed it, reduced to what a host name holds: it is printed back
  const name = (host ?? '').replace(/:\d+$/, '').replace(/[^A-Za-z0-9.:[\]-]/g, '').slice(0, 100);
  const shown = name === '' ? 'this-name' : name;
  // a PUBLIC IP address is a name that must be listed, with the login set up first; the addresses of a network (private, link-local, CGNAT) need no listing
  if (hostIpRange(host) === 'public') {
    return ['forbidden host', '', `gonogo does not answer to the public address ${shown}. Add it: set GONOGO_ALLOWED_HOSTS=${shown}, or start gonogo with --allow-host ${shown}, and set up the login first.`, 'An address of your own network (192.168.x.x, 10.x.x.x, 172.16-31.x.x, 100.64-127.x.x) needs no setting: open gonogo by that.'].join('\n');
  }
  return [
    'forbidden host',
    '',
    `gonogo does not answer to the name "${shown}". Allow it: set GONOGO_ALLOWED_HOSTS=${shown} (several names: a comma list), or start gonogo with --allow-host ${shown}.`,
    `With Docker Compose: put GONOGO_ALLOWED_HOSTS=${shown} in the .env next to compose.yaml, then run: docker compose up -d`,
    'To publish gonogo on the internet, read "Exposing it safely" first: a public name needs the login account and a second factor.',
  ].join('\n');
}
