# Hangar: the files of an agent

<HangarMock class="doc-mock" />

OPEN FILES (console actions, or MORE on a phone) opens HANGAR: a file tree and plain text editor for that agent's folder or its [Clean Room](./clean-room.md) worktree. The other half is [Recorder](./recorder.md), the GIT tab beside FILES. Design: [`docs/hangar-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/hangar-spec.md).

- **Tree:** folders open on click (folders first, then by name, with sizes). At most 2000 entries a folder. A symbolic link shows a LINK chip and is not opened. `.git` is never listed.
- **Open:** text files up to 1 MiB, valid UTF-8, no NUL. Binary, larger or other encodings are refused with the reason.
- **Edit:** monospaced box with line numbers. Tab indents (a tab if the file uses tabs, else 4 or 2 spaces as the file does), Shift+Tab unindents, also across selected lines. Escape, then Tab, leaves the box. Undo works. CRLF files stay CRLF; mixed endings open read-only.
- **Save:** SAVE or Ctrl or Cmd+S. If the file changed on disk since you opened it, nothing is written: `the file changed on disk since you opened it: nothing was saved`; DISCARD MY CHANGES AND RELOAD loads the new text. Saves go via a temporary file renamed over it, keeping its mode. A read-only file is refused.
- **New file:** NEW FILE asks for a path (open file's folder prefilled). The folder must exist; an existing name is refused. No delete, no rename.
- **Unsaved edits** stay when you leave and return to the same agent. Opening another file asks first; closing the tab asks the browser's question.

## What it will not touch

Only the agent's folder. 403 for: `..` or an absolute path, a symbolic link that leads out, `.git` (and any name a file system takes for it), and gonogo's own folder when the agent's folder holds it (the boss in your home directory), except Clean Room worktrees. Limits of these checks: [Security](../reference/security.md#hangar-and-recorder).

## API

Browser token required; `<name>` is an agent. Errors are `{ error, code, field? }`.

| Call | Body, answer |
|---|---|
| `GET /api/agents/<name>/files?path=src` | `{ "path", "entries": [{ "name", "kind": "file\|dir\|link", "size" }], "truncated": false }` |
| `GET /api/agents/<name>/file?path=src/a.ts` | `{ "path", "text", "size", "etag" }`; 413 over 1 MiB, 415 binary |
| `PUT /api/agents/<name>/file` | `{ "path", "text", "etag" }` -> `{ "path", "size", "etag" }`; 409 when the etag is not the file's |
| `POST /api/agents/<name>/file` | `{ "path", "text"? }` makes a new file; 409 when the name exists |

The etag is a hash of the content. A save body may be up to 6 MiB + 8 KiB of JSON; every other body at most 256 KiB.
