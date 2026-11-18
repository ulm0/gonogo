# Spec: Phone approvals (draft)

Design by FIDO, 2026-11-18. Backlog section 4, "Phone approvals through Claude Code's `/remote-control`". Status: draft,
not built.

## Verdict first

**`/remote-control` cannot carry gonogo's approvals, and gonogo should not be designed against it.** What was checked, and
how far:

- `claude --help` (2.1.325) and `claude remote-control --help`: Remote Control is "control local sessions from
  claude.ai/code or the Claude mobile app". The CLI connects the session to Anthropic's servers and the phone app talks to it
  there. The options only start, name, reattach and choose the permission mode of spawned sessions. There is **no local
  socket, port, hook, file or event** that tells another program a request is pending or lets it answer one. (Read from the
  help text and from `docs/facts/`; **not run**, because this machine has no claude.ai login to try it with. A run with a
  login is the one thing that could change this verdict, and step 5 below is where it would be tried.)
- `docs/facts/prior-art-notes.md` and `toolchain-docker.md`: it needs a claude.ai (subscription) login; a
  `CLAUDE_CODE_OAUTH_TOKEN` or an API key "cannot establish Remote Control sessions". So it does not work for a Clean Room
  agent that gets only a token, nor for an API-key room.
- The reference app only types `/remote-control` into the terminal at start (`prior-art-notes.md`, item 22: the write had to
  be serialised so it did not glue to the next prompt). It starts the session; it does not read approvals from it.

So gonogo **cannot** show a Remote Control approval in its own page, forward it, or answer it from the phone. Whatever is
answered in the Claude app goes straight to the CLI, and gonogo only learns of it afterwards through the hooks (the state
leaves `needs_you`), exactly as when the Director types into the terminal today.

## What gonogo can do instead: reach the phone itself

gonogo already has everything for a phone round trip except the buttons: the phone page (`answer` from the phone bar),
Downlink events, and Relay's Telegram and Slack targets, which post out and take replies in (`docs/relay-spec.md`). The
missing parts are that a **pending permission** and a **pending Relief request** are not Downlink events, and that a
Telegram message cannot carry GO and NO-GO.

## Design

- **Two new Downlink event kinds**, `permission` and `relief`, posted by the hub when an agent enters `needs_you` with
  `needsKind: 'permission'` (from `PermissionRequest`, once per dialog) and when `Relief.request` makes a request. Text, one
  line, at most 300 characters, control characters turned into spaces, as for every event: `ana asks: Bash: pnpm
  vitest run` (`describePermission`) and `FLIGHT asks to hire guido-1 (claude, acceptEdits) in /path`. They appear in the
  inbox like the others. They are forwardable in Relay (a fifth and sixth switch; default **off**, because they ask for
  something the Director may not want on a third-party service).
- **Buttons, Telegram first.** For these two kinds Relay's Telegram send adds `reply_markup.inline_keyboard` with two
  buttons, GO and NO-GO. `callback_data` is `a:<kind>:<id>:<verdict>:<tag>` (64-byte Telegram limit), where `<id>` is the
  agent's `needs_you` sequence number or the Relief id, and `<tag>` is the first 8 hex characters of
  `HMAC-SHA256(uplink secret, kind:id:verdict)`. Slack needs an interactivity endpoint and a second signing flow: a later
  step, not this design.
- **The way back** is the existing Telegram uplink `POST /uplink/<id>` (same secret-token header proof). The uplink kind
  `telegram` learns one more update type, `callback_query`, and answers it in three steps:
  1. The `from` chat must be the target chat (as for messages), and the tag must verify (constant-time compare).
  2. **Permission:** `Hub.answer(name, { go })`, with a new precondition `needSeq` equal to the pending dialog's sequence,
     so a button pressed late, for a dialog that was already answered or replaced, is `conflict` and does nothing. It types
     Enter or Escape through the same path as the page. **Relief:** `Relief.decide(id, verdict, { kind: 'user' })`; the
     existing "leaves the list first" rule makes two taps hire once.
  3. The bot answers the callback (`answerCallbackQuery`: "Sent GO" or "Too late: already answered") and edits the message to
     remove the buttons (`editMessageReplyMarkup`), so the phone shows the result.
- **What may be approved from the phone.** A permission dialog of tools only; never `bypass`/trust/login startup dialogs (they
  are `needsKind: 'startup_dialog'`, not `permission`). A Relief request is approved with all its fields shown in the
  message (name, position, engine, mode, folder); the **role text is not shown on the phone** and the message says "role text:
  open gonogo to read it", because the Director approves the text they can read (relief spec) and a 312-character role does
  not fit a button decision. So Relief gets **NO-GO and "Open"** buttons on the phone, and GO only in the page. (Option 2
  below reverses this.)
- **Security.** The bot token and the chat id are the owner's own target. The tag binds a button to one request and one
  verdict, so a forwarded or edited message cannot approve something else; an agent cannot make a valid tag (it has no
  secret) and cannot press the button (it has no Telegram). Text in the message comes from an agent (the tool input), so it is
  plain text only, truncated and shown in `<pre>`-free plain form, as Relay already does. A rate limit of 10 callbacks a
  minute per uplink uses Uplink's limiter. The page's `answer` route and the page itself are unchanged.
- **The optional pass-through (step 5, unverified).** Per-agent `remoteControl?: {}` makes the launcher add
  `--remote-control` (or type `/remote-control`) so the Director can also approve in the Claude app, for the Claude-login
  rooms only. gonogo gains nothing from it but the flag; its pending block clears when the hook reports the outcome.
  It must be tried with a real login before anyone trusts it, and is built **last or not at all**.
- **No top-bar key.** Settings are two switches and a note in the existing RELAY module of the Launch Window view; the
  Patch Panel lists it.

## Options

1. **Own channel with signed buttons (pick).** Works on any engine with hooks, any login, Clean Room included, and gonogo
   keeps seeing and recording every answer (Black Box, Recorder), which a Claude-app approval would bypass.
2. Same, but Relief GO on the phone too. Rejected for the first build for the hidden-text reason above; revisit if the role
   text is made short enough to show whole.
3. Web Push to the installed phone page instead of Telegram. Needs HTTPS (`docs/https.md`), a service worker and keys, and
   the page's token on the phone. More to build for the same result; later.

## Interfaces

`Downlink.post('permission' | 'relief', text)`; hub: post at the `PermissionRequest` handler and in `Relief` after a request;
`Hub.answer(name, { go, needSeq? })` (`needSeq` optional so the page keeps working); `relaykinds.ts`: `telegram.read` returns
`{ kind: 'answer', ... }` for a callback, and Relay (`relay.ts`) gets `callbackTag(secret, kind, id, verdict)`,
`verifyCallback`, and the `reply_markup` and `answerCallbackQuery` calls (same fetch, timeout and no-redirect rules).
`relay.json` `forward` gains the two kinds.

## Order of changes

1. The two event kinds, in the inbox only (no Relay): useful alone, and the page shows them.
2. `needSeq` on `Hub.answer` and its race tests.
3. Relay: forward the kinds as plain text (default off).
4. Buttons and the callback path (tag, uplink kind, answers, edit). Feature page `docs/features/phone-approvals.md` that
   opens with the Remote Control verdict.
5. Optional `remoteControl` pass-through, only after a real login run.

## Test plan

- Tags: valid, wrong verdict, wrong id, wrong secret, truncated; constant-time compare.
- Callback path with a fake Telegram: right chat go/no-go for permission and Relief; wrong chat ignored; stale `needSeq`
  conflict; double tap hires once; a callback for a request that expired; edit of the message after the answer.
- The Telegram secret-token header still required; callbacks do not use the 30-per-minute delivery limit but have their own.
- Relay text: an agent that writes `<b>` or a `/command` in a tool input; 300-character cut; the role text never in the
  message.
- Stand-in agent end to end: a `PermissionRequest` hook makes an event, a callback types Enter, the hooks move the state.
- Not testable here: a real Telegram bot. State it in the feature page, as Relay's spec does.

## Known limits

- gonogo must be reachable by Telegram's webhook (HTTPS, as Uplink already needs).
- A permission asked while the Director's phone has no signal waits as it does today; nothing times it out.
- Approving a Bash command from a chat is a decision made on a truncated line: the message says `truncated` when it was cut,
  and a cut permission message offers **NO-GO and Open** only.
