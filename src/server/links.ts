/**
 * Docking 2, the core (docs/docking-collab-spec.md, sections 1 to 3 and 5): the LINK that two stations hold about one task, the events that replicate both ways,
 * and the outbox that keeps an event until the other side has acked it. A task is never shared; each side owns its own fields and the other side only gets events.
 *
 * Integrity (RSO M1, M2): an event is taken only when its author is the dock it came from, its kind fits the role of the link, its `seq` is the next one (a known
 * `seq` with other content is refused and logged, never overwritten), and `by` is `<agent>@<station>` with the station taken from the dock, never from the body.
 * Everything that leaves or arrives is cleaned like any text of another station.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { AGENT_NAME_PATTERN, LINK_PRIORITIES, TASK_STATUSES } from '../shared/protocol.js';
import type { LinkEventView, LinkPriority, LinkState, LinkView, Logger, OutboundEntry, Task, TaskStatus } from '../shared/protocol.js';
import {
  DOCK_OUTBOX_FILE,
  LINK_BATCH_MAX,
  LINK_GAP_HOLD_MAX,
  LINK_TEXT_MAX_CHARS,
  LINK_TRAIL_MAX,
  LINKS_FILE,
  OUTBOX_EVENT_MAX_AGE_MS,
  OUTBOX_PER_DOCK_MAX,
  OUTBOX_RETRY_MAX_MS,
  OUTBOX_RETRY_MIN_MS,
  OUTBOX_SENT_KEEP,
} from './constants.js';
import { isRecord } from './hooks.js';
import { HubError } from './hub.js';

const NAME_RE = new RegExp(AGENT_NAME_PATTERN);
export const LINK_ID_RE = /^dl_[0-9a-f]{16}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** What each side may author on a link, by its role. The sender owns intent; the receiver owns execution. */
export const SENDER_KINDS = ['offer', 'recall', 'note', 'ask', 'reply', 'lost'] as const;
export const RECEIVER_KINDS = ['accept', 'status', 'note', 'ask', 'reply', 'return', 'refuse', 'lost'] as const;

export interface LinkEvent {
  link: string;
  /** The station id of the author. */
  author: string;
  seq: number;
  at: number;
  kind: string;
  /** `<agent>@<station>`. */
  by: string;
  text: string;
  status?: TaskStatus;
}

export interface Link {
  id: string;
  role: 'sender' | 'receiver';
  /** The dock id of the other station. */
  peer: string;
  peerName: string;
  mine: string;
  theirs: string | null;
  state: LinkState;
  peerStatus: TaskStatus | null;
  title: string;
  due: string | null;
  priority: LinkPriority;
  onward: boolean;
  budget: number | null;
  trail: LinkEvent[];
  /** The last `seq` of ours, and the last of theirs that was applied in order. */
  outSeq: number;
  inSeq: number;
  updatedAt: number;
  /** Events of theirs that came ahead of a gap, by `seq`. */
  held: LinkEvent[];
  /** A short hash of each of their events in the trail window, so that a `seq` sent again is told from a `seq` rewritten. */
  seen: Record<string, string>;
}

interface Outbox {
  events: Array<LinkEvent & { queuedAt: number }>;
  sent: OutboundEntry[];
}

export interface LinksOptions {
  dir: string;
  now(): number;
  /** This station's id and name. */
  station(): { id: string; name: string };
  /** The name of a dock, or undefined when it is not (or no longer) docked. */
  dockName(dockId: string): string | undefined;
  /** Writes a file of the home atomically (the chain of docking.ts). */
  write(file: string, text: string): Promise<void>;
  /** Sends a batch to a dock; the answer is the highest `seq` the dock applied, per link. Rejects when it cannot be reached. */
  send(dockId: string, events: LinkEvent[]): Promise<Record<string, number>>;
  /** What happened, for the history of triggers and the Black Box: kinds, ids and counts, never text. */
  trace(dockId: string, what: string, outcome?: string): void;
  /** The view of links changed. */
  changed(): void;
  log: Logger;
}

export interface Links {
  load(): Promise<void>;
  /** An outgoing link for `task` to `dock` for an offer: an `offered` one is reused (a retry after an answer that was lost). */
  outgoing(dock: { id: string; name: string }, task: Task, offer: OfferFields): Link;
  /** Counts for the caps. */
  openIncoming(dockId: string): number;
  incomingThisHour(dockId: string): number;
  outgoingThisHour(dockId: string): number;
  noteOutgoing(dockId: string): void;
  /** The receiver side of an offer: the link of a task that was made here. */
  incoming(dock: { id: string; name: string }, linkId: string, taskId: string, offer: OfferFields, title: string, by: string): Link;
  find(id: string): Link | undefined;
  /** A link of this dock, or undefined: another dock's link is never handed out. */
  of(dockId: string, id: string): Link | undefined;
  byTask(taskId: string): Link[];
  /** An event of ours. Stored, queued for the dock and sent at once without waiting for the answer. */
  record(link: Link, kind: string, by: string, text: string, status?: TaskStatus, queue?: boolean): LinkEvent;
  /** The events a dock sent. Returns what it applied, per link, for the ack. Never throws for one bad event: it is refused and logged. */
  apply(dock: { id: string; name: string }, raw: unknown): Record<string, number>;
  /** An event of theirs that came in the answer of an offer (accept, refuse). */
  applyOne(dock: { id: string; name: string }, raw: unknown): void;
  /** The outbox: send what waits for `dockId` (all docks when omitted). */
  flush(dockId?: string, force?: boolean): Promise<void>;
  /** The dock was removed: its links are `detached`, its outbox dropped. */
  detach(dockId: string): void;
  views(): LinkView[];
  trail(id: string): LinkEventView[] | null;
  outbound(dockId: string): OutboundEntry[];
  waiting(dockId: string): number;
  close(): Promise<void>;
}

export interface OfferFields {
  due: string | null;
  priority: LinkPriority;
  onward: boolean;
  budget: number | null;
}

/** Text of another station, or ours on its way out: control, bidi and zero-width characters out, one line, cut. */
const UNSAFE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff]', 'g');
export const cleanLine = (value: unknown, max = LINK_TEXT_MAX_CHARS): string => (typeof value === 'string' ? value.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** The offer fields of a body, checked; a bad one is a bad_request with its field. */
export function readOffer(body: Record<string, unknown>): OfferFields {
  const bad = (message: string, field: string): HubError => new HubError('bad_request', message, field);
  let due: string | null = null;
  if (body.due !== undefined && body.due !== null) {
    if (typeof body.due !== 'string' || !DATE_RE.test(body.due) || Number.isNaN(Date.parse(`${body.due}T00:00:00Z`)) || new Date(`${body.due}T00:00:00Z`).toISOString().slice(0, 10) !== body.due) throw bad('due must be a date, YYYY-MM-DD', 'due');
    due = body.due;
  }
  let priority: LinkPriority = 'normal';
  if (body.priority !== undefined && body.priority !== null) {
    if (typeof body.priority !== 'string' || !(LINK_PRIORITIES as readonly string[]).includes(body.priority)) throw bad(`priority must be one of: ${LINK_PRIORITIES.join(', ')}`, 'priority');
    priority = body.priority as LinkPriority;
  }
  if (body.onward !== undefined && typeof body.onward !== 'boolean') throw bad('onward must be true or false', 'onward');
  let budget: number | null = null;
  if (body.budget !== undefined && body.budget !== null) {
    if (typeof body.budget !== 'number' || !Number.isFinite(body.budget) || body.budget < 0 || body.budget > 1_000_000) throw bad('budget must be a number of dollars from 0 to 1000000', 'budget');
    budget = Math.round(body.budget * 100) / 100;
  }
  return { due, priority, onward: body.onward === true, budget };
}

const hashOf = (e: Pick<LinkEvent, 'kind' | 'by' | 'text' | 'status'>): string => createHash('sha256').update(JSON.stringify([e.kind, e.by, e.text, e.status ?? null])).digest('hex').slice(0, 16);
const newId = (): string => `dl_${randomBytes(8).toString('hex')}`;
const HOUR = 3600_000;

export function createLinks(options: LinksOptions): Links {
  const { now, log } = options;
  const links = new Map<string, Link>();
  const outboxes = new Map<string, Outbox>();
  /** Per dock: when the next try is due, and how many failed in a row. */
  const retry = new Map<string, { at: number; fails: number; busy: boolean }>();
  const handoffs = new Map<string, number[]>();
  const outgoingTimes = new Map<string, number[]>();
  let pending: Promise<unknown> = Promise.resolve();

  const box = (dockId: string): Outbox => {
    let b = outboxes.get(dockId);
    if (!b) {
      b = { events: [], sent: [] };
      outboxes.set(dockId, b);
    }
    return b;
  };
  const stationId = (): string => options.station().id;

  const save = (): void => {
    const linksJson = JSON.stringify({ version: 1, links: [...links.values()] });
    const boxJson = JSON.stringify({ version: 1, docks: Object.fromEntries([...outboxes].map(([id, b]) => [id, b])) });
    pending = options.write(LINKS_FILE, linksJson).then(() => options.write(DOCK_OUTBOX_FILE, boxJson)).catch((error: unknown) => log.error('links could not write', error));
  };
  const touch = (link: Link): void => {
    link.updatedAt = now();
  };

  const clipTrail = (link: Link): void => {
    if (link.trail.length <= LINK_TRAIL_MAX) return;
    const dropped = link.trail.length - LINK_TRAIL_MAX;
    // older events are folded into one line, never dropped silently
    const first = link.trail[0];
    link.trail = [{ link: link.id, author: stationId(), seq: 0, at: first?.at ?? now(), kind: 'lost', by: `station@${options.station().name}`, text: `${dropped} older events are not kept here` }, ...link.trail.slice(dropped + 1)];
  };

  const sendNow = (dockId: string): void => {
    void api.flush(dockId).catch(() => undefined);
  };

  const fits = (link: Link, kind: string, ours: boolean): boolean => {
    const mine = ours ? link.role : link.role === 'sender' ? 'receiver' : 'sender';
    return ((mine === 'sender' ? SENDER_KINDS : RECEIVER_KINDS) as readonly string[]).includes(kind);
  };

  const stateAfter = (link: Link, event: LinkEvent): void => {
    if (event.kind === 'accept') link.state = 'accepted';
    else if (event.kind === 'refuse') link.state = 'refused';
    else if (event.kind === 'return') link.state = 'returned';
    else if (event.kind === 'recall') link.state = 'recalled';
    if (event.kind === 'status' && event.status !== undefined) link.peerStatus = event.status;
  };

  const api: Links = {
    async load() {
      const read = async (file: string): Promise<unknown> => {
        try {
          const saved: unknown = JSON.parse(await readFile(join(options.dir, file), 'utf8'));
          if (!isRecord(saved) || saved.version !== 1) throw new Error('not a version 1 file');
          return saved;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            log.error(`${file} could not be read; it is kept as ${file}.bad and the links start from what is left`, error instanceof SyntaxError ? 'not valid JSON' : error);
            await rename(join(options.dir, file), join(options.dir, `${file}.bad`)).catch(() => undefined);
          }
          return null;
        }
      };
      const saved = await read(LINKS_FILE);
      for (const raw of isRecord(saved) && Array.isArray(saved.links) ? saved.links : []) {
        const link = readLink(raw);
        if (link !== null) links.set(link.id, link);
      }
      const boxes = await read(DOCK_OUTBOX_FILE);
      if (isRecord(boxes) && isRecord(boxes.docks)) {
        for (const [dockId, value] of Object.entries(boxes.docks)) {
          if (!/^[0-9a-f]{32}$/.test(dockId) || !isRecord(value)) continue;
          const b = box(dockId);
          for (const e of Array.isArray(value.events) ? value.events : []) {
            const ev = readEvent(e);
            if (ev !== null && typeof (e as { queuedAt?: unknown }).queuedAt === 'number') b.events.push({ ...ev, queuedAt: (e as { queuedAt: number }).queuedAt });
          }
          for (const s of Array.isArray(value.sent) ? value.sent : []) {
            if (isRecord(s) && typeof s.at === 'number' && typeof s.link === 'string' && typeof s.seq === 'number' && typeof s.kind === 'string' && typeof s.by === 'string' && typeof s.text === 'string') {
              b.sent.push({ at: s.at, link: s.link, seq: s.seq, kind: s.kind, by: s.by, text: s.text, ackedAt: typeof s.ackedAt === 'number' ? s.ackedAt : null });
            }
          }
          b.sent = b.sent.slice(-OUTBOX_SENT_KEEP);
        }
      }
    },

    outgoing(dock, task, offer) {
      const again = [...links.values()].find((l) => l.role === 'sender' && l.peer === dock.id && l.mine === task.id && l.state === 'offered');
      if (again) {
        Object.assign(again, { ...offer });
        return again;
      }
      const link: Link = { id: newId(), role: 'sender', peer: dock.id, peerName: dock.name, mine: task.id, theirs: null, state: 'offered', peerStatus: null, title: cleanLine(task.title, 120), ...offer, trail: [], outSeq: 0, inSeq: 0, updatedAt: now(), held: [], seen: {} };
      links.set(link.id, link);
      return link;
    },

    openIncoming(dockId) {
      return [...links.values()].filter((l) => l.role === 'receiver' && l.peer === dockId && (l.state === 'accepted' || l.state === 'offered')).length;
    },
    incomingThisHour(dockId) {
      const list = (handoffs.get(dockId) ?? []).filter((t) => now() - t < HOUR);
      handoffs.set(dockId, list);
      return list.length;
    },
    outgoingThisHour(dockId) {
      const list = (outgoingTimes.get(dockId) ?? []).filter((t) => now() - t < HOUR);
      outgoingTimes.set(dockId, list);
      return list.length;
    },
    noteOutgoing(dockId) {
      outgoingTimes.set(dockId, [...(outgoingTimes.get(dockId) ?? []).filter((t) => now() - t < HOUR), now()]);
    },

    incoming(dock, linkId, taskId, offer, title, by) {
      const link: Link = { id: linkId, role: 'receiver', peer: dock.id, peerName: dock.name, mine: taskId, theirs: null, state: 'accepted', peerStatus: null, title: cleanLine(title, 120), ...offer, trail: [], outSeq: 0, inSeq: 0, updatedAt: now(), held: [], seen: {} };
      handoffs.set(dock.id, [...(handoffs.get(dock.id) ?? []).filter((t) => now() - t < HOUR), now()]);
      links.set(link.id, link);
      // the offer is the sender's first event (seq 1), applied as one so that both trails agree; the accept is ours
      const offerEvent: LinkEvent = { link: linkId, author: dock.id, seq: 1, at: now(), kind: 'offer', by, text: '' };
      link.trail.push(offerEvent);
      link.inSeq = 1;
      link.seen['1'] = hashOf(offerEvent);
      save();
      return link;
    },

    find: (id) => links.get(id),
    of(dockId, id) {
      const link = links.get(id);
      return link !== undefined && link.peer === dockId ? link : undefined;
    },
    byTask: (taskId) => [...links.values()].filter((l) => l.mine === taskId),

    record(link, kind, by, text, status, queue = true) {
      const clean = cleanLine(text);
      const event: LinkEvent = { link: link.id, author: stationId(), seq: link.outSeq + 1, at: now(), kind, by: cleanLine(by, 80), text: clean, ...(status === undefined ? {} : { status }) };
      link.outSeq = event.seq;
      link.trail.push(event);
      clipTrail(link);
      touch(link);
      // the offer travels on the `task` route and the answer acks it; everything else waits in the outbox
      stateAfter(link, event);
      if (kind !== 'offer' && queue) {
        const b = box(link.peer);
        b.events.push({ ...event, queuedAt: now() });
        // past the cap the oldest goes; the lost events that say so are the next slice's
        while (b.events.length > OUTBOX_PER_DOCK_MAX) b.events.shift();
      }
      options.trace(link.peer, `link event ${kind} on ${link.id}`);
      save();
      options.changed();
      if (kind !== 'offer' && queue) sendNow(link.peer);
      return event;
    },

    apply(dock, raw) {
      const acked: Record<string, number> = {};
      const events = isRecord(raw) && Array.isArray(raw.events) ? raw.events.slice(0, LINK_BATCH_MAX) : [];
      for (const item of events) {
        const ev = readEvent(item);
        if (ev === null) continue;
        const link = api.of(dock.id, ev.link);
        // a link of another dock, or none: nothing of this dock to touch
        if (link === undefined) continue;
        try {
          applyEvent(link, dock, ev);
        } catch (error) {
          log.warn(`link ${link.id}: ${error instanceof Error ? error.message : String(error)}`);
          options.trace(dock.id, `link event refused on ${link.id}`, 'refused');
        }
        acked[link.id] = link.inSeq;
      }
      if (events.length > 0) {
        save();
        options.changed();
      }
      return acked;
    },

    applyOne(dock, raw) {
      const ev = readEvent(raw);
      if (ev === null) return;
      const link = api.of(dock.id, ev.link);
      if (link === undefined) return;
      try {
        applyEvent(link, dock, ev);
      } catch (error) {
        log.warn(`link ${link.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
      save();
      options.changed();
    },

    async flush(dockId, force = false) {
      const ids = dockId === undefined ? [...outboxes.keys()] : [dockId];
      for (const id of ids) {
        const b = outboxes.get(id);
        const state = retry.get(id) ?? { at: 0, fails: 0, busy: false };
        retry.set(id, state);
        if (b === undefined || b.events.length === 0 || state.busy || (!force && now() < state.at)) continue;
        // an event unsent for 7 days is not worth the room: it goes (the next slice replaces it with a visible `lost`)
        b.events = b.events.filter((e) => now() - e.queuedAt < OUTBOX_EVENT_MAX_AGE_MS);
        if (b.events.length === 0) continue;
        state.busy = true;
        const batch = b.events.slice(0, LINK_BATCH_MAX);
        try {
          const ack = await options.send(id, batch.map(({ queuedAt: _q, ...e }) => e));
          state.fails = 0;
          state.at = 0;
          const at = now();
          for (const e of batch) {
            if (typeof ack[e.link] === 'number' && (ack[e.link] as number) >= e.seq) {
              b.events = b.events.filter((x) => !(x.link === e.link && x.seq === e.seq));
              b.sent.push({ at: e.at, link: e.link, seq: e.seq, kind: e.kind, by: e.by, text: e.text, ackedAt: at });
            }
          }
          b.sent = b.sent.slice(-OUTBOX_SENT_KEEP);
          save();
          options.changed();
          // more waits: send it too, in the same breath
          if (b.events.length > 0) {
            state.busy = false;
            await api.flush(id, true);
          }
        } catch (error) {
          state.fails += 1;
          state.at = now() + Math.min(OUTBOX_RETRY_MAX_MS, OUTBOX_RETRY_MIN_MS * 2 ** (state.fails - 1));
          log.debug(`link events for ${id} not sent: ${error instanceof Error ? error.message : String(error)}`);
          options.changed();
        } finally {
          state.busy = false;
        }
      }
    },

    detach(dockId) {
      for (const link of links.values()) if (link.peer === dockId) link.state = 'detached';
      outboxes.delete(dockId);
      retry.delete(dockId);
      save();
      options.changed();
    },

    views() {
      return [...links.values()].map((l) => ({
        id: l.id,
        role: l.role,
        peer: l.peer,
        peerName: options.dockName(l.peer) ?? l.peerName,
        mine: l.mine,
        theirs: l.theirs,
        state: l.state,
        peerStatus: l.peerStatus,
        title: l.title,
        due: l.due,
        priority: l.priority,
        onward: l.onward,
        budget: l.budget,
        events: l.trail.length,
        waiting: (outboxes.get(l.peer)?.events ?? []).filter((e) => e.link === l.id).length,
        updatedAt: l.updatedAt,
      }));
    },

    trail(id) {
      const link = links.get(id);
      if (!link) return null;
      return link.trail.map((e) => ({ link: e.link, from: e.author === stationId() ? 'us' : 'them', seq: e.seq, at: e.at, kind: e.kind, by: e.by, text: e.text, ...(e.status === undefined ? {} : { status: e.status }) }));
    },

    outbound: (dockId) => (outboxes.get(dockId)?.sent ?? []).map((s) => ({ ...s })).concat((outboxes.get(dockId)?.events ?? []).map((e) => ({ at: e.at, link: e.link, seq: e.seq, kind: e.kind, by: e.by, text: e.text, ackedAt: null }))).slice(-OUTBOX_SENT_KEEP),
    waiting: (dockId) => outboxes.get(dockId)?.events.length ?? 0,

    close: () => pending.then(() => undefined),
  };

  /** One event of a dock, against the rules. Throws when it is refused; a no-op for one that is known. */
  function applyEvent(link: Link, dock: { id: string; name: string }, ev: LinkEvent): void {
    if (ev.author !== dock.id) throw new Error(`dock ${dock.name} sent an event that is not its own`);
    if (!fits(link, ev.kind, false) || ev.kind === 'offer') throw new Error(`dock ${dock.name} sent a ${ev.kind} that its side of the link cannot send`);
    const by = byOf(ev.by, dock.name);
    const event: LinkEvent = { ...ev, by, text: cleanLine(ev.text), ...(ev.status !== undefined && (TASK_STATUSES as readonly string[]).includes(ev.status) ? { status: ev.status } : {}) };
    if (ev.kind === 'status' && event.status === undefined) throw new Error(`dock ${dock.name} sent a status with no status`);
    const known = link.seen[String(event.seq)];
    if (event.seq <= link.inSeq) {
      if (known !== undefined && known !== hashOf(event)) throw new Error(`dock ${dock.name} tried to rewrite event ${event.seq}`);
      return;
    }
    if (event.seq > link.inSeq + 1) {
      // ahead of a gap: held (not acked) until the ones before it come
      if (link.held.length < LINK_GAP_HOLD_MAX && !link.held.some((h) => h.seq === event.seq)) link.held.push(event);
      return;
    }
    take(link, event);
    // the held ones that now follow
    for (;;) {
      const next = link.held.find((h) => h.seq === link.inSeq + 1);
      if (!next) break;
      link.held = link.held.filter((h) => h !== next);
      take(link, next);
    }
  }

  function take(link: Link, event: LinkEvent): void {
    link.inSeq = event.seq;
    link.seen[String(event.seq)] = hashOf(event);
    // only the window of the trail keeps hashes
    for (const key of Object.keys(link.seen)) if (Number(key) <= event.seq - LINK_TRAIL_MAX) delete link.seen[key];
    link.trail.push(event);
    clipTrail(link);
    stateAfter(link, event);
    touch(link);
    options.trace(link.peer, `link event ${event.kind} on ${link.id}`);
  }

  /** `<agent>@<station>`: the agent part checked, the station the dock's own name, whatever the body said. */
  function byOf(by: string, station: string): string {
    const agent = typeof by === 'string' ? by.split('@')[0] ?? '' : '';
    return `${NAME_RE.test(agent) ? agent : 'station'}@${station}`;
  }

  /** What a file holds for a link, or null. A hostile file gives fewer links, never a crash. */
  function readLink(raw: unknown): Link | null {
    if (!isRecord(raw) || typeof raw.id !== 'string' || !LINK_ID_RE.test(raw.id) || (raw.role !== 'sender' && raw.role !== 'receiver')) return null;
    if (typeof raw.peer !== 'string' || !/^[0-9a-f]{32}$/.test(raw.peer) || typeof raw.mine !== 'string' || !/^t[1-9]\d{0,5}$/.test(raw.mine)) return null;
    let offer: OfferFields;
    try {
      offer = readOffer(raw);
    } catch {
      offer = { due: null, priority: 'normal', onward: false, budget: null };
    }
    const trail = (Array.isArray(raw.trail) ? raw.trail : []).map(readEvent).filter((e): e is LinkEvent => e !== null).slice(-LINK_TRAIL_MAX);
    const seen: Record<string, string> = {};
    if (isRecord(raw.seen)) for (const [k, v] of Object.entries(raw.seen)) if (/^\d{1,9}$/.test(k) && typeof v === 'string' && /^[0-9a-f]{16}$/.test(v)) seen[k] = v;
    return {
      id: raw.id,
      role: raw.role,
      peer: raw.peer,
      peerName: typeof raw.peerName === 'string' ? cleanLine(raw.peerName, 31) : '',
      mine: raw.mine,
      theirs: typeof raw.theirs === 'string' && /^t[1-9]\d{0,5}$/.test(raw.theirs) ? raw.theirs : null,
      state: (['offered', 'accepted', 'delivered', 'returned', 'recalled', 'done', 'detached', 'refused'] as const).find((s) => s === raw.state) ?? 'accepted',
      peerStatus: (TASK_STATUSES as readonly unknown[]).includes(raw.peerStatus) ? (raw.peerStatus as TaskStatus) : null,
      title: cleanLine(raw.title, 120),
      ...offer,
      trail,
      outSeq: Number.isSafeInteger(raw.outSeq) && (raw.outSeq as number) >= 0 ? (raw.outSeq as number) : 0,
      inSeq: Number.isSafeInteger(raw.inSeq) && (raw.inSeq as number) >= 0 ? (raw.inSeq as number) : 0,
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : now(),
      held: [],
      seen,
    };
  }

  function readEvent(raw: unknown): LinkEvent | null {
    if (!isRecord(raw) || typeof raw.link !== 'string' || !LINK_ID_RE.test(raw.link) || typeof raw.author !== 'string' || !/^[0-9a-f]{32}$/.test(raw.author)) return null;
    if (typeof raw.seq !== 'number' || !Number.isSafeInteger(raw.seq) || raw.seq < 0 || typeof raw.kind !== 'string' || !/^[a-z]{2,12}$/.test(raw.kind)) return null;
    return {
      link: raw.link,
      author: raw.author,
      seq: raw.seq,
      at: typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : now(),
      kind: raw.kind,
      by: typeof raw.by === 'string' ? cleanLine(raw.by, 80) : '',
      text: cleanLine(raw.text),
      ...((TASK_STATUSES as readonly unknown[]).includes(raw.status) ? { status: raw.status as TaskStatus } : {}),
    };
  }

  return api;
}
