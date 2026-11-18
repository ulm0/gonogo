# Spec: Hangar

Written and built 2026-11-18. Section 8 of `docs/backlog.md` ("File tree with a code editor"), for one agent at a time.
Git is the other half of that section: `docs/recorder-spec.md`.

## Intent

An agent works in a folder, and the Director sometimes needs to read a file it wrote or fix a line, from a phone too,
without opening a terminal. Hangar is a file tree and a plain text editor for the folder of the selected console, or for its
Clean Room worktree. It reads and writes text files by the Director's own keys. It never deletes or renames, and it never
lets a path leave the folder.

## Design

- **Which folder.** For a Clean Room agent the worktree `<home>/cleanroom/<name>`; for any other the `dir` of the agent.
  Both are resolved with `realpath` for every call (`createRoots` in `src/server/hangar.ts`). A Clean Room with no worktree
  yet, or a folder that is gone, is a 404 that says so.
- **A path** is relative to that folder, with `/` between names, at most 1024 characters. `pathParts` refuses a NUL
  (400) and, with 403 (`forbidden`), an absolute path, a `..` segment and a `.git` segment. `.git` is matched after
  Unicode NFKC, without zero-width characters and without case, because some file systems take those for `.git`.
- **Containment.** The target is resolved with `realpath` and must be inside the folder's own `realpath`: a symbolic link
  that leads out is 403, one that leads inside works. After the resolution the real path is checked again for a `.git`
  segment (a link to `.git` is refused) and against gonogo's own home: everything under `<home>` is refused and left out of
  listings, except the Clean Room worktrees. So an agent whose folder holds gonogo's home (the boss in your home directory)
  cannot reach `agents.json`, the tokens or the browser token.
- **List.** `GET /api/agents/<name>/files?path=`: the entries of a folder, folders first, then by name, each
  `{ name, kind, size }`, `kind` being `file`, `dir` or `link`. `.git` and special files (pipes, sockets, devices) are left
  out. At most 2000 entries; a bigger folder says `truncated` (shortcut: the entries are the first the disk gave).
  A link is listed and the tree does not open it.
- **Read.** `GET /api/agents/<name>/file?path=` answers `{ path, text, size, etag }`. A file over 1 MiB is 413; a binary
  file (a NUL in its first 8000 bytes, as git decides) or text that is not valid UTF-8 is 415. It is opened without
  following a link in its last name and without waiting on a pipe, and must be a regular file. The etag is the first 32 hex
  digits of the SHA-256 of the bytes: a change of one byte in the same second still changes it.
- **Save.** `PUT /api/agents/<name>/file` with `{ path, text, etag }`. The file is read again; when its etag is not the
  one sent the answer is 409 (`conflict`, field `etag`) and nothing is written. Otherwise the text is written whole to a
  temporary file beside it (mode of the file) and renamed over it, so a full disk or a crash leaves the old file. A
  read-only file is 403. A save of a file that changed during the save is a 409. At most 1 MiB of text, no NUL
  character. shortcut: a write by another process between the last check and the rename is lost; a lock file would close it.
- **Create.** `POST /api/agents/<name>/file` with `{ path, text? }` makes a new file in a folder that exists, mode 0644, with
  `O_EXCL`: a name that exists, a link included (also a dangling one), is a 409 and nothing is written through it. No folder
  is made.
- **Body limit.** A save may carry 6 MiB + 8 KiB of JSON (1 MiB of text in the worst case of `\u0000` escapes); every other
  route keeps the 256 KiB limit.
- **Authentication and routes** are those of every `/api` route: the browser token, the Host and Origin checks. An agent's
  token does not open them. No frame goes out; the page asks again.
- **What this does not stop.** An agent that is not in a Clean Room runs as the same user as gonogo and can write any
  of these files itself. The checks guard against a wrong or forged request from the browser, and keep the page from
  showing gonogo's state; they are not a boundary against the agent.

## The page

- **Where.** A view of its own, HANGAR (`Hangar.tsx`, `editor.ts`, `hangar.css`; `store.view` is `hangar`), reached with
  OPEN FILES in the actions of a console (the side panel, or MORE on a phone). It follows `store.selected`; an AGENT field
  switches the agent. FILES and GIT are the two tabs of the pair; ROOM goes back. No key was added to the top bar or the phone
  bar, which are full.
- **The tree.** Folders are buttons with `aria-expanded`, loaded when they open; files are buttons, the open one is
  `aria-current`. NEW FILE asks for a path, with the open file's folder filled in. REFRESH lists the open folders again.
- **The editor.** A plain monospaced `<textarea>` with a column of line numbers beside it (same font and line height,
  scrolled together), no wrapping. Tab writes a tab if the file has a line that starts with one, else the indent of its first
  indented line (4 or 2 spaces); with a selection across lines it indents every line, Shift+Tab takes the indent back.
  Edits go through `execCommand`, so the browser's undo keeps working. To keep Tab from trapping the keyboard, Escape then
  Tab leaves the box. Ctrl or Cmd+S saves. On a phone the text is 16 px (a smaller one makes a phone zoom in).
- **Line endings.** A textarea turns every line end into LF. A file with only CRLF is edited as LF and saved back as CRLF; one
  that mixes the two, or has a lone CR, is opened read-only, because it could not go back as it was.
- **Unsaved edits.** The status chip says UNSAVED CHANGES. Opening another file asks first (DISCARD AND OPEN or KEEP
  EDITING). An edit that is not saved when the page is left waits in memory (`drafts` in `editor.ts`) and returns with the agent;
  closing the tab asks the browser's own question. A refused save keeps the text, says why, and offers DISCARD MY CHANGES AND
  RELOAD.
- **No CodeMirror.** The brief allowed CodeMirror 6 only if it added under 120 KB gzipped. Measured on 2026-11-18, with
  esbuild, minified, in a scratch project: `@codemirror/state`, `view` and `commands` with line numbers, history, the active
  line and `indentWithTab` are 277.9 KB raw and 90.1 KB gzipped, and that is with no syntax highlighting (each language
  pack adds more). It would be under the limit and not worth it: a textarea does what the page needs, works with every
  screen reader and phone keyboard, and keeps the client small: the whole of Hangar and Recorder adds 5.8 KB gzipped to the client
  script (206.6 KB before, 212.4 KB after), against 90.1 KB for CodeMirror's smallest setup. Revisit it when syntax colour or very large files are wanted.

## Tests

`test/hangar.test.ts` (paths, listing, reading, saving and creating on real folders: `..`, absolute paths, `.git` in four
spellings, links out and into `.git`, a pipe, binary and non-UTF-8 files, the size limit, a changed etag, a read-only file,
gonogo's home inside the folder, the Clean Room folder), `test/hangar-routes.test.ts` (routes, the token, statuses, limits),
`test/client-hangar.test.ts` (line endings, Tab, the colours of the pages in the four liveries). Not run: a Clean Room worktree
made by real Docker, a real phone, Firefox, Safari, a screen reader.
