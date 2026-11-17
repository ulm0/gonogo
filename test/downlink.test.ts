import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACTIVITY_WIRE_BODY_CHARS } from '../src/shared/protocol.js';
import type { ActivityItem, DownlinkView, HubEvent, Logger, MessageRecord } from '../src/shared/protocol.js';
import { DOWNLINK_EVENTS_MAX, DOWNLINK_IDS_MAX, DOWNLINK_MAIL_MAX, DOWNLINK_TEXT_MAX_CHARS } from '../src/server/constants.js';
import { createDownlink } from '../src/server/downlink.js';
import type { Downlink } from '../src/server/downlink.js';
import { HubError } from '../src/server/hub.js';

let dir: string;
let now: number;
let past: MessageRecord[];
let emitted: DownlinkView[];
let logs: string[];
const open: Downlink[] = [];

const quiet = (sink: string[]): Logger => {
  const log: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message) => void sink.push(message),
    error: (message, ...extra) => void sink.push([message, ...extra.map(String)].join(' ')),
    child: () => log,
  };
  return log;
};

function make(): Downlink {
  const d = createDownlink({ dir, now: () => now, history: () => past, emit: (view) => void emitted.push(view), log: quiet(logs) });
  open.push(d);
  return d;
}

const record = (id: string, to: string, at: number, extra: Partial<MessageRecord> = {}): MessageRecord => ({
  id,
  from: 'ana',
  to,
  subject: `subject ${id}`,
  body: `body ${id}`,
  inReplyTo: null,
  hops: 1,
  at,
  status: to === 'user' ? 'to_user' : 'queued',
  note: null,
  updatedAt: at,
  ...extra,
});
const frame = (r: MessageRecord, truncated = false): HubEvent => ({ t: 'activity', item: { ...r, truncated } as ActivityItem });
const ids = (d: Downlink): string[] => d.view().items.map((item) => item.id);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gonogo-downlink-'));
  now = Date.UTC(2026, 10, 17, 16, 0);
  past = [];
  emitted = [];
  logs = [];
});

afterEach(async () => {
  for (const d of open.splice(0)) await d.close();
  await rm(dir, { recursive: true, force: true });
});

const fails = async (run: Promise<unknown>, field?: string): Promise<void> => {
  const error = await run.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HubError);
  expect(error).toMatchObject({ code: 'bad_request', field });
};

describe('downlink: the items', () => {
  it('starts empty without a file and without mail', async () => {
    const d = make();
    await d.load();
    expect(d.view()).toEqual({ unread: 0, items: [] });
    expect(emitted).toEqual([]);
  });

  it('takes every message to the user, and no other, once, whatever frame brings it', async () => {
    const d = make();
    await d.load();
    d.observe(frame(record('m1', 'user', 100)));
    d.observe(frame(record('m2', 'ben', 110)));
    d.observe({ t: 'poll', poll: null });
    d.observe(frame(record('m1', 'user', 100, { status: 'to_user', note: 'again' })));
    d.observe(frame(record('m3', 'user', 120, { from: 'ben', inReplyTo: 'm0' })));
    expect(d.view()).toEqual({
      unread: 2,
      items: [
        { type: 'message', id: 'm3', at: 120, from: 'ben', subject: 'subject m3', body: 'body m3', truncated: false, inReplyTo: 'm0', read: false, archived: false },
        { type: 'message', id: 'm1', at: 100, from: 'ana', subject: 'subject m1', body: 'body m1', truncated: false, inReplyTo: null, read: false, archived: false },
      ],
    });
    // one frame for each message that joined, none for the ones that did not
    expect(emitted.map((v) => v.unread)).toEqual([1, 2]);
  });

  it('keeps the body the hub cut as cut, and cuts a record of the log the same way', async () => {
    past = [record('m1', 'user', 100, { body: 'x'.repeat(ACTIVITY_WIRE_BODY_CHARS + 5) })];
    const d = make();
    await d.load();
    d.observe(frame(record('m2', 'user', 200, { body: 'y'.repeat(ACTIVITY_WIRE_BODY_CHARS) }), true));
    const [m2, m1] = d.view().items;
    expect(m1).toMatchObject({ id: 'm1', truncated: true });
    expect(m1?.type === 'message' && m1.body).toHaveLength(ACTIVITY_WIRE_BODY_CHARS);
    expect(m2).toMatchObject({ id: 'm2', truncated: true });
  });

  it('makes an event with an id, the time and one clean line, and tells the browsers', async () => {
    const d = make();
    await d.load();
    d.post('redline', '  ana:\n loop: Bash‮  5 times  ');
    now += 1000;
    d.post('tminus', 'GO: all go');
    d.post('uplink', '   ');
    expect(d.view()).toEqual({
      unread: 2,
      items: [
        { type: 'event', id: 'e2', at: now, kind: 'tminus', text: 'GO: all go', read: false, archived: false },
        { type: 'event', id: 'e1', at: now - 1000, kind: 'redline', text: 'ana: loop: Bash 5 times', read: false, archived: false },
      ],
    });
    expect(emitted).toHaveLength(2);
  });

  it('cuts the text of an event, and keeps the newest DOWNLINK_EVENTS_MAX with their flags dropped as they go', async () => {
    const d = make();
    await d.load();
    d.post('uplink', 'z'.repeat(DOWNLINK_TEXT_MAX_CHARS + 20));
    expect((d.view().items[0] as { text: string }).text).toHaveLength(DOWNLINK_TEXT_MAX_CHARS);
    await d.read({ ids: ['e1'] });
    for (let i = 0; i < DOWNLINK_EVENTS_MAX; i += 1) d.post('flight-plan', `ana moved t${i} to review: x`);
    const all = d.view().items;
    expect(all).toHaveLength(DOWNLINK_EVENTS_MAX);
    expect(all.some((item) => item.id === 'e1')).toBe(false);
    expect(all[0]?.id).toBe(`e${DOWNLINK_EVENTS_MAX + 1}`);
    await d.close();
    const saved = JSON.parse(await readFile(join(dir, 'downlink.json'), 'utf8')) as { events: unknown[]; flags: Record<string, string> };
    expect(saved.events).toHaveLength(DOWNLINK_EVENTS_MAX);
    expect(saved.flags).toEqual({});
  });

  it('keeps the newest DOWNLINK_MAIL_MAX messages', async () => {
    const d = make();
    await d.load();
    for (let i = 1; i <= DOWNLINK_MAIL_MAX + 3; i += 1) d.observe(frame(record(`m${i}`, 'user', i)));
    expect(d.view().items).toHaveLength(DOWNLINK_MAIL_MAX);
    expect(ids(d)[0]).toBe(`m${DOWNLINK_MAIL_MAX + 3}`);
    expect(ids(d).at(-1)).toBe('m4');
  });

  it('puts messages and events in one list, newest first', async () => {
    const d = make();
    await d.load();
    d.observe(frame(record('m1', 'user', now - 3000)));
    d.post('redline', 'ana: loop');
    d.observe(frame(record('m2', 'user', now + 5000)));
    expect(ids(d)).toEqual(['m2', 'e1', 'm1']);
  });
});

describe('downlink: read and archive', () => {
  async function three(): Promise<Downlink> {
    const d = make();
    await d.load();
    d.observe(frame(record('m1', 'user', 100)));
    d.observe(frame(record('m2', 'user', 200)));
    d.post('redline', 'ana: loop');
    return d;
  }
  const flagsOf = (d: Downlink): Record<string, string> =>
    Object.fromEntries(d.view().items.map((item) => [item.id, item.archived ? 'archived' : item.read ? 'read' : 'unread']));

  it('marks read, and counts only what is neither read nor archived', async () => {
    const d = await three();
    expect(d.view().unread).toBe(3);
    const view = await d.read({ ids: ['m1', 'e1'] });
    expect(view.unread).toBe(1);
    expect(flagsOf(d)).toEqual({ m1: 'read', m2: 'unread', e1: 'read' });
    expect(emitted.at(-1)).toEqual(view);
  });

  it('archives, and archived is read: it leaves the count and stays archived when it is read again', async () => {
    const d = await three();
    await d.archive({ ids: ['m2'] });
    expect(d.view().unread).toBe(2);
    expect(flagsOf(d).m2).toBe('archived');
    await d.read({ ids: ['m2'] });
    await d.readAll();
    expect(flagsOf(d)).toEqual({ m1: 'read', m2: 'archived', e1: 'read' });
    expect(d.view().items.find((i) => i.id === 'm2')).toMatchObject({ read: true, archived: true });
  });

  it('marks everything read in one call, and says nothing when there is nothing to mark', async () => {
    const d = await three();
    expect((await d.readAll()).unread).toBe(0);
    const frames = emitted.length;
    await d.readAll();
    await d.read({ ids: ['m1'] });
    await d.archive({ ids: ['m1'] });
    expect(emitted.length).toBe(frames + 1);
    // a message that comes after is unread again
    d.observe(frame(record('m3', 'user', 300)));
    expect(d.view().unread).toBe(1);
  });

  it('skips an id the inbox does not hold, and writes nothing for it', async () => {
    const d = await three();
    const frames = emitted.length;
    const view = await d.read({ ids: ['m99', 'e99', 'm2'] });
    expect(view.unread).toBe(2);
    await d.archive({ ids: ['m98'] });
    expect(emitted.length).toBe(frames + 1);
  });

  it('refuses a bad request with the name of the field', async () => {
    const d = await three();
    await fails(d.read(null));
    await fails(d.read([]));
    await fails(d.read({ ids: ['m1'], note: 'x' }), 'note');
    await fails(d.read({}), 'ids');
    await fails(d.read({ ids: [] }), 'ids');
    await fails(d.read({ ids: 'm1' }), 'ids');
    await fails(d.archive({ ids: [1] }), 'ids');
    await fails(d.archive({ ids: ['x1'] }), 'ids');
    await fails(d.archive({ ids: ['m0'] }), 'ids');
    await fails(d.archive({ ids: ['../m1'] }), 'ids');
    await fails(d.archive({ ids: Array.from({ length: DOWNLINK_IDS_MAX + 1 }, () => 'm1') }), 'ids');
    expect(d.view().unread).toBe(3);
  });
});

describe('downlink: the file', () => {
  const file = (): string => join(dir, 'downlink.json');

  it('writes version 1 of mode 0600 after each change, with the events and the flags and not the mail', async () => {
    const d = make();
    await d.load();
    d.observe(frame(record('m1', 'user', 100)));
    d.post('tminus', 'HOLD: no-go: ana');
    await d.read({ ids: ['m1'] });
    await d.archive({ ids: ['e1'] });
    await d.close();
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({
      version: 1,
      seq: 1,
      events: [{ id: 'e1', at: now, kind: 'tminus', text: 'HOLD: no-go: ana' }],
      flags: { m1: 'read', e1: 'archived' },
    });
    expect((await stat(file())).mode & 0o777).toBe(0o600);
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('reads it back: the events, the flags, and the ids going on after a restart', async () => {
    past = [record('m1', 'user', 100), record('m2', 'user', 200)];
    const first = make();
    await first.load();
    first.post('redline', 'ana: loop');
    first.post('uplink', 'GitHub: more than 3 requests with a bad signature in 10 minutes');
    first.observe(frame(record('m3', 'user', 300)));
    await first.archive({ ids: ['e2', 'm1'] });
    await first.close();
    past.push(record('m3', 'user', 300));
    const again = make();
    await again.load();
    expect(again.view()).toMatchObject({ unread: 2 });
    expect(Object.fromEntries(again.view().items.map((i) => [i.id, [i.read, i.archived]]))).toEqual({
      m1: [true, true],
      m2: [true, false],
      m3: [false, false],
      e1: [false, false],
      e2: [true, true],
    });
    again.post('tminus', 'GO: all go');
    expect(ids(again)[0]).toBe('e3');
  });

  it('does not use an id again after the newest event was dropped from the file', async () => {
    await writeFile(file(), JSON.stringify({ version: 1, seq: 9, events: [{ id: 'e2', at: 1, kind: 'redline', text: 'old' }], flags: {} }));
    const d = make();
    await d.load();
    d.post('redline', 'new');
    expect(ids(d)).toEqual(['e10', 'e2']);
  });

  it('counts the mail of the log as read on the first run, and as it was on the next', async () => {
    past = [record('m1', 'user', 100), record('m2', 'ben', 150), record('m3', 'user', 200)];
    const first = make();
    await first.load();
    expect(first.view()).toMatchObject({ unread: 0 });
    expect(ids(first)).toEqual(['m3', 'm1']);
    first.observe(frame(record('m4', 'user', 300)));
    await first.close();
    // the second run finds the file: m4 was never marked, so it is unread, and the baseline is not made again
    past = [record('m1', 'user', 100), record('m3', 'user', 200), record('m4', 'user', 300)];
    const second = make();
    await second.load();
    expect(Object.fromEntries(second.view().items.map((i) => [i.id, i.read]))).toEqual({ m4: false, m3: true, m1: true });
  });

  it('drops the flag of a message the log no longer has', async () => {
    past = [record('m1', 'user', 100)];
    const first = make();
    await first.load();
    await first.archive({ ids: ['m1'] });
    await first.close();
    past = [];
    const second = make();
    await second.load();
    second.post('redline', 'x');
    await second.close();
    expect((JSON.parse(await readFile(file(), 'utf8')) as { flags: object }).flags).toEqual({});
  });

  it('starts empty and keeps the file as downlink.json.bad when it cannot be read, without quoting it', async () => {
    await writeFile(file(), '{"secret": "hunter2", oops');
    past = [record('m1', 'user', 100)];
    const d = make();
    await d.load();
    expect(await readFile(`${file()}.bad`, 'utf8')).toBe('{"secret": "hunter2", oops');
    expect(logs.join('\n')).toContain('downlink.json could not be read');
    expect(logs.join('\n')).not.toContain('hunter2');
    expect(d.view()).toMatchObject({ unread: 0 });
    d.post('redline', 'x');
    await d.close();
    expect(JSON.parse(await readFile(file(), 'utf8'))).toMatchObject({ version: 1, events: [{ id: 'e1' }] });
  });

  it('keeps a file of another version aside, and skips a bad event and a bad flag with a warning', async () => {
    await writeFile(file(), JSON.stringify({ version: 2, events: [], flags: {} }));
    const other = make();
    await other.load();
    expect(await readFile(`${file()}.bad`, 'utf8')).toContain('"version":2');
    await rm(`${file()}.bad`);

    await writeFile(
      file(),
      JSON.stringify({
        version: 1,
        seq: 'x',
        events: [
          { id: 'e1', at: 1, kind: 'redline', text: 'kept' },
          { id: 'e1', at: 2, kind: 'redline', text: 'twice' },
          { id: 'e2', at: 2, kind: 'nonsense', text: 'bad kind' },
          { id: 'e3', at: 'x', kind: 'redline', text: 'bad time' },
          { id: 'x4', at: 4, kind: 'redline', text: 'bad id' },
          { id: 'e5', at: 5, kind: 'uplink' },
          'text',
          { id: 'e6', at: 6, kind: 'uplink', text: 'also kept' },
        ],
        flags: { e1: 'read', e6: 'maybe', e7: 'read', m1: 'archived' },
      }),
    );
    const d = make();
    await d.load();
    expect(d.view().items.map((i) => [i.id, i.read])).toEqual([
      ['e6', false],
      ['e1', true],
    ]);
    expect(logs.filter((l) => l.includes('an event was skipped'))).toHaveLength(6);
    d.post('redline', 'next');
    expect(ids(d)[0]).toBe('e7');
  });
});
