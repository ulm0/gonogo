/**
 * Engine switch handoff (docs/engine-switch-spec.md): a conversation does not move from one CLI to another (their session files have nothing in
 * common), so at a switch gonogo reads the last turns of the old engine's transcript and writes them, with the path of the whole transcript, to
 * `handoff.md` in the agent's own folder. The first session of the new engine is told to read it (its role text names the file), and only that
 * session: the file names the session id it was written for.
 *
 * Read only: no transcript is changed or moved. An engine whose transcript gonogo cannot read gets a handoff that says so, so the new session
 * still knows that it carries on from another one.
 */
import { execFile } from 'node:child_process';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Provider } from '../shared/protocol.js';
import { providerInfo } from '../shared/protocol.js';
import { PI_SESSIONS_DIR } from './piextension.js';

export const HANDOFF_FILE = 'handoff.md';
/** At most this many turns (a user's or the assistant's text) and this many characters go into the file: the newest ones. */
export const HANDOFF_TURNS = 30;
export const HANDOFF_CHARS = 24_000;
/** One turn is cut to this many characters: a pasted log must not take the whole handoff. */
const TURN_CHARS = 4_000;
/** A transcript is read from its end, at most this many bytes. */
const TAIL_BYTES = 8 * 1024 * 1024;

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

export interface Transcript {
  path: string;
  turns: Turn[];
}

export interface HandoffSide {
  name: string;
  provider?: Provider | undefined;
  sessionId: string;
  /** opencode's own session id (AgentRecord.engineSession), when it was recorded for this sessionId. */
  engineSession?: { for: string; id: string } | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The text blocks of a message content (a string, or a list of blocks); tool calls, tool results, images and thinking are left out. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: string; text: string } => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/** The last TAIL_BYTES of a file, as whole lines. */
async function tailLines(path: string): Promise<string[]> {
  const info = await stat(path);
  if (info.size <= TAIL_BYTES) return (await readFile(path, 'utf8')).split('\n');
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(TAIL_BYTES);
    await handle.read(buffer, 0, TAIL_BYTES, info.size - TAIL_BYTES);
    // the first line is cut: drop it
    return buffer.toString('utf8').split('\n').slice(1);
  } finally {
    await handle.close();
  }
}

function parseLines(lines: readonly string[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value)) out.push(value);
    } catch {
      // a line being written, or a cut one
    }
  }
  return out;
}

/** opencode: `opencode export <id>` prints the session as JSON (after a line or two of its own); text parts only, synthetic ones left out. */
export function opencodeTurns(output: string): Turn[] {
  const start = output.indexOf('{');
  if (start < 0) return [];
  let data: unknown;
  try {
    data = JSON.parse(output.slice(start));
  } catch {
    return [];
  }
  if (!isRecord(data) || !Array.isArray(data.messages)) return [];
  const turns: Turn[] = [];
  for (const message of data.messages) {
    if (!isRecord(message) || !isRecord(message.info) || !Array.isArray(message.parts)) continue;
    const role = message.info.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = message.parts
      .filter((part): part is { type: string; text: string } => isRecord(part) && part.type === 'text' && typeof part.text === 'string' && part.synthetic !== true)
      .map((part) => part.text)
      .join('\n')
      .trim();
    if (text !== '') turns.push({ role, text });
  }
  return turns;
}

/** Claude Code: `{type: 'user'|'assistant', message: {content}}`; a sidechain (a subagent) and a meta line are not the conversation. */
export function claudeTurns(lines: readonly string[]): Turn[] {
  const turns: Turn[] = [];
  for (const entry of parseLines(lines)) {
    if ((entry.type !== 'user' && entry.type !== 'assistant') || entry.isSidechain === true || entry.isMeta === true || !isRecord(entry.message)) continue;
    const text = textOf(entry.message.content).trim();
    if (text === '' || text.startsWith('<command-') || text.startsWith('<local-command-')) continue;
    turns.push({ role: entry.type, text });
  }
  return turns;
}

/**
 * pi: a tree of entries (`id`, `parentId`); the conversation is the path from the last entry back to the root, so a branch left behind is not in it.
 * Only `user` and `assistant` messages count (a tool result, a system or custom message do not).
 */
export function piTurns(lines: readonly string[]): Turn[] {
  const entries = parseLines(lines).filter((entry) => typeof entry.id === 'string');
  const byId = new Map(entries.map((entry) => [entry.id as string, entry]));
  const path: Record<string, unknown>[] = [];
  let at: Record<string, unknown> | undefined = entries[entries.length - 1];
  const seen = new Set<string>();
  while (at !== undefined && !seen.has(at.id as string)) {
    seen.add(at.id as string);
    path.push(at);
    at = typeof at.parentId === 'string' ? byId.get(at.parentId) : undefined;
  }
  const turns: Turn[] = [];
  for (const entry of path.reverse()) {
    if (entry.type !== 'message' || !isRecord(entry.message)) continue;
    const role = entry.message.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = textOf(entry.message.content).trim();
    if (text !== '') turns.push({ role, text });
  }
  return turns;
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (info) => info.isFile(),
    () => false,
  );
}

/** A file in `root` or one folder below it whose name is `<id>.jsonl` or ends with `_<id>.jsonl`. */
async function findSessionFile(root: string, sessionId: string): Promise<string | null> {
  const fits = (name: string): boolean => name === `${sessionId}.jsonl` || name.endsWith(`_${sessionId}.jsonl`);
  const names = await readdir(root).catch(() => [] as string[]);
  for (const name of names) if (fits(name) && (await isFile(join(root, name)))) return join(root, name);
  for (const name of names) {
    const inner = await readdir(join(root, name)).catch(() => [] as string[]);
    for (const file of inner) if (fits(file) && (await isFile(join(root, name, file)))) return join(root, name, file);
  }
  return null;
}

export interface TranscriptPlaces {
  /** The agent's own folder in the gonogo home. */
  agentDir: string;
  /** The agent's working folder: a session that was started before gonogo named it (an older version, another place) is found by this and the time. */
  cwd?: string;
  /** CLAUDE_CONFIG_DIR when set. */
  claudeConfigDir?: string;
  /** pi's own folder (PI_CODING_AGENT_DIR, else ~/.pi/agent): where it keeps a session that gonogo did not name. */
  piDir?: string;
  /** opencode: runs `opencode session list --format json` with the agents' environment. */
  listOpencode?: () => Promise<string>;
  /** Sessions newer than this (ms) are not the old one (the moment of the switch); default now. */
  until?: number;
  /** opencode: runs `opencode export <id>` and resolves with what it printed. The launcher gives one with the agents' environment. */
  exportOpencode?: (id: string) => Promise<string>;
}

/** `opencode <args>` with that environment: no shell, at most 20 s and 64 MB. */
function opencodeRunner(env: Record<string, string | undefined>, cwd: string, bin: string): (args: string[]) => Promise<string> {
  return (args) =>
    new Promise((done, fail) => {
      execFile(bin, args, { env, cwd, timeout: 20_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => (error === null ? done(stdout) : fail(error)));
    });
}

/** `opencode export <id>` with that environment. */
export function opencodeExporter(env: Record<string, string | undefined>, cwd: string, bin = 'opencode'): (id: string) => Promise<string> {
  const run = opencodeRunner(env, cwd, bin);
  return (id) => run(['export', id]);
}

/** `opencode session list --format json` with that environment. */
export function opencodeLister(env: Record<string, string | undefined>, cwd: string, bin = 'opencode'): () => Promise<string> {
  const run = opencodeRunner(env, cwd, bin);
  return () => run(['session', 'list', '--format', 'json']);
}

/** The id of the newest opencode session of this folder that is not newer than `until`, from the JSON of `opencode session list`; null when there is none. */
export function newestOpencodeSession(listing: string, cwd: string, until: number): string | null {
  const start = listing.indexOf('[');
  if (start < 0) return null;
  let data: unknown;
  try {
    data = JSON.parse(listing.slice(start));
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;
  const fits = data
    .filter((s): s is { id: string; directory: string; updated: number; created: number } => isRecord(s) && typeof s.id === 'string' && typeof s.directory === 'string' && typeof s.updated === 'number' && typeof s.created === 'number' && s.directory === cwd && s.created <= until)
    .sort((a, b) => b.updated - a.updated);
  return fits[0]?.id ?? null;
}

/** The newest `*.jsonl` of the folders below `root` (one level) whose first line says it was started in `cwd` (pi: `{ type: 'session', cwd }`) and which was written before `until`. */
async function newestPiSession(root: string, cwd: string, until: number): Promise<string | null> {
  let best: { path: string; at: number } | null = null;
  for (const folder of await readdir(root).catch(() => [] as string[])) {
    for (const file of await readdir(join(root, folder)).catch(() => [] as string[])) {
      if (!file.endsWith('.jsonl')) continue;
      const path = join(root, folder, file);
      const info = await stat(path).catch(() => null);
      if (info === null || !info.isFile() || (best !== null && info.mtimeMs <= best.at)) continue;
      const head = await open(path, 'r').then(async (handle) => {
        try {
          const buffer = Buffer.alloc(2048);
          const { bytesRead } = await handle.read(buffer, 0, 2048, 0);
          return buffer.toString('utf8', 0, bytesRead).split('\n')[0] ?? '';
        } finally {
          await handle.close();
        }
      }, () => '');
      try {
        const first: unknown = JSON.parse(head);
        if (isRecord(first) && first.type === 'session' && first.cwd === cwd && info.mtimeMs <= until + 60_000) best = { path, at: info.mtimeMs };
      } catch {
        // not a session file
      }
    }
  }
  return best?.path ?? null;
}

/** Claude Code names a project folder by its path with every character that is not a letter or a digit as a dash. */
const claudeProjectFolder = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-');

/** The newest session file of the folder's Claude Code project (a session whose id gonogo did not name), written before `until`. */
async function newestClaudeSession(root: string, cwd: string, until: number): Promise<string | null> {
  const folder = join(root, claudeProjectFolder(cwd));
  let best: { path: string; at: number } | null = null;
  for (const file of await readdir(folder).catch(() => [] as string[])) {
    if (!file.endsWith('.jsonl')) continue;
    const info = await stat(join(folder, file)).catch(() => null);
    if (info !== null && info.isFile() && info.mtimeMs <= until + 60_000 && (best === null || info.mtimeMs > best.at)) best = { path: join(folder, file), at: info.mtimeMs };
  }
  return best?.path ?? null;
}

/** Where the old engine kept the session and what it said; null when gonogo cannot read that engine's transcript or there is none. */
export async function readTranscript(side: HandoffSide, places: TranscriptPlaces): Promise<Transcript | null> {
  const provider = side.provider ?? 'claude';
  if (provider === 'claude') {
    const root = join(places.claudeConfigDir ?? join(homedir(), '.claude'), 'projects');
    const path = (await findSessionFile(root, side.sessionId)) ?? (places.cwd === undefined ? null : await newestClaudeSession(root, places.cwd, places.until ?? Date.now()));
    return path === null ? null : { path, turns: claudeTurns(await tailLines(path)) };
  }
  if (provider === 'opencode') {
    let id = side.engineSession?.for === side.sessionId ? side.engineSession.id : null;
    // a session of an older gonogo has no recorded id: the newest one of this folder is the old one
    if (id === null && places.listOpencode !== undefined && places.cwd !== undefined) id = newestOpencodeSession(await places.listOpencode(), places.cwd, places.until ?? Date.now());
    if (id === null || places.exportOpencode === undefined) return null;
    return { path: `opencode session ${id} (opencode export ${id})`, turns: opencodeTurns(await places.exportOpencode(id)) };
  }
  if (provider === 'pi') {
    // the session gonogo named lives in the agent's folder; one that pi started on its own (an older gonogo) lives in pi's own folder, found by the folder and the time
    const path = (await findSessionFile(join(places.agentDir, PI_SESSIONS_DIR), side.sessionId)) ?? (places.cwd === undefined ? null : await newestPiSession(join(places.piDir ?? join(homedir(), '.pi', 'agent'), 'sessions'), places.cwd, places.until ?? Date.now()));
    return path === null ? null : { path, turns: piTurns(await tailLines(path)) };
  }
  return null;
}

const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)}\n[... cut: ${text.length - max} more characters in the transcript]`);

/** The newest turns that fit in HANDOFF_TURNS and HANDOFF_CHARS, oldest first. */
export function lastTurns(turns: readonly Turn[]): Turn[] {
  const out: Turn[] = [];
  let size = 0;
  for (let i = turns.length - 1; i >= 0 && out.length < HANDOFF_TURNS; i -= 1) {
    const turn = turns[i] as Turn;
    const text = cut(turn.text, TURN_CHARS);
    if (size + text.length > HANDOFF_CHARS && out.length > 0) break;
    size += text.length;
    out.unshift({ role: turn.role, text });
  }
  return out;
}

/** The first line names the session it is for: `<!-- gonogo handoff for <session id> -->`. */
export const handoffMarker = (sessionId: string): string => `<!-- gonogo handoff for ${sessionId} -->`;

export function handoffText(from: HandoffSide, to: HandoffSide, transcript: Transcript | null, at: Date): string {
  const lines = [
    handoffMarker(to.sessionId),
    `# Handoff for ${to.name}`,
    '',
    `You were running on ${providerInfo(from.provider).label} until ${at.toISOString()}; the Director moved you to ${providerInfo(to.provider).label}.`,
    'Your name, role, folder, memory file, keys, team and mail are the same. Only the conversation could not come with you: below are its last turns, so you can carry on where it stopped.',
    '',
  ];
  if (transcript === null) {
    lines.push(`gonogo cannot read the transcript of ${providerInfo(from.provider).label}, so no turn is shown. Ask the Director or check your memory file and your messages (read_messages) for what you were doing.`);
    return `${lines.join('\n')}\n`;
  }
  const turns = lastTurns(transcript.turns);
  lines.push(`The whole transcript (read only, in ${providerInfo(from.provider).label}'s own format): ${transcript.path}`);
  if (turns.length < transcript.turns.length) lines.push(`Shown: the last ${turns.length} of ${transcript.turns.length} turns.`);
  lines.push('');
  if (turns.length === 0) lines.push('The old session had no turns yet.');
  for (const turn of turns) lines.push(`## ${turn.role === 'user' ? 'User' : 'You'}`, '', turn.text, '');
  return `${lines.join('\n').trimEnd()}\n`;
}

/** The line the role text of the new session gets, when the handoff in `content` was written for `sessionId`; else null. */
export function handoffNote(content: string | null, sessionId: string, path: string): string | null {
  if (content === null || !content.startsWith(handoffMarker(sessionId))) return null;
  // the recap in one line: which engine, until when, which engine now (the words of the file's own second paragraph)
  const moved = /You were running on (.+?) until (\S+); the Director moved you to (.+?)\./.exec(content);
  const what = moved === null ? 'from another engine' : `from ${moved[1]} (until ${moved[2]}) to ${moved[3]}`;
  return `\n\nThe Director moved you ${what}: this is a new session, not the one you remember. Before anything else, read ${path}: it holds the last turns of your previous session.`;
}
