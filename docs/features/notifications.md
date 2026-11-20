# Notifications: be told when the tab is not in front

<NotificationsMock class="doc-mock" />

Get a browser notification when something needs you and the gonogo tab is in the background. **Off by default, per browser**: turn on in [Flight Rules](./flight-rules.md), THIS BROWSER. The browser asks permission on that key press, never on load. The setting is `gonogo.notify` in this browser's `localStorage`; nothing is sent to a server.

## What is shown

Only while the tab is hidden or unfocused:

- **A message to you** ([Downlink](./downlink.md)): title is sender and subject (`ana: Done`), body the first 80 characters. A burst from one agent replaces the earlier notification.
- **A T-minus poll** that holds on a no-go or comes out go; a [Static fire](./static-fire.md) the same way.
- **A [Relief](./relief.md) request** awaiting GO or NO-GO.

Clicking focuses the tab and opens the Comms INBOX (a message) or the room (poll, Relief). Inbox content at connect, and messages arriving while you watch the tab, are not announced.

## The tab title

While the tab is away its title counts what waits: `(3) gonogo` (unread Downlink items plus Relief requests). No permission needed; works with notifications off or blocked.

## Where it works

Only on a secure context: `https://` or `localhost`. Over plain `http://` the key is disabled (Flight Rules says so) and only the tab title counter works; put TLS in front ([HTTPS](../https.md)). If you blocked the address, allow it in the browser's site settings. These notifications use no service worker, so a phone browser that needs one shows only the tab title; for push with the app closed see [The phone app](./mobile.md).
