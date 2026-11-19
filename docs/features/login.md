# Login: an account instead of the token

<LoginMock class="doc-mock" />

gonogo asks for a **name and a password** instead of a token you paste once. One account, for you. Design and limits:
[`docs/login-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/login-spec.md). Tried with real HTTP, WebSockets and unix sockets in
tests; **not tried in a real browser, behind a real tunnel or with a real second factor** ([What was not verified](../reference/not-verified.md)).

**A signed-in session can run anything on this machine.** Through a console, or a message to an agent allowed to do anything, it can run
commands as you. The login keeps strangers out; it does not make a stolen session harmless. This is why the first-run page, the Flight
Rules block and these docs say it, and why a Clean Room is the one real boundary for agents when the page is exposed
([Security](../reference/security.md)).

## First start

On an install that has never had an account nothing changes: the address gonogo prints (`#token=...`) still opens the page. gonogo also
prints a **setup token** once, and writes it to `<home>/setup-token` (0600): one use, valid for one hour. Open `/setup`, give that token
(or the old browser token of this install), a name and a password of 12 characters or more, and you are signed in.

- **Setup is answered on this machine and on your local network only.** A public name gets "login is not set up: open gonogo from this
  machine or your local network" and never takes a setup token, so a stolen token is useless from the internet.
- **The old browser token dies when the account is made.** The file is deleted and nothing replaces it: links, bookmarks, logs and shell
  history that held it open nothing. It does not come back after `gonogo auth reset` either; `gonogo token rotate` refuses.
- The password is stored as argon2id (Node's own; scrypt on a Node older than 24.7), at the current OWASP minimum cost, made again at the
  next login if the cost rises. A wrong name and a wrong password get the same answer in the same time.

**After setup, remote scripts and TUIs need a key.** The old token is what they used; once the account exists it opens nothing. On this machine `gonogo tui` and scripts use the local socket; from another machine make a key with `gonogo auth key add <name> --remote` (or in Flight Rules) and send it as `Authorization: Bearer gnk_...`.

## Sessions

Signing in sets a cookie (`HttpOnly`, `SameSite=Strict`): on a public name `__Host-gonogo` (`Secure`), on a loopback or private name
`gonogo-session`, which is **not encrypted** over plain http (the login page says so; use https for anything beyond your own network).

| Where | Idle | At most |
|---|---|---|
| a public name | 2 hours | 7 days |
| this machine or your network | 12 hours | 30 days |

gonogo keeps only a hash of the cookie, with its address and browser, and lists the sessions in **Flight Rules → LOGIN** with REVOKE and
LOG OUT EVERYWHERE. A password change ends every session but the one that made it. Input to a console keeps a session alive (at most once
a minute); the terminal's output does not.

- **WebSockets end with their session.** The page's socket records its session, is checked every minute, and is closed when the session is
  revoked, logged out, expired, or the password changes.
- **A change needs this page's `Origin`.** A request that changes something and is authenticated by the cookie, without an `Origin` of
  this address, is refused (CSRF); so is a WebSocket from another site.
- **A page of gonogo carries a strict policy** (`script-src 'self'`, `connect-src 'self'`, no frames).
- **A socket is a console**, so only a session, the local socket, the old token or a `full` key may open one; a `read` or `act` key is refused. A socket opened with a key ends when the key is revoked or expires, and every socket opened with the old token ends when the account is made.

## Too many tries

Failures wait 1, 2, 4 ... seconds, up to 15 minutes, **per client address, per known device and once for all devices gonogo does not
know**. A known device carries a signed cookie set after a full login; it has its own bucket, so a stranger guessing, or the many clients
behind one tunnel address, cannot keep you out. There is no lock: the way back is `gonogo auth reset` on the machine. Twenty failures
in ten minutes from unknown devices raise an alert.

**A request is local only when the Host it names and the address it came from are both local.** `Host: 127.0.0.1` from the internet is public, and so is a request that carries a forwarding header (`X-Forwarded-For`, `Forwarded`, `X-Real-IP`, ...) from a peer that is not a trusted proxy. That class decides setup, the cookie and its lifetime, the keys that may be used, and who may lift the pause after a tamper alarm. **What it cannot see:** a proxy on this machine that drops its forwarding headers and rewrites the Host looks local: put its address in `--trusted-proxy` so the forwarded client address decides.

The client address is the socket's. Behind a reverse proxy it is the proxy's, until you tell gonogo which proxies to believe:
`--trusted-proxy <ip>` (or `GONOGO_TRUSTED_PROXY`, comma list). A forwarded address from anyone else changes nothing.

## Second factor (TOTP)

In Flight Rules → LOGIN → SECOND FACTOR, TURN ON makes a secret: add it to an authenticator app (the key is shown as text and as an `otpauth://` address; no QR code is drawn), give the first code, and gonogo shows ten **recovery codes once**. From then on signing in is two steps: the password, then a six-digit code (or a recovery code, which works once).

- **There is no command for it: turn it on in the page, from this machine or your network.** On a headless machine open the page through a tunnel (`ssh -L 8080:127.0.0.1:<port> <host>`, then `http://127.0.0.1:8080`), which counts as this machine.
- A code works once and is good for its own 30-second step and one either side.
- A wrong code counts like a wrong password, in the same waits; giving the password again does not clear them.
- **A public name cannot be signed in to without it.** On this machine or your network a password alone still works, with the plain-http warning.
- Turning it off, or making new recovery codes, needs your password **and** a code: a stolen session alone cannot. `gonogo auth reset` removes it with the account.

## Passkeys

A passkey is the password and the second factor in one step: a fingerprint, a face, a screen lock or a security key. In Flight Rules → LOGIN → PASSKEYS, ADD A PASSKEY makes one for the name the page is open at; the login page then shows **LOG IN WITH A PASSKEY**, and the confirmation dialog of the step-up offers USE A PASSKEY.

- **Only on a public name opened over https.** WebAuthn works in secure contexts only, and its rp id has to be a domain: a browser refuses an IP address, and gonogo does not offer one on this machine, on `localhost` or on your network's names. A passkey works **only at the name it was made for** (the rp id is fixed when it is made); at another name the password stays.
- gonogo behind a tunnel sees plain http, so https is known from the origin the authenticator signed (`https://` and the Host): a page opened over http signs another origin and is refused.
- **Not slowed by the failure waits** (a passkey cannot be guessed), but always verified: the signature, the origin, the rp id, a challenge used once within five minutes, and user verification. A counter that does not go up raises an alert (a copy of the passkey may exist) and is refused.
- **The second factor comes first.** The first passkey can be made only with TOTP on (and its recovery codes), and TOTP cannot be turned off while a passkey exists. A passkey is tied to the name it was made at, so if that name changes (a new domain, a new tunnel) every passkey stops working at once; the way back is the password and a code from your authenticator (or a recovery code), or, on a headless machine, opening the page through `ssh -L 8080:127.0.0.1:<port> <host>` and `http://127.0.0.1:8080`, then removing the old passkeys and making new ones at the new name. `gonogo auth reset` remains the last resort.
- Adding one is a change of the account, behind the step-up. **Removing one asks your password and a code (or a passkey)**, as turning TOTP off does: a fresh session alone cannot. Each raises an alert. Up to twenty. The list shows the name, the rp id, when it was made and last used, and whether it is synced.
- **A stolen password cannot use it, and a lost authenticator is removed from the list.**
- **Discoverable passkeys.** A passkey is made to be kept on the authenticator (`residentKey: required`), so the sign-in options name no credential: whoever asks for them learns nothing of yours. A security key with no room for passkeys cannot be used; a phone, a laptop or a recent key can.
- **Anonymous requests cost nothing.** A sign-in challenge is not stored: it is a nonce, the time and a keyed hash of them and the name, checked when the answer comes and marked used only after an answer verified, so any number of requests cannot push your own out.
- It is made with `@simplewebauthn/server` 14.0.3 (MIT), pinned: the cryptography and the checks of the standard are the library's, not gonogo's. Passkeys of all kinds are asked for with attestation `none` and user verification required.

## Confirming again (step-up)

A session whose password was checked more than five minutes ago is asked for it again (and the code) before the changes that matter most: a hire with a command of its own, a mode that works without asking, no Clean Room, remote control or keys of its own, any edit of an agent except its name, position, autostart, co-author line, model and effort (a field added later is asked about too), the room's permissions, Features, the secrets of Uplink, Relay and Docking, the keys of an engine, writing a file in an agent's folder, a commit, a Docker update, and the account's own changes. The page opens CONFIRM IT IS YOU by itself and repeats the change. Confirming mints the session's id again, and its sockets stay open.

**This is a speed bump, not a wall.** Typing into a console, a message to an agent, a GO on a permission dialog, hold, resume and starting or restarting an agent are not behind it, and each of them can make an agent that is allowed to do anything run anything. A stolen session is still shell-equivalent. What protects it is the second factor at login, the short lifetimes, the session list with REVOKE, and the alerts. A passkey confirms instead of a password and a code. A key, the local socket and the old token are not asked.

## Alerts

A `redline` event in the Downlink, forwarded by Relay when it is on, for: the account made, `gonogo auth reset`, the first login from a
new device, a new API key, a password change, a second factor turned on or off, a recovery code used or new ones made, the failure count above, and the tamper alarm. The text has the address and the browser,
never a secret.

## API keys

For a script or a remote TUI. Made in Flight Rules or with `gonogo auth key add <name> [--scope read|act|full] [--expires 90d] [--remote]`,
shown **once**, stored hashed, expiring (90 days by default), with the last use and its address. Sent as `Authorization: Bearer gnk_...`
(or the subprotocol of a WebSocket).

- **read:** state and lists. **act:** read, plus messages, answers, hold and resume, a poll's hold or abort, Relief GO and NO-GO.
  **full:** everything except the account (a `full` key is listed as dangerous). The rooms list is changed by a `full` key only.
- **A key is refused from a public name unless it was made with `--remote`.** A key never reaches `/api/auth`.

## On this machine: a unix socket, no token

`gonogo tui`, the `gonogo auth` commands and scripts on the machine talk to **`<home>/run/api.sock`** (directory 0700, socket 0600): the
same API and WebSocket, the file permissions being the credential. `curl --unix-socket <home>/run/api.sock http://localhost/api/state`
works. **No token is accepted on TCP once an account exists**, for any Host, so a proxy that rewrites the Host or drops forwarding
headers gains nothing.

Each room answers on its own `<room home>/run/room.sock` and has **no TCP credential at all** for its page: the supervisor holds the login
and reaches the rooms by their sockets. The agents' `/hook` and `/mcp` keep their own tokens on the room's loopback port.

## Reset, and the tamper alarm

`gonogo auth reset` empties the account, writes a new setup token (not printed) and ends every session and key. A running gonogo notices,
raises the alert, closes the sockets and answers "login is not set up" on public names until you set up again from this machine.

An agent outside a Clean Room runs as you and can write `<home>/auth.json` itself. gonogo cannot stop that, so it makes it loud: after each
of its own writes it remembers the file's hash, and checks it on a request (once a second) and every five seconds. A change it did not make
raises a `redline`, ends the sessions, keys and devices it cannot match to its own record, writes the file back from memory, and **pauses
remote logins until you confirm on the machine** with your password (Flight Rules, or `gonogo auth confirm` with the password on standard
input): checked against the account in memory, never against the file, so a password an agent planted confirms nothing.

When the page is exposed, **any agent that does not run in a Clean Room can open the remote door** (this alarm, or its own `reset` and
setup). Run agents in a Clean Room on an exposed gonogo.

## What it does not do

- **No QR code** for the authenticator: the key and the address are shown as text.
- **A change made while gonogo is stopped is not seen** by the alarm; the next start loads the file as it is.
- **Not exposure.** This page does not publish gonogo; it only makes a login for when you do ([Exposing gonogo safely](../https.md)).
- Telegram approvals stay a second path that does not use the login (an approval of a permission or a Relief request only).
- The webhook and docking paths (`/uplink/*`, `/dock/*`) and the agents' paths are unchanged.
- A unix socket path is limited to about 100 characters: a home folder with a very long path cannot start.
