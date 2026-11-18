# Hangar: the files of an agent

<HangarMock class="doc-mock" />

OPEN FILES (in the actions of a console, or under MORE on a phone) opens HANGAR: a file tree and a plain text editor for the
folder of that agent, or for its [Clean Room](./clean-room.md) worktree. Design and limits: [`docs/hangar-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/hangar-spec.md). The other half is [Recorder](./recorder.md), the GIT tab beside FILES.

## What it does

- **Tree.** Folders open on click and list their entries (folders first, then by name, with sizes). At most 2000 entries a folder. A symbolic link is listed with a LINK chip and not opened. `.git` is never listed.
- **Open.** Text files of up to 1 MiB, valid UTF-8, without a NUL character. A binary file, a larger one or another encoding is refused with the reason.
- **Edit.** A monospaced box with line numbers. Tab indents (a tab if the file indents with tabs, else 4 or 2 spaces as the file does), Shift+Tab takes the indent back, also across selected lines. Escape, then Tab, leaves the box. Undo works.
- **Save.** SAVE or Ctrl or Cmd+S. The server refuses when the file changed on disk since you opened it (`the file changed on disk since you opened it: nothing was saved`) and writes nothing; DISCARD MY CHANGES AND RELOAD then loads the new text. A save writes a temporary file beside it and renames it over the file, and keeps its mode. A read-only file is refused.
- **New file.** NEW FILE asks for a path, with the open file's folder filled in. The folder must exist; a name that exists is refused. No delete, no rename.
- **Line endings.** A CRLF file is saved as CRLF. A file with mixed endings opens read-only.
- **Unsaved edits** stay when you leave the page and come back to the same agent. Opening another file asks first. Closing the tab asks the browser's own question.

## What it will not touch

Only the agent's folder: a `..` or an absolute path is 403, a symbolic link that leads out is 403, `.git` (and any name a file system takes for it) is 403, and so is gonogo's own folder when the agent's folder holds it (the boss in your home directory), except the Clean Room worktrees. Details and the limits of these checks: [Security](../reference/security.md#hangar-and-recorder).

## API

All need the browser token; `<name>` is an agent. Errors are the usual `{ error, code, field? }`.

- `GET /api/agents/<name>/files?path=src` answers `{ "path": "src", "entries": [{ "name", "kind": "file|dir|link", "size" }], "truncated": false }`.
- `GET /api/agents/<name>/file?path=src/a.ts` answers `{ "path", "text", "size", "etag" }`; 413 over 1 MiB, 415 for a binary file.
- `PUT /api/agents/<name>/file` with `{ "path", "text", "etag" }` answers `{ "path", "size", "etag" }`; 409 when the etag is not the file's.
- `POST /api/agents/<name>/file` with `{ "path", "text"? }` makes a new file; 409 when the name exists.

The etag is a hash of the content. A save may be up to 6 MiB + 8 KiB of JSON; every other body is at most 256 KiB. No option, no file of its own, no frame.
