# The phone app: install gonogo and get a push

<MobileMock class="doc-mock" />

Install gonogo on a phone and get a push when an agent needs you, even with the app closed. It is the same page as on the computer: no store, no sign-in but your own gonogo, no service of ours in the middle.

## What you need

- **https.** Phone browsers give the service worker only to `https://` or `localhost`. Over plain `http://` there is no install, no push, no offline shell (Flight Rules says so). Put TLS in front ([HTTPS](../https.md)); a private tunnel such as Tailscale Serve avoids publishing gonogo.
- **Android (Chrome, Edge, Firefox):** browser **Install app** (or **Add to Home screen**), then turn push on.
- **iPhone and iPad (16.4 or newer):** push only for a Home Screen web app. In Safari: **Share**, **Add to Home Screen**, open gonogo **from its icon**, turn push on there. Flight Rules says this in a Safari tab.

## Turn push on

[Flight Rules](./flight-rules.md), THIS BROWSER, **PUSH TO THIS DEVICE**: **Turn push on for this device** (the press lets the browser ask permission; never asked on load). Per device; default off. The block lists devices with **Test** (generic test push) and **Remove**.

## What is pushed

What the page's [notifications](./notifications.md) show, computed on the server so it arrives with no page open:

- a message to you (Downlink)
- an agent needs you (permission request)
- a T-minus poll wanting a call
- a Relief hire request awaiting GO or NO-GO
- a Redline trip

A burst from one sender is one notification. **Text is generic by default** ("1 new message", "An agent needs you"), since the lock screen and your phone vendor's push service carry it. A device can opt to show **sender and the first 80 characters** (cleaned like page notifications).

**A push never asks for a password or links elsewhere; one that does is not from gonogo.** **You cannot approve from the notification** (no buttons). A tap opens the app at the ask (Comms INBOX for a message, the room otherwise); a dangerous approval still goes through the login's step-up.

## Limits

- **No relay.** The supervisor holds one VAPID key pair and the device list in `push.json` (home, mode 0600) and sends straight to the vendor's push service (Google, Apple, Mozilla, Microsoft), which sees an encrypted body (RFC 8291, signed RFC 8292) and the device address. A room only tells the supervisor, over its pipe, that something waits.
- **No offline data.** The service worker keeps only room main's built page (`/r/main/`: hashed files, icons); the room list and other rooms come from the network. Offline it opens and says "not connected" until its socket is up. It never keeps an API answer, a login or a terminal.
- Approving from Telegram stays in [Phone approvals](./phone-approvals.md) for people without the app.

## Security

- **A device belongs to a login session.** No subscription without one (keys, the old token and the local socket have none). The device is dropped when its session ends (sign-out, revoke, expiry, password change, reset, tamper alarm).
- **The push address is checked** when stored and at every send: `https` only, standard port, no credentials, host on the list `fcm.googleapis.com`, `*.push.apple.com`, `*.push.services.mozilla.com`, `*.notify.windows.com`. No redirect followed, answer never shown, so a session cannot make gonogo post to `127.0.0.1` or your LAN. At most 20 devices.
- **One app for every room:** one manifest, one service worker (`/sw.js`, scope `/`), one device list, one icon. A non-main room's push title names it ("gonogo, Team B"); a tap opens `/r/<id>/` (main: `/`, the room list). The manifest takes the livery colour.

## Not verified

**No phone was used** and no real push service reached. Tested: encryption against the RFC 8291 example (byte for byte), signature, address check, device lifecycle, service worker against a scope stand-in, routes, proxy. **Not** tested: an iPhone Home Screen app receiving push (VAPID and delivery on iOS unconfirmed), Android Chrome, a locked phone keeping its socket (it does not: the page reconnects and repaints from a snapshot), install on any browser, soft keyboard over the terminal in the installed app, the Flight Rules block in a real browser, a notification tap opening the right room in installed iOS (`openWindow` and `focus` may be restricted). Try it on your own devices first.

Design: [`docs/mobile-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/mobile-spec.md).
