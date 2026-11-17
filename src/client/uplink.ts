import { UPLINK_GIVEN_SECRET_KINDS, UPLINK_NAME_MAX_CHARS } from '../shared/protocol.js';
import type { UplinkDelivery, UplinkKind, UplinkRequest, UplinkView } from '../shared/protocol.js';
import { MONTHS, pad } from './launch.js';

// What Uplink shows and asks, kept out of UplinkPanel.tsx so that it can be tested without a DOM. Who an uplink writes to is
// chosen and named as in Launch Window (`recipients` and `toText` of launch.ts).

/** The address a service posts to, on the origin the page came from. A reverse proxy may give another one; the reference says how. */
export const endpointOf = (origin: string, id: string): string => `${origin}/uplink/${id}`;

/** A time for a delivery: the clock of this browser, with the date when it was not today. */
export function atText(at: number, now: number): string {
  const d = new Date(at);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return new Date(now).toDateString() === d.toDateString() ? time : `${d.getDate()} ${MONTHS[d.getMonth()]} ${time}`;
}

/** The last delivery of an uplink for its row. */
export function lastText(uplink: UplinkView, now: number): string {
  const last = uplink.deliveries[0];
  return last === undefined ? 'No deliveries yet' : `Last delivery ${atText(last.at, now)}: ${last.note}`;
}

/** The look of a delivery's chip: sent on is go, held is amber, a message that did not go or a request that was refused is no-go. */
export function toneOf(status: UplinkDelivery['status']): 'go' | 'amber' | 'nogo' | 'quiet' {
  if (status === 'queued' || status === 'delivered' || status === 'read') return 'go';
  if (status === 'held') return 'amber';
  return status === 'undelivered' || status === 'refused' ? 'nogo' : 'quiet';
}

export interface Values {
  name: string;
  to: string;
  enabled: boolean;
}
export type Field = 'name' | 'to' | 'secret';
export type Problems = Partial<Record<Field, string>>;
export const FIELDS: readonly Field[] = ['name', 'to', 'secret'];

/** Slack and Linear make the signing secret; the uplink takes theirs (and keeps its own kind of secret for the other kinds). */
export const needsSecret = (kind: UplinkKind): boolean => UPLINK_GIVEN_SECRET_KINDS.includes(kind);
/** The same shape as the server's: 16 to 256 printable characters, no spaces. Empty is fine when editing: the saved one stays. */
export const secretProblem = (secret: string, editing: boolean): string | undefined =>
  secret === '' ? (editing ? undefined : 'Paste the signing secret.') : /^[\x21-\x7e]{16,256}$/.test(secret) ? undefined : 'A signing secret has 16 to 256 characters and no spaces.';

export const emptyValues = (to: string): Values => ({ name: '', to, enabled: true });
export const valuesOf = (u: UplinkView): Values => ({ name: u.name, to: u.to, enabled: u.enabled });

export function validate(v: Values): Problems {
  const problems: Problems = {};
  const name = v.name.trim();
  if (name === '') problems.name = 'Give it a name.';
  else if (name.length > UPLINK_NAME_MAX_CHARS) problems.name = `At most ${UPLINK_NAME_MAX_CHARS} characters.`;
  if (v.to === '') problems.to = 'Pick who gets it.';
  return problems;
}

export const requestOf = (v: Values): UplinkRequest => ({ name: v.name.trim(), to: v.to, enabled: v.enabled });

/** Puts text on the clipboard. false where the browser has none or refuses: the page is not on HTTPS or localhost, or the tab has no focus. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
