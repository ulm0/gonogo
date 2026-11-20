# Phone approvals: answer from your phone

<PhoneApprovalsMock class="doc-mock" />

Approve an agent's permission dialog or a hire request from your phone. Set it in **Flight Rules, Phone approvals**: Off (default), Telegram buttons, Claude app, or both. **Claude Code's `/remote-control` cannot carry gonogo's approvals**: it connects to Anthropic's servers and offers no local socket, hook or file to learn of or answer a request (read from `claude --help` 2.1.325, never run). What you answer in the app goes to the CLI; gonogo learns afterwards from hooks. Design: [`docs/phone-approvals-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/phone-approvals-spec.md).

## Path A: Telegram buttons

- **Sent**: a permission dialog (`ana asks: Bash: pnpm vitest run`) and a FLIGHT hire request ([Relief](./relief.md)) to your Telegram chat; both are also [Downlink](./downlink.md) lines whatever the setting. Never a startup, trust or login dialog.
- **Buttons**: a permission has GO and NO-GO. A hire request, or a permission whose text was cut, has NO-GO and Open only (read the role text in gonogo and press GO there).
- **Signed**: each button carries an HMAC-SHA256 tag (8 hex characters) of the Telegram uplink's secret, binding one request and one answer; a forwarded or edited button cannot approve something else. An agent has no secret, so cannot make one.
- **Late presses do nothing**: a GO names its dialog (`needSeq` of `POST /api/agents/<name>/answer`); a press for an answered or replaced dialog answers "Too late" and types nothing. Two taps act once. After a press the bot answers ("Sent GO") and removes the buttons.
- **Needs**: a Telegram Relay target; a Telegram [Uplink](./uplink.md) whose webhook also receives `callback_query` updates; gonogo reachable by Telegram over HTTPS; the setting on Telegram or both. At most 10 presses a minute; only your chat counts.
- **Use a private chat** (you and the bot). gonogo checks the chat, not who pressed: in a group anyone could.
- **What leaves your machine**: the permission text is the tool and its input (command, path, URL), cut to one line; it can hold a secret an agent put in a command and goes to Telegram. Keep the setting off or the target away if that matters.
- **Recorded**: Black Box lists `Director answered ana: go`.

## Path B: the Claude app

The box **Approve in the Claude app** (shown when Flight Rules allows it) starts a Claude Code agent with `--remote-control gonogo-<name>`, so you approve in the app. gonogo gets nothing: the dialog and inbox line stay until the hooks say it ended, and an app approval is not recorded as a page answer. Needs a claude.ai (subscription) login on the machine; **not** with an API key or `CLAUDE_CODE_OAUTH_TOKEN`, and **not** for a Clean Room agent (both refused, field `remoteControl`).

## Not verified

- A real Telegram bot and webhook: tested with a fake Telegram only.
- Path B: the flag was read from `--help`; not run (unattended start, first-run questions, whether an app approval clears the terminal dialog unknown).
- A button from before a restart answers "Too late" (handles are in memory).
- A permission asked while your phone has no signal waits; nothing times it out.
