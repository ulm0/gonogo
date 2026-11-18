# Notifications: be told when the tab is not in front

<NotificationsMock class="doc-mock" />

You miss a message for you when the gonogo tab is in the background. Notifications tell you. They are **off by default and a setting of this browser**: turn them on in [Flight Rules](./flight-rules.md), under THIS BROWSER. The browser asks for permission when you press that key, never when the page loads.

## What is shown

A notification appears only while the tab is hidden or not focused, for:

- **A message to you** ([Downlink](./downlink.md)): the title is the sender and the subject (`ana: Done`), the body is the first 80 characters of the text. A notification can show on a lock screen, so only a snippet leaves the page. One agent gives one notification: a burst from the same sender replaces the one before it.
- **A T-minus poll** that holds on a no-go or comes out go, and a [Static fire](./static-fire.md) the same way.
- **A [Relief](./relief.md) request** waiting for your GO or NO-GO.

Clicking a notification focuses the tab and opens the INBOX tab of Comms (a message) or the room (a poll or a Relief request). What was in the inbox when the page connected is history and is not announced; messages that arrive while you are looking at the tab are not announced either.

## The tab title

While the tab is away, its title counts what waits for you: `(3) gonogo` (unread items of the Downlink plus Relief requests). It goes back when you return. This needs no permission, so it also works when notifications are off, blocked or not available.

## Where it works

Browsers allow notifications only on a **secure context**: `https://` or `localhost`. Over plain `http://` on another address, for example gonogo behind a reverse proxy without TLS, the browser offers no notifications: Flight Rules says so and the key is disabled, and the tab title counter is what you get. Put TLS in front ([HTTPS](../https.md)) to use them. If you blocked notifications for the address in the browser, the page says so; allow them in the browser's site settings. Some phone browsers show notifications only from a service worker; gonogo does not use one, so on those only the tab title works.

Nothing is sent to a server: the page raises the notification itself from what it already shows. The setting is the `gonogo.notify` key of this browser's `localStorage`.
