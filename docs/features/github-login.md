# A GitHub login per room

<GithubLoginMock class="doc-mock" />

Every agent of a room starts with `GH_CONFIG_DIR=<the room's home>/gh`, so the **GitHub CLI (`gh`) logs in once per room**, not once per machine. An agent of one room cannot push as another room's account. Room `main`: `<gonogo home>/rooms/main/gh` (`<gonogo home>/gh` on a home made before 0.9); another room: `<gonogo home>/rooms/<id>/gh`. Made (0700) when an agent starts.

## Use it

- In a console of the room run `gh auth login`; it writes only that room's folder. Other rooms and your own shell are untouched. `gh auth status` in a console says who the room is.
- **Override:** `GH_CONFIG_DIR` in the environment gonogo itself runs in (container `environment:`, shell) is kept for every room; a **Clearance key** `GH_CONFIG_DIR` (hire or edit form, KEYS) sets it for one agent (not a reserved name). A Clearance key `GH_TOKEN` also works for one agent: gh prefers it to any login.
- **Share the old login:** agents used to use the machine user's `~/.config/gh`. A room now has no login until someone logs in. To keep sharing, set `GH_CONFIG_DIR=$HOME/.config/gh` in gonogo's environment. gonogo never copies a login.
- **Docker:** the room's home is under the home volume, so the login survives restarts and updates. `docker exec -it gonogo gh auth login` logs in the container's shell, not a room: use a console of the room, or give the room's environment a token.

## What breaks

- **`git push`:** if `~/.gitconfig` has `credential.helper = !gh auth git-credential`, `gh` now looks in the room's empty folder and a push fails with a **credential error** (not "logged out") until you run `gh auth login` in a console of that room.
- **Clean Room:** gets **no** GitHub login (the `gh` folder is not mounted, `GH_CONFIG_DIR` not passed). If it must reach GitHub, give that agent a narrow Clearance key `GH_TOKEN`.

## Security

- **This separates logins, it does not isolate them.** Agents of every room outside a Clean Room run as the same OS user, so one can read another room's `gh/hosts.yml`. A Clean Room is the only boundary.
- `<room home>/gh` holds the token `gh` saves (or the system keyring key). An agent in `bypassPermissions` outside a Clean Room runs as you and can read it. Log in as an account whose reach you accept, per room.

## Tried

Tests start agents of two rooms and check the folder, its mode, the override by key and by environment, and that a Clean Room is not given it. A real `gh auth login` against GitHub was not run.
