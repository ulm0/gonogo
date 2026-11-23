# First-run audit: the first ten minutes of a new gonogo user

Ordered by how badly each point stops a newcomer. Written 2026-11-23 against gonogo 0.13.0 (npm) and the image `ghcr.io/ulm0/gonogo:latest` (0.13.0), by EECOM, for FLIGHT. Nothing was fixed here: PAO and CONTROL take the fixes.

## What was done, and what it cannot say

The newcomer is someone who knows Claude Code but not gonogo, with only the README and the docs site (`gonogo.ulm0.com`). Both installs were run in fresh containers inside an isolated docker-in-docker (`docker:27.5.1-dind`), nothing on the host:

- **npm path.** A fresh `node:24-bookworm-slim` container as the user `node` (not root): `npm i -g @ulm0/gonogo@latest`, `claude` installed the same way, `gonogo doctor`, `gonogo`, then the HTTP calls the page makes (setup form, state, staffing, messages, rooms) and a WebSocket attach to read a console's screen.
- **Docker path.** The `compose.yaml` from `main`, the commands of `docs/guide/docker.md` ("Clean Room in the container"), `docker compose up -d`, `logs`, then the same HTTP and WebSocket checks.

**It cannot say** how any of it looks in a browser (no browser exists here: every statement about a page comes from its HTML, the strings in `src/client`, or the server's answers), how long a person takes to read and type, or what a real Claude answers (no sign-in was available and none was borrowed). The agent in the "first brief" run was the stand-in used by the test suite (`test/fake-claude.mjs`): it proves the mechanics (staff, brief, reply in the Downlink, a second room), not a model's answer. So the requested "time to the first agent answering a brief" is **not measured**; the machine times are in the last table.

## Friction points, worst first

### 1. In Docker without a credential, nothing says so: FLIGHT looks ready, a brief is "delivered", and nothing happens

*Stops the newcomer completely, and the screen reassures them.*

Seen: `docker compose up -d` with no `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` exported (compose does not ask for one) starts and is healthy in 7 s. FLIGHT's state is `idle` (green), so the Commissioning step "FLIGHT is staffed" counts as **done**. The console of FLIGHT shows Claude Code's header with "Not logged in · Run /login". A brief to FLIGHT is answered `201 ... "status":"queued"` and then the item reads **delivered**; 30 s later the state is still `idle` and nothing came back. The docs mention the credential only as the last paragraph of a block ("Set one credential, not both").

Fix:
- **Product:** when the console shows "Not logged in" (the string is on the screen, as the startup-dialog detector already reads it), set the agent to needs-you with the reason "Claude Code is not signed in: set CLAUDE_CODE_OAUTH_TOKEN (see Docker) or type /login in this console", and do not count the Commissioning step done.
- **Docs:** put the credential first in the Docker block, as a numbered step with the one command that makes it (`claude setup-token`), and say what the symptom is when it is missing.
- **Compose:** the `.env` a newcomer is told to make could carry a commented `CLAUDE_CODE_OAUTH_TOKEN=` line.

### 2. Outside Docker the first launch drops Claude's own first-run dialogs into the web terminal

*Stops a newcomer who has not run `claude` once on this machine.*

Seen: on the npm path, FLIGHT starts `claude`, which shows its welcome and the **theme chooser** (then its login). gonogo does say so: the state is `needs_you`, "startup dialog: answer it in the terminal". But the docs' Requirements say "signed in" without saying that an installed-but-never-run `claude` is not; the way out (run `claude` once in an ordinary terminal first, or start with `--seed-claude`) is not on the Getting started page.

Fix: one sentence in Requirements ("run `claude` once in a normal terminal and finish its sign-in"), and the needs-you reason text could name the same.

### 3. Two addresses on the first screen, and only one of them says what to do

*Costs minutes and trust; the Director's user wrote that they needed Claude to understand it.*

Seen: stdout prints two lines. First `gonogo ready: http://127.0.0.1:7777/#token=...`, then `gonogo setup: open http://127.0.0.1:7777/setup and give this setup token (one use, one hour ...): ...`. The ready address opens the app at once with no login and **nothing in the app asks for an account** (the only "SET UP THE LOGIN" key is in Flight Rules, in the ACCOUNT block). The Getting started page does explain the setup, but a newcomer who follows the first line never meets it. After the account is made the first address returns 401 (measured), which a user with that tab open will meet later without warning (the tab's behaviour was not seen).

Fix: when no account exists, a banner on the first page ("No login yet. Set it up: ..."), and print the two lines as one instruction: "1. Open http://127.0.0.1:7777/setup 2. Give this setup token: ..." with the `#token=` address only after it, or not at all on a fresh install.

### 4. The first page is a list of rooms with one room in it

*Costs a click and a concept.*

Seen: since 0.7, `/` is the list of rooms and the app is at `/r/main/`. The address the newcomer is given (`.../#token=...`) lands on the list (a card "Main" and an OPEN key, plus a "NEW ROOM" prompt, "Only main so far"). "Room" is not defined before this screen, and the Getting started page's picture (`RoomMock`) is the room itself, not this list.

Fix: on an install with only `main`, make the list's card the page's whole content with the one instruction "Open your room"; or define "room" in one line on Getting started and show the list page in a second mock.

### 5. There is no copy-and-paste Docker path, and no way to get `compose.yaml`

*Stops a newcomer who chooses Docker.*

Seen: the README's Docker line is `docker build -t gonogo . && docker run ...` (needs a clone; the Dockerfile is not in the npm package) and a link to `compose.yaml` with a warning that it gives root over the host. `docs/guide/docker.md` says "`compose.yaml` at the repository root" and lists commands that assume the file is already beside you; nothing says to download it. The home page's button is `docker pull ghcr.io/ulm0/gonogo`, which pulls and does nothing else. The first `docker compose up -d` (as the README implies) fails with "required variable GONOGO_DATA is missing a value: set GONOGO_DATA to the absolute path of the data folder": clear, but the README never mentions it, and the fix is three more commands.

Fix: one block, whole, in the README and on Getting started:

```
curl -fsSLO https://raw.githubusercontent.com/ulm0/gonogo/main/compose.yaml
install -d -o 1000 -g 1000 gonogo-data gonogo-data/projects gonogo-data/home
printf 'GONOGO_DATA=%s\nDOCKER_GID=%s\n' "$PWD/gonogo-data" "$(stat -L -c %g /var/run/docker.sock)" > .env
export CLAUDE_CODE_OAUTH_TOKEN=...     # from: claude setup-token
docker compose up -d && docker compose logs gonogo
```

and, for a newcomer who does not want the socket, a plain `docker run` that needs nothing from a clone (the image is public) with the warning put where the socket line is, not in front of every Docker instruction.

### 6. Reaching it from another machine is not on the path a newcomer follows

*Stops everyone who installs on a NAS, a VPS or a home server.*

Seen: the server and compose bind `127.0.0.1` (right). Getting started does not say what to do when the browser is on another machine; the answer (an `ssh -L` tunnel) is the first bullet of `docs/https.md`, which the README mentions only after the sentence "Keep the port on 127.0.0.1". The setup page's own text says setup is "answered on this machine and your local network only": a reader on a LAN reads that as "open it from the laptop".

Fix: a box on Getting started: "Browser on another machine? `ssh -L 7777:127.0.0.1:7777 you@host`, then open the address on your own machine."

### 7. Reading the first reply: where it appears depends on the agent, and nothing says so

*Not measured with a real model; risk, not a finding.*

Seen with the stand-in: the agent's answer arrived in the Downlink (the unread count rose to 1). A real Claude answers in its console; whether it also uses gonogo's `send_message` to the Director depends on the role text and the model. A newcomer who sends a brief and watches the Downlink may see nothing while the console has the answer.

Fix to check with a real run: one line under "Send your first brief": "The answer is in the console; an agent that messages you shows in the Downlink." and a role placeholder that tells the agent to report to the Director.

### 8. `npm i -g` fails on a system Node (EACCES) and the docs do not mention it

*Generic npm, hits many Linux newcomers; minutes.*

Seen: as a normal user on the stock Node image: `EACCES: permission denied, mkdir '/usr/local/lib/node_modules/@ulm0'`. gonogo's docs offer `pnpm dlx` as the alternative but frame it around release age, not permissions.

Fix: a line under the install block: "EACCES? Use nvm or fnm, or `npm config set prefix ~/.npm-global` and add its `bin` to PATH."

### 9. `gonogo doctor` prints a wall of "not found"

*Noise at the moment of greatest doubt.*

Seen: with only `claude` installed it prints about a dozen engines, all but one of them `--  ... not found` with an install command and a docs link each (over 30 lines), and `ok` for Claude buried at the top. The newcomer who ran it to check "am I set?" has to find one line in a screen of red-looking text.

Fix: print only the found engines and a count of the others ("12 more engines are supported: gonogo doctor --all").

### 10. The setup page's wrong-token message names the wrong thing

*Small, but it is the one place a typo is likely.*

Seen: a wrong setup token returns "Wrong name or password." (401), though name and password were fine. A second try within a second returns "Too many tries. Wait 1 seconds, then try again." (429). A right token with a 5-character password returns "The password needs 12 to 256 characters, and the name letters, digits, dots, dashes or spaces (64 at most)." (400): clear, and the token is **not** burnt by the failed try (checked).

Fix: "That setup token is wrong, or it was already used or has expired (it is in `setup-token` in gonogo's home folder)."

### 11. The vocabulary arrives before the explanation

*Slows, does not stop.*

Seen: the first screens use FLIGHT, console, staff, Commissioning, Propellant, Redline, livery, Downlink. The Commissioning checklist explains its own four steps (FLIGHT staffed; a Propellant limit "A token budget for the room. Over it, Redline stops the agents."; livery; the security note). "Staff a console" is the hire form; its errors are clear when measured (below). Nothing on Getting started lists the five words a newcomer must know.

Fix: a five-line glossary box on Getting started (room, console, FLIGHT, brief, Downlink).

### 12. Smaller things

- Git is not a stated requirement: on a machine without it the first launch logs "the Black Box does not commit: git was not found" (stderr, easy to miss). Recorder, worktrees and the Black Box need it.
- The hire form's errors are good: `~/proj` gives "directory must be an absolute path"; a missing folder "directory does not exist: /home/node/nope"; a capital in the name "name must be 1 to 32 lowercase letters, digits or hyphens, and start with a letter or digit"; no role "role must be 1 to 4000 characters"; `bypassPermissions` without the box "bypassPermissions needs confirmBypass: true". Only the `~` one could add "expand it yourself", and the last should name the checkbox's label, not the field.
- The form's working directory defaults to the folder `gonogo` was started in (verified in the code: `dir: current?.dir ?? cwd`), which is a kindness; Getting started says "an absolute working directory that exists" without saying the default.
- Adding a room works as documented (`POST /api/rooms` answered 201, state `starting`); not tried through the page.

## What went right

- The npm path is fast and quiet: install 3 s, the ready line 1 s after start.
- The Docker path is healthy 7 s after `up -d`, and the first `compose up` without `GONOGO_DATA` fails with a message that names the variable.
- gonogo catches Claude's startup dialog (outside Docker) and says it needs you.
- Setup does not burn its token on a bad password, and says what is wrong with the password.
- The newcomer is protected by default: loopback bind, no account means the old address only, an account kills it.

## The machine times (not the human's)

| Step | Time |
|---|---|
| `npm i -g @ulm0/gonogo@latest` (warm network) | 3 s (127 packages, 40 MB) |
| `npm i -g @anthropic-ai/claude-code` | 5 s |
| `gonogo` start to the ready line | 1 s |
| Setup form (right token, good password) to a session | under 1 s |
| `docker compose up -d` to healthy (image already pulled) | 7 s |
| Staff a console to idle (stand-in agent) | 1 s |

## Not covered

Anything seen only in a browser (the first page, the banner, the hire form's layout, the tab that still has the old `#token=` address, notifications), a real Claude sign-in and answer, Windows and macOS, `brew`, `pnpm dlx`, the phone, a second device, and the update and Clean Room paths after the first run. The order of the list above is therefore by what the server and the text show; a browser pass by CONTROL would reorder points 3 and 4 and could add its own.
