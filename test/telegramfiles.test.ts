import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TELEGRAM_FILE_MAX_BYTES, TELEGRAM_FILES_MAX } from '../src/server/constants.js';
import { attachmentOf, createTelegramFiles, safeStem, sniff } from '../src/server/telegramfiles.js';
import { createUplinks } from '../src/server/uplinks.js';
import type { Inbound, Uplinks } from '../src/server/uplinks.js';
import type { Logger, SendResult, UserMessageRequest } from '../src/shared/protocol.js';

// Photos and documents of the Director's Telegram chat (src/server/telegramfiles.ts), through the same read as a text, by polling and by webhook.

const TOKEN = '123456789:AAFakeTokenFakeTokenFakeTokenFake_x-1';
const CHAT = '777';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest of the png')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('rest of the jpeg')]);
const PDF = Buffer.from('%PDF-1.7\n%rest');

let dir: string;
let logs: string[];
let sent: Array<{ request: UserMessageRequest; director?: { said: string } }>;
let urls: string[];
let files: Map<string, Buffer | 'too big' | 'error'>;
let uplinks: Uplinks;
let clock: number;
const quiet: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (message, ...extra) => void logs.push([message, ...extra.map(String)].join(' ')),
  error: (message, ...extra) => void logs.push([message, ...extra.map(String)].join(' ')),
  child: () => quiet,
};
const inbound: Inbound = { find: () => undefined, seen: () => false, telegramChat: () => CHAT };

/** The Bot API, stubbed: getFile for an id of `files`, and the bytes under /file/bot<token>/<path>. */
const stub = async (url: string, init?: RequestInit): Promise<Response> => {
  urls.push(url);
  if (url === `https://api.telegram.org/bot${TOKEN}/getFile`) {
    const id = (JSON.parse(String(init?.body)) as { file_id: string }).file_id;
    const file = files.get(id);
    if (file === 'error') throw new Error(`connect ECONNRESET ${url}`);
    if (file === 'too big') return new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: file is too big' }), { status: 400 });
    if (file === undefined) return new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: wrong file_id' }), { status: 400 });
    return new Response(JSON.stringify({ ok: true, result: { file_id: id, file_size: file.length, file_path: `photos/${id}.jpg` } }));
  }
  const m = /^https:\/\/api\.telegram\.org\/file\/bot[^/]+\/photos\/(.+)\.jpg$/.exec(url);
  const file = m === null ? undefined : files.get(m[1] ?? '');
  return file instanceof Buffer ? new Response(new Uint8Array(file)) : new Response('no', { status: 404 });
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gng-tgfiles-'));
  logs = [];
  sent = [];
  urls = [];
  files = new Map();
  clock = Date.UTC(2026, 10, 20, 9, 0);
  const fetcher = createTelegramFiles({ fetch: stub, token: () => TOKEN, agentDir: (name) => join(dir, 'agents', name), now: () => clock, log: quiet });
  uplinks = createUplinks({
    dir,
    now: () => clock,
    inbound,
    fetchFile: (file, agent) => fetcher.fetchFile(file, agent),
    send: (request, director): SendResult => {
      sent.push({ request, ...(director === undefined ? {} : { director }) });
      return { ok: true, id: `m${sent.length}`, to: request.to, status: 'queued', note: null };
    },
    emit: () => undefined,
    log: quiet,
  });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const update = (message: Record<string, unknown>): Buffer =>
  Buffer.from(JSON.stringify({ update_id: 1, message: { message_id: 40, from: { id: 777, first_name: 'Ulm' }, chat: { id: 777, type: 'private' }, ...message } }));
const poll = async (message: Record<string, unknown>): Promise<void> => {
  uplinks.deliverPolled(update(message), 'k');
  await uplinks.close();
};
const body = (): string => sent.map((s) => s.request.body).join('\n---\n');
const stored = async (): Promise<string[]> => readdir(join(dir, 'agents', 'boss', 'inbox-files')).catch(() => []);

describe('what is read from the update', () => {
  it('takes the largest size of a photo', () => {
    const got = attachmentOf({ message_id: 40, photo: [{ file_id: 'small', width: 90, height: 60, file_size: 900 }, { file_id: 'big', width: 1280, height: 960, file_size: 90000 }, { file_id: 'mid', width: 320, height: 240, file_size: 9000 }] });
    expect(got).toMatchObject({ fileId: 'big', messageId: '40', name: 'photo', mime: null });
  });

  it('takes an image or a PDF as a document, and names any other type as refused', () => {
    expect(attachmentOf({ message_id: 7, document: { file_id: 'd', file_name: 'a.pdf', mime_type: 'application/pdf' } })).toMatchObject({ fileId: 'd', mime: 'application/pdf' });
    expect(attachmentOf({ message_id: 7, document: { file_id: 'd', file_name: 'a.jpg', mime_type: 'image/jpg' } })).toMatchObject({ mime: 'image/jpeg' });
    expect(attachmentOf({ message_id: 7, document: { file_id: 'd', mime_type: 'text/html' } })).toEqual({ refused: 'text/html' });
    expect(attachmentOf({ message_id: 7, document: { file_id: 'd' } })).toEqual({ refused: 'unknown' });
    expect(attachmentOf({ message_id: 7, text: 'hi' })).toBeNull();
  });

  it('knows the types by their first bytes, not by what is said', () => {
    expect(sniff(PNG)?.ext).toBe('png');
    expect(sniff(JPEG)?.ext).toBe('jpg');
    expect(sniff(PDF)?.ext).toBe('pdf');
    expect(sniff(Buffer.from('GIF89a....'))?.ext).toBe('gif');
    expect(sniff(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))?.ext).toBe('webp');
    expect(sniff(Buffer.from('<html><script>'))).toBeNull();
    expect(sniff(Buffer.alloc(0))).toBeNull();
  });

  it('makes a name of letters and digits only', () => {
    expect(safeStem('../../etc/passwd.pdf')).toBe('passwd');
    expect(safeStem('..\\..\\evil name (1).png')).toBe('evil_name_1_');
    expect(safeStem('.hidden')).toBe('hidden');
    expect(safeStem('')).toBe('file');
    expect(safeStem('x'.repeat(200)).length).toBe(60);
  });
});

describe('a photo or a document of the Director', () => {
  it('a photo reaches the boss as a file in its folder, with "(no caption)", as his own words', async () => {
    files.set('big', JPEG);
    await poll({ photo: [{ file_id: 'small', width: 9, height: 9, file_size: 9 }, { file_id: 'big', width: 900, height: 900, file_size: JPEG.length }] });
    const path = join(dir, 'agents', 'boss', 'inbox-files', '40-photo.jpg');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.request.to).toBe('boss');
    expect(sent[0]?.request.body).toBe(`Telegram message from Ulm in chat 777:\n\n(no caption)\n\nAttached: ${path}`);
    expect(sent[0]?.director?.said).toBe(`(no caption)\n\nAttached: ${path}`);
    expect(await readFile(path)).toEqual(JPEG);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'agents', 'boss', 'inbox-files'))).mode & 0o777).toBe(0o700);
  });

  it('a photo with a caption: the caption is the words', async () => {
    files.set('p', JPEG);
    await poll({ photo: [{ file_id: 'p', width: 9, height: 9 }], caption: 'the build fails here' });
    expect(sent[0]?.request.body).toMatch(/^Telegram message from Ulm in chat 777:\n\nthe build fails here\n\nAttached: .*40-photo\.jpg$/);
    expect(sent[0]?.director?.said).toMatch(/^the build fails here\n\nAttached: /);
  });

  it('a PDF: its own name is cleaned, and the path is the one gonogo made', async () => {
    files.set('d', PDF);
    await poll({ document: { file_id: 'd', file_name: '../../etc/Spec v2.pdf', mime_type: 'application/pdf' }, caption: 'read this' });
    expect(await stored()).toEqual(['40-Spec_v2.pdf']);
    expect(body()).toContain(join(dir, 'agents', 'boss', 'inbox-files', '40-Spec_v2.pdf'));
  });

  it('a file that says image/png and is not one is refused by its bytes: nothing is stored', async () => {
    files.set('d', Buffer.from('<html><script>alert(1)</script>'));
    await poll({ document: { file_id: 'd', file_name: 'cat.png', mime_type: 'image/png' }, caption: 'a cat' });
    expect(await stored()).toEqual([]);
    expect(body()).toMatch(/a cat\n\n\(The file was refused: its content is not a image\/png/);
    expect(body()).not.toContain('Attached:');
  });

  it('a PDF that says it is a PNG is refused too', async () => {
    files.set('d', PDF);
    await poll({ document: { file_id: 'd', file_name: 'x.png', mime_type: 'image/png' } });
    expect(await stored()).toEqual([]);
    expect(body()).toContain('was refused');
  });

  it('a document of another type is not downloaded, and the agent is told', async () => {
    await poll({ document: { file_id: 'd', file_name: 'a.zip', mime_type: 'application/zip' }, caption: 'here' });
    expect(urls).toEqual([]);
    expect(body()).toContain('here\n\n(The file was not taken: it is application/zip, and only png, jpg, webp, gif and PDF are.)');
  });

  it('too big for the Bot API: the agent gets the caption and the reason, nothing is stored', async () => {
    files.set('big', 'too big');
    await poll({ photo: [{ file_id: 'big', width: 9, height: 9 }], caption: 'the whole log' });
    expect(await stored()).toEqual([]);
    expect(body()).toContain('the whole log\n\n(The file was too big for the Telegram Bot API');
    // a size that is known is not even asked for
    urls = [];
    await poll({ document: { file_id: 'd', mime_type: 'application/pdf', file_size: TELEGRAM_FILE_MAX_BYTES + 1 } });
    expect(urls).toEqual([]);
    expect(sent[1]?.request.body).toContain('too big');
  });

  it('a forwarded photo arrives, without the mark of the Director', async () => {
    files.set('p', PNG);
    await poll({ photo: [{ file_id: 'p', width: 9, height: 9 }], forward_origin: { type: 'user' } });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.request.body).toContain('Attached:');
    expect(sent[0]?.director).toBeUndefined();
  });

  it('a photo in a group, or from another chat, is dropped before anything is fetched', async () => {
    files.set('p', PNG);
    await poll({ photo: [{ file_id: 'p', width: 9, height: 9 }], chat: { id: -100777, type: 'supergroup' } });
    await poll({ photo: [{ file_id: 'p', width: 9, height: 9 }], chat: { id: 999, type: 'private' }, from: { id: 999 } });
    expect(sent).toEqual([]);
    expect(urls).toEqual([]);
  });

  it('at most ten downloads in a minute; the eleventh is told so, and a minute later it goes again', async () => {
    files.set('p', JPEG);
    for (let i = 0; i < TELEGRAM_FILES_MAX + 1; i += 1) await poll({ message_id: 100 + i, photo: [{ file_id: 'p', width: 9, height: 9 }] });
    expect(sent.filter((s) => s.request.body.includes('Attached:'))).toHaveLength(TELEGRAM_FILES_MAX);
    expect(sent.at(-1)?.request.body).toContain('more than 10 files in a minute');
    clock += 61_000;
    await poll({ message_id: 200, photo: [{ file_id: 'p', width: 9, height: 9 }] });
    expect(sent.at(-1)?.request.body).toContain('Attached:');
  });

  it('a failing download is told to the agent, and the token is nowhere: not in a message, a note, a log', async () => {
    files.set('p', 'error');
    await poll({ photo: [{ file_id: 'p', width: 9, height: 9 }], caption: 'x' });
    files.set('q', JPEG);
    await poll({ message_id: 41, photo: [{ file_id: 'q', width: 9, height: 9 }] });
    files.set('nope', Buffer.alloc(0));
    await poll({ message_id: 42, photo: [{ file_id: 'unknown', width: 9, height: 9 }] });
    expect(body()).toContain('(The file could not be downloaded from Telegram.)');
    // the stub saw the token (it has to), nothing that left gonogo did
    expect(urls.some((u) => u.includes(TOKEN))).toBe(true);
    const out = JSON.stringify([sent, logs, JSON.stringify(uplinks.list())]);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain('AAFakeToken');
    expect(out).not.toContain('api.telegram.org');
  });

  it('a path from Telegram that goes up or elsewhere is not asked for', async () => {
    const evil = createTelegramFiles({
      fetch: async (url) => (url.endsWith('/getFile') ? new Response(JSON.stringify({ ok: true, result: { file_path: '../../etc/passwd' } })) : new Response(JSON.stringify({ ok: true, result: { file_path: 'https://evil.example/x' } }))),
      token: () => TOKEN,
      agentDir: (name) => join(dir, name),
      now: () => clock,
      log: quiet,
    });
    expect(await evil.fetchFile({ fileId: 'a', messageId: '1', name: 'x', mime: null, size: null }, 'boss')).toMatchObject({ problem: expect.stringContaining('could not') });
  });

  it('a reply to something gonogo posted goes to that agent, with its own folder', async () => {
    const threads = new Map([['telegram:777:55', { id: 'm5', agent: 'ana', subject: 'Build' }]]);
    const withThreads = createUplinks({
      dir,
      now: () => clock,
      inbound: { ...inbound, find: (key) => threads.get(key) },
      fetchFile: (file, agent) => createTelegramFiles({ fetch: stub, token: () => TOKEN, agentDir: (n) => join(dir, 'agents', n), now: () => clock, log: quiet }).fetchFile(file, agent),
      send: (request, director): SendResult => (sent.push({ request, ...(director === undefined ? {} : { director }) }), { ok: true, id: 'm9', to: request.to, status: 'queued', note: null }),
      emit: () => undefined,
      log: quiet,
    });
    files.set('p', PNG);
    withThreads.deliverPolled(update({ photo: [{ file_id: 'p', width: 9, height: 9 }], reply_to_message: { message_id: 55 }, caption: 'this one' }), 'k');
    await withThreads.close();
    expect(sent[0]?.request).toMatchObject({ to: 'ana', inReplyTo: 'm5' });
    expect(await readdir(join(dir, 'agents', 'ana', 'inbox-files'))).toEqual(['40-photo.png']);
  });

  it('by webhook the endpoint answers at once, and the message follows with the file', async () => {
    const made = await uplinks.create({ name: 'Telegram', to: 'ana', kind: 'telegram' });
    files.set('p', JPEG);
    const answer = uplinks.deliver(made.id, update({ photo: [{ file_id: 'p', width: 9, height: 9 }], caption: 'by webhook' }), { 'x-telegram-bot-api-secret-token': made.secret });
    expect(answer).toEqual({ ok: true, answer: { ok: true } });
    await uplinks.close();
    expect(sent[0]?.request).toMatchObject({ to: 'ana' });
    expect(sent[0]?.request.body).toMatch(/by webhook\n\nAttached: .*agents\/ana\/inbox-files\/40-photo\.jpg$/);
    expect(uplinks.list()[0]?.deliveries[0]?.note).toMatch(/^m1/);
  });

  it('without a download set up the agent is told the file was not fetched', async () => {
    const bare = createUplinks({ dir, now: () => clock, inbound, send: (request): SendResult => (sent.push({ request }), { ok: true, id: 'm1', to: 'boss', status: 'queued', note: null }), emit: () => undefined, log: quiet });
    bare.deliverPolled(update({ photo: [{ file_id: 'p', width: 9, height: 9 }], caption: 'x' }), 'k');
    await bare.close();
    expect(sent[0]?.request.body).toContain('not fetched');
  });
});
