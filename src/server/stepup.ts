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
/** The hire is where the room's default sandbox matters: the proxy asks the room for it before it decides. */
export const needsRoomSandbox = (method: string, path: string, body: Record<string, unknown> | null): boolean => method === 'POST' && path === '/api/agents' && typeof body?.cleanRoom === 'object' && body.cleanRoom !== null && typeof (body.cleanRoom as Record<string, unknown>).flavor === 'string';

export function bodyMatters(method: string, path: string): boolean {
  if (method === 'PUT' && path === '/api/autoupdate') return true;
  if (method === 'POST' && path === '/api/rooms/main/migrate') return true;
  if (method === 'POST' && /^\/api\/knowledge\/[^/]+\/move$/.test(path)) return true;
  if (method === 'POST' && path === '/api/agents') return true;
  if (method === 'PUT' && path === '/api/models/mode') return true;
  return (method === 'PATCH' || method === 'PUT') && /^\/api\/agents\/[^/]+$/.test(path);
}

/** The walls of the Clean Room, weakest first: a hire below the room's own sandbox is a weaker one than the Director set. */
const FLAVOR_RANK = ['docker', 'gvisor', 'microvm'];

/** What the proxy knows of the room for the rule: its default sandbox flavor (`docker` when none). */
export interface StepUpContext {
  roomSandbox?: string;
}

/** Why this change needs a fresh check, or null when it does not. `body` is the parsed JSON object, or null when there is none or it is not one. */
export function stepUpReason(method: string, path: string, body: Record<string, unknown> | null, context: StepUpContext = {}): string | null {
  if (!CHANGES.has(method)) return null;
  if (method === 'POST' && path === '/api/agents') {
    if (body === null) return 'hiring an agent';
    if (body.command !== undefined && body.command !== null) return 'hiring an agent with a command of your own';
    if (typeof body.mode === 'string' && UNATTENDED.has(body.mode)) return 'hiring an agent that works without asking';
    // a Clean Room with a wall below the room's own default: a session that has not stepped up cannot undercut what the Director stepped up to set
    const flavor = typeof body.cleanRoom === 'object' && body.cleanRoom !== null ? (body.cleanRoom as Record<string, unknown>).flavor : undefined;
    if (typeof flavor === 'string' && FLAVOR_RANK.indexOf(flavor) < FLAVOR_RANK.indexOf(context.roomSandbox ?? 'docker')) return "hiring below the room's sandbox";
    // outside a Clean Room, with a remote control or with keys of its own: more than a plain hire
    if (body.cleanRoom === false) return 'hiring an agent outside a Clean Room';
    // a Clean Room that keeps its API key inside its container, against the room's setting
    if (typeof body.cleanRoom === 'object' && body.cleanRoom !== null && (body.cleanRoom as Record<string, unknown>).egress === false) return 'hiring a Clean Room agent that holds its own API key';
    if (given(body.remoteControl)) return 'hiring an agent with remote control';
    if (given(body.keys)) return 'hiring an agent with keys of its own';
    if (given(body.payload) || given(body.permissions)) return 'hiring an agent with a payload or permissions of its own';
    return null;
  }
  if ((method === 'PATCH' || method === 'PUT') && /^\/api\/agents\/[^/]+$/.test(path)) {
    if (body === null) return 'editing an agent';
    return Object.keys(body).some((field) => body[field] !== undefined && !PLAIN_EDIT_FIELDS.has(field)) ? 'changing what an agent may do' : null;
  }
  // the room's default mode: auto or bypass makes every hire from the form start without asking; clearing it or a milder mode stays free
  if (method === 'PUT' && path === '/api/models/mode') return body !== null && typeof body.mode === 'string' && UNATTENDED.has(body.mode) ? 'setting the room to work without asking' : body === null ? 'setting the room to work without asking' : null;
  // the room's default sandbox: a weaker wall for the Clean Room agents of the room (toward docker), or a stronger one the Director may not have asked for; the password again either way
  if (method === 'PUT' && path === '/api/models/sandbox') return 'changing the sandbox of the room\'s Clean Room agents';
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
  // where a Clean Room's API key is held: turning it off puts the key back in the container
  if (/^\/api\/egress(\/|$)/.test(path)) return 'where a Clean Room keeps its API key';
  // the rules of the room reach every agent at the authority of a system prompt
  if (/^\/api\/rules(\/|$)/.test(path)) return 'the rules of the room';
  if (/^\/api\/(uplinks|relay|docking)(\/|$)/.test(path)) return 'a secret of Uplink, Relay or Docking';
  if (/^\/api\/engines?(\/|$)/.test(path)) return 'the keys of an engine';
  // auto-update runs code of the publisher unattended: turning it on or moving its window asks; turning it off and SKIP THIS VERSION never do (they only make it do less)
  if (method === 'PUT' && path === '/api/autoupdate') return body === null || body.enabled === true || body.windows !== undefined ? 'turning on auto-update, or changing when it runs' : null;
  // a room made with a project folder starts its agents there
  if (method === 'POST' && path === '/api/rooms') return body !== null && body.dir !== undefined && body.dir !== null ? 'adding a room with a project folder' : null;
  // the project folder: every agent that starts afterwards starts there
  if (method === 'PUT' && path === '/api/project-folder') return 'changing the project folder of the room';
  // the runtime settings (hops, Max Q, the agent command, what is scrubbed, ...): every write asks again, like the keys of the room
  if (method === 'PUT' && /^\/api\/settings\/[A-Za-z]+$/.test(path)) return `changing the runtime setting ${path.split('/').pop() ?? ''}`;
  // stopping rooms kills the agents in them at once (and stop-all every room), and removing a room takes it off the list: the password again. Starting one room is not asked (the server does it at boot anyway); starting all of them is.
  if (method === 'POST' && (/^\/api\/rooms\/(?:stop-all|start-all)$/.test(path) || /^\/api\/rooms\/[a-z][a-z0-9-]{0,23}\/stop$/.test(path))) return path.endsWith('start-all') ? 'starting every room' : path.endsWith('stop-all') ? 'stopping every room' : 'stopping a room and its agents';
  if (method === 'DELETE' && /^\/api\/rooms\/[a-z][a-z0-9-]{0,23}$/.test(path)) return 'removing a room';
  // moving where room main keeps its files (MIGRATE NOW, UNDO) is done at the next start; cancelling that or dismissing the note only does less
  if (method === 'POST' && path === '/api/rooms/main/migrate') return body !== null && (body.action === 'cancel' || body.action === 'dismiss') ? null : 'moving where room main keeps its files';
  // Knowledge: taking the claims of one repository to another is one rename of a folder the Director's decisions live in (keeping two apart changes nothing)
  if (method === 'POST' && /^\/api\/knowledge\/[^/]+\/move$/.test(path)) return body !== null && body.action === 'keep' ? null : 'moving the claims of a repository';
  // Search by meaning sends the notes of the room to the endpoint that is named here
  if (method === 'PUT' && path === '/api/semantic') return 'the endpoint of Search by meaning';
  // the template of the closing checklist: its lines are copied into every new mission and shown in the Director's name
  if (method === 'PUT' && path === '/api/ritual-template') return 'the closing checklist template';
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
