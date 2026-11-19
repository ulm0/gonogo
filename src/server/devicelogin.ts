/**
 * TUI device login (docs/login-spec.md, last section): a terminal that has no credential asks for one, the Director approves it in a browser
 * they are signed in to, and the terminal's next poll gets a session of kind `tui`. Modelled on the OAuth device grant (RFC 8628) and `gh auth login`.
 *
 * Everything here is in memory (a restart of gonogo ends the flows) and anonymous callers reach `start` and `poll`, so they are small and counted:
 * 2 pending flows per address and 5 in all, 5 starts per address per 10 minutes and 30 an hour, a poll faster than `interval` is `slow_down` and counted.
 * The code is typed by the Director (never in an address); a flow dies after 10 minutes, or 2 minutes after its approval if nobody polls.
 */
import { createHash, randomBytes } from 'node:crypto';
import { cleanText, networkOf } from './auth.js';
import type { AuthStore, Who } from './auth.js';

export const DEVICE_EXPIRES_S = 600;
export const DEVICE_INTERVAL_S = 5;
const APPROVED_KEEP_MS = 2 * 60 * 1000;
const PER_ADDRESS = 2;
const IN_ALL = 5;
const STARTS_ADDRESS = { count: 5, windowMs: 10 * 60 * 1000 };
const STARTS_ALL = { count: 30, windowMs: 60 * 60 * 1000 };
const SLOWS_ADDRESS = { count: 30, windowMs: 10 * 60 * 1000 };
const WRONG_CODES = { count: 5, windowMs: 10 * 60 * 1000 };
/** No 0, O, 1, I or L: a code is read off a screen and typed. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const LABEL_MAX = 40;
export const AGENT_MAX = 200;

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const userCode = (): string => {
  const bytes = randomBytes(8);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
};
/** What a person typed (case, spaces and a dash do not matter) as it is stored. */
export const normalizeCode = (text: string): string => text.replace(/[\s-]/g, '').toUpperCase();
export const showCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;

interface Flow {
  /** SHA-256 of the device code: the polling secret is never kept. */
  hash: string;
  code: string;
  label: string;
  address: string;
  agent: string;
  at: number;
  lastPoll: number;
  status: 'pending' | 'approved' | 'denied';
  approvedAt: number;
  /** Who approved, for the alert: the address of the browser session. */
  approver: string;
}

export interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}
export type DevicePoll = { error: 'authorization_pending' | 'slow_down' | 'expired_token' | 'access_denied' } | { token: string } | { rate: true };
/** What the approve page shows about a flow, by its typed code. */
export interface DeviceView {
  label: string;
  address: string;
  agent: string;
  asked: number;
  far: boolean;
}
export type Decide = { ok: true; label: string } | { ok: false; reason: 'none' | 'wait' };

export interface Devices {
  start(who: Who, label: unknown, verificationUri: string): { ok: true; flow: DeviceStart } | { ok: false; reason: 'rate' | 'cap' };
  poll(who: Who, deviceCode: unknown): DevicePoll;
  /** The flow a typed code names, or null: not consumed. `wrong` counts the try against the approving session. */
  find(session: string, who: Who, typed: string): { view: DeviceView } | { wait: true } | null;
  /** Approve or deny the flow the typed code names. */
  decide(session: string, who: Who, typed: string, approve: boolean): Decide;
  /** For the tests and the status: how many flows are open. */
  open(): number;
}

export function createDevices(options: { auth: AuthStore; now: () => number; alert: (text: string) => void; notice: (text: string) => void }): Devices {
  const { auth, now } = options;
  const flows = new Map<string, Flow>();
  const starts = new Map<string, number[]>();
  const allStarts: number[] = [];
  const slows = new Map<string, number[]>();
  const wrong = new Map<string, number[]>();

  const recent = (list: number[], windowMs: number): number[] => list.filter((t) => now() - t < windowMs);
  const sweep = (): void => {
    const t = now();
    for (const [key, f] of flows) {
      const dead = t - f.at > DEVICE_EXPIRES_S * 1000 || (f.status === 'approved' && t - f.approvedAt > APPROVED_KEEP_MS);
      if (dead) flows.delete(key);
    }
  };
  const live = (): Flow[] => [...flows.values()].filter((f) => f.status !== 'denied');

  return {
    open: () => flows.size,

    start(who, label, verificationUri) {
      sweep();
      const mine = starts.get(who.address) ?? [];
      const recentMine = recent(mine, STARTS_ADDRESS.windowMs);
      const recentAll = recent(allStarts, STARTS_ALL.windowMs);
      if (recentMine.length >= STARTS_ADDRESS.count || recentAll.length >= STARTS_ALL.count) return { ok: false, reason: 'rate' };
      const pending = live().filter((f) => f.status === 'pending');
      if (pending.filter((f) => f.address === who.address).length >= PER_ADDRESS || pending.length >= IN_ALL) return { ok: false, reason: 'cap' };
      starts.set(who.address, [...recentMine, now()]);
      allStarts.splice(0, allStarts.length, ...recentAll, now());
      const deviceCode = randomBytes(32).toString('base64url');
      const code = userCode();
      flows.set(sha(deviceCode), { hash: sha(deviceCode), code, label: cleanText(label, LABEL_MAX), address: who.address, agent: cleanText(who.agent, AGENT_MAX), at: now(), lastPoll: 0, status: 'pending', approvedAt: 0, approver: '' });
      // every open page learns that a device is asking, before anybody is asked for a code (not to Relay: a phone that says so is a phisher's timing)
      options.notice(`A device at ${who.address} is asking to log in to the terminal. If you did not start it, ignore it.`);
      return { ok: true, flow: { device_code: deviceCode, user_code: showCode(code), verification_uri: verificationUri, expires_in: DEVICE_EXPIRES_S, interval: DEVICE_INTERVAL_S } };
    },

    // M4: the check of `approved`, the session, and the end of the flow are one synchronous step: no await between them, so two polls with one code give one token
    poll(who, deviceCode) {
      sweep();
      if (typeof deviceCode !== 'string' || deviceCode === '' || deviceCode.length > 100) return { error: 'expired_token' };
      const f = flows.get(sha(deviceCode));
      if (f === undefined) return { error: 'expired_token' };
      const faster = f.lastPoll !== 0 && now() - f.lastPoll < DEVICE_INTERVAL_S * 1000;
      f.lastPoll = now();
      if (faster) {
        const list = recent(slows.get(who.address) ?? [], SLOWS_ADDRESS.windowMs);
        list.push(now());
        slows.set(who.address, list);
        return list.length > SLOWS_ADDRESS.count ? { rate: true } : { error: 'slow_down' };
      }
      if (f.status === 'denied') {
        flows.delete(f.hash);
        return { error: 'access_denied' };
      }
      if (f.status === 'pending') return { error: 'authorization_pending' };
      flows.delete(f.hash);
      const token = auth.tuiStart({ address: f.address, agent: f.agent, label: f.label });
      options.alert(`TUI session approved: ${f.label || 'unnamed'}, from ${f.address}, approved from ${f.approver}`);
      return { token };
    },

    find(session, who, typed) {
      sweep();
      const list = recent(wrong.get(session) ?? [], WRONG_CODES.windowMs);
      wrong.set(session, list);
      if (list.length >= WRONG_CODES.count) return { wait: true };
      const code = normalizeCode(typed);
      const f = [...flows.values()].find((x) => x.code === code && x.status === 'pending');
      if (f === undefined) {
        list.push(now());
        return null;
      }
      return { view: { label: f.label, address: f.address, agent: f.agent, asked: f.at, far: networkOf(f.address) !== networkOf(who.address) } };
    },

    decide(session, who, typed, approve) {
      const found = this.find(session, who, typed);
      if (found === null) return { ok: false, reason: 'none' };
      if ('wait' in found) return { ok: false, reason: 'wait' };
      const code = normalizeCode(typed);
      const f = [...flows.values()].find((x) => x.code === code && x.status === 'pending') as Flow;
      f.code = ''; // single use: consumed by approve, deny
      if (approve) {
        f.status = 'approved';
        f.approvedAt = now();
        f.approver = `${who.address}${who.agent === '' ? '' : ` (${cleanText(who.agent, 60)})`}`;
      } else f.status = 'denied';
      return { ok: true, label: f.label };
    },
  };
}
