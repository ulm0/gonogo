/**
 * Rooms (docs/rooms-spec.md): behind the supervisor a room's page is served at `/r/<id>/`, and every request of the page must stay under
 * that prefix. `BASE` is the prefix ('' only on a page that is not a room's, such as one left open from 0.5.0 at `/`, which the root aliases still serve); `withBase` puts it in front of an absolute path.
 * It is read from the address of the page itself, so the server needs to tell the page nothing. The room's asset paths are relative.
 */
const ROOM_PATH = /^(\/r\/[a-z][a-z0-9-]{0,23})\//;

export const baseOf = (pathname: string): string => ROOM_PATH.exec(pathname)?.[1] ?? '';

export const BASE = baseOf(typeof location === 'undefined' ? '/' : location.pathname);

/** The list of rooms, the supervisor's page at the root (every room, main too, is under /r/<id>/). */
export const ROOMS_PATH = '/';

/** The main room: it checks for a newer gonogo and is where Update lives. */
export const MAIN_PATH = '/r/main/';

export const withBase = (path: string): string => BASE + path;

/** The address other machines use to reach this room: its origin and its prefix (webhooks and docking calls go there). */
let publicOrigin: string | null = null;
/** `--public-url` (docs/expose-spec.md): the address other machines use, when the Director gave one; the page may be open on another name (a LAN address). */
export const setPublicOrigin = (origin: string | null | undefined): void => {
  publicOrigin = typeof origin === 'string' && /^https?:\/\/[^/\s]+$/.test(origin) ? origin : null;
};
export const roomOrigin = (): string => (publicOrigin ?? location.origin) + BASE;
