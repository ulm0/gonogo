# Room keys: environment variables for every agent

<RoomKeysMock class="doc-mock" />

[Clearance](engine-bay.md) gives one agent environment variables, usually API keys. **ROOM KEYS** in [Flight Rules](flight-rules.md) gives them to **every agent of the room**: set the cloud login once instead of in each agent's form.

- **Set one at a time.** A name (capital letters, digits and `_`, the same rules and reserved names as Clearance) and a value. The list shows the name, SET and the date, never the value, which is saved in `room-keys.json` (mode 0600, plain text) and never sent to the page or logged. To change a value, set the same name again; the switch "Also in a Clean Room" changes alone, with the value kept. A value is 1 to 4096 printable characters **without a space** (the same as Clearance). At most 16 keys. A change applies at each agent's next start.
- **The agent's own key wins.** An agent's Clearance key of the same name replaces the room's one for that agent.
- **Reserved names and the CA warning** are the same as Clearance's ([Engine Bay](engine-bay.md)): a name that changes what runs is refused, and `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` or `SSL_CERT_DIR` only warns. A stored room key whose name is reserved later is refused at load, with its name in the log and the Downlink, and the entry is moved to `room-keys.refused.json` (0600, merged if it exists), not deleted, and the file is written without it, so the note is made once.
- **Every engine.** Claude Code, the other engines and custom commands all get them (the keys are environment variables of the agent's process).
- **Clean Room: opt-in, per key.** A Clean Room agent runs in a container to keep keys out, so by default it gets **none** of the room's keys. A key with "Also in a Clean Room" switched on is passed to the container by name (the value stays in gonogo's environment, never on the `docker run` line), like the agent's own keys.
- **When.** At each agent's next start; a running agent keeps what it started with.
- **Who may change them.** A key every agent gets is shell-level power in the room, so a change asks for the password again (step-up), and the Black Box notes it by name, never a value.
- **Not a secret store.** The file is readable by anything that runs as the same OS user as gonogo, so a console outside a Clean Room can read it. That is the same as Clearance's `keys.json`; the [security notes](../reference/security.md) say so.

## Example: Amazon Bedrock for the whole room

Set these room keys and every Claude Code agent of the room starts on Bedrock (see [Engine Bay](engine-bay.md#amazon-bedrock) for the other engines):

| Key | Value |
|---|---|
| `CLAUDE_CODE_USE_BEDROCK` | `1` |
| `AWS_REGION` | `us-east-1` (your region) |
| `AWS_BEARER_TOKEN_BEDROCK` | a Bedrock API key (or `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` [+ `AWS_SESSION_TOKEN`]) |

Add `ANTHROPIC_MODEL` with a Bedrock model id, or set the model on each agent. One agent that must use something else sets its own key of that name in its Clearance fold. For a Clean Room agent, switch on "Also in a Clean Room" for each of the three; leave the secret off if the container should not hold it.

Nothing here was run against a real AWS account (see [Not verified](../reference/not-verified.md)); the API and the launcher are covered by tests, the page was never seen in a browser.

## API

`GET /api/room-keys` answers `{ keys: [{ name, at, cleanRoom }] }`. `PUT /api/room-keys/<NAME>` takes `{ value?, cleanRoom? }` (a new key needs a `value`; 400 with the field `name`, `value` or `cleanRoom`). `DELETE /api/room-keys/<NAME>` removes one (404 if there is none). Writes are step-up.
