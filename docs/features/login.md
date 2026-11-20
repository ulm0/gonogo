# Login: an account instead of the token

<LoginMock class="doc-mock" />

Sign in with a **name and a password** instead of a pasted token. One account. Design and limits: [`docs/login-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/login-spec.md). Tried with real HTTP, WebSockets and unix sockets in tests; **not tried in a real browser, behind a real tunnel or with a real second factor** ([What was not verified](../reference/not-verified.md)).

**A signed-in session can run anything on this machine** (a console, or a message to an agent allowed to do anything). The login keeps strangers out; it does not make a stolen session harmless. A Clean Room is the one real boundary for agents when the page is exposed ([Security](../reference/security.md)).

## First start

- With no account, the printed `#token=...` address still opens the page. gonogo also prints a **setup token** once and writes it to `<home>/setup-token` (0600): one use, one hour.
- Open `/setup`; give that token (or the old browser token), a name and a password of 12 characters or more.
- **Setup is answered on this machine and your local network only.** A public name gets "login is not set up: open gonogo from this machine or your local network".
- **The old browser token dies when the account is made** (file deleted; `gonogo token rotate` refuses; `gonogo auth reset` does not bring it back).
- Passwords: argon2id (scrypt on Node older than 24.7), OWASP minimum cost, rehashed at login if the cost rises.
- **Remote scripts and TUIs then need a key**: `gonogo auth key add <name> --remote`, sent as `Authorization: Bearer gnk_...`. On this machine `gonogo tui` and scripts use the local socket.

## Sessions

Cookie `HttpOnly`, `SameSite=Strict`: `__Host-gonogo` (`Secure`) on a public name, `gonogo-session` on a loopback or private name (**not encrypted** over plain http; use https beyond your own network).

| Where | Idle | At most |
|---|---|---|
| a public name | 2 hours | 7 days |
| this machine or your network | 12 hours | 30 days |

- Flight Rules -> LOGIN lists sessions (REVOKE, LOG OUT EVERYWHERE). A password change ends all but the session that made it.
- Console input keeps a session alive (once a minute at most); terminal output does not.
- WebSockets are checked every minute and close when their session is revoked, logged out, expired, or the password changes.
- A cookie-authenticated change without an `Origin` of this address is refused (CSRF), as is a WebSocket from another site.
- Pages carry a strict policy (`script-src 'self'`, `connect-src 'self'`, no frames).
- **A socket is a console**: only a session, the local socket, the old token or a `full` key may open one. A key's socket ends when the key is revoked or expires; old-token sockets end when the account is made.

## Too many tries

- Failures wait 1, 2, 4 ... seconds, up to 15 minutes, **per client address, per known device, and once for all unknown devices**. A known device has a signed cookie from a full login and its own bucket.
- No lock. The way back is `gonogo auth reset` on the machine. Twenty failures in ten minutes from unknown devices raise an alert.
- **A request is local only when its Host and its source address are both local.** `Host: 127.0.0.1` from the internet is public, as is a request with a forwarding header (`X-Forwarded-For`, `Forwarded`, `X-Real-IP`, ...) from a peer that is not a trusted proxy. This decides setup, the cookie and lifetime, usable keys, and who may lift the tamper pause.
- **Not seen:** a proxy on this machine that drops forwarding headers and rewrites the Host looks local. List it in `--trusted-proxy <ip>` (or `GONOGO_TRUSTED_PROXY`, comma list) so the forwarded address decides. Without it the client address is the proxy's. A forwarded address from anyone else changes nothing.

## Second factor (TOTP)

- Flight Rules -> LOGIN -> SECOND FACTOR -> TURN ON shows a secret as text and an `otpauth://` address (**no QR code**). Add it to an authenticator, give the first code, and save the ten **recovery codes** (shown once).
- Login becomes password, then a six-digit code (or a recovery code, once). A code works once, in its 30-second step and one either side. A wrong code counts like a wrong password; the password again does not clear the waits.
- **No command for it.** Use the page from this machine or your network; headless: `ssh -L 8080:127.0.0.1:<port> <host>`, then `http://127.0.0.1:8080` (counts as this machine).
- **A public name cannot be signed in to without it.** On this machine or your network a password alone works, with the plain-http warning.
- Turning it off or making new recovery codes needs password **and** code. `gonogo auth reset` removes it with the account.

## Passkeys

Password and second factor in one step. Flight Rules -> LOGIN -> PASSKEYS -> ADD A PASSKEY; the login page then shows **LOG IN WITH A PASSKEY** and the step-up offers USE A PASSKEY.

- **Public name over https only.** The rp id must be a domain (not an IP, `localhost`, this machine or your network's names). A passkey works **only at the name it was made for**; elsewhere the password stays. Behind a tunnel https is read from the origin the authenticator signed; a page over http is refused.
- Not slowed by the failure waits, but fully verified (signature, origin, rp id, a challenge used once within 5 minutes, user verification). A counter that does not rise raises an alert and is refused.
- **TOTP first**: the first passkey needs TOTP on; TOTP cannot be turned off while a passkey exists.
- **If the name changes**, every passkey stops. Sign in with password plus authenticator code (or recovery code; headless: the `ssh -L` tunnel above), remove the old passkeys, make new ones. Last resort: `gonogo auth reset`.
- Adding is behind the step-up. **Removing asks password and code (or a passkey).** Each raises an alert. Up to 20. The list shows name, rp id, made, last used, synced.
- Discoverable (`residentKey: required`): a security key with no room for passkeys cannot be used. Attestation `none`, user verification required. Made with pinned `@simplewebauthn/server` 14.0.3 (MIT).

## Confirming again (step-up)

A session whose password was checked over 5 minutes ago must re-confirm (password and code, or a passkey) before: a hire with its own command, a mode that works without asking, no Clean Room, remote control or own keys, any agent edit except name, position, autostart, co-author line, model and effort (fields added later are asked too), room permissions, Features, secrets of Uplink, Relay and Docking, engine keys, writing a file in an agent's folder, a commit, a Docker update, and the account's own changes. The page opens CONFIRM IT IS YOU and repeats the change; sockets stay open. Keys, the local socket and the old token are not asked.

**This is a speed bump, not a wall.** Typing into a console, a message to an agent, GO on a permission dialog, hold, resume, and starting or restarting an agent are not behind it, and each can make an agent that is allowed to do anything run anything. What protects a session: the second factor, short lifetimes, REVOKE, alerts.

## Alerts

A `redline` event in the Downlink (forwarded by Relay when on) for: account made, `gonogo auth reset`, first login from a new device, new API key, password change, second factor on or off, recovery code used or new ones made, the failure count above, the tamper alarm. The text has address and browser, never a secret.

## API keys

`gonogo auth key add <name> [--scope read|act|full] [--expires 90d] [--remote]`, or Flight Rules. Shown **once**, stored hashed, expires (90 days default), shows last use and address. Send `Authorization: Bearer gnk_...` (or the WebSocket subprotocol).

| Scope | Allows |
|---|---|
| `read` | state and lists |
| `act` | read, plus messages, answers, hold and resume, a poll's hold or abort, Relief GO and NO-GO |
| `full` | everything except the account (listed as dangerous); only `full` changes the rooms list |

- **Refused from a public name unless made with `--remote`.** Never reaches `/api/auth`. `read` and `act` keys cannot open a socket.

## A terminal on another machine

`gonogo tui --url https://...` shows a code; type it in the browser and approve ([TUI](tui.md)). The terminal gets its own session (a week idle, 30 days in all), listed in LOGIN as TERMINAL, able to do what a browser session can except step-up routes and the account. It is a Bearer credential in `tui.json` on that machine: a stolen file is a stolen session, so revoke it here. First use from another network is a notice.

## On this machine: a unix socket

`gonogo tui`, `gonogo auth` and local scripts use **`<home>/run/api.sock`** (dir 0700, socket 0600; the file permissions are the credential): `curl --unix-socket <home>/run/api.sock http://localhost/api/state`.

- **No token is accepted on TCP once an account exists**, for any Host.
- Each room answers on `<room home>/run/room.sock` with no TCP credential for its page. Agents' `/hook` and `/mcp` keep their own tokens on the room's loopback port.

## Reset, and the tamper alarm

`gonogo auth reset` empties the account, writes a new setup token (not printed) and ends every session and key. A running gonogo raises the alert, closes sockets, and answers "login is not set up" on public names until you set up again from this machine.

An agent outside a Clean Room runs as you and can write `<home>/auth.json`. gonogo makes that loud: it hashes the file after each own write and checks on a request (once a second) and every 5 seconds. An unknown change raises a `redline`, ends sessions, keys and devices it cannot match, rewrites the file from memory, and **pauses remote logins until you confirm on the machine** (Flight Rules, or `gonogo auth confirm` with the password on standard input; checked against memory, never the file).

**When the page is exposed, any agent not in a Clean Room can open the remote door** (this alarm, or its own `reset` and setup). Run agents in a Clean Room.

## Limits

- No QR code. A change made while gonogo is stopped is not seen by the alarm.
- Does not publish gonogo ([Exposing gonogo safely](../https.md)).
- Telegram approvals (a permission or Relief request only), webhook and docking paths (`/uplink/*`, `/dock/*`) and agents' paths do not use the login.
- A unix socket path is limited to about 100 characters: a very long home path cannot start.
