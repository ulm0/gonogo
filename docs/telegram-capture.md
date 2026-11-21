# Telegram capture: recording the real Bot API for the tests

For maintainers. The Telegram file code (`telegramfiles.ts`, `relaykinds.ts`) was written from the Bot API documentation. This switch records what the real API sends, so the tests can replay shapes that were seen. It is **off unless set** and has no route, flag or page.

```
GONOGO_TELEGRAM_CAPTURE=/absolute/folder[:N]   gonogo ...
```

`N` is how many files to keep (default 12, at most 50). Polling must be on (a Telegram target saved, no Telegram uplink), because the capture sits on the `fetch` that polling and file downloads share; a webhook delivery does not pass through it. Then send the bot what you want recorded: a photo, a photo with a caption, a PNG sent as a file, a PDF, a file over 20 MB, a forwarded photo, a photo in a group.

## What is written

`<folder>/NN-getUpdates.json` (one per update) and `NN-getFile.json` (the whole answer, an error included), as `{ "method", "status", "body" }`, 0600 in a 0700 folder, never replaced. Nothing else: `sendMessage`, `getMe` and the others are not recorded, and **the file download is never read**, so no byte of a file is kept.

## Redaction

By allowlist, for strings and for numbers. Every string is `"<redacted>"` except `type`, `mime_type`, `language_code` and `file_path` (which keeps its folder and extension, `photos/file_1.jpg`), and the `description` at the top of an error answer (`ok: false`: that is how the over-20-MB case reads). Names, usernames, text, captions, file names, `file_id` and `file_unique_id` all go. Identifying numbers (chat, user, message and update ids, dates) become fixed fake ones, the same real id always the same fake one. Numbers that are the shape of a file or an answer are kept (`file_size`, `width`, `height`, `duration`, `offset`, `length`, `error_code`, `retry_after`); **every other number is 0**: a shared location, a count, a poll's votes. Before a file is written its text is searched for the bot token and for every real id seen; a hit refuses the file and logs "a file was not written", without saying what.

Do not point the folder at the repository: review the files before they become fixtures under `test/fixtures/telegram/`.
