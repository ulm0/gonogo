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

/** The body decides these two (hire; edit of an agent), so the proxy reads it first. */
export function bodyMatters(method: string, path: string): boolean {
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
    if (body.remoteControl !== undefined && body.remoteControl !== null && body.remoteControl !== false) return 'hiring an agent with remote control';
    if (body.keys !== undefined && body.keys !== null) return 'hiring an agent with keys of its own';
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
  if (/^\/api\/features(\/|$)/.test(path)) return 'the feature switches';
  if (/^\/api\/(uplinks|relay|docking)(\/|$)/.test(path)) return 'a secret of Uplink, Relay or Docking';
  if (/^\/api\/engines?(\/|$)/.test(path)) return 'the keys of an engine';
  // a Docker self-update
  if (/^\/api\/update(\/|$)/.test(path)) return 'updating gonogo';
  // the account itself
  if (path === '/api/auth/password') return 'changing the password';
  if (path === '/api/auth/keys' && method === 'POST') return 'making an API key';
  if (path === '/api/auth/logout-all' || /^\/api\/auth\/sessions\//.test(path)) return 'ending sessions';
  if (path === '/api/auth/mfa/begin' || path === '/api/auth/mfa/enable') return 'turning on a second factor';
  return null;
}
