# The phone app: install gonogo and get a push

<MobileMock class="doc-mock" />

gonogo is a web app with a phone layout (one column, a bottom bar, a console full screen with its own keys). On a phone you can **install** it, so it has an icon and opens full screen, and you can turn on **push**, so your phone tells you when an agent needs you even with the app closed. It is the same page as on the computer, not a second app: there is nothing to download from a store, nothing to sign in to but your own gonogo, and no service of ours in the middle.

## What you need

- **https.** A phone browser gives a service worker (the part that receives a push) only to a page on `https://` or `localhost`. Over plain `http://` on your network there is no install, no push and no offline shell: Flight Rules says so. Put TLS in front of gonogo (see [HTTPS](../https.md)); a private tunnel such as Tailscale Serve is the easy way to get https without publishing gonogo to the internet.
- **Android (Chrome, Edge, Firefox):** open gonogo, use the browser's **Install app** (or **Add to Home screen**), then turn push on.
- **iPhone and iPad (iOS and iPadOS 16.4 or newer):** Safari gives push only to a web app on the Home Screen. In Safari press **Share**, then **Add to Home Screen**, open gonogo **from its icon**, and turn push on there. Flight Rules says this too while you are still in a Safari tab, because iOS has no install button.

## Turn push on

In [Flight Rules](./flight-rules.md), under THIS BROWSER, **PUSH TO THIS DEVICE**: press **Turn push on for this device**. The press is what lets the browser ask for permission, which is why it is never asked when the page loads (iOS requires this too). Each device is its own choice and the default is off. The block lists the devices that get a push, each with **Test** (sends a generic test) and **Remove**.

## What is pushed

The same things the page's own [notifications](./notifications.md) tell you, but worked out on the server, so they arrive when no page is open:

- a **message to you** (the Downlink),
- an agent **needs you** (a permission request),
- a **T-minus** poll that wants a call,
- a **Relief** hire request waiting for your GO or NO-GO,
- a **Redline** trip.

A burst from the same sender is one notification. **The text is generic by default** ("1 new message", "An agent needs you"), because a lock screen shows it and the push service of your phone's vendor carries it. A device can choose to show **who it is from and the first 80 characters** instead (the check above the key); it is cut and cleaned the way the page's notifications are.

**You cannot approve from the notification.** It has no buttons. A tap opens the app at the ask (the INBOX of Comms for a message, the room for the rest), and a dangerous approval still goes through the login's step-up on the page.

## What it does not do

- **No relay.** gonogo does not send your events to a server of ours. The supervisor (the process behind the one port, which also holds the login) holds one VAPID key pair and the list of devices in `push.json` in gonogo's home (mode 0600), and sends a push straight to the push service of your browser's vendor (Google, Apple, Mozilla or Microsoft). That service sees an encrypted body and the device's address, nothing else. The body is encrypted for the device (RFC 8291) and signed with the key (RFC 8292). A room only tells the supervisor, on the pipe it already has to it, that something waits for you.
- **No offline data.** The service worker keeps only the built page (its hashed files and icons), so the app opens with no network and then says "not connected" until its socket is up. It never keeps an answer of the API, a login or a terminal.
- **Not for approving from Telegram.** [Phone approvals](./phone-approvals.md) through Telegram stay as the channel for people who do not install the app.

## Security

- **A device belongs to a login session.** The supervisor refuses a subscription without one (a key, the old token and the local socket have none), ties each device to the session that made it, and drops the device when that session ends (you sign out, revoke it, it expires, the password changes, a reset, the tamper alarm).
- **The address a push goes to is checked** (it is the one place a session can make the server send a request): `https` only, the standard port, no credentials, and a host on a short list of the vendors' push hosts (`fcm.googleapis.com`, `*.push.apple.com`, `*.push.services.mozilla.com`, `*.notify.windows.com`). It is checked when it is stored and again at every send, a redirect is never followed, and the answer is never shown, so a session cannot make gonogo post to `127.0.0.1` or to your LAN. At most 20 devices.
- **One app for every room.** There is one manifest, one service worker (at `/sw.js`, scope `/`) and one list of devices for the whole gonogo, whichever room's page you install from, so the phone holds one icon (iOS ties a Home Screen app to one scope). The title of a push says the room when it is not main ("gonogo, Team B"), and a tap opens that room's page (`/r/<id>/`, or `/` for main). The manifest takes the colour of the livery.

## Not verified

Said plainly: **no phone was used** to build this, and no real push service was reached. What was tested: the encryption against the example of RFC 8291 (byte for byte), the signature, the address check, the lifecycle of a device, the service worker against a stand-in for its scope, the routes and the proxy. What was **not**: that an iPhone on the Home Screen receives a push (VAPID support on iOS and delivery reliability are not confirmed by anything run here), that Android Chrome does, that a locked phone keeps its socket (it does not: the page reconnects and repaints from a snapshot), the install on any browser, the soft keyboard over the terminal in the installed app, and the look of the block in Flight Rules in a real browser. Also not tried: a tap on a notification opening the right room's window in the installed iOS app (the worker uses `openWindow` and `focus`, which iOS may restrict). Try it on your own devices before relying on it, and tell us what happened.

Design: [`docs/mobile-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/mobile-spec.md).
