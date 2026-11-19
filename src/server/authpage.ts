/**
 * The login, setup and "not set up" pages of the supervisor (docs/login-spec.md). Plain forms posted to `/api/auth/...`: no script at all, so the
 * page needs no inline-script exception and works with the strictest CSP. Dressed with the built client's stylesheet when there is one.
 */
import { createHash } from 'node:crypto';

const STYLE = `
body{margin:0;background:var(--body,#e4e2dc);color:var(--text,#1b1b1a);font:15px/1.4 var(--font-ui,system-ui,sans-serif)}
.lg-main{max-width:460px;margin:8vh auto 0;padding:0 16px;display:grid;gap:12px}
.lg-form{display:grid;gap:12px;padding:16px}
.lg-form label{display:grid;gap:4px}
.lg-form p{margin:0}
.lg-warn{padding:10px 12px;margin:0}
.lg-main h1{margin:0}
@media (prefers-color-scheme:dark){body{background:var(--body,#16171a);color:var(--text,#e8e6e1)}}
`;

const hash = (text: string): string => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
const esc = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The same strict policy as the room pages (docs/login-spec.md, threat model 3): nothing but the page's own files, no script, no frame. */
export const authPageHeaders = (): Record<string, string> => ({
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': `default-src 'none'; style-src 'self' ${hash(STYLE)}; font-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
});

export type AuthPageKind = 'login' | 'setup' | 'unset' | 'damaged' | 'locked' | 'second';

export interface AuthPageInput {
  kind: AuthPageKind;
  stylesheet: string | null;
  /** What went wrong, in words the Director can act on; never the reason a login failed beyond "wrong name or password". */
  message?: string;
  user?: string;
  /** The single-use token of a login that waits for its second factor. */
  pending?: string;
  /** Whether the connection is plain http to a private name (the page says so: a LAN sniffer sees the password). */
  plain?: boolean;
}

const LOCAL_NOTE = 'Opened over plain http: on a shared network anyone listening can read the password and the session. Use this address only on a network you trust, or put https in front of it.';

export function authPage(input: AuthPageInput): string {
  const head =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>gonogo</title>` +
    `${input.stylesheet === null ? '' : `<link rel="stylesheet" href="/rooms/assets/${esc(input.stylesheet)}">`}<style>${STYLE}</style></head><body><main class="lg-main">` +
    `<h1 class="mark"><img class="mark-name" src="/rooms/lockup.svg" alt="gonogo" height="28"></h1>`;
  const tail = `</main></body></html>`;
  const error = input.message === undefined ? '' : `<p class="error lg-warn" role="alert">${esc(input.message)}</p>`;
  const plain = input.plain === true ? `<p class="hint">${esc(LOCAL_NOTE)}</p>` : '';
  if (input.kind === 'unset') {
    return `${head}<section class="module lg-form"><h2 class="label">LOGIN IS NOT SET UP</h2><p>Open gonogo from this machine or from your local network to create the account. It is not offered on a public address.</p>${error}</section>${tail}`;
  }
  if (input.kind === 'damaged') {
    return `${head}<section class="module lg-form"><h2 class="label">THE ACCOUNT FILE IS DAMAGED</h2><p>Page logins are refused until it is made again. On the machine gonogo runs on, run <code>gonogo auth reset</code>, then set the account up again.</p>${error}</section>${tail}`;
  }
  if (input.kind === 'locked') {
    return `${head}<section class="module lg-form"><h2 class="label">REMOTE LOGINS ARE PAUSED</h2><p>gonogo saw its account file change outside gonogo. Remote logins stay refused until the Director confirms on the machine gonogo runs on (the account block in Flight Rules, or <code>gonogo auth confirm</code>).</p>${error}</section>${tail}`;
  }
  if (input.kind === 'second') {
    return (
      `${head}<form class="module lg-form" method="post" action="/api/auth/second" autocomplete="off"><h2 class="label">SECOND FACTOR</h2>` +
      `<p>Give the six-digit code of your authenticator, or one of your recovery codes.</p>` +
      `<input type="hidden" name="pending" value="${esc(input.pending ?? '')}">` +
      `<label><span class="label">CODE</span><input class="input" name="code" inputmode="text" autocomplete="one-time-code" required maxlength="20" autofocus spellcheck="false"></label>` +
      `${error}${plain}<button class="btn" data-kind="primary" type="submit">CONTINUE</button></form>${tail}`
    );
  }
  if (input.kind === 'setup') {
    return (
      `${head}<form class="module lg-form" method="post" action="/api/auth/setup" autocomplete="on"><h2 class="label">SET UP THE LOGIN</h2>` +
      `<p>One account, for the Director. <strong>A logged-in session can run anything on this machine</strong>: it can type into every agent's terminal. Use a long password and keep this page off the internet unless you need it there.</p>` +
      `<label><span class="label">SETUP TOKEN</span><input class="input" name="token" type="password" autocomplete="off" required spellcheck="false" aria-describedby="t"></label>` +
      `<p id="t" class="hint">It is in the file <code>setup-token</code> in gonogo's home folder (valid for one hour, used once), or the old browser token of this install.</p>` +
      `<label><span class="label">NAME</span><input class="input" name="user" value="${esc(input.user ?? 'director')}" autocomplete="username" required maxlength="64"></label>` +
      `<label><span class="label">PASSWORD (12 CHARACTERS OR MORE)</span><input class="input" name="password" type="password" autocomplete="new-password" required minlength="12" maxlength="256"></label>` +
      `${error}${plain}<button class="btn" data-kind="primary" type="submit">CREATE ACCOUNT</button></form>${tail}`
    );
  }
  return (
    `${head}<form class="module lg-form" method="post" action="/api/auth/login" autocomplete="on"><h2 class="label">LOG IN</h2>` +
    `<label><span class="label">NAME</span><input class="input" name="user" value="${esc(input.user ?? 'director')}" autocomplete="username" required maxlength="64"></label>` +
    `<label><span class="label">PASSWORD</span><input class="input" name="password" type="password" autocomplete="current-password" required maxlength="256" autofocus></label>` +
    `${error}${plain}<button class="btn" data-kind="primary" type="submit">LOG IN</button></form>${tail}`
  );
}
