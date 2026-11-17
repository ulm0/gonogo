/**
 * Downlink: the Director's inbox (docs/downlink-spec.md).
 *
 * Two kinds of item: every message to "user" (the server keeps a copy of the newest DOWNLINK_MAIL_MAX, found again in
 * messages.jsonl at start) and the events other parts of the server post (a Redline trip, a T-minus result, a failed Launch
 * Window, an Uplink that was refused too often, a task an agent moved to blocked or review). downlink.json keeps the events
 * with their text and one flag per item id, `read` or `archived` (archived is read too); no flag is unread. So phone and
 * desktop agree: the browsers only show what the server says. The clock is injected for tests.
 *
 * shortcut: a message leaves the inbox when DOWNLINK_MAIL_MAX newer ones came (it stays in messages.jsonl), and the whole
 * inbox is in every frame and every snapshot (at the limits that is about 700 KB); send only the changes if that ever hurts.
 */
import { randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ACTIVITY_WIRE_BODY_CHARS, DOWNLINK_EVENT_KINDS } from '../shared/protocol.js';
import type { DownlinkEvent, DownlinkEventKind, DownlinkItem, DownlinkMessage, DownlinkView, HubEvent, Logger, MessageRecord } from '../shared/protocol.js';
import { DOWNLINK_EVENTS_MAX, DOWNLINK_FILE, DOWNLINK_IDS_MAX, DOWNLINK_MAIL_MAX, DOWNLINK_TEXT_MAX_CHARS, FILE_MODE } from './constants.js';
import { isRecord } from './hooks.js';
import { cutText, HubError } from './hub.js';

const ID_RE = /^[me][1-9]\d{0,9}$/;
const EVENT_ID_RE = /^e[1-9]\d{0,9}$/;
// C0, DEL, C1 and bidi controls: an event text comes from agents and must stay one clean line.
const UNSAFE_IN_TEXT = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

type Flag = 'read' | 'archived';
type Mail = Omit<DownlinkMessage, 'type' | 'read' | 'archived'>;
type Stored = Omit<DownlinkEvent, 'type' | 'read' | 'archived'>;

export interface DownlinkOptions {
  /** gonogo's home: downlink.json lives here. */
  dir: string;
  now(): number;
  /** The newest messages of messages.jsonl, oldest first: the mail to the Director that came before this run. */
  history(): MessageRecord[];
  /** The inbox changed. */
  emit(view: DownlinkView): void;
  log: Logger;
}

export interface Downlink {
  /** Reads the file and the mail of the log. Mail found with no file (the first run) counts as read: the inbox starts empty. */
  load(): Promise<void>;
  view(): DownlinkView;
  /** An event for the Director: one line, cut to DOWNLINK_TEXT_MAX_CHARS. Never throws. */
  post(kind: DownlinkEventKind, text: string): void;
  /** Every frame the hub emits: the ones that carry a message to the user join the inbox. */
  observe(event: HubEvent): void;
  /** The input is a JSON value from the wire, `{ ids }`; a bad one throws a HubError (bad_request, field). An id the inbox does not hold is skipped. */
  read(input: unknown): Promise<DownlinkView>;
  archive(input: unknown): Promise<DownlinkView>;
  readAll(): Promise<DownlinkView>;
  close(): Promise<void>;
}

const bad = (message: string, field?: string): HubError => new HubError('bad_request', message, field);

function idsOf(input: unknown): string[] {
  if (!isRecord(input)) throw bad('request body must be a JSON object');
  for (const key of Object.keys(input)) if (key !== 'ids') throw bad(`unknown field "${key}"`, key);
  const ids = input.ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > DOWNLINK_IDS_MAX || !ids.every((id) => typeof id === 'string' && ID_RE.test(id))) {
    throw bad(`ids must be a list of 1 to ${DOWNLINK_IDS_MAX} item ids`, 'ids');
  }
  return ids as string[];
}

export function createDownlink(options: DownlinkOptions): Downlink {
  const { dir, now, log } = options;
  const path = join(dir, DOWNLINK_FILE);
  /** Both lists are oldest first. */
  let mail: Mail[] = [];
  let events: Stored[] = [];
  /** No entry is unread. */
  const flags = new Map<string, Flag>();
  let seq = 0;
  let chain: Promise<unknown> = Promise.resolve();

  const later = (fn: () => Promise<unknown>): Promise<void> => {
    const run = chain.then(fn);
    chain = run.catch((error: unknown) => log.error('downlink could not write', error));
    return run.then(() => undefined);
  };

  const save = (): Promise<void> => {
    // the mail is not stored: messages.jsonl has it, the file keeps what the Director did with it
    const json = JSON.stringify({ version: 1, seq, events, flags: Object.fromEntries(flags) }, null, 2);
    return later(async () => {
      const tmp = join(dir, `.${DOWNLINK_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
      await writeFile(tmp, json, { mode: FILE_MODE, flag: 'wx' });
      await rename(tmp, path);
    });
  };

  const view = (): DownlinkView => {
    const marks = (id: string): { read: boolean; archived: boolean } => ({ read: flags.has(id), archived: flags.get(id) === 'archived' });
    // newest first: the lists are read from their ends, so that the sort (it is stable) leaves the later of two items of one millisecond first
    const items: DownlinkItem[] = [
      ...mail.map((m): DownlinkItem => ({ ...m, type: 'message', ...marks(m.id) })).reverse(),
      ...events.map((e): DownlinkItem => ({ ...e, type: 'event', ...marks(e.id) })).reverse(),
    ];
    items.sort((a, b) => b.at - a.at);
    return { unread: items.filter((item) => !item.read).length, items };
  };

  /** Tells the browsers and saves; a failed save is logged by `later`, so a caller that does not wait may ignore it. */
  const changed = (): Promise<void> => {
    options.emit(view());
    return save();
  };

  const addMail = (record: Mail): boolean => {
    if (mail.some((m) => m.id === record.id)) return false;
    mail.push(record);
    for (const old of mail.splice(0, Math.max(0, mail.length - DOWNLINK_MAIL_MAX))) flags.delete(old.id);
    return true;
  };

  /** A record of the log, or an activity item whose body the hub cut already (`truncated`). */
  const toMail = (r: Pick<MessageRecord, 'id' | 'at' | 'from' | 'subject' | 'body' | 'inReplyTo'> & { truncated?: boolean }): Mail => {
    const body = cutText(r.body, ACTIVITY_WIRE_BODY_CHARS);
    return { id: r.id, at: r.at, from: r.from, subject: r.subject, body, truncated: r.truncated === true || body.length < r.body.length, inReplyTo: r.inReplyTo };
  };

  const setFlag = async (flag: Flag, input: unknown): Promise<DownlinkView> => {
    const ids = idsOf(input);
    const held = new Set([...mail, ...events].map((item) => item.id));
    let any = false;
    for (const id of ids) {
      if (!held.has(id) || flags.get(id) === 'archived' || flags.get(id) === flag) continue;
      flags.set(id, flag);
      any = true;
    }
    if (any) await changed();
    return view();
  };

  return {
    async load() {
      let saved: unknown = null;
      let fresh = false;
      try {
        saved = JSON.parse(await readFile(path, 'utf8'));
        if (!isRecord(saved) || saved.version !== 1 || !Array.isArray(saved.events) || !isRecord(saved.flags)) throw new Error('not a version 1 downlink file');
      } catch (error) {
        saved = null;
        fresh = true;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          // kept aside, so that the next save cannot overwrite what the Director marked
          log.error(`${DOWNLINK_FILE} could not be read; the inbox starts empty and the file is kept as ${DOWNLINK_FILE}.bad`, error instanceof SyntaxError ? 'not valid JSON' : error);
          await rename(path, `${path}.bad`).catch(() => undefined);
        }
      }
      if (isRecord(saved)) {
        if (typeof saved.seq === 'number' && Number.isSafeInteger(saved.seq) && saved.seq > 0) seq = saved.seq;
        for (const raw of Array.isArray(saved.events) ? (saved.events as unknown[]) : []) {
          const { id, at, kind, text } = isRecord(raw) ? raw : ({} as Record<string, unknown>);
          if (
            typeof id !== 'string' ||
            !EVENT_ID_RE.test(id) ||
            typeof at !== 'number' ||
            typeof text !== 'string' ||
            !(DOWNLINK_EVENT_KINDS as readonly string[]).includes(kind as string) ||
            events.some((e) => e.id === id)
          ) {
            log.warn(`${DOWNLINK_FILE}: an event was skipped`);
            continue;
          }
          events.push({ id, at, kind: kind as DownlinkEventKind, text: cutText(text, DOWNLINK_TEXT_MAX_CHARS) });
          seq = Math.max(seq, Number(id.slice(1)));
        }
        events = events.slice(-DOWNLINK_EVENTS_MAX);
      }
      for (const record of options.history()) if (record.to === 'user') addMail(toMail(record));
      if (isRecord(saved) && isRecord(saved.flags)) {
        const held = new Set([...mail, ...events].map((item) => item.id));
        for (const [id, flag] of Object.entries(saved.flags)) if (held.has(id) && (flag === 'read' || flag === 'archived')) flags.set(id, flag);
      }
      if (fresh && mail.length > 0) {
        // the first run: the mail that is already there was seen in the comm loop, so the badge does not start at 200
        for (const m of mail) flags.set(m.id, 'read');
        await save();
      }
    },

    view,

    post(kind, text) {
      const line = cutText(text.replace(UNSAFE_IN_TEXT, ' ').replace(/\s+/g, ' ').trim(), DOWNLINK_TEXT_MAX_CHARS);
      if (line === '') return;
      seq += 1;
      events.push({ id: `e${seq}`, at: now(), kind, text: line });
      for (const old of events.splice(0, Math.max(0, events.length - DOWNLINK_EVENTS_MAX))) flags.delete(old.id);
      void changed().catch(() => undefined);
    },

    observe(event) {
      if (event.t !== 'activity' || event.item.to !== 'user') return;
      if (addMail(toMail(event.item))) options.emit(view());
    },

    read: (input) => setFlag('read', input),
    archive: (input) => setFlag('archived', input),

    async readAll() {
      let any = false;
      for (const item of [...mail, ...events]) {
        if (flags.has(item.id)) continue;
        flags.set(item.id, 'read');
        any = true;
      }
      if (any) await changed();
      return view();
    },

    close() {
      return chain.then(() => undefined);
    },
  };
}
