/**
 * Relief on the page (docs/relief-spec.md): the words of a hire request that waits for the Director. No JSX, so that the
 * tests can reach it.
 */
import { positionById } from '../shared/positions.js';
import { providerInfo } from '../shared/protocol.js';
import type { PermissionMode, ReliefRequest } from '../shared/protocol.js';

/** The names of the modes as the hire form shows them, with what each does. A request never holds the last two. */
const MODE_TEXT: Readonly<Record<PermissionMode, string>> = {
  default: 'ASK: asks you for a go before a tool runs',
  acceptEdits: 'ACCEPT EDITS: edits files without asking',
  auto: 'AUTO',
  bypassPermissions: 'BYPASS',
};

export interface ReliefRow {
  label: string;
  value: string;
}

/** `FLIGHT ASKS TO HIRE guido-1`: the legend is the call sign of the boss that asked. */
export const reliefTitle = (request: Pick<ReliefRequest, 'name'>, legend: string): string => `${legend} ASKS TO HIRE ${request.name}`;

/** The label over the role text: its length says how much there is to read, since the box scrolls. */
export const roleLabel = (request: Pick<ReliefRequest, 'role'>): string => `Role text (${request.role.length} ${request.role.length === 1 ? 'character' : 'characters'})`;

/** How long the request still waits, in whole minutes rounded up. */
export function expiresText(request: Pick<ReliefRequest, 'expiresAt'>, now: number): string {
  const left = request.expiresAt - now;
  if (left <= 0) return 'expiring now';
  if (left < 60_000) return 'under a minute left';
  const minutes = Math.ceil(left / 60_000);
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} left`;
}

/** Every parameter of the request except the role text, in the order the Director reads them. */
export function reliefRows(request: ReliefRequest, now: number): ReliefRow[] {
  const position = positionById(request.position);
  const rows: ReliefRow[] = [
    { label: 'Name', value: request.name },
    { label: 'Position', value: position === null ? 'none: a role of its own' : `${position.callSign} · ${position.title}` },
    { label: 'Engine', value: providerInfo(request.provider).label },
    // an engine without permission modes runs on its own rules whatever the hub passes: 'ASK' would promise what it does not do
    { label: 'Mode', value: providerInfo(request.provider).modes ? MODE_TEXT[request.mode] : 'none: this engine has no permission modes in gonogo, its own rules apply' },
    { label: 'Folder', value: request.dir },
  ];
  if (request.cleanRoom !== null) rows.push({ label: 'Clean Room', value: request.cleanRoom.image === undefined ? 'yes: its own container and branch' : `yes: its own container and branch, image ${request.cleanRoom.image}` });
  rows.push({ label: 'Waits', value: expiresText(request, now) });
  return rows;
}

/** The line for the live region when the number of requests that wait grows. */
export const reliefAnnouncement = (waiting: number): string => `${waiting} hire ${waiting === 1 ? 'request waits' : 'requests wait'} for your go`;
