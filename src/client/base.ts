/**
 * Rooms (docs/rooms-spec.md): behind the supervisor a room's page is served at `/r/<id>/`, and every request of the page must stay under
 * that prefix. `BASE` is the prefix ('' at `/`, so a single room is unchanged); `withBase` puts it in front of an absolute path.
 * It is read from the address of the page itself, so the server needs to tell the page nothing. The room's asset paths are relative.
 */
const ROOM_PATH = /^(\/r\/[a-z][a-z0-9-]{0,23})\//;

export const baseOf = (pathname: string): string => ROOM_PATH.exec(pathname)?.[1] ?? '';

export const BASE = baseOf(typeof location === 'undefined' ? '/' : location.pathname);

/** The list of rooms, a page of the supervisor (src/server/supervisor.ts ROOMS_PATH). */
export const ROOMS_PATH = '/rooms';

export const withBase = (path: string): string => BASE + path;

/** The address other machines use to reach this room: its origin and its prefix (webhooks and docking calls go there). */
export const roomOrigin = (): string => location.origin + BASE;
