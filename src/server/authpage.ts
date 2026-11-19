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
export const authPageHeaders = (script = false): Record<string, string> => ({
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': `default-src 'none'; ${script ? "script-src 'self'; connect-src 'self'; " : ''}style-src 'self' ${hash(STYLE)}; font-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  'X-Content-Type-Options': 'nosniff',
  // not no-referrer: under it a browser sends `Origin: null` on a same-origin POST, and the Origin check refuses the form
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
});

export type AuthPageKind = 'login' | 'setup' | 'unset' | 'damaged' | 'locked' | 'second';

export interface AuthPageInput {
  kind: AuthPageKind;
  stylesheet: string | null;
  /** What went wrong, in words the Director can act on; never the reason a login failed beyond "wrong name or password". */
  message?: string;
  user?: string;
  /** Offer a passkey: the page loads /login/passkey.js (the one script it may load) and shows its button. */
  passkey?: boolean;
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
    `${error}${plain}<button class="btn" data-kind="primary" type="submit">LOG IN</button>${input.passkey === true ? '<button class="btn" type="button" id="pk" hidden>LOG IN WITH A PASSKEY</button><p id="pkmsg" class="error lg-warn" role="alert" hidden></p>' : ''}</form>${input.passkey === true ? '<script src="/login/passkey.js" defer></script>' : ''}${tail}`
  );
}

/**
 * The script of the login page: one button, no library. It asks for the options, has the authenticator sign them, and posts the answer; the server
 * checks everything. base64url to bytes and back is all it does besides.
 */
export const PASSKEY_SCRIPT = `(function(){
var b=document.getElementById('pk');
if(!b||!window.PublicKeyCredential||!navigator.credentials)return;
b.hidden=false;
var m=document.getElementById('pkmsg');
function say(t){m.textContent=t;m.hidden=false}
function dec(s){s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';var r=atob(s),u=new Uint8Array(r.length);for(var i=0;i<r.length;i++)u[i]=r.charCodeAt(i);return u.buffer}
function enc(a){var u=new Uint8Array(a),s='';for(var i=0;i<u.length;i++)s+=String.fromCharCode(u[i]);return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')}
function post(p,x){return fetch(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(x||{}),credentials:'same-origin'})}
b.addEventListener('click',function(){
m.hidden=true;b.disabled=true;
post('/api/auth/passkey/options').then(function(r){if(!r.ok)throw new Error('No passkey is set up for this address.');return r.json()}).then(function(o){
o.challenge=dec(o.challenge);(o.allowCredentials||[]).forEach(function(c){c.id=dec(c.id)});
return navigator.credentials.get({publicKey:o})}).then(function(c){
var r=c.response;
return post('/api/auth/passkey/login',{id:c.id,rawId:enc(c.rawId),type:c.type,clientExtensionResults:c.getClientExtensionResults(),authenticatorAttachment:c.authenticatorAttachment||undefined,response:{clientDataJSON:enc(r.clientDataJSON),authenticatorData:enc(r.authenticatorData),signature:enc(r.signature),userHandle:r.userHandle?enc(r.userHandle):undefined}})}).then(function(r){
if(r.ok){location.assign('/');return}
say(r.status===423?'Remote logins are paused. Confirm on the machine gonogo runs on.':'That passkey was not accepted.');b.disabled=false}).catch(function(e){say(e&&e.name==='NotAllowedError'?'The passkey was not given.':(e&&e.message)||'The passkey did not work.');b.disabled=false})});
})();
`;
