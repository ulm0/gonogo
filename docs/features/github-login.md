# A GitHub login per room

<GithubLoginMock class="doc-mock" />

Every agent of a room starts with `GH_CONFIG_DIR=<the room's home>/gh`, so the **GitHub CLI (`gh`) logs in once per room**, not once for the whole machine. Room `main` has its own folder too (`<gonogo home>/gh`); another room has `<gonogo home>/rooms/<id>/gh`. The folder is made (mode 0700) when an agent starts.

- **Log in inside a console of the room:** `gh auth login` there writes only that room's folder. Another room, and your own shell on the machine, are not touched (gonogo changes only the environment it gives its agents). `gh auth status` in a console says who the room is.
- **Each room can be a different GitHub account:** a client's room with the client's bot, your own room with you. That is the point: an agent of one room cannot push as the account of another.
- **It is only a default.** If the **environment gonogo itself runs in** (the container's `environment:`, the shell that started it) sets `GH_CONFIG_DIR`, that value is kept for every room. If an agent has a **Clearance key** named `GH_CONFIG_DIR` (hire or edit form, KEYS), that agent gets its own value. `GH_CONFIG_DIR` is not a reserved key name. A key `GH_TOKEN` also works for one agent: gh prefers it to any login.
- **What changed from before:** agents used the machine user's `~/.config/gh`, shared by every room. They no longer do: a room has no login until someone logs in in it. To go on sharing the old one for every room, set `GH_CONFIG_DIR=$HOME/.config/gh` in gonogo's environment. gonogo never copies a login from one place to another: a login you made as yourself does not end up in a room's agents unless you put it there.
- **A Clean Room** (the container of an agent) gets only the variables gonogo names for it, so it has **no** GitHub login: the room's `gh` folder is not mounted into it, and `GH_CONFIG_DIR` is not passed. A sandboxed agent that could push as the room's account would defeat the sandbox. Give that one agent a narrow token as a Clearance key `GH_TOKEN` if it must reach GitHub.
- **Who can read it:** `<room home>/gh` holds the token `gh` saves (or the key of the system keyring where there is one). An agent in `bypassPermissions` outside a Clean Room runs as you and can read it, as it can read any file of yours: log in as an account whose reach you accept, per room.

## In Docker

The room's home is under the home volume, so the login survives restarts and updates. `docker exec -it gonogo gh auth login` would log in the container's shell, not a room: use a console of the room (`gh auth login` there) or give the room's environment a token.

## Tried

The tests start agents of two rooms and check the folder, its mode, the override by a key and by the environment, and that a Clean Room is not given it. A real `gh auth login` against GitHub was not run here.
