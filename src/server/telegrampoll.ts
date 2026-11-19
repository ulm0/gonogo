/**
 * Telegram inbound by long polling (docs/features/relay.md): `getUpdates`, so a gonogo behind a LAN with no public address still hears the
 * Director's Telegram messages and button presses. Each update goes through the SAME read as a webhook delivery (uplinks.ts `deliverPolled`):
 * the chat filter (only the chat of the target), reply routing, dedup, and the phone-approval buttons.
 *
 * On whenever the Telegram target (token and chat) is set and no Telegram uplink exists. One loop in the process that holds the Relay (room main).
 * The offset (last update_id + 1) is kept in telegram-poll.json (0600) with the bot's id and written after each update is handed on, so a restart does not
 * replay. The FIRST start (no offset yet, or another bot) asks `getUpdates {offset: -1, timeout: 0}`, takes that update's id + 1 and hands on NOTHING from
 * that call: Telegram keeps a day of updates, and they must not arrive as new messages.
 * A webhook that is set makes Telegram answer 409: said in the RELAY card, never removed by gonogo (no deleteWebhook). A 409 "terminated by other getUpdates request"
 * is another program polling the same bot (a second gonogo, a reload overlap): said so and backed off like an error. Errors back off, capped and
 * with no hot loop. The token is in the URL: it is never in a log line, an error or the state this module shows.
 *
 * shortcut: delivery is at least once (the offset is written after the hand-on), so a crash between the two repeats one update; a message is not lost.
 * shortcut: the RELAY card reads this state when it is opened or changed; it is not pushed.
 */
import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../shared/protocol.js';
import { FILE_MODE } from './constants.js';
import { isRecord } from './hooks.js';

export const TELEGRAM_POLL_FILE = 'telegram-poll.json';
const LONG_POLL_S = 50;
const CHECK_MS = 2_000;
const WEBHOOK_RETRY_MS = 60_000;
const BACKOFF_FIRST_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const BAD_TOKEN_RETRY_MS = 5 * 60_000;
const API_MS = (LONG_POLL_S + 15) * 1000;

export type PollMode = 'off' | 'polling' | 'webhook' | 'uplink' | 'error';
export interface PollState {
  mode: PollMode;
  /** One line for the RELAY card; never a token. */
  note: string;
}

export interface TelegramPollOptions {
  /** gonogo's home: telegram-poll.json lives here. */
  dir: string;
  /** The Telegram target of Relay, or null. */
  target(): { token: string; to: string } | null;
  /** A Telegram uplink exists: it gets the updates by webhook, so polling stays off. */
  hasUplink(): boolean;
  /** One update, as Telegram sent it, with the secret that signs the buttons. Never throws. */
  deliver(update: Buffer, secret: string): void;
  fetch: typeof fetch;
  /** Waits; resolves early when the signal aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
  log: Logger;
}

export interface TelegramPoll {
  load(): Promise<void>;
  /** Starts the loop (one per process). */
  start(): void;
  state(): PollState;
  /** The secret that signs the buttons of phone approvals while there is no Telegram uplink (made once, kept in telegram-poll.json). */
  secret(): string;
  /** Ends the loop and the request in flight. */
  stop(): Promise<void>;
}

/** What an error may say: the name and a short code, never a message (a message of a failed fetch can hold the URL). */
const safe = (error: unknown): string => {
  if (!(error instanceof Error)) return 'error';
  const cause = (error as { cause?: { code?: unknown } }).cause;
  return `${error.name}${typeof cause?.code === 'string' ? ` ${cause.code}` : ''}`;
};

export function createTelegramPoll(options: TelegramPollOptions): TelegramPoll {
  const { log } = options;
  const path = join(options.dir, TELEGRAM_POLL_FILE);
  /** null: nothing is known yet (the first start, or another bot): the next call primes it. */
  let offset: number | null = null;
  /** The bot the offset belongs to: the number before the colon of the token. */
  let bot = '';
  let key = randomBytes(32).toString('hex');
  let state: PollState = { mode: 'off', note: 'Telegram inbound is off until a Telegram target is set.' };
  const stopping = new AbortController();
  let running: Promise<void> | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  const save = (): void => {
    const json = JSON.stringify({ version: 1, offset, bot, secret: key });
    chain = chain
      .then(async () => {
        const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
        try {
          await writeFile(temp, json, { flag: 'wx', mode: FILE_MODE });
          await rename(temp, path);
        } catch (error) {
          await rm(temp, { force: true }).catch(() => undefined);
          throw error;
        }
      })
      .catch((error: unknown) => log.warn(`telegram polling: the offset could not be saved (${safe(error)})`));
  };

  const set = (mode: PollMode, note: string): void => {
    if (state.mode !== mode || state.note !== note) state = { mode, note };
  };

  /** One getUpdates; resolves with what happened, never throws and never says the token. */
  async function once(token: string, signal: AbortSignal, ask: { offset: number; timeout: number } = { offset: offset ?? 0, timeout: LONG_POLL_S }): Promise<{ kind: 'updates'; updates: Record<string, unknown>[] } | { kind: 'webhook' | 'badtoken' | 'wait' | 'error' | 'other'; waitMs?: number; note: string }> {
    try {
      const res = await options.fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offset: ask.offset, timeout: ask.timeout, allowed_updates: ['message', 'callback_query'] }),
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(API_MS)]),
      });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        // not JSON: the status says it
      }
      if (res.status === 409) {
        // two meanings: a webhook is set, or another getUpdates is running for this bot (Telegram ends the older one)
        const said = isRecord(body) && typeof body.description === 'string' ? body.description : '';
        if (/terminated by other getUpdates|other getUpdates request/i.test(said)) return { kind: 'other', note: 'Another program polls this bot (a second gonogo, a reload that overlaps, a script): this one waits and tries again.' };
      }
      if (res.status === 409) return { kind: 'webhook', note: 'A webhook is set for this bot; inbound uses it. Polling resumes when the webhook is removed (gonogo never removes it).' };
      if (res.status === 401 || res.status === 404) return { kind: 'badtoken', note: 'Telegram refused the bot token: check it in this card.' };
      if (res.status === 429) {
        const retry = isRecord(body) && isRecord(body.parameters) && typeof body.parameters.retry_after === 'number' ? body.parameters.retry_after : 30;
        return { kind: 'wait', waitMs: Math.min(Math.max(retry, 1), 300) * 1000, note: 'Telegram asked for a pause.' };
      }
      if (!res.ok || !isRecord(body) || body.ok !== true || !Array.isArray(body.result)) return { kind: 'error', note: `Telegram answered ${res.status}.` };
      return { kind: 'updates', updates: body.result.filter(isRecord) };
    } catch (error) {
      if (signal.aborted) return { kind: 'wait', waitMs: 0, note: '' };
      return { kind: 'error', note: `Telegram could not be reached (${safe(error)}).` };
    }
  }

  async function loop(): Promise<void> {
    let backoff = BACKOFF_FIRST_MS;
    while (!stopping.signal.aborted) {
      const target = options.target();
      if (target === null || target.token === '' || target.to === '') {
        set('off', 'Telegram inbound is off until a Telegram target is set.');
        await options.sleep(CHECK_MS, stopping.signal);
        continue;
      }
      if (options.hasUplink()) {
        set('uplink', 'A Telegram uplink is set: inbound uses its webhook, so polling is off.');
        await options.sleep(CHECK_MS, stopping.signal);
        continue;
      }
      // a token changed while a request is in flight ends it: the next turn of the loop uses the new one
      const turn = new AbortController();
      const watch = setInterval(() => {
        const now = options.target();
        if (now === null || now.token !== target.token || options.hasUplink()) turn.abort();
      }, 2_000);
      watch.unref();
      const botNow = target.token.split(':')[0] ?? '';
      // another bot has its own update ids: start again from its newest
      if (bot !== '' && bot !== botNow) offset = null;
      const priming = offset === null;
      let result: Awaited<ReturnType<typeof once>>;
      try {
        result = await once(target.token, AbortSignal.any([stopping.signal, turn.signal]), priming ? { offset: -1, timeout: 0 } : undefined);
      } finally {
        clearInterval(watch);
      }
      if (stopping.signal.aborted) return;
      switch (result.kind) {
        case 'updates': {
          backoff = BACKOFF_FIRST_MS;
          if (priming) {
            // nothing of what Telegram still holds is handed on: only what comes after
            const ids = result.updates.map((u) => u.update_id).filter((id): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id >= 0);
            offset = ids.length === 0 ? 0 : Math.max(...ids) + 1;
            bot = botNow;
            save();
            set('polling', 'Telegram inbound: getUpdates long polling, no public address needed.');
            break;
          }
          if (bot !== botNow) {
            bot = botNow;
            save();
          }
          set('polling', 'Telegram inbound: getUpdates long polling, no public address needed.');
          for (const update of [...result.updates].sort((a, b) => Number(a.update_id) - Number(b.update_id))) {
            const id = update.update_id;
            if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) continue;
            try {
              options.deliver(Buffer.from(JSON.stringify(update)), key);
            } catch (error) {
              log.warn(`telegram polling: an update was not handled (${safe(error)})`);
            }
            if (id + 1 > (offset ?? 0)) {
              offset = id + 1;
              save();
            }
          }
          break;
        }
        case 'other':
          set('error', result.note);
          await options.sleep(backoff, stopping.signal);
          backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
          break;
        case 'webhook':
          set('webhook', result.note);
          await options.sleep(WEBHOOK_RETRY_MS, stopping.signal);
          break;
        case 'badtoken':
          set('error', result.note);
          await options.sleep(BAD_TOKEN_RETRY_MS, stopping.signal);
          break;
        case 'wait':
          // an abort (a token change) comes back with 0: look again at once
          if (result.note !== '') set('error', result.note);
          if (result.waitMs !== undefined && result.waitMs > 0) await options.sleep(result.waitMs, stopping.signal);
          break;
        case 'error':
          set('error', result.note);
          log.warn(`telegram polling: ${result.note}`);
          await options.sleep(backoff, stopping.signal);
          backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
          break;
      }
    }
  }

  return {
    async load() {
      try {
        const saved: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (isRecord(saved) && saved.version === 1) {
          if (typeof saved.offset === 'number' && Number.isSafeInteger(saved.offset) && saved.offset >= 0 && typeof saved.bot === 'string' && /^\d{1,20}$/.test(saved.bot)) {
            offset = saved.offset;
            bot = saved.bot;
          }
          if (typeof saved.secret === 'string' && /^[0-9a-f]{64}$/.test(saved.secret)) key = saved.secret;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`${TELEGRAM_POLL_FILE} could not be read; polling starts at the newest update`);
      }
      save();
    },
    start() {
      running ??= loop().catch((error: unknown) => log.error(`telegram polling stopped (${safe(error)})`));
    },
    state() {
      // a target set a moment ago: the loop looks again within two seconds
      if (state.mode === 'off' && options.target() !== null && !options.hasUplink() && !stopping.signal.aborted) return { mode: 'off', note: 'Telegram inbound is starting: the first look is within a few seconds.' };
      return state;
    },
    secret: () => key,
    async stop() {
      stopping.abort();
      await running;
      await chain;
    },
  };
}
