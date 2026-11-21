import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '../src/shared/protocol.js';
import { captureFetch, CAPTURE_DEFAULT, CAPTURE_MAX, createRedactor, parseCaptureEnv } from '../src/server/telegramcapture.js';
import { createTelegramFiles } from '../src/server/telegramfiles.js';

// Telegram capture (src/server/telegramcapture.ts): what is kept of the real Bot API's answers, and what never is.

const TOKEN = '123456789:AAFakeTokenFakeTokenFakeTokenFake_x-1';
const CHAT = 4_815_162_342;
let dir: string;
let logs: string[];
const log: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (m) => void logs.push(m),
  error: (m) => void logs.push(m),
  child: () => log,
};
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gonogo-cap-'));
  logs = [];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** What the Bot API sends for a photo with a caption, as documented; the values are the sort that must not be kept. */
const photoUpdate = (over: Record<string, unknown> = {}): unknown => ({
  update_id: 551_234_001,
  message: {
    message_id: 90_017,
    from: { id: CHAT, is_bot: false, first_name: 'Ulm', last_name: 'Ugaz', username: 'ulm_real', language_code: 'es' },
    chat: { id: CHAT, first_name: 'Ulm', username: 'ulm_real', type: 'private' },
    date: 1_795_235_123,
    photo: [
      { file_id: 'AgACAgQAAxkBAAIBsmFileIdSmall', file_unique_id: 'AQADuniqueSmall', file_size: 1234, width: 90, height: 51 },
      { file_id: 'AgACAgQAAxkBAAIBsmFileIdBig', file_unique_id: 'AQADuniqueBig', file_size: 98_765, width: 1280, height: 720 },
    ],
    caption: 'the build fails here, see https://example.test/secret-link',
    ...over,
  },
});

describe('the environment variable', () => {
  it('is a folder and an optional count, clamped; anything not an absolute folder is off', () => {
    expect(parseCaptureEnv(undefined)).toBeNull();
    expect(parseCaptureEnv('')).toBeNull();
    expect(parseCaptureEnv('relative/dir')).toBeNull();
    expect(parseCaptureEnv('/tmp/cap')).toEqual({ dir: '/tmp/cap', max: CAPTURE_DEFAULT });
    expect(parseCaptureEnv('/tmp/cap:7')).toEqual({ dir: '/tmp/cap', max: 7 });
    expect(parseCaptureEnv('/tmp/cap:0')?.max).toBe(1);
    expect(parseCaptureEnv('/tmp/cap:999')?.max).toBe(CAPTURE_MAX);
    expect(parseCaptureEnv('/tmp/with:colon')).toEqual({ dir: '/tmp/with:colon', max: CAPTURE_DEFAULT });
  });
});

describe('redaction', () => {
  it('keeps the shape and drops everything that is content or identity', () => {
    const redactor = createRedactor();
    const out = redactor.redact(photoUpdate());
    const text = JSON.stringify(out);
    for (const secret of ['Ulm', 'Ugaz', 'ulm_real', 'AgACAgQ', 'AQADunique', 'secret-link', 'build fails', String(CHAT), '551234001', '90017', '1795235123']) expect(text, secret).not.toContain(secret);
    const m = (out as { message: Record<string, unknown> }).message;
    expect(Object.keys(m).sort()).toEqual(['caption', 'chat', 'date', 'from', 'message_id', 'photo']);
    expect(m.caption).toBe('<redacted>');
    expect((m.chat as Record<string, unknown>).type).toBe('private');
    expect((m.from as Record<string, unknown>).language_code).toBe('es');
    expect((m.from as Record<string, unknown>).is_bot).toBe(false);
    const photo = m.photo as Array<Record<string, unknown>>;
    expect(photo.map((p) => [p.width, p.height, p.file_size])).toEqual([[90, 51, 1234], [1280, 720, 98_765]]);
    expect(photo.every((p) => p.file_id === '<redacted>' && p.file_unique_id === '<redacted>')).toBe(true);
    // the same real id is the same fake one, in the chat and in from, and in another update
    expect((m.chat as { id: number }).id).toBe((m.from as { id: number }).id);
    const again = redactor.redact(photoUpdate({ message_id: 90_018 })) as { message: { chat: { id: number }; message_id: number } };
    expect(again.message.chat.id).toBe((m.chat as { id: number }).id);
    expect(again.message.message_id).not.toBe(m.message_id);
    expect(redactor.seen()).toEqual(expect.arrayContaining([String(CHAT), '551234001', '90017']));
  });

  it('keeps the folder and the extension of a file_path and nothing of its name, and refuses a path that is not that shape', () => {
    const r = createRedactor();
    expect(r.redact({ ok: true, result: { file_id: 'x', file_path: 'photos/file_12345.jpg', file_size: 777 } })).toEqual({ ok: true, result: { file_id: '<redacted>', file_path: 'photos/file_1.jpg', file_size: 777 } });
    expect(r.redact({ file_path: 'documents/file_9.pdf' })).toEqual({ file_path: 'documents/file_1.pdf' });
    expect(r.redact({ file_path: '../../etc/passwd' })).toEqual({ file_path: '<redacted>' });
    expect(r.redact({ file_path: 'documents/My Tax Return.pdf' })).toEqual({ file_path: '<redacted>' });
  });

  it('keeps an error answer: its code and its description are the shape of the over-20-MB case', () => {
    expect(createRedactor().redact({ ok: false, error_code: 400, description: 'Bad Request: file is too big' })).toEqual({ ok: false, error_code: 400, description: 'Bad Request: file is too big' });
  });
});

/** A Bot API that answers getUpdates, getFile and the download, and counts what was read of the download. */
function fakeApi(updates: unknown[][], files: Array<{ status: number; body: unknown }>): { fetch: (url: string, init?: RequestInit) => Promise<Response>; downloadReads: () => number } {
  let reads = 0;
  let u = 0;
  let f = 0;
  return {
    downloadReads: () => reads,
    fetch: async (url) => {
      if (url.endsWith('/getUpdates')) return new Response(JSON.stringify({ ok: true, result: updates[u++] ?? [] }));
      if (url.endsWith('/getFile')) {
        const next = files[f++] ?? files[files.length - 1];
        return new Response(JSON.stringify(next?.body), { status: next?.status ?? 200 });
      }
      if (url.includes('/file/bot')) {
        return new Response(new ReadableStream({ pull: (c) => (reads++, c.enqueue(new Uint8Array([0x89, 0x50])), c.close()) }));
      }
      return new Response('no', { status: 404 });
    },
  };
}
const GETUPDATES = `https://api.telegram.org/bot${TOKEN}/getUpdates`;
const GETFILE = `https://api.telegram.org/bot${TOKEN}/getFile`;

describe('numbers', () => {
  it('a shared location, a count and a call duration are 0; ids and dates are fake; the shape of a file is kept', () => {
    const out = createRedactor().redact({
      update_id: 77_777_777,
      message: {
        message_id: 5_555_555,
        date: 1_795_236_000,
        chat: { id: CHAT, type: 'private' },
        location: { latitude: -12.046374, longitude: -77.042793, horizontal_accuracy: 12.5, live_period: 3600, heading: 90, proximity_alert_radius: 150 },
        venue: { location: { latitude: 51.5007, longitude: -0.1246 }, title: 'Big Ben', foursquare_id: 'x' },
        document: { file_id: 'a', file_unique_id: 'b', file_size: 4096, thumbnail: { width: 90, height: 51, file_size: 800 } },
        voice: { duration: 7, file_size: 1000 },
        poll: { total_voter_count: 41, options: [{ text: 'a', voter_count: 17 }] },
        entities: [{ type: 'bold', offset: 3, length: 5 }],
        giveaway: { winner_count: 3, premium_subscription_month_count: 6 },
      },
    });
    const text = JSON.stringify(out);
    for (const real of ['12.046374', '77.042793', '51.5007', '0.1246', '12.5', '3600', '77777777', '5555555', '1795236000', String(CHAT), 'Big Ben']) expect(text, real).not.toContain(real);
    const m = (out as { message: Record<string, Record<string, unknown>> }).message;
    expect(m.location).toEqual({ latitude: 0, longitude: 0, horizontal_accuracy: 0, live_period: 0, heading: 0, proximity_alert_radius: 0 });
    expect((m.venue?.location as Record<string, number>)).toEqual({ latitude: 0, longitude: 0 });
    expect(m.poll).toMatchObject({ total_voter_count: 0 });
    expect(m.giveaway).toEqual({ winner_count: 0, premium_subscription_month_count: 0 });
    expect(m.document).toMatchObject({ file_size: 4096, thumbnail: { width: 90, height: 51, file_size: 800 } });
    expect(m.voice).toEqual({ duration: 7, file_size: 1000 });
    expect(out).toMatchObject({ message: { entities: [{ type: 'bold', offset: 3, length: 5 }] } });
  });

  it('a description is kept only at the top of an error answer', () => {
    const r = createRedactor();
    expect(r.redact({ ok: false, error_code: 400, description: 'Bad Request: file is too big' })).toEqual({ ok: false, error_code: 400, description: 'Bad Request: file is too big' });
    // a description inside a message (a group's, a poll's, a venue's) is somebody's text
    expect(r.redact({ message: { chat: { type: 'group', description: 'our secret plans' } } })).toEqual({ message: { chat: { type: 'group', description: '<redacted>' } } });
    // and at the top of an answer that did not fail
    expect(r.redact({ ok: true, description: 'something' })).toEqual({ ok: true, description: '<redacted>' });
  });
});

describe('the wrapped fetch', () => {
  const open = (api: ReturnType<typeof fakeApi>, max = 12) => captureFetch(api.fetch, { dir: join(dir, 'cap'), max, token: () => TOKEN, log });
  const names = async (): Promise<string[]> => (await readdir(join(dir, 'cap')).catch(() => [])).sort();

  it('gives the caller the answer untouched and writes one file per update and one per getFile answer, redacted, 0600 in a 0700 folder', async () => {
    const api = fakeApi([[photoUpdate(), photoUpdate({ message_id: 90_099 })]], [{ status: 200, body: { ok: true, result: { file_id: 'a', file_unique_id: 'b', file_size: 98_765, file_path: 'photos/file_7.jpg' } } }, { status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: file is too big' } }]);
    const fetcher = open(api);
    const updates = (await (await fetcher(GETUPDATES)).json()) as { result: unknown[] };
    expect(updates.result).toHaveLength(2);
    expect(((await (await fetcher(GETFILE)).json()) as { ok: boolean }).ok).toBe(true);
    expect((await fetcher(GETFILE)).status).toBe(400);
    await fetcher.flush();
    expect(await names()).toEqual(['01-getUpdates.json', '02-getUpdates.json', '03-getFile.json', '04-getFile.json']);
    const third = JSON.parse(await readFile(join(dir, 'cap', '03-getFile.json'), 'utf8')) as { method: string; status: number; body: { result: { file_path: string } } };
    expect(third).toMatchObject({ method: 'getFile', status: 200, body: { ok: true, result: { file_path: 'photos/file_1.jpg', file_size: 98_765 } } });
    expect(JSON.parse(await readFile(join(dir, 'cap', '04-getFile.json'), 'utf8'))).toMatchObject({ status: 400, body: { description: 'Bad Request: file is too big' } });
    expect((await stat(join(dir, 'cap'))).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, 'cap', '01-getUpdates.json'))).mode & 0o777).toBe(0o600);
    const all = (await Promise.all((await names()).map((n) => readFile(join(dir, 'cap', n), 'utf8')))).join('\n');
    for (const secret of ['Ulm', 'ulm_real', 'AgACAg', 'secret-link', String(CHAT), TOKEN, 'AAFakeToken']) expect(all, secret).not.toContain(secret);
  });

  it('never reads the file download: no byte of a file is kept, and nothing is recorded for it', async () => {
    const api = fakeApi([], []);
    const fetcher = open(api);
    const res = await fetcher(`https://api.telegram.org/file/bot${TOKEN}/photos/file_7.jpg`);
    await fetcher.flush();
    expect(api.downloadReads()).toBeLessThanOrEqual(1);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0x89, 0x50]));
    expect(await names()).toEqual([]);
  });

  it('does not count a quiet getUpdates, stops after N, and records no other method', async () => {
    const api = fakeApi([[], [], [photoUpdate()], [photoUpdate()], [photoUpdate()]], []);
    const fetcher = open(api, 2);
    for (let i = 0; i < 5; i += 1) await fetcher(GETUPDATES);
    await fetcher(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    await fetcher(`https://api.telegram.org/bot${TOKEN}/getMe`);
    await fetcher.flush();
    expect(await names()).toEqual(['01-getUpdates.json', '02-getUpdates.json']);
  });

  it('refuses a file that still holds the token or a real id after redaction, and says so without saying what', async () => {
    // a description is kept as it is, so a token in it must stop the file
    const api = fakeApi([], [{ status: 400, body: { ok: false, error_code: 400, description: `Bad Request: bot${TOKEN} is wrong` } }, { status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: file is too big' } }]);
    const fetcher = open(api);
    await fetcher(GETFILE);
    await fetcher(GETFILE);
    await fetcher.flush();
    expect(await names()).toEqual(['01-getFile.json']);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('not written');
    expect(logs.join('\n')).not.toContain(TOKEN);
  });

  it('a failing write is a warning and the caller never notices', async () => {
    const api = fakeApi([[photoUpdate()]], []);
    // a plain file where the folder should be: mkdir fails with ENOTDIR
    await writeFile(join(dir, 'plain'), 'x');
    const fetcher = captureFetch(api.fetch, { dir: join(dir, 'plain', 'cap'), max: 3, token: () => TOKEN, log });
    expect((await fetcher(GETUPDATES)).status).toBe(200);
    await fetcher.flush();
    expect(logs.some((l) => l.includes('not written'))).toBe(true);
  });
});

describe('with the file download', () => {
  it('a photo goes through createTelegramFiles with the wrapped fetch: getFile is kept, the bytes are not', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const inner = async (url: string): Promise<Response> =>
      url.endsWith('/getFile') ? new Response(JSON.stringify({ ok: true, result: { file_id: 'p', file_unique_id: 'u', file_size: png.length, file_path: 'photos/file_3.png' } })) : new Response(png);
    const capturing = captureFetch(inner, { dir: join(dir, 'cap'), max: 5, token: () => TOKEN, log });
    const files = createTelegramFiles({ fetch: capturing, token: () => TOKEN, agentDir: (n) => join(dir, 'agents', n), agentsRoot: join(dir, 'agents'), now: () => 1, log });
    const got = await files.fetchFile({ fileId: 'p', messageId: '40', name: 'photo', mime: null, size: null }, 'boss');
    expect('path' in got).toBe(true);
    await capturing.flush();
    const kept = await readdir(join(dir, 'cap'));
    expect(kept).toEqual(['01-getFile.json']);
    expect(await readFile(join(dir, 'cap', kept[0] as string), 'utf8')).not.toContain('PNG');
  });
});
