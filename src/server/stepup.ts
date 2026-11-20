/**
 * Step-up (docs/login-spec.md, "Step-up, widened"): which changes need the password (and the second factor) again when the session's last check is
 * more than five minutes old. It is a speed bump for the quick routes, not a wall: typing into a console, a message to an agent, a GO on a
 * permission dialog and starting or restarting an existing agent are NOT behind it, and are shell-equivalent anyway (the page says so).
 *
 * Only a change is asked about (POST, PUT, PATCH, DELETE); a read never is. The reason is a short phrase for the dialog.
 */

const CHANGES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/**
 * The fields of an edit that change nothing an agent may DO. An ALLOW-list on purpose: any other field (mode, command, role, permissions, payload,
 * dir, cleanRoom, confirmBypass, worktree, remoteControl, keys, and one a later version adds) asks for the password again.
 */
const PLAIN_EDIT_FIELDS = new Set(['name', 'position', 'autostart', 'coauthor', 'model', 'effort']);
const UNATTENDED = new Set(['auto', 'bypassPermissions']);

/** A field that carries something: not missing, null, empty text, an empty object or an empty list. */
const given = (value: unknown): boolean => value !== undefined && value !== null && value !== '' && value !== false && !(typeof value === 'object' && Object.keys(value as object).length === 0);

/** The body decides these two (hire; edit of an agent), so the proxy reads it first. */
export function bodyMatters(method: string, path: string): boolean {
  if (method === 'PUT' && path === '/api/autoupdate') return true;
  if (method === 'POST' && path === '/api/rooms/main/migrate') return true;
  if (method === 'POST' && path === '/api/agents') return true;
  return (method === 'PATCH' || method === 'PUT') && /^\/api\/agents\/[^/]+$/.test(path);
}

/** Why this change needs a fresh check, or null when it does not. `body` is the parsed JSON object, or null when there is none or it is not one. */
export function stepUpReason(method: string, path: string, body: Record<string, unknown> | null): string | null {
  if (!CHANGES.has(method)) return null;
  if (method === 'POST' && path === '/api/agents') {
    if (body === null) return 'hiring an agent';
    if (body.command !== undefined && body.command !== null) return 'hiring an agent with a command of your own';
    if (typeof body.mode === 'string' && UNATTENDED.has(body.mode)) return 'hiring an agent that works without asking';
    // outside a Clean Room, with a remote control or with keys of its own: more than a plain hire
    if (body.cleanRoom === false) return 'hiring an agent outside a Clean Room';
    if (given(body.remoteControl)) return 'hiring an agent with remote control';
    if (given(body.keys)) return 'hiring an agent with keys of its own';
    if (given(body.payload) || given(body.permissions)) return 'hiring an agent with a payload or permissions of its own';
    return null;
  }
  if ((method === 'PATCH' || method === 'PUT') && /^\/api\/agents\/[^/]+$/.test(path)) {
    if (body === null) return 'editing an agent';
    return Object.keys(body).some((field) => body[field] !== undefined && !PLAIN_EDIT_FIELDS.has(field)) ? 'changing what an agent may do' : null;
  }
  // Hangar writes and Recorder commits, per agent
  if (/^\/api\/agents\/[^/]+\/file$/.test(path)) return 'writing a file in an agent\'s folder';
  if (/^\/api\/agents\/[^/]+\/git\/commit$/.test(path)) return 'making a commit';
  // the permissions editor, Features, Uplink, Relay, Docking and Clearance (the keys of an engine)
  if (/^\/api\/permissions(\/|$)/.test(path)) return 'the permissions of the room';
  // a key every agent of the room gets (a cloud login, say)
  if (/^\/api\/room-keys(\/|$)/.test(path)) return 'the keys of the room';
  // a default server is a program every agent of the room starts, with the keys in its env
  if (/^\/api\/payload-defaults(\/|$)/.test(path)) return 'the Payload defaults of the room';
  if (/^\/api\/features(\/|$)/.test(path)) return 'the feature switches';
  if (/^\/api\/(uplinks|relay|docking)(\/|$)/.test(path)) return 'a secret of Uplink, Relay or Docking';
  if (/^\/api\/engines?(\/|$)/.test(path)) return 'the keys of an engine';
  // auto-update runs code of the publisher unattended: turning it on or moving its window asks; turning it off and SKIP THIS VERSION never do (they only make it do less)
  if (method === 'PUT' && path === '/api/autoupdate') return body === null || body.enabled === true || body.windows !== undefined ? 'turning on auto-update, or changing when it runs' : null;
  // moving where room main keeps its files (MIGRATE NOW, UNDO) is done at the next start; cancelling that or dismissing the note only does less
  if (method === 'POST' && path === '/api/rooms/main/migrate') return body !== null && (body.action === 'cancel' || body.action === 'dismiss') ? null : 'moving where room main keeps its files';
  // a Docker self-update
  if (/^\/api\/update(\/|$)/.test(path)) return 'updating gonogo';
  // the account itself
  if (path === '/api/auth/password') return 'changing the password';
  if (path === '/api/auth/keys' && method === 'POST') return 'making an API key';
  if (path === '/api/auth/logout-all' || /^\/api\/auth\/sessions\//.test(path)) return 'ending sessions';
  if (path === '/api/auth/mfa/begin' || path === '/api/auth/mfa/enable') return 'turning on a second factor';
  if (path === '/api/auth/passkeys/begin' || path === '/api/auth/passkeys/finish' || /^\/api\/auth\/passkeys\//.test(path)) return 'adding or removing a passkey';
  return null;
}
