/**
 * The body of a 403 for a Host name gonogo does not answer to. Programs (the docking check, tests, scripts) get exactly `forbidden host`;
 * a browser (it asks for text/html) also gets what to set, because on a fresh install this is the first thing it sees.
 */
export function forbiddenHostText(host: string | undefined, accept: string | undefined): string {
  if (accept === undefined || !accept.includes('text/html')) return 'forbidden host';
  // the name as the browser typed it, reduced to what a host name holds: it is printed back
  const name = (host ?? '').replace(/:\d+$/, '').replace(/[^A-Za-z0-9.:[\]-]/g, '').slice(0, 100);
  const shown = name === '' ? 'this-name' : name;
  return [
    'forbidden host',
    '',
    `gonogo does not answer to the name "${shown}". Allow it: set GONOGO_ALLOWED_HOSTS=${shown} (several names: a comma list), or start gonogo with --allow-host ${shown}.`,
    `With Docker Compose: put GONOGO_ALLOWED_HOSTS=${shown} in the .env next to compose.yaml, then run: docker compose up -d`,
    'To publish gonogo on the internet, read "Exposing it safely" first: a public name needs the login account and a second factor.',
  ].join('\n');
}
