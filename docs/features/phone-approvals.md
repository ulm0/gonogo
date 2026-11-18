# Phone approvals: answer from your phone

**Claude Code's `/remote-control` cannot carry gonogo's approvals.** It connects a session to Anthropic's servers and the
Claude app talks to it there; it has no local socket, hook or file that tells another program a request is pending or
lets it answer one (read from `claude --help` 2.1.325, never run: this machine has no claude.ai login). What you answer in
the app goes straight to the CLI, and gonogo learns of it afterwards from the hooks. So gonogo offers two paths, and you
choose in **Flight Rules, Phone approvals**: Off (default), Telegram buttons, Claude app, or both. Design:
[`docs/phone-approvals-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/phone-approvals-spec.md).

## Path A: Telegram buttons

- **What is sent.** A permission dialog of an agent (`ana asks: Bash: pnpm vitest run`) and a hire request of FLIGHT
  ([Relief](./relief.md)), to your Telegram chat. Both are also lines in the inbox ([Downlink](./downlink.md)), whatever the
  setting. Never a startup, trust or login dialog.
- **Buttons.** A permission has GO and NO-GO. A hire request has NO-GO and Open only: its role text is not shown on a phone,
  so you read it in gonogo and press GO there. A permission whose text was cut also has NO-GO and Open only.
- **Signed.** Each button carries a tag of the Telegram uplink's secret (HMAC-SHA256, 8 hex characters) that binds it to one
  request and one answer, so a forwarded or edited button cannot approve something else. An agent has no secret and no
  Telegram, so it can make neither.
- **Late presses do nothing.** A GO names the dialog it was sent for (`needSeq` of `POST /api/agents/<name>/answer`): a
  press for a dialog that was answered or replaced answers "Too late" and types nothing. Two taps hire or answer once.
- **After a press** the bot answers it on Telegram ("Sent GO") and takes the buttons off the message.
- **Needs** a Telegram Relay target and a Telegram [Uplink](./uplink.md) (its webhook must also receive `callback_query`
  updates), gonogo reachable by Telegram over HTTPS, and Phone approvals set to Telegram or both. Presses are limited to 10
  a minute; only your chat counts.
- **Use a private chat** (you and the bot). gonogo checks the chat a press comes from, not who pressed: in a group, anybody in it could press.
- **What leaves your machine.** The text of a permission is the tool and its input (a command, a file path, a URL), cut to one line. It can hold a secret an agent put in a command; it goes to Telegram. Keep the setting off, or the target away, if that matters.
- **Recorded.** An answer by a button is a page answer to the hub: Black Box lists it as `Director answered ana: go`.

## Path B: the Claude app

The box **Approve in the Claude app** (shown when Flight Rules allows it) starts a Claude Code agent with
`--remote-control gonogo-<name>`, so its session shows in the Claude app and you approve there. gonogo gets nothing from
that channel: the dialog and its inbox line stay until the hooks say it ended, and an approval made in the app is not
recorded as a page answer. It needs a claude.ai (subscription) login on the machine: it does **not** work with an
API key or `CLAUDE_CODE_OAUTH_TOKEN`, and **not** for a Clean Room agent (both are refused, field `remoteControl`).

## Not verified

- A real Telegram bot and webhook: tested with a fake Telegram only.
- Path B: the flag was read from `--help`. Not run: does it start unattended, does it ask something at first run, does an
  approval in the app clear the terminal dialog.
- A button of before a restart answers "Too late" (the handles are in memory, and every id carries a number made at start, so an old button never matches a new dialog).
- A permission asked while your phone has no signal waits as it does today; nothing times it out.
