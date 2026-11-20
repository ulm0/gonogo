# Room keys: environment variables for every agent

<RoomKeysMock class="doc-mock" />

Set an environment variable (usually an API key or cloud login) once for **every agent of the room**. **ROOM KEYS** in [Flight Rules](flight-rules.md); per-agent keys are [Clearance](engine-bay.md).

- **Set one at a time**: a name (capital letters, digits, `_`; Clearance's rules and reserved names) and a value of 1 to 4096 printable characters **without a space**. At most 16 keys. The list shows name, SET and date, never the value (saved in `room-keys.json`, 0600, plain text; never sent to the page or logged). To change a value set the name again; the "Also in a Clean Room" switch changes alone.
- **The agent's own Clearance key of the same name wins.**
- **Reserved names** as in [Engine Bay](engine-bay.md): a name that changes what runs is refused; `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR` only warn. A stored key whose name becomes reserved is refused at load (named in the log and Downlink) and moved to `room-keys.refused.json` (0600, merged if it exists), not deleted.
- **Engines**: all (Claude Code, others, custom commands).
- **Clean Room: opt-in per key.** By default a Clean Room agent gets **none** of the room's keys. With "Also in a Clean Room" on, the key is passed to the container by name (value stays in gonogo's environment, never on the `docker run` line).
- **When**: each agent's next start; running agents keep theirs.
- **Who**: a change asks for the password again (step-up; it is shell-level power for the room); the Black Box notes the name, never a value.
- **Not a secret store**: any process of the same OS user can read the file, so a console outside a Clean Room can ([security notes](../reference/security.md)).

## Example: Amazon Bedrock for the whole room

Every Claude Code agent then starts on Bedrock ([Engine Bay](engine-bay.md#amazon-bedrock) for other engines):

| Key | Value |
|---|---|
| `CLAUDE_CODE_USE_BEDROCK` | `1` |
| `AWS_REGION` | `us-east-1` (your region) |
| `AWS_BEARER_TOKEN_BEDROCK` | a Bedrock API key (or `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` [+ `AWS_SESSION_TOKEN`]) |

Add `ANTHROPIC_MODEL` with a Bedrock model id, or set the model per agent. An agent needing something else sets its own key of that name in Clearance. For a Clean Room agent switch on "Also in a Clean Room" for each (leave the secret off if the container should not hold it).

Not run against a real AWS account ([Not verified](../reference/not-verified.md)); API and launcher are tested, the page never seen in a browser.

## API

- `GET /api/room-keys` -> `{ keys: [{ name, at, cleanRoom }] }`.
- `PUT /api/room-keys/<NAME>` `{ value?, cleanRoom? }` (a new key needs `value`; 400 names the field `name`, `value` or `cleanRoom`).
- `DELETE /api/room-keys/<NAME>` (404 if none). Writes are step-up.
