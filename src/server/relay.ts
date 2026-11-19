/**
 * Relay: Slack, GitHub, Linear and Telegram (docs/relay-spec.md). The inbound half is the uplink kinds of relaykinds.ts; this is
 * the outbound half and what ties the two together.
 *
 * relay.json (mode 0600, written whole through a temporary file and a rename) holds the targets, a Slack channel and a Telegram
 * chat each with the bot token that posts there, and which kinds of Downlink item are sent to them. Every forward is one call
 * of fetch with a timeout, tried again with a growing wait; a token is never logged and never sent to a browser. A message
 * that was forwarded is remembered by the id the service gave it (a Slack `ts`, a Telegram message id), so that a thread
 * reply or a Telegram reply to it comes back as a message to the agent that wrote it (`find`). The clock, fetch and the
 * sleep between tries are injected for tests.
 *
 * shortcut: the targets' tokens are stored as text in the 0600 file (a bot token has to be sent as it is), so encrypt the file
 * if the home folder is ever shared.
 * shortcut: the map of forwarded messages and the list of handled inbound ids are in memory, bounded, and gone at a restart: a
 * reply to a message from before the restart is a message to the uplink's agent (Telegram, a Slack DM) or is dropped (Slack channel).
 * Persist them if restarts get common.
 */
import { randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PHONE_MODES, RELAY_FORWARD_KINDS, RELAY_SERVICES } from '../shared/protocol.js';
import type { DownlinkEventKind, HubEvent, Logger, PhoneMode, RelayForwardKind, RelayLast, RelayService, RelayView } from '../shared/protocol.js';
import {
  FILE_MODE,
  RELAY_BACKOFF_MS,
  RELAY_FILE,
  RELAY_NOTE_MAX_CHARS,
  RELAY_QUEUE_MAX,
  RELAY_RETRY_AFTER_MAX_MS,
  RELAY_SEEN_MAX,
  RELAY_TEXT_MAX_CHARS,
  RELAY_THREADS_MAX,
  RELAY_TIMEOUT_MS,
  RELAY_TRIES,
} from './constants.js';
import { isRecord } from './hooks.js';
import { cutText, HubError } from './hub.js';
import type { Inbound, Thread } from './uplinks.js';

export interface RelayOptions {
  /** gonogo's home: relay.json lives here. */
  dir: string;
  now(): number;
  /** The global fetch; a test hands in a fake. */
  fetch: typeof fetch;
  /** The wait between two tries. */
  sleep(ms: number): Promise<void>;
  log: Logger;
}

import type { TelegramInbound } from '../shared/protocol.js';

export interface Relay extends Inbound {
  load(): Promise<void>;
  view(): RelayView;
  /** The input is a JSON value from the wire, `{ token?, to }`; a bad one throws a HubError (bad_request, field). Without a token the saved one is kept. */
  set(service: string, input: unknown): Promise<RelayView>;
  remove(service: string): Promise<RelayView>;
  /** `{ kinds }`: which kinds of item go to the targets. */
  forward(input: unknown): Promise<RelayView>;
  /** `{ mode }`: where phone approvals go (off, telegram, remote-control or both). */
  setPhone(input: unknown): Promise<RelayView>;
  /** Phone approvals: whether the Telegram path is on and a Telegram target exists. */
  phoneTelegram(): boolean;
  /** One message with buttons to the Telegram target; resolves with its key when it went. */
  sendButtons(text: string, markup: unknown): Promise<boolean>;
  /** One call of the Telegram bot API (answerCallbackQuery, editMessageReplyMarkup); true when it was accepted. Never throws, never says the token. */
  /** The Telegram target for the long-polling loop (the token stays in this process); null when there is none. */
  telegramTarget(): { token: string; to: string } | null;
  /** Where Telegram inbound stands (long polling, webhook, uplink, off), asked at each `view()`. */
  setInbound(read: () => TelegramInbound): void;
  telegramCall(method: 'answerCallbackQuery' | 'editMessageReplyMarkup', body: Record<string, unknown>): Promise<boolean>;
  /** Sends one test message, one try, and waits for the answer. A refusal is in `last`, not thrown. */
  test(service: string): Promise<RelayView>;
  /** Every frame the hub emits: a message to the Director is forwarded. */
  observe(event: HubEvent): void;
  /** What the other parts of the server tell the Downlink (the same function): a redline trip, a T-minus result or a task that is blocked or in review is forwarded. */
  event(kind: DownlinkEventKind, text: string): void;
  /** Stops what is in flight and drops what is queued. */
  close(): Promise<void>;
}

interface Target {
  token: string;
  to: string;
}
interface Answer {
  ok: boolean;
  /** What the service said was wrong, or ''. */
  error: string;
  /** The id the service gave the message, in the form of the keys of `Inbound.find`. */
  key: string | null;
}
interface Service {
  label: string;
  /** What a good token and a good destination look like, so that a mistake (the signing secret pasted as a token) is caught here. */
  token: RegExp;
  to: RegExp;
  toHint: string;
  request(target: Target, text: string, extra?: Record<string, unknown>): { url: string; headers: Record<string, string>; body: unknown };
  answer(json: unknown, target: Target): Answer;
}

const pick = (value: unknown, path: string[]): unknown => path.reduce<unknown>((at, key) => (isRecord(at) ? at[key] : undefined), value);

const SERVICES: Record<RelayService, Service> = {
  slack: {
    label: 'Slack',
    token: /^xoxb-[A-Za-z0-9-]{10,200}$/,
    to: /^[CGD][A-Z0-9]{6,20}$/,
    toHint: 'the channel id, such as C0123456789',
    request: (target, text) => ({
      url: 'https://slack.com/api/chat.postMessage',
      headers: { Authorization: `Bearer ${target.token}`, 'Content-Type': 'application/json; charset=utf-8' },
      // `&`, `<` and `>` are Slack's own markup: an agent's text must not be able to say <!channel>
      body: { channel: target.to, text: text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') },
    }),
    answer: (json) => {
      const ts = pick(json, ['ts']);
      const channel = pick(json, ['channel']);
      return {
        ok: pick(json, ['ok']) === true,
        error: typeof pick(json, ['error']) === 'string' ? String(pick(json, ['error'])) : '',
        key: typeof ts === 'string' && typeof channel === 'string' ? `slack:${channel}:${ts}` : null,
      };
    },
  },
  telegram: {
    label: 'Telegram',
    token: /^\d{4,15}:[A-Za-z0-9_-]{20,64}$/,
    to: /^-?[1-9]\d{0,19}$/,
    toHint: 'the chat id, a number such as 123456789',
    request: (target, text, extra) => ({
      // the token is part of the address: this url is never logged
      url: `https://api.telegram.org/bot${target.token}/sendMessage`,
      headers: { 'Content-Type': 'application/json' },
      body: { chat_id: target.to, text, ...extra },
    }),
    answer: (json, target) => {
      const id = pick(json, ['result', 'message_id']);
      return {
        ok: pick(json, ['ok']) === true,
        error: typeof pick(json, ['description']) === 'string' ? String(pick(json, ['description'])) : '',
        key: typeof id === 'number' ? `telegram:${target.to}:${id}` : null,
      };
    },
  },
};

const LABEL: Record<RelayForwardKind, string> = { message: 'Message', redline: 'Redline', tminus: 'T-minus', 'flight-plan': 'Flight Plan' };
const bad = (message: string, field?: string): HubError => new HubError('bad_request', message, field);
const serviceOf = (name: string): RelayService => {
  if (!(RELAY_SERVICES as readonly string[]).includes(name)) throw new HubError('not_found', 'unknown service');
  return name as RelayService;
};
const isForward = (kind: string): kind is RelayForwardKind => (RELAY_FORWARD_KINDS as readonly string[]).includes(kind);
const reasonOf = (error: unknown): string => (error instanceof Error ? (error.name === 'TimeoutError' ? 'timed out' : error.message) : String(error));
/** The wait the service asks for, in ms, or null. */
const retryAfter = (res: Response): number | null => {
  const seconds = Number(res.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, RELAY_RETRY_AFTER_MAX_MS) : null;
};

export function createRelay(options: RelayOptions): Relay {
  const { dir, now, log } = options;
  const path = join(dir, RELAY_FILE);
  const targets: Partial<Record<RelayService, Target>> = {};
  const last: Partial<Record<RelayService, RelayLast>> = {};
  /** Everything is sent until the Director chooses. */
  let forwarded = new Set<RelayForwardKind>(RELAY_FORWARD_KINDS);
  let phone: PhoneMode = 'off';
  /** Forwarded messages by the service's own id, oldest first (a Map keeps the order of insertion). */
  const threads = new Map<string, Thread>();
  const handled = new Set<string>();
  const queue: Array<() => Promise<void>> = [];
  let draining = false;
  let chain: Promise<unknown> = Promise.resolve();
  const closing = new AbortController();

  const later = (fn: () => Promise<unknown>): Promise<void> => {
    const run = chain.then(fn);
    chain = run.catch((error: unknown) => log.error('relay could not write', error));
    return run.then(() => undefined);
  };

  const save = (): Promise<void> => {
    const json = JSON.stringify({ version: 1, ...targets, forward: RELAY_FORWARD_KINDS.filter((k) => forwarded.has(k)), phone }, null, 2);
    return later(async () => {
      const tmp = join(dir, `.${RELAY_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
      await writeFile(tmp, json, { mode: FILE_MODE, flag: 'wx' });
      await rename(tmp, path);
    });
  };

  let inboundOf: (() => TelegramInbound) | null = null;
  const view = (): RelayView => {
    const of = (service: RelayService) => (targets[service] ? { to: targets[service].to, last: last[service] ?? null } : null);
    return { slack: of('slack'), telegram: of('telegram'), forward: RELAY_FORWARD_KINDS.filter((k) => forwarded.has(k)), phone, ...(inboundOf === null ? {} : { telegramInbound: inboundOf() }) };
  };

  /** One message to one service: the id the service gave it, or why it did not go. Never throws, never says the token. */
  async function post(service: RelayService, target: Target, text: string, tries: number, extra?: Record<string, unknown>): Promise<{ ok: boolean; note: string; key: string | null }> {
    const def = SERVICES[service];
    const { url, headers, body } = def.request(target, text, extra);
    let note = '';
    for (let attempt = 1; attempt <= tries && !closing.signal.aborted; attempt++) {
      let wait = RELAY_BACKOFF_MS * 2 ** (attempt - 1);
      try {
        const res = await options.fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          // a redirect would carry the token somewhere else
          redirect: 'error',
          signal: AbortSignal.any([AbortSignal.timeout(RELAY_TIMEOUT_MS), closing.signal]),
        });
        const answer = def.answer(await res.json().catch(() => null), target);
        if (res.ok && answer.ok) return { ok: true, note: 'sent', key: answer.key };
        note = `${def.label} answered ${res.status}${answer.error === '' ? '' : `: ${answer.error}`}`;
        // a refusal (a wrong token, a channel that is not there) will be the same next time; a busy or broken service may not be
        if (res.status !== 429 && res.status < 500) break;
        wait = retryAfter(res) ?? wait;
      } catch (error) {
        note = `${def.label}: ${reasonOf(error)}`;
      }
      if (attempt < tries) await options.sleep(wait);
    }
    return { ok: false, note: cutText(note.split(target.token).join('(token)'), RELAY_NOTE_MAX_CHARS), key: null };
  }

  async function drain(): Promise<void> {
    draining = true;
    try {
      for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
        try {
          await job();
        } catch (error) {
          log.error('relay could not send', error instanceof Error ? error.name : 'error');
        }
      }
    } finally {
      draining = false;
    }
  }

  /** Sends `text` to every target, one message after the other so that they stay in order. `thread` is what a reply to it will find. */
  function send(text: string, thread: Thread | null): void {
    if (closing.signal.aborted) return;
    const clipped = text.length > RELAY_TEXT_MAX_CHARS ? `${cutText(text, RELAY_TEXT_MAX_CHARS - 1)}…` : text;
    for (const service of RELAY_SERVICES) {
      if (!targets[service]) continue;
      queue.push(async () => {
        // read when it is its turn: a target that was removed or changed while this waited gets nothing, or the new place
        const target = targets[service];
        if (!target) return;
        const sent = await post(service, target, clipped, RELAY_TRIES);
        last[service] = { at: now(), ok: sent.ok, note: sent.note };
        if (!sent.ok) log.warn(`relay: ${service}: ${sent.note}`);
        else if (thread !== null && sent.key !== null) {
          threads.set(sent.key, thread);
          if (threads.size > RELAY_THREADS_MAX) threads.delete(threads.keys().next().value as string);
        }
      });
      if (queue.length > RELAY_QUEUE_MAX) {
        queue.shift();
        log.warn('relay: the queue is full, the oldest message was dropped');
      }
    }
    if (!draining && queue.length > 0) void drain();
  }

  return {
    async load() {
      let saved: unknown = null;
      try {
        saved = JSON.parse(await readFile(path, 'utf8'));
        if (!isRecord(saved) || saved.version !== 1) throw new Error('not a version 1 relay file');
      } catch (error) {
        saved = null;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          // kept aside, so that the next save cannot overwrite the tokens the Director handed over
          // a SyntaxError quotes the text around the fault, which can be part of a token
          log.error(`${RELAY_FILE} could not be read; the targets start empty and the file is kept as ${RELAY_FILE}.bad`, error instanceof SyntaxError ? 'not valid JSON' : error);
          await rename(path, `${path}.bad`).catch(() => undefined);
        }
      }
      if (!isRecord(saved)) return;
      for (const service of RELAY_SERVICES) {
        const t = saved[service];
        if (t === undefined) continue;
        if (isRecord(t) && typeof t.token === 'string' && typeof t.to === 'string' && SERVICES[service].token.test(t.token) && SERVICES[service].to.test(t.to)) targets[service] = { token: t.token, to: t.to };
        else log.warn(`${RELAY_FILE}: the ${service} target was skipped`);
      }
      if (typeof saved.phone === 'string' && (PHONE_MODES as readonly string[]).includes(saved.phone)) phone = saved.phone as PhoneMode;
      if (Array.isArray(saved.forward)) forwarded = new Set(saved.forward.filter((k): k is RelayForwardKind => typeof k === 'string' && isForward(k)));
    },

    view,

    async set(name, input) {
      const service = serviceOf(name);
      const def = SERVICES[service];
      if (!isRecord(input)) throw bad('request body must be a JSON object');
      for (const key of Object.keys(input)) if (key !== 'token' && key !== 'to') throw bad(`unknown field "${key}"`, key);
      if (typeof input.to !== 'string' || !def.to.test(input.to)) throw bad(`to must be ${def.toHint}`, 'to');
      const token = input.token ?? targets[service]?.token;
      // the message never says the token: it may be a secret that was pasted into the wrong place
      if (typeof token !== 'string' || !def.token.test(token)) throw bad(input.token === undefined ? 'token is required' : `token is not the bot token of ${def.label}`, 'token');
      targets[service] = { token, to: input.to };
      delete last[service];
      await save();
      return view();
    },

    async remove(name) {
      const service = serviceOf(name);
      delete targets[service];
      delete last[service];
      await save();
      return view();
    },

    async forward(input) {
      if (!isRecord(input)) throw bad('request body must be a JSON object');
      for (const key of Object.keys(input)) if (key !== 'kinds') throw bad(`unknown field "${key}"`, key);
      const kinds = input.kinds;
      if (!Array.isArray(kinds) || !kinds.every((k) => typeof k === 'string' && isForward(k))) throw bad(`kinds must be a list of: ${RELAY_FORWARD_KINDS.join(', ')}`, 'kinds');
      forwarded = new Set(kinds as RelayForwardKind[]);
      await save();
      return view();
    },

    async setPhone(input) {
      if (!isRecord(input)) throw bad('request body must be a JSON object');
      for (const key of Object.keys(input)) if (key !== 'mode') throw bad(`unknown field "${key}"`, key);
      if (typeof input.mode !== 'string' || !(PHONE_MODES as readonly string[]).includes(input.mode)) throw bad(`mode must be one of: ${PHONE_MODES.join(', ')}`, 'mode');
      phone = input.mode as PhoneMode;
      await save();
      return view();
    },

    phoneTelegram: () => (phone === 'telegram' || phone === 'both') && targets.telegram !== undefined,

    async sendButtons(text, markup) {
      const target = targets.telegram;
      if (!target || closing.signal.aborted) return false;
      const clipped = text.length > RELAY_TEXT_MAX_CHARS ? `${cutText(text, RELAY_TEXT_MAX_CHARS - 1)}…` : text;
      // not in the queue of the other forwards: a button that waits behind them may be late for its dialog
      const sent = await post('telegram', target, clipped, RELAY_TRIES, { reply_markup: markup });
      last.telegram = { at: now(), ok: sent.ok, note: sent.note };
      if (!sent.ok) log.warn(`relay: telegram: ${sent.note}`);
      return sent.ok;
    },

    async telegramCall(method, body) {
      const target = targets.telegram;
      if (!target || closing.signal.aborted) return false;
      try {
        const res = await options.fetch(`https://api.telegram.org/bot${target.token}/${method}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: target.to, ...body }),
          redirect: 'error',
          signal: AbortSignal.any([AbortSignal.timeout(RELAY_TIMEOUT_MS), closing.signal]),
        });
        return res.ok;
      } catch {
        return false;
      }
    },

    async test(name) {
      const service = serviceOf(name);
      const target = targets[service];
      if (!target) throw new HubError('not_found', `no ${SERVICES[service].label} target`);
      const sent = await post(service, target, 'gonogo relay test: this target is connected.', 1);
      last[service] = { at: now(), ok: sent.ok, note: sent.ok ? 'test sent' : sent.note };
      return view();
    },

    observe(event) {
      if (event.t !== 'activity' || event.item.to !== 'user' || !forwarded.has('message')) return;
      const m = event.item;
      send(`${LABEL.message} from ${m.from}${m.subject === '' ? '' : `: ${m.subject}`}\n\n${m.body}`, { id: m.id, agent: m.from, subject: m.subject });
    },

    event(kind, text) {
      if (isForward(kind) && forwarded.has(kind)) send(`${LABEL[kind]}: ${text}`, null);
    },

    find: (key) => threads.get(key),

    seen(key) {
      if (handled.has(key)) return true;
      handled.add(key);
      if (handled.size > RELAY_SEEN_MAX) handled.delete(handled.values().next().value as string);
      return false;
    },

    telegramChat: () => targets.telegram?.to ?? null,
    telegramTarget: () => (targets.telegram === undefined ? null : { token: targets.telegram.token, to: targets.telegram.to }),
    setInbound: (read) => void (inboundOf = read),

    close() {
      closing.abort();
      queue.length = 0;
      return chain.then(() => undefined);
    },
  };
}
