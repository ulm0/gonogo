# What was not verified

Update this list when these are run. Most features were tested with unit tests, a fake clock and a real server driving the stand-in agent (`test/fake-claude.mjs`); a real `claude` ran only the smoke test (`scripts/smoke-real.mjs`, claude 2.1.325 and 2.1.326, haiku, macOS arm64; numbers in [`docs/contract.md`](https://github.com/ulm0/gonogo/blob/main/docs/contract.md) section 15).

<UnverifiedMock class="doc-mock" />

## Not run

- **Browsers:** every view was driven by script in Chrome (1440, 1280, 1024 px, a 500 px window, 390 px phone emulation); never by hand, on a real phone, in Firefox or Safari, or with a screen reader.
- **Linux and amd64:** Linux only inside the arm64 container; not as a host, not on amd64, no real `claude` on Linux.
- **Docker image:** built and run in a Lima VM (Docker 29.9, arm64) with the stand-in agent. Not run: linux/amd64, a real `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` (seed mode with a real `claude`, `apiKeyHelper` with a real key and its environment), a bind-mounted `/projects` and its ownership, the `safe.directory` entries.
- **Real `claude`:** whether `permissions.deny` and `crossSessionInbound` take effect, whether the role text applies on a first start, startup dialogs other than trust and bypass, Esc twice clearing the input box (from Claude Code's docs).
- **Real `claude` with newer features:** no model has used an Engine Bay engine, a payload, a Clean Room, a schedule, an uplink, the Flight Plan, Downlink, Mission Log, Livery or Relay tools, or a docked station. Whether a model calls these tools when it should is unknown.
- **T-minus and Max Q:** a real `claude` answered one poll with go; no-go, hold, abort and Max Q not run with one.
- **Custom agents:** no full-screen program (`htop`, an editor) tried.
- **`auto` permission mode:** a turn in `auto` through gonogo; behaviour on an account or model that cannot use it.
- **Engine Bay:** no engine other than Claude Code run against a model. Gemini CLI 0.59.0 installed but not signed in (hooks reaching gonogo, mail handover, pointer confirmation, its dialogs, its first hook within the 5 s startup timer). pi checked by `--help` only. Codex, opencode, Kimi, Copilot, Qwen, Grok, Crush and Cursor Agent never installed (flags from their docs). Whether each engine turns on bracketed paste (without it, no mail).
- **Model, keys, Pad Check and Rollout:** `--model` was run only for Claude Code (`haiku`); for Gemini CLI and pi it comes from their `--help`, for Codex, Kimi and Cursor Agent from their docs. No engine was run with a key from Clearance; a Clean Room with a key ran only against the fake docker. The install commands were read from each vendor's page on 2026-11-18 and never run; Kimi CLI has none, and whether the Grok CLI of that page is the `grok` the adapter means is not known. Rollout was never run against a newer release: tests use a fake `fetch`, and the address was fetched once by hand; the hourly look across a real day change, `gonogo update` from a real pnpm, npm or Docker install, and the note on a real phone are not tried.
- **Payload:** a model using a payload tool or skill, its permission prompt, the skill name as Claude Code shows it, remote (http or sse) servers, `${NAME}` expansion, Gemini and Kimi file shapes against the real CLIs.
- **Clean Room:** a real `claude` in the container (hooks to `host.docker.internal`), gonogo on the host with `host-gateway` against real Docker, Docker Desktop, linux/amd64, rootless Docker, a gonogo container recreated under a running console, a container left behind by a killed server, reaching the server from a Linux bridge with the default `--host 127.0.0.1` (not expected to work). Propellant does not count a Clean Room agent.
- **Launch Window:** a real minute boundary, machine sleep or clock change, a real `claude` receiving a scheduled message.
- **Uplink:** a real reverse proxy, a real GitHub or other sender, a real `claude` reading a delivery, saved deliveries across a real restart, the rate limit across a real minute, the nginx rate-limit lines, the cost of a flood of failed proofs.
- **Flight Plan, Downlink, Mission Log:** boards, inboxes or logs of hundreds of items; Downlink between 700 and 999 px and `prefers-reduced-motion` by hand. Mission Log ranking constants are chosen, not tuned.
- **Mass Budget and Star Chart:** a real model reading the request and condensing its `memory.md` well, keeping what matters and answering (the stand-in agent only reads the message); in a Clean Room with real Docker. The chart on a real log of hundreds of entries (a made-up one of 197 entries and one author was drawn in Chrome: a dense ball, nodes overlap, only Links is usable there), whether its layout reads well, Firefox, Safari and a screen reader; the clicks were made by script.
- **Relay:** never run against a real Slack, GitHub, Linear or Telegram: real payload shapes, `chat.postMessage` and `sendMessage` replies, Slack's Request URL check, real retries, and the setup menus (from the docs as remembered; Linear's URL being editable afterwards is assumed). TEST not pressed against a saved target.
- **Livery:** a model designing a livery that passes the check; another engine calling the tool; contrast of error messages, open questions, hover and focus states; `theme-color` on a real phone; a reverse proxy with a Content-Security-Policy.
- **Relief:** a real `claude` calling `hire_agent` (the tool text and the FLIGHT role line are untried with a model: whether it asks when it should, and with a fitting role), and a GO of a Clean Room request on real Docker. The block was opened in Chrome only against the stand-in agent.
- **Docking:** between two machines, over HTTPS or a real proxy, a real `claude` reading a message from another station, the 30 s roster pull outside a fake timer.
- **Proxy recipes:** none of the Caddy, nginx or `tailscale serve` configs in [Exposing gonogo safely](../https.md) and [Security](./security.md#reverse-proxy) was run; ruling out basic auth comes from reading `src/client/api.ts`.
- **Saved-state upgrades:** every format is still version 1, so no real upgrade has run. Not tested: two gonogos on one home at once, a disk filling between the copy and the write.
- **Release:** `.github/workflows/release.yml` checked with actionlint only before the first publish.
- **Flaky tests:** end-to-end scenarios 4 and 6 (pointer timing) on a loaded machine, and the Uplink 256 KiB body route test (`write EPIPE`). They pass on rerun.

## Known limits

- Launch Window: a fire time a DST change skips does not fire that day (in America/Santiago `0 0 * * *` misses the September change). A scheduled message to FLIGHT replaces the wall's MISSION.
- Uplink: an unknown id answers 404 before the HMAC runs, so timing reveals whether an id exists. A record `load()` skips (e.g. a newer kind after a downgrade) is dropped with its secret at the next save, with a warning.
- Flight Plan: the whole list goes in every frame, so a full board nears the 4 MB socket buffer. A task keeps its assignee's name and does not follow a rename. The top-bar count is an `aria-label` on a span, which screen readers other than Chrome's may not read.
- Downlink: every frame carries the whole inbox (about 700 KB at the limits). After a restart, unread mail is found only among the newest 1000 log records.
- Mission Log: with two writers the last write wins, without a warning. Hand edits are seen only after a restart. Ids above `l999999` are not handled. Entries are text a model may follow: not for secrets or untrusted agents.
- Relay: Telegram updates are not deduplicated by `update_id`. A Slack event is marked handled even when the hub then refuses it, so Slack's retry is ignored.
- Livery: an `oklch` colour outside sRGB is clipped per channel in the check. If removing a custom livery fails on disk after `livery.json` moved back, no livery frame goes out until the next state.
- Relief: requests are kept in memory, so a restart drops them and FLIGHT is not told. A boss saved before Relief keeps its old role text, which says it cannot hire.
- Docking: codes and seen nonces live in memory, so a call replayed within 5 minutes across a restart is accepted once. If the other station accepts a hand-off and the local task then fails to move, the remote copy stays. A queued message to a station is marked undelivered at a restart.
- Engines without the gonogo tools (pi, Qwen, Grok, Crush, Cursor Agent) still get `GONOGO_TOKEN`. gonogo needs `claude` on `PATH` because FLIGHT is always Claude Code.
- Codex, opencode and Copilot take no payload.
- The npm tarball has no lock file; transitive dependencies resolve at install time.
