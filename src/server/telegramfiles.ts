/**
 * Telegram files: a photo or a document in the Director's chat reaches the agent as a file under its own folder
 * (`inbox-files/<message id>-<name>`, 0600) and a path in the message. `attachmentOf` reads the update (pure); `createTelegramFiles` downloads
 * through getFile and `https://api.telegram.org/file/bot<token>/<file_path>`. The Bot API stops at 20 MB (getFile) and gonogo adds no
 * cap of its own. What is stored is decided by the bytes, never by the sender: the type is checked by its magic bytes as well as by
 * the mime type, the name is rebuilt from letters and digits, and no path from the update is used. The token is in the address of
 * every call: nothing here puts it, or an address, into a message, a log or an error.
 *
 * shortcut: a file that is the right type by its magic bytes is not scanned for anything else (a PDF with a script, an image with a payload
 * after its end); the agent opens it with its file reader, not a program. Add a scan if a real run needs one.
 */
import { lstat, mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from './hooks.js';
import { TELEGRAM_FILE_MAX_BYTES, TELEGRAM_FILES_DIR, TELEGRAM_FILES_KEEP_MS, TELEGRAM_FILES_MAX, TELEGRAM_FILE_TIMEOUT_MS, UPLINK_RATE_WINDOW_MS } from './constants.js';
import type { Logger } from '../shared/protocol.js';

/** What a message carries to download (the ids come from the update; the path is never taken from it). */
export interface TelegramFile {
  fileId: string;
  /** The message id (digits): the start of the name on disk. */
  messageId: string;
  /** The name the sender gave, or `photo`; only its letters and digits are used. */
  name: string;
  /** The mime type the sender gave (a document), or null (a photo: Telegram makes it a JPEG). */
  mime: string | null;
  size: number | null;
}

/** The types that are accepted, by their magic bytes. */
const TYPES: Record<string, { mime: string; ext: string }> = {
  png: { mime: 'image/png', ext: 'png' },
  jpeg: { mime: 'image/jpeg', ext: 'jpg' },
  gif: { mime: 'image/gif', ext: 'gif' },
  webp: { mime: 'image/webp', ext: 'webp' },
  pdf: { mime: 'application/pdf', ext: 'pdf' },
};
export const FILE_ACCEPTED_TEXT = 'png, jpg, webp, gif and PDF';

/** The type of the first bytes of a file, or null. */
export function sniff(bytes: Uint8Array): { mime: string; ext: string } | null {
  const at = (offset: number, text: string): boolean => text.split('').every((c, i) => bytes[offset + i] === c.charCodeAt(0));
  if (bytes[0] === 0x89 && at(1, 'PNG\r\n') && bytes[6] === 0x1a && bytes[7] === 0x0a) return TYPES.png ?? null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return TYPES.jpeg ?? null;
  if (at(0, 'GIF87a') || at(0, 'GIF89a')) return TYPES.gif ?? null;
  if (at(0, 'RIFF') && at(8, 'WEBP')) return TYPES.webp ?? null;
  if (at(0, '%PDF-')) return TYPES.pdf ?? null;
  return null;
}

const MIME_ALIAS: Record<string, string> = { 'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg' };
const mimeOf = (mime: string): string => {
  const base = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  return MIME_ALIAS[base] ?? base;
};
const ACCEPTED_MIMES = new Set(Object.values(TYPES).map((t) => t.mime));

const digits = (value: unknown): string => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : typeof value === 'string' && /^\d{1,15}$/.test(value) ? value : '');
const size = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);

/**
 * The file of a Telegram message: the largest size of a photo, or a document that is an image or a PDF by its mime type.
 * `{ refused }` is a document of another type (the agent is told, nothing is downloaded); null is a message without a file.
 */
export function attachmentOf(message: unknown): TelegramFile | { refused: string } | null {
  if (!isRecord(message)) return null;
  const messageId = digits(message.message_id);
  if (messageId === '') return null;
  const photo = message.photo;
  if (Array.isArray(photo)) {
    let best: { fileId: string; size: number | null; area: number } | null = null;
    for (const p of photo) {
      if (!isRecord(p) || typeof p.file_id !== 'string' || p.file_id === '') continue;
      const area = (typeof p.width === 'number' ? p.width : 0) * (typeof p.height === 'number' ? p.height : 0);
      const bytes = size(p.file_size);
      if (best === null || (bytes ?? 0) > (best.size ?? 0) || ((bytes ?? 0) === (best.size ?? 0) && area > best.area)) best = { fileId: p.file_id, size: bytes, area };
    }
    if (best !== null) return { fileId: best.fileId, messageId, name: 'photo', mime: null, size: best.size };
  }
  const doc = message.document;
  if (isRecord(doc) && typeof doc.file_id === 'string' && doc.file_id !== '') {
    const mime = typeof doc.mime_type === 'string' ? mimeOf(doc.mime_type) : '';
    if (!ACCEPTED_MIMES.has(mime)) return { refused: mime.slice(0, 60).replace(/[^\x21-\x7e]/g, '') || 'unknown' };
    return { fileId: doc.file_id, messageId, name: typeof doc.file_name === 'string' ? doc.file_name : 'file', mime, size: size(doc.file_size) };
  }
  return null;
}

/** A name that is safe to put on a disk and in a message: letters, digits, `.`, `_`, `-`, no leading dot, no extension of its own. */
export function safeStem(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const stem = base.replace(/\.[A-Za-z0-9]{1,5}$/, '').normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+/, '').slice(0, 60);
  return stem === '' ? 'file' : stem;
}

export type FileResult = { path: string } | { problem: string };

export interface TelegramFilesOptions {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** The bot token of the target, or null when there is none. */
  token(): string | null;
  /** The folder of an agent (throws for a name that is not one). */
  agentDir(agent: string): string;
  /** The folder of all the agents: `prune` looks in each of them. */
  agentsRoot: string;
  now(): number;
  log: Logger;
}

export interface TelegramFiles {
  /** Downloads `file` into the folder of `agent`. Never throws and never says the token: a refusal is a `problem`, a text for the agent. */
  fetchFile(file: TelegramFile, agent: string): Promise<FileResult>;
  /** Removes the files of every agent's `inbox-files` that are older than 30 days (a start of gonogo does it); the number removed. Never throws. */
  prune(): Promise<number>;
}

const TOO_BIG = `(The file was too big for the Telegram Bot API, which gives a bot files of up to ${TELEGRAM_FILE_MAX_BYTES / 1024 / 1024} MB: it was not downloaded.)`;
const FAILED = '(The file could not be downloaded from Telegram.)';

export function createTelegramFiles(options: TelegramFilesOptions): TelegramFiles {
  const { fetch, log } = options;
  let taken: number[] = [];

  /** One download of the last minute, or false. */
  const takeSlot = (): boolean => {
    const t = options.now();
    taken = taken.filter((at) => t - at < UPLINK_RATE_WINDOW_MS);
    if (taken.length >= TELEGRAM_FILES_MAX) return false;
    taken.push(t);
    return true;
  };

  async function download(file: TelegramFile, agent: string): Promise<FileResult> {
    const token = options.token();
    if (token === null) return { problem: FAILED };
    if (file.size !== null && file.size > TELEGRAM_FILE_MAX_BYTES) return { problem: TOO_BIG };
    if (!takeSlot()) return { problem: `(The file was not downloaded: more than ${TELEGRAM_FILES_MAX} files in a minute.)` };
    // redirect: error: a redirect would carry the token (it is in the address) somewhere else
    const init = (extra: RequestInit): RequestInit => ({ redirect: 'error', signal: AbortSignal.timeout(TELEGRAM_FILE_TIMEOUT_MS), ...extra });
    const info = await fetch(`https://api.telegram.org/bot${token}/getFile`, init({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: file.fileId }) }));
    const answer: unknown = await info.json().catch(() => null);
    if (!isRecord(answer) || answer.ok !== true) {
      // the Bot API answers 400 "file is too big" past its 20 MB; the description is read here and never passed on
      return { problem: isRecord(answer) && typeof answer.description === 'string' && /too big/i.test(answer.description) ? TOO_BIG : FAILED };
    }
    const result = answer.result;
    const filePath = isRecord(result) ? result.file_path : undefined;
    // the path is only a place on Telegram's server: it is not used on our disk, and a path with `..` or a scheme is not asked for
    if (typeof filePath !== 'string' || !/^[A-Za-z0-9_./-]{1,200}$/.test(filePath) || filePath.split('/').includes('..')) return { problem: FAILED };
    if (isRecord(result) && typeof result.file_size === 'number' && result.file_size > TELEGRAM_FILE_MAX_BYTES) return { problem: TOO_BIG };
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`, init({}));
    if (!res.ok) return { problem: FAILED };
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > TELEGRAM_FILE_MAX_BYTES) return { problem: TOO_BIG };
    const type = sniff(bytes);
    // the type that the bytes show must be an accepted one and the one the sender said (a photo is whatever Telegram made of it)
    if (type === null || (file.mime !== null && file.mime !== type.mime)) return { problem: `(The file was refused: its content is not ${file.mime === null ? 'an image' : `a ${file.mime}`}; only ${FILE_ACCEPTED_TEXT} are taken.)` };
    const dir = join(options.agentDir(agent), TELEGRAM_FILES_DIR);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${file.messageId}-${safeStem(file.name)}.${type.ext}`);
    // wx: a file that is there (the same message again) is not overwritten
    await writeFile(path, bytes, { mode: 0o600, flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    return { path };
  }

  return {
    async prune() {
      let removed = 0;
      for (const agent of await readdir(options.agentsRoot).catch(() => [])) {
        const folder = join(options.agentsRoot, agent, TELEGRAM_FILES_DIR);
        for (const name of await readdir(folder).catch(() => [])) {
          try {
            // lstat: a link is not followed, and only a plain file is removed
            const info = await lstat(join(folder, name));
            if (info.isFile() && options.now() - info.mtimeMs > TELEGRAM_FILES_KEEP_MS) {
              await unlink(join(folder, name));
              removed += 1;
            }
          } catch {
            // gone already, or not ours to remove: the next start tries again
          }
        }
      }
      if (removed > 0) log.info(`telegram files: ${removed} older than 30 days removed`);
      return removed;
    },

    async fetchFile(file, agent) {
      try {
        return await download(file, agent);
      } catch (error) {
        // the reason stays here, without its text: a network error can quote the address, and the address has the token
        log.warn(`telegram files: a download failed (${error instanceof Error ? error.name : 'error'})`);
        return { problem: FAILED };
      }
    },
  };
}
