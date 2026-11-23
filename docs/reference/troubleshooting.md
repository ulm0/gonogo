# Troubleshooting

<HeldMock class="doc-mock" />

- **An agent is "needs you".** The reason is on the agent bar and in the activity strip. Answer it in the agent's terminal: `startup dialog: answer it in the terminal` is usually Claude Code's once-per-folder trust question; permission requests are answered there too.
- **`held: text in <name>'s input`**: the input box holds text you typed. Submit it, or clear it with Ctrl-C (or Esc twice); the mail goes in within about two seconds.
- **`held: no hook has reached gonogo from <name>; is its folder trusted?`**: Claude Code holds hooks back in an untrusted folder. Outside seed mode, answer the trust dialog in the terminal; in seed mode, restart the agent. Otherwise something blocks the hook URL.
- **`held: pointer not confirmed within 2 s`**: Claude Code did not report the typed pointer as submitted, and gonogo does not retry. Press Enter in that terminal to send it, or Ctrl-C to clear it.
- **`not read: <name> did not read it after two pointers`**: the agent never called `read_messages`. Ask it to in its terminal.
- **An agent stays "starting".** Open its terminal; an unrecognised dialog shows there.
- **A rename says the name is taken by a notes folder left over from a removed agent.** `agents/<name>/` is still in the home ([State on disk](./configuration.md#state-on-disk)). Pick another name, or delete the folder if you do not need its `memory.md`. Hiring under that name works and reuses the old notes.
- **`<file> was saved by a newer gonogo (format version N; ...)`.** Start the newer gonogo, move the file away, or restore its `.bak-v<n>` copy ([Versions of the saved state](./configuration.md#versions-of-the-saved-state)).
- **`another gonogo is using <dir>`.** Stop the other one, or delete `server.lock` in that directory if none is running.

- **An agent is "needs you" with "Claude Code isn't signed in".** Its console shows "Not logged in · Run /login". Open the agent's console and run `/login` there, or give the container the credential (`CLAUDE_CODE_OAUTH_TOKEN`, see the Docker guide). Until then the agent is not counted as ready and its mail waits (`waiting: <name> isn't signed in`). A first start of Claude Code on a computer shows its own setup (theme, login) first: the reason says "first run of Claude Code: finish its setup in the console".
