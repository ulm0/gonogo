/**
 * Auto-update (docs/self-update-spec.md, "Auto-update"; docs/features/update.md): an opt-in Docker self-update that runs by itself, unattended.
 * Off by default (Flight Rules, or GONOGO_AUTO_UPDATE=1). It only ever takes the NEXT PATCH of the version that runs (while gonogo is 0.x a new
 * minor counts as a major, so it is never taken), one that Rollout has seen for a day, inside the Director's window, once per version, and only
 * after nothing has been working, nothing has needed the Director and no poll has been open for the whole lead time (10 minutes). The update itself
 * is the manual one (updater.ts: the same pull, helper, health gate, rollback and UNDO); this file only decides WHEN, and keeps the record.
 * A rolled-back version is never tried again and turns the switch off with the reason (the breaker).
 *
 * `<home>/autoupdate.json` `{ version: 1, enabled, windows, skipped, tried, pending, note }`; a file that cannot be read means off.
 */
import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AutoUpdateView, AutoUpdateWindow, Logger } from '../shared/protocol.js';
import { FILE_MODE, nullLogger } from './constants.js';
import { HubError } from './hub.js';
import type { UpdateResult } from './dockerupdate.js';
import type { Rollout } from './rollout.js';

export const AUTOUPDATE_FILE = 'autoupdate.json';
export const AUTO_LEAD_MS = 10 * 60_000;
export const AUTO_COOL_MS = 24 * 3_600_000;
const TICK_MS = 60_000;
const SETTLE_EVERY_MS = 5_000;
const SETTLE_FOLLOW_MS = 15 * 60_000;
const MAX_WINDOWS = 4;
const STABLE = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DEFAULT_WINDOWS: AutoUpdateWindow[] = [{ from: '02:00', to: '05:00' }];
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const minutesOf = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** `HH:MM-HH:MM` (24 hours, local time), or null. */
export function parseWindow(text: string): AutoUpdateWindow | null {
  const m = /^(\d\d:\d\d)\s*-\s*(\d\d:\d\d)$/.exec(text.trim());
  if (m === null || !TIME.test(m[1] as string) || !TIME.test(m[2] as string) || m[1] === m[2]) return null;
  return { from: m[1] as string, to: m[2] as string };
}

/** Whether the local time of `at` is inside one of the windows. A window whose end is before its start runs over midnight. */
export function inWindow(at: Date, windows: readonly AutoUpdateWindow[]): boolean {
  const now = at.getHours() * 60 + at.getMinutes();
  return windows.some((w) => {
    const from = minutesOf(w.from);
    const to = minutesOf(w.to);
    return from < to ? now >= from && now < to : now >= from || now < to;
  });
}

/** The next patch of the running version, and nothing else: same major and minor, a higher patch, both stable x.y.z. */
export function autoEligible(current: string, latest: string): boolean {
  const a = /^(\d+)\.(\d+)\.(\d+)/.exec(current);
  const b = STABLE.exec(latest);
  if (a === null || b === null) return false;
  return a[1] === b[1] && a[2] === b[2] && Number(b[3]) > Number(a[3]);
}

interface State {
  enabled: boolean;
  windows: AutoUpdateWindow[];
  skipped: string[];
  tried: string[];
  pending: { version: string; from: string; at: number } | null;
  note: string | null;
}

const validWindows = (value: unknown): AutoUpdateWindow[] | null => {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_WINDOWS) return null;
  const out: AutoUpdateWindow[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.from !== 'string' || typeof entry.to !== 'string') return null;
    const w = parseWindow(`${entry.from}-${entry.to}`);
    if (w === null) return null;
    out.push(w);
  }
  return out;
};

const versions = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && STABLE.test(v)).slice(-50) : []);

export interface AutoUpdateStore {
  load(): Promise<void>;
  /** The settings and the record, with the environment applied. */
  state(): State & { source: 'file' | 'env'; enabledByEnv: boolean | null };
  /** `{ enabled?, windows? }`; a bad value throws a HubError (bad_request, the field). The switch cannot be changed while the environment sets it. */
  set(input: unknown): Promise<void>;
  /** Never takes this version by itself. */
  skip(version: string): Promise<void>;
  /** One attempt per version: recorded BEFORE the update starts, with what the next start needs to tell how it ended. */
  attempt(version: string, from: string, at: number): Promise<void>;
  /** The next start has read the outcome. */
  settle(): Promise<void>;
  /** The update never started (the manual one refused): the attempt is taken back, so the version may be tried at the next chance. */
  undo(version: string): Promise<void>;
  /** The breaker: this version is not tried again, and (unless the environment forces it) the switch goes off with the reason. */
  trip(version: string, why: string): Promise<void>;
  close(): Promise<void>;
}

export function createAutoUpdateStore(options: { dir: string; env: NodeJS.ProcessEnv; log?: Logger }): AutoUpdateStore {
  const log = options.log ?? nullLogger;
  const path = join(options.dir, AUTOUPDATE_FILE);
  let s: State = { enabled: false, windows: DEFAULT_WINDOWS.map((w) => ({ ...w })), skipped: [], tried: [], pending: null, note: null };
  let chain: Promise<unknown> = Promise.resolve();
  const word = (options.env.GONOGO_AUTO_UPDATE ?? '').trim().toLowerCase();
  const enabledByEnv = ['1', 'on', 'true', 'yes'].includes(word) ? true : ['0', 'off', 'false', 'no'].includes(word) ? false : null;
  const envWindows = (() => {
    const text = options.env.GONOGO_AUTO_UPDATE_WINDOW;
    if (text === undefined || text.trim() === '') return null;
    const list = text.split(',').map((part) => parseWindow(part));
    return list.length > 0 && list.length <= MAX_WINDOWS && list.every((w) => w !== null) ? (list as AutoUpdateWindow[]) : null;
  })();
  if (options.env.GONOGO_AUTO_UPDATE_WINDOW !== undefined && options.env.GONOGO_AUTO_UPDATE_WINDOW.trim() !== '' && envWindows === null) log.warn('GONOGO_AUTO_UPDATE_WINDOW is not "HH:MM-HH:MM[,HH:MM-HH:MM]": the windows of the file apply');

  const save = (): Promise<void> => {
    const run = chain.then(async () => {
      const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      try {
        await writeFile(temp, JSON.stringify({ version: 1, ...s }, null, 2), { flag: 'wx', mode: FILE_MODE });
        await rename(temp, path);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw new Error(`could not save the auto-update settings: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    chain = run.catch(() => undefined);
    return run;
  };

  return {
    async load() {
      try {
        const saved: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!isRecord(saved) || saved.version !== 1 || typeof saved.enabled !== 'boolean') throw new Error('not a version 1 auto-update file');
        const pending = isRecord(saved.pending) && typeof saved.pending.version === 'string' && STABLE.test(saved.pending.version) && typeof saved.pending.from === 'string' && typeof saved.pending.at === 'number' ? { version: saved.pending.version, from: saved.pending.from.slice(0, 40), at: saved.pending.at } : null;
        s = { enabled: saved.enabled, windows: validWindows(saved.windows) ?? s.windows, skipped: versions(saved.skipped), tried: versions(saved.tried), pending, note: typeof saved.note === 'string' ? saved.note.slice(0, 400) : null };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        // damaged or unreadable: auto-update stays OFF and the file is left where it is for the Director to look at
        log.error(`${AUTOUPDATE_FILE} could not be read; auto-update is off`, error instanceof SyntaxError ? 'not valid JSON' : error);
        s = { ...s, enabled: false };
      }
    },
    state: () => ({ ...s, windows: envWindows ?? s.windows, enabled: enabledByEnv ?? s.enabled, source: enabledByEnv === null ? 'file' : 'env', enabledByEnv }),
    async set(input) {
      if (!isRecord(input)) throw new HubError('bad_request', 'request body must be a JSON object');
      for (const key of Object.keys(input)) if (key !== 'enabled' && key !== 'windows') throw new HubError('bad_request', `unknown field "${key}"`, key);
      if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new HubError('bad_request', 'enabled must be true or false', 'enabled');
      if (input.enabled !== undefined && enabledByEnv !== null) throw new HubError('conflict', 'GONOGO_AUTO_UPDATE sets this switch: change the environment of the container', 'enabled');
      const windows = input.windows === undefined ? null : validWindows(input.windows);
      if (input.windows !== undefined && windows === null) throw new HubError('bad_request', `windows are 1 to ${MAX_WINDOWS} of { "from": "HH:MM", "to": "HH:MM" } (24 hours, local time, from not equal to)`, 'windows');
      const before = s;
      s = { ...s, ...(input.enabled === undefined ? {} : { enabled: input.enabled, note: input.enabled ? null : s.note }), ...(windows === null ? {} : { windows }) };
      try {
        await save();
      } catch (error) {
        s = before;
        throw error;
      }
    },
    async skip(version) {
      if (!STABLE.test(version)) throw new HubError('bad_request', 'version must be a release number like 1.2.3', 'version');
      if (!s.skipped.includes(version)) s = { ...s, skipped: [...s.skipped, version].slice(-50) };
      await save();
    },
    async attempt(version, from, at) {
      s = { ...s, tried: s.tried.includes(version) ? s.tried : [...s.tried, version].slice(-50), pending: { version, from, at } };
      await save();
    },
    async settle() {
      if (s.pending === null) return;
      s = { ...s, pending: null };
      await save();
    },
    async undo(version) {
      s = { ...s, tried: s.tried.filter((v) => v !== version), pending: null };
      await save();
    },
    async trip(version, why) {
      s = { ...s, tried: s.tried.includes(version) ? s.tried : [...s.tried, version].slice(-50), pending: null, enabled: enabledByEnv === null ? false : s.enabled, note: `${version} was not updated (${why}); it will not be tried again${enabledByEnv === null ? ', and auto-update is off until you turn it on again' : ''}.` };
      await save();
    },
    close: () => chain.then(() => undefined),
  };
}

export interface AutoUpdaterOptions {
  store: AutoUpdateStore;
  rollout: Pick<Rollout, 'view' | 'seenAt'>; // view().update: how the update this process started is going
  /** The version that runs. */
  current: string;
  /** null when this install can update itself by Docker (the socket, a moving tag, room main); else the reason it cannot. */
  unavailable(): string | null;
  /** Why this room or any other is busy (a working or needing agent, queued mail, a poll or Static fire), or null. */
  busy(): Promise<string | null>;
  /** The manual update: one call, the same checks. */
  start(version: string): Promise<unknown> | unknown;
  /** True while an update is already running (or just handed off). */
  updating(): boolean;
  readResult(): Promise<UpdateResult | null>;
  notify(text: string): void;
  now(): number;
  log?: Logger;
}

export interface AutoUpdater {
  /** Reads how an update that auto-update started ended (this process may be the new one), then ticks every minute. */
  start(): Promise<void>;
  view(): AutoUpdateView;
  /** One look at the conditions; exposed for tests (the timer calls it). */
  tick(): Promise<void>;
  /** One look at how the last update ended; true when nothing is left to wait for. Exposed for tests (start() follows it). */
  settle(): Promise<boolean>;
  close(): void;
}

const clock = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export function createAutoUpdater(options: AutoUpdaterOptions): AutoUpdater {
  const log = options.log ?? nullLogger;
  let plan: { version: string; since: number } | null = null;
  const announced = new Set<string>();
  const refused = new Set<string>();
  let waiting: string | null = null;
  let timer: NodeJS.Timeout | undefined;
  let ticking = false;
  let retry: NodeJS.Timeout | undefined;

  /** Why it is not time (null when it is). */
  async function why(): Promise<string | null> {
    const st = options.store.state();
    if (!st.enabled) return 'auto-update is off';
    const cant = options.unavailable();
    if (cant !== null) return cant;
    const view = options.rollout.view();
    if (!view.enabled) return 'the update check is off';
    if (!view.newer || view.latest === null) return 'no newer version';
    const latest = view.latest;
    if (!autoEligible(options.current, latest)) return `${latest} is not the next patch of ${options.current}: only the Update key takes it (a new minor or major never installs by itself)`;
    if (st.tried.includes(latest)) return `${latest} was tried once already`;
    if (st.skipped.includes(latest)) return `${latest} is skipped`;
    const seen = options.rollout.seenAt();
    if (seen === null || options.now() - seen < AUTO_COOL_MS) return `${latest} is not a day old yet`;
    if (!inWindow(new Date(options.now()), st.windows)) return 'outside the window';
    if (options.updating()) return 'an update is running';
    return await options.busy();
  }

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      // the update it started failed before the helper took over (the pull was refused, the version label was wrong): this process is still the old one
      const pending = options.store.state().pending;
      const update = options.rollout.view().update;
      // an attempt still on record with nothing running for it: how did it end? (a restart between the note and the helper leaves one)
      if (pending !== null && update?.state !== 'failed' && !options.updating() && options.current !== pending.version && (await settleOnce())) return;
      if (pending !== null && update?.state === 'failed' && update.version === pending.version) {
        const reason = update.note.slice(0, 300).replace(/[.\s]+$/, '');
        await options.store.trip(pending.version, reason);
        options.notify(`Auto-update to ${pending.version} failed: ${reason} gonogo is running ${options.current} as before. ${pending.version} is not tried again and auto-update is off until you turn it on.`);
        return;
      }
      const blocked = await why();
      waiting = blocked;
      const latest = options.rollout.view().latest;
      if (blocked !== null || latest === null) {
        plan = null;
        return;
      }
      const now = options.now();
      if (plan === null || plan.version !== latest) {
        plan = { version: latest, since: now };
        if (!announced.has(latest)) {
          announced.add(latest);
          options.notify(`Auto-update to ${latest} starts at about ${clock(now + AUTO_LEAD_MS)} if nothing starts working before then. Nothing is working now. To stop it: SKIP THIS VERSION or turn auto-update off in Flight Rules.`);
        }
        return;
      }
      if (now - plan.since < AUTO_LEAD_MS) return;
      plan = null;
      // recorded first: whatever happens next, this version is not tried a second time
      await options.store.attempt(latest, options.current, now);
      try {
        await options.start(latest);
      } catch (error) {
        // the manual update refused before it touched anything (a poll opened, the socket went): not an attempt, and not a reason to turn off
        const text = error instanceof Error ? error.message : String(error);
        await options.store.undo(latest);
        if (!refused.has(latest)) {
          refused.add(latest);
          options.notify(`Auto-update to ${latest} did not start: ${text}. Nothing was changed; it will try again at the next quiet moment in a window.`);
        }
      }
    } catch (error) {
      log.warn(`the auto-update check failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      ticking = false;
    }
  }

  /**
   * The record an earlier process left: did the update it started end well? Judged by the helper's own result (update.json), never by the version
   * alone: the new container runs for a moment before its health check passes, and a failed one is torn down and the old one comes back. Returns true
   * when there is nothing left to wait for (this process may be either of the two).
   */
  async function settleOnce(): Promise<boolean> {
    const pending = options.store.state().pending;
    if (pending === null) return true;
    const result = await options.readResult();
    const mine = result !== null && result.to === pending.version ? result : null;
    const bad = mine !== null && (mine.state === 'rolled-back' || mine.state === 'failed' || mine.state === 'interrupted');
    if (options.current === pending.version) {
      // the new container: only the helper's "ok" says it stayed; "started" is the health wait, and a rolled-back one is about to be removed
      if (mine?.state === 'ok') {
        await options.store.settle();
        options.notify(`Auto-update: updated ${pending.from} to ${pending.version}. The agents that were running start again by themselves (the startup setting); UNDO is on the update strip for a day.`);
        return true;
      }
      return bad;
    }
    if (bad) {
      const reason = mine.state === 'interrupted' ? 'the helper stopped half way' : mine.note === '' ? mine.state : mine.note.slice(0, 300).replace(/[.\s]+$/, '');
      await options.store.trip(pending.version, reason);
      options.notify(`Auto-update to ${pending.version} ${mine.state === 'rolled-back' ? 'was rolled back' : 'failed'}: ${reason}. gonogo is running ${options.current} as before. ${pending.version} is not tried again and auto-update is off until you turn it on.`);
      return true;
    }
    // a helper still at work: this process is the old one waiting for it
    if (mine !== null) return false;
    // no record of this update at all: gonogo restarted between the note of the attempt and the helper (or the pull failed and was lost): the attempt
    // never happened, so the version is open again, and the Director is told (no silent skip)
    await options.store.undo(pending.version);
    options.notify(`Auto-update to ${pending.version} was interrupted before it started (gonogo restarted, or nothing came of it). Nothing was changed; it will try again at the next quiet moment in a window.`);
    return true;
  }

  /** Follows the record every few seconds for a quarter of an hour (the helper's health wait is minutes), then lets it be. */
  function follow(since: number): void {
    retry = setTimeout(() => {
      settleOnce().then(
        (done) => {
          if (!done && options.now() - since < SETTLE_FOLLOW_MS) follow(since);
        },
        (error: unknown) => log.warn(`could not read how the last auto-update ended: ${error instanceof Error ? error.message : String(error)}`),
      );
    }, SETTLE_EVERY_MS);
    retry.unref();
  }

  return {
    async start() {
      const done = await settleOnce().catch((error: unknown) => (log.warn(`could not read how the last auto-update ended: ${error instanceof Error ? error.message : String(error)}`), true));
      if (!done) follow(options.now());
      timer = setInterval(() => void tick(), TICK_MS);
      timer.unref();
    },
    view() {
      const st = options.store.state();
      const latest = options.rollout.view().latest;
      return {
        enabled: st.enabled,
        source: st.source,
        available: options.unavailable() === null,
        unavailable: options.unavailable(),
        windows: st.windows,
        skipped: st.skipped,
        tried: st.tried,
        note: st.note,
        latest,
        waiting,
        plan: plan === null ? null : { version: plan.version, startsAt: plan.since + AUTO_LEAD_MS },
      };
    },
    tick,
    settle: settleOnce,
    close() {
      clearInterval(timer);
      clearTimeout(retry);
    },
  };
}
