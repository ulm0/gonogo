/**
 * Terminal host (contract section 6): one pty and one headless mirror per agent name. The mirror is what the hub reads
 * (prompt box, dialogs, title) and what a joining browser is served; everything that depends on how claude draws its
 * screen lives here. No method of the host throws after spawn(): a pty call that fails returns false.
 */
import { accessSync, chmodSync, constants as fsConstants, existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { spawn as ptySpawn } from '@lydell/node-pty';
import type { IPty } from '@lydell/node-pty';
import { SerializeAddon } from '@xterm/addon-serialize';
import xtermHeadless from '@xterm/headless';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';
import type {
  Attachment,
  DialogKind,
  Logger,
  OutputListener,
  ScreenProbe,
  SpawnSpec,
  TerminalEvent,
  TerminalHost,
  TerminalHostOptions,
  TerminalInfo,
  TitleGlyph,
  TitleInfo,
} from '../shared/protocol.js';
import {
  BOX_MAX_ROWS,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  DIALOG_PATTERNS,
  ENTER,
  EXIT_TAIL_CHARS,
  EXIT_TAIL_LINES,
  MAX_COLS,
  MAX_ROWS,
  MIN_COLS,
  MIN_ROWS,
  MIRROR_SCROLLBACK_LINES,
  NBSP,
  PASTE_END,
  PASTE_START,
  POINTER_PREFIX,
  PROMPT_GLYPH,
  RULE_CHAR,
  RULE_MIN_RUN,
  SNAPSHOT_SCROLLBACK_LINES,
  STOP_GIVEUP_AFTER_KILL_MS,
  STOP_KILL_AFTER_MS,
  TERM_VALUE,
  TITLE_IDLE_GLYPH,
  TITLE_WORKING_GLYPHS,
  nullLogger,
} from './constants.js';

// The package is CommonJS: the named import is undefined in plain Node ESM (vitest and tsc accept it, which hides that).
const { Terminal } = xtermHeadless;

/** A pointer is one short line; anything longer is not one (contract 6.7). */
const SUBMIT_MAX_CHARS = 500;
/** What execvp falls back to when the child environment has no PATH. */
const FALLBACK_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/* ---- screen analysis (6.4) ---- */

const RULE_RUN = new RegExp(`${RULE_CHAR}{${RULE_MIN_RUN},}`);
const BOX_PREFIX = PROMPT_GLYPH + NBSP;
const DIALOGS = DIALOG_PATTERNS.map(({ kind, source }) => ({ kind, regex: new RegExp(source) }));

/** The lowest row that is a prompt row between two rules, or -1. The lowest is the live box, not an echo in the transcript. */
function findPromptBox(rows: readonly string[]): number {
  for (let y = rows.length - 1; y >= 1; y--) {
    if (!rows[y].startsWith(BOX_PREFIX) || !RULE_RUN.test(rows[y - 1])) continue;
    for (let k = 1; k <= BOX_MAX_ROWS && y + k < rows.length; k++) {
      if (RULE_RUN.test(rows[y + k])) return y;
    }
  }
  return -1;
}

function findDialog(lines: readonly string[]): DialogKind | null {
  const hasMenu = (): boolean => DIALOGS.some((d) => d.kind === 'menu' && lines.some((line) => d.regex.test(line)));
  for (const { kind, regex } of DIALOGS) {
    if (!lines.some((line) => regex.test(line))) continue;
    // "Do you want to ..." without a numbered menu is assistant prose, not a permission dialog.
    if (kind === 'permission' && !hasMenu()) continue;
    return kind;
  }
  return null;
}

/** `rows` are the visible rows of the active buffer as xterm returns them (the NBSP of an empty box row must survive). */
export function analyzeScreen(rows: readonly string[], cols: number): ScreenProbe {
  const boxRow = findPromptBox(rows);
  // The box row is left out of the dialog search: a draft or placeholder in the box must never look like a dialog.
  const lines = rows.map((row, y) => (y === boxRow ? '' : row.trimEnd()));
  return {
    cols,
    rows: rows.length,
    promptBox: boxRow >= 0,
    dialog: findDialog(lines),
    promptText: boxRow >= 0 ? rows[boxRow].slice(BOX_PREFIX.length).trim() : null,
  };
}

/* ---- window title (6.5) ---- */

export function classifyTitle(title: string): TitleGlyph {
  const first = title.trimStart().charAt(0);
  if (first === TITLE_IDLE_GLYPH) return 'idle';
  return (TITLE_WORKING_GLYPHS as readonly string[]).includes(first) ? 'working' : 'unknown';
}

/* ---- typing (6.7) ---- */

// C0 controls except tab and line feed (carriage returns are turned into line feeds first), DEL, C1, then the characters
// Claude Code strips itself: zero-width, bidi and tag characters.
const UNSAFE_IN_PASTE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{feff}\u{e0000}-\u{e007f}]/gu;

/** Removing ESC is what stops a message from ending the paste with ESC[201~ and typing keys. */
export function sanitizeForPaste(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(UNSAFE_IN_PASTE, '').trim();
}

export function buildSubmit(text: string): string {
  return PASTE_START + sanitizeForPaste(text) + PASTE_END + ENTER;
}

/* ---- terminal modes that serialize() does not carry (6.6) ---- */

const MODE_SEQUENCE = /\x1b\[\?([0-9;]*)([hl])/g;
const UNFINISHED_MODE_SEQUENCE = /^\x1b(?:\[(?:\?[0-9;]*)?)?$/;
const MAX_UNFINISHED_BYTES = 32;
/** Order of fixup(): SGR mouse encoding, colour-scheme reports, cursor visibility. */
const TRACKED_MODES = [1006, 2031, 25] as const;

const asLatin1 = (chunk: Uint8Array | string): string =>
  typeof chunk === 'string' ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('latin1');

/**
 * Remembers the last `ESC [ ? n h|l` of three modes in the raw output. xterm's serialize() restores bracketed paste,
 * mouse tracking and the alternate screen but not these three, and a joining browser would get the wrong mouse encoding.
 * Arrow fields, not methods: no `this`, so a method may be passed on detached.
 */
export class ModeTracker {
  private readonly last = new Map<number, boolean>();
  private tail = '';

  feed = (chunk: Uint8Array | string): void => {
    const text = this.tail + asLatin1(chunk);
    for (const match of text.matchAll(MODE_SEQUENCE)) {
      for (const param of match[1].split(';')) {
        const mode = Number(param);
        if (param !== '' && (TRACKED_MODES as readonly number[]).includes(mode)) this.last.set(mode, match[2] === 'h');
      }
    }
    // A sequence may be cut by the chunk boundary: keep what could still become one.
    const esc = text.lastIndexOf('\x1b');
    const rest = esc < 0 ? '' : text.slice(esc);
    this.tail = rest.length <= MAX_UNFINISHED_BYTES && UNFINISHED_MODE_SEQUENCE.test(rest) ? rest : '';
  };

  fixup = (): string =>
    TRACKED_MODES.filter((mode) => this.last.has(mode))
      .map((mode) => `\x1b[?${mode}${this.last.get(mode) ? 'h' : 'l'}`)
      .join('');
}

/* ---- spawn-helper guard (6.10) ---- */

const require = createRequire(import.meta.url);

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const errorCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined;

function resolveQuietly(specifier: string, log: Logger): string | null {
  try {
    return require.resolve(specifier);
  } catch (error) {
    log.debug(`${specifier} is not installed: ${errorMessage(error)}`);
    return null;
  }
}

/** Package directories of the pty libraries that may be installed. `<package>/package.json` is not exported by the @lydell packages. */
function ptyPackageDirs(log: Logger): string[] {
  const dirs: string[] = [];
  const platformEntry = resolveQuietly(`@lydell/node-pty-${process.platform}-${process.arch}`, log);
  if (platformEntry !== null) dirs.push(dirname(dirname(platformEntry))); // <pkg>/lib/index.js
  const official = resolveQuietly('node-pty/package.json', log);
  if (official !== null) dirs.push(dirname(official));
  return dirs;
}

function helperPaths(packageDir: string): string[] {
  const candidates = [join(packageDir, 'build', 'Release', 'spawn-helper')];
  const prebuilds = join(packageDir, 'prebuilds');
  if (existsSync(prebuilds)) {
    for (const entry of readdirSync(prebuilds, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(join(prebuilds, entry.name, 'spawn-helper'));
    }
  }
  return candidates.filter((path) => existsSync(path));
}

/**
 * node-pty 1.1.0 ships its macOS spawn-helper without the executable bit, and then every spawn fails with
 * "posix_spawnp failed". Returns the paths it fixed; a file it cannot change is logged and left alone.
 */
export function ensureSpawnHelperExecutable(log: Logger = nullLogger, roots?: readonly string[]): string[] {
  const fixed: string[] = [];
  for (const packageDir of roots ?? ptyPackageDirs(log)) {
    let helpers: string[] = [];
    try {
      helpers = helperPaths(packageDir);
    } catch (error) {
      log.warn(`cannot look for spawn-helper in ${packageDir}: ${errorMessage(error)}`);
    }
    for (const helper of helpers) {
      try {
        const mode = statSync(helper).mode;
        if ((mode & 0o111) !== 0) {
          log.debug(`spawn-helper is executable: ${helper}`);
          continue;
        }
        chmodSync(helper, (mode & 0o7777) | 0o755);
        fixed.push(helper);
        log.info(`made spawn-helper executable: ${helper}`);
      } catch (error) {
        log.warn(`cannot make spawn-helper executable: ${helper}: ${errorMessage(error)}`);
      }
    }
  }
  return fixed;
}

let helperChecked = false;

/* ---- the host ---- */

interface Sink {
  listener: OutputListener;
  started: boolean;
  detached: boolean;
  buffer: Uint8Array[];
}

interface Rec {
  name: string;
  readonly generation: number;
  readonly pid: number;
  pty: IPty | null;
  readonly mirror: HeadlessTerminal;
  readonly serializer: SerializeAddon;
  readonly tracker: ModeTracker;
  readonly sinks: Set<Sink>;
  readonly spawnedAt: number;
  bytes: number;
  /** Chunks written to the mirror and not parsed yet: while it is above 0 the screen is stale. */
  pending: number;
  /** Bumped when the mirror parsed a chunk or was resized; keys the cached probe. */
  version: number;
  probe: { version: number; value: ScreenProbe } | null;
  title: TitleInfo | null;
  ready: boolean;
  /** The process is gone (set by the first line of the exit handling). */
  exited: boolean;
  /** Not finished: true until the exit event has been emitted. */
  running: boolean;
  stopRequested: boolean;
  killTimer: ReturnType<typeof setTimeout> | null;
  giveUpTimer: ReturnType<typeof setTimeout> | null;
  mirrorFailed: boolean;
  /** Resolves after the exit event handlers ran; stop() hands it out. */
  readonly done: Promise<void>;
  markDone: () => void;
}

type DestroyablePty = IPty & { destroy?: () => void };

const isLive = (rec: Rec): boolean => rec.running && !rec.exited;

const clampDim = (value: number | undefined, min: number, max: number, fallback: number): number => {
  const n = value !== undefined && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, n));
};

function viewportRows(mirror: HeadlessTerminal): string[] {
  const buffer = mirror.buffer.active;
  const rows: string[] = [];
  for (let y = 0; y < mirror.rows; y++) rows.push(buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? '');
  return rows;
}

function exitTail(mirror: HeadlessTerminal): string {
  const lines = viewportRows(mirror)
    .map((row) => row.trimEnd())
    .filter((row) => row.length > 0);
  return lines.slice(-EXIT_TAIL_LINES).join('\n').slice(-EXIT_TAIL_CHARS);
}

/** node-pty does not throw for a missing command on macOS: the child just exits with code 1 and no output. */
function commandExists(spec: SpawnSpec): boolean {
  const direct = spec.file.includes('/');
  const candidates = direct
    ? [resolve(spec.cwd || '.', spec.file)]
    : (spec.env.PATH ?? FALLBACK_PATH).split(':').map((dir) => join(dir || '.', spec.file));
  return candidates.some((candidate) => {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return statSync(candidate).isFile();
    } catch {
      return false; // not there or not executable: try the next directory
    }
  });
}

export function createTerminalHost(options: TerminalHostOptions = {}): TerminalHost {
  const log = options.log ?? nullLogger;
  const now = options.now ?? Date.now;
  const killAfterMs = options.killAfterMs ?? STOP_KILL_AFTER_MS;
  const giveUpAfterKillMs = options.giveUpAfterKillMs ?? STOP_GIVEUP_AFTER_KILL_MS;
  const records = new Map<string, Rec>();
  const handlers: Array<(event: TerminalEvent) => void> = [];

  /** Callbacks of node-pty and xterm run inside their emitters: an exception there would end the process. */
  const guarded = (what: string, fn: () => void): void => {
    try {
      fn();
    } catch (error) {
      log.error(`terminal ${what} failed`, error);
    }
  };

  const emit = (event: TerminalEvent): void => {
    for (const handler of [...handlers]) guarded('event handler', () => handler(event));
  };

  const probeOf = (rec: Rec): ScreenProbe => {
    let probe = rec.probe;
    if (probe === null || probe.version !== rec.version) {
      probe = { version: rec.version, value: analyzeScreen(viewportRows(rec.mirror), rec.mirror.cols) };
      rec.probe = probe;
    }
    return { ...probe.value };
  };

  /**
   * Ready = claude wrote ESC[?2004h (raw mode is on, so an Enter is not lost) and the boxed prompt row is drawn with no
   * dialog on screen. Not "output went quiet" (the status line and the spinner never let it), not SessionStart.
   */
  const checkReady = (rec: Rec): void => {
    if (rec.ready || !rec.mirror.modes.bracketedPasteMode) return;
    const probe = probeOf(rec);
    if (!probe.promptBox || probe.dialog !== null) return;
    rec.ready = true;
    emit({ kind: 'ready', name: rec.name, generation: rec.generation, at: now() });
  };

  const afterParse = (rec: Rec): void => {
    rec.pending -= 1;
    rec.version += 1;
    guarded('ready check', () => checkReady(rec));
  };

  const onTitle = (rec: Rec, title: string): void => {
    const glyph = classifyTitle(title);
    const at = now();
    const previous = rec.title;
    if (previous !== null && previous.glyph === glyph) {
      rec.title = { glyph, title, since: previous.since };
      return;
    }
    rec.title = { glyph, title, since: at };
    emit({ kind: 'title', name: rec.name, generation: rec.generation, glyph, title, at });
  };

  const deliver = (sink: Sink, chunk: Uint8Array): void => {
    if (sink.detached) return;
    if (!sink.started) {
      sink.buffer.push(chunk);
      return;
    }
    guarded('output listener', () => sink.listener(chunk));
  };

  const onChunk = (rec: Rec, data: string | Uint8Array): void => {
    if (!rec.running) return;
    const chunk = typeof data === 'string' ? Buffer.from(data) : data;
    rec.bytes += chunk.length;
    rec.tracker.feed(chunk);
    rec.pending += 1;
    try {
      rec.mirror.write(chunk, () => afterParse(rec));
    } catch (error) {
      // xterm refuses writes beyond 50 MB of unparsed data; logging every chunk of a flood would be worse than the flood.
      rec.pending -= 1;
      if (!rec.mirrorFailed) {
        rec.mirrorFailed = true;
        log.error(`the mirror of ${rec.name} rejected output`, error);
      }
    }
    for (const sink of rec.sinks) deliver(sink, chunk);
  };

  const clearStopTimers = (rec: Rec): void => {
    if (rec.killTimer !== null) clearTimeout(rec.killTimer);
    if (rec.giveUpTimer !== null) clearTimeout(rec.giveUpTimer);
    rec.killTimer = null;
    rec.giveUpTimer = null;
  };

  const finishExit = (rec: Rec, exitCode: number, signal: number): void => {
    if (rec.exited) return;
    rec.exited = true;
    clearStopTimers(rec);
    // node-pty reports exit code 0 together with the signal for a process that was killed.
    const killedBy = signal > 0 ? signal : null;
    const code = killedBy === null ? exitCode : null;
    const durationMs = now() - rec.spawnedAt;
    const complete = (): void => {
      let tail = '';
      try {
        tail = exitTail(rec.mirror);
      } catch (error) {
        log.warn(`cannot read the last screen of ${rec.name}`, error);
      }
      rec.running = false;
      rec.pty = null;
      emit({
        kind: 'exit',
        name: rec.name,
        generation: rec.generation,
        info: { code, signal: killedBy, durationMs, requested: rec.stopRequested, tail },
        at: now(),
      });
      rec.markDone();
    };
    try {
      // The marker is parsed after every chunk written so far, so the tail holds the whole last screen.
      rec.mirror.write('', complete);
    } catch (error) {
      log.warn(`the mirror of ${rec.name} could not flush before the exit event`, error);
      complete();
    }
  };

  /** To the process group (the pty child leads its own session), so its children end with it. */
  const sendSignal = (rec: Rec, signal: NodeJS.Signals): void => {
    if (!(rec.pid > 1)) return; // kill(0) and kill(-1) would reach far more than this agent
    for (const target of [-rec.pid, rec.pid]) {
      try {
        process.kill(target, signal);
        return;
      } catch (error) {
        if (errorCode(error) !== 'ESRCH') {
          log.warn(`${signal} to ${rec.name} (${target}) failed`, error);
          return;
        }
      }
    }
  };

  const spawn = (name: string, generation: number, spec: SpawnSpec): { pid: number } => {
    if (!helperChecked) {
      helperChecked = true;
      ensureSpawnHelperExecutable(log);
    }
    const previous = records.get(name);
    if (previous?.running) throw new Error(`agent ${name} is already running`);
    if (!commandExists(spec)) throw new Error(`could not start ${spec.file}: command not found or not executable`);
    const cols = clampDim(spec.cols ?? previous?.mirror.cols, MIN_COLS, MAX_COLS, DEFAULT_COLS);
    const rows = clampDim(spec.rows ?? previous?.mirror.rows, MIN_ROWS, MAX_ROWS, DEFAULT_ROWS);

    // Built before the pty so that nothing that can still fail is left to run after the process started.
    // logLevel off: xterm prints every parser error it recovers from to the console, and what the agent writes is not ours to fix.
    const mirror = new Terminal({ cols, rows, scrollback: MIRROR_SCROLLBACK_LINES, allowProposedApi: true, logLevel: 'off' });
    const serializer = new SerializeAddon();
    mirror.loadAddon(serializer);

    let pty: IPty;
    try {
      pty = ptySpawn(spec.file, spec.args, { name: TERM_VALUE, cols, rows, cwd: spec.cwd, env: spec.env, encoding: null });
    } catch (error) {
      const message = errorMessage(error);
      const hint = message.includes('posix_spawnp failed') ? ' (command not found, or the pty helper is not executable)' : '';
      throw new Error(`could not start ${spec.file}: ${message}${hint}`);
    }

    let markDone: () => void = () => {};
    const done = new Promise<void>((resolveDone) => {
      markDone = resolveDone;
    });
    const rec: Rec = {
      name,
      generation,
      pid: pty.pid,
      pty,
      mirror,
      serializer,
      tracker: new ModeTracker(),
      sinks: new Set(),
      spawnedAt: now(),
      bytes: 0,
      pending: 0,
      version: 0,
      probe: null,
      title: null,
      ready: false,
      exited: false,
      running: true,
      stopRequested: false,
      killTimer: null,
      giveUpTimer: null,
      mirrorFailed: false,
      done,
      markDone,
    };
    records.set(name, rec);
    mirror.onTitleChange((title) => guarded('title handler', () => onTitle(rec, title)));
    pty.onData((data: string | Uint8Array) => guarded('data handler', () => onChunk(rec, data)));
    pty.onExit(({ exitCode, signal }) => guarded('exit handler', () => finishExit(rec, exitCode, signal ?? 0)));
    log.debug(`spawned ${name} generation ${generation} pid ${rec.pid} at ${cols}x${rows}`);
    return { pid: rec.pid };
  };

  const stop = (name: string, generation?: number): Promise<void> => {
    const rec = records.get(name);
    if (!rec || !rec.running || (generation !== undefined && generation !== rec.generation)) return Promise.resolve();
    // A process that is already gone (exit handling still flushing the mirror) is never signalled: its pid may be reused.
    if (!rec.stopRequested && !rec.exited) {
      rec.stopRequested = true;
      // SIGTERM first: claude runs its SessionEnd hooks and ends its own children; SIGKILL would orphan them.
      sendSignal(rec, 'SIGTERM');
      const killTimer = setTimeout(() => {
        rec.killTimer = null;
        if (rec.exited) return;
        guarded('SIGKILL timer', () => {
          log.warn(`${rec.name} did not exit after SIGTERM; sending SIGKILL`);
          sendSignal(rec, 'SIGKILL');
        });
        const giveUpTimer = setTimeout(() => {
          rec.giveUpTimer = null;
          if (rec.exited) return;
          guarded('give-up timer', () => {
            log.warn(`${rec.name} did not exit after SIGKILL; treating it as gone`);
            const pty = rec.pty as DestroyablePty | null;
            finishExit(rec, 0, 9);
            pty?.destroy?.();
          });
        }, giveUpAfterKillMs);
        giveUpTimer.unref();
        rec.giveUpTimer = giveUpTimer;
      }, killAfterMs);
      killTimer.unref();
      rec.killTimer = killTimer;
    }
    return rec.done;
  };

  const stopAll = async (): Promise<void> => {
    await Promise.all([...records.values()].filter((rec) => rec.running).map((rec) => stop(rec.name)));
  };

  const write = (name: string, data: string | Uint8Array): boolean => {
    const rec = records.get(name);
    if (!rec?.pty || !isLive(rec)) return false;
    try {
      rec.pty.write(typeof data === 'string' ? data : Buffer.from(data));
      return true;
    } catch (error) {
      log.debug(`write to ${name} failed: ${errorMessage(error)}`);
      return false;
    }
  };

  const submit = (name: string, generation: number, text: string): boolean => {
    const rec = records.get(name);
    if (!rec?.pty || !isLive(rec) || rec.generation !== generation) return false;
    if (!rec.mirror.modes.bracketedPasteMode) return false;
    const clean = sanitizeForPaste(text);
    // The prefix is what makes it impossible for the server to type anything but a pointer.
    if (clean === '' || clean.length > SUBMIT_MAX_CHARS || !clean.startsWith(POINTER_PREFIX)) return false;
    try {
      rec.pty.write(PASTE_START + clean + PASTE_END + ENTER);
      return true;
    } catch (error) {
      log.debug(`submit to ${name} failed: ${errorMessage(error)}`);
      return false;
    }
  };

  const resize = (name: string, cols: number, rows: number): boolean => {
    const rec = records.get(name);
    if (!rec?.pty || !isLive(rec) || !Number.isFinite(cols) || !Number.isFinite(rows)) return false;
    const c = clampDim(cols, MIN_COLS, MAX_COLS, DEFAULT_COLS);
    const r = clampDim(rows, MIN_ROWS, MAX_ROWS, DEFAULT_ROWS);
    // Every resize makes claude repaint everything, so an unchanged size must not reach the pty.
    if (c === rec.mirror.cols && r === rec.mirror.rows) return true;
    try {
      rec.pty.resize(c, r); // throws EBADF once the child is gone; then the mirror keeps the size the pty still has
    } catch (error) {
      log.debug(`resize of ${name} failed: ${errorMessage(error)}`);
      return false;
    }
    rec.mirror.resize(c, r);
    rec.version += 1;
    return true;
  };

  const rename = (oldName: string, newName: string): boolean => {
    const rec = records.get(oldName);
    if (!rec || rec.running || records.get(newName)?.running) return false;
    records.delete(oldName);
    rec.name = newName;
    records.set(newName, rec);
    return true;
  };

  /** A removed agent's record would otherwise keep its mirror, with up to MIRROR_SCROLLBACK_LINES rows, for the life of the server. */
  const forget = (name: string): void => {
    const rec = records.get(name);
    if (!rec || rec.running) return;
    records.delete(name);
    for (const sink of rec.sinks) {
      sink.detached = true;
      sink.buffer = [];
    }
    rec.sinks.clear();
    try {
      rec.mirror.dispose();
    } catch (error) {
      log.warn(`could not dispose the mirror of ${name}`, error);
    }
  };

  const startSink = (sink: Sink): void => {
    if (sink.started || sink.detached) return;
    sink.started = true;
    const queued = sink.buffer;
    sink.buffer = [];
    for (const chunk of queued) {
      if (sink.detached) return;
      guarded('output listener', () => sink.listener(chunk));
    }
  };

  const attach = (name: string, listener: OutputListener): Promise<Attachment> => {
    const rec = records.get(name);
    if (!rec) {
      const empty: Attachment = {
        snapshot: { cols: DEFAULT_COLS, rows: DEFAULT_ROWS, data: '', generation: 0, running: false },
        start() {},
        detach() {},
      };
      return Promise.resolve(empty);
    }
    // Steps 1 and 2 are one synchronous block: every chunk after this point is buffered for the sink, and the marker sits
    // in the mirror's queue right behind everything that is not, so the snapshot and the buffer meet with no gap or overlap.
    const sink: Sink = { listener, started: false, detached: false, buffer: [] };
    rec.sinks.add(sink);
    const modes = rec.tracker.fixup();
    return new Promise<Attachment>((resolveAttachment) => {
      const atMark = (): void => {
        let data = modes;
        try {
          data = rec.serializer.serialize({ scrollback: SNAPSHOT_SCROLLBACK_LINES }) + modes;
        } catch (error) {
          log.warn(`snapshot of ${name} failed`, error);
        }
        resolveAttachment({
          snapshot: { cols: rec.mirror.cols, rows: rec.mirror.rows, data, generation: rec.generation, running: rec.running },
          start: () => startSink(sink),
          detach: () => {
            sink.detached = true;
            sink.buffer = [];
            rec.sinks.delete(sink);
          },
        });
      };
      try {
        rec.mirror.write('', atMark);
      } catch (error) {
        log.warn(`the mirror of ${name} could not take a marker`, error);
        atMark();
      }
    });
  };

  const screen = (name: string): ScreenProbe | null => {
    const rec = records.get(name);
    return rec && rec.pending === 0 ? probeOf(rec) : null;
  };

  const titleOf = (name: string): TitleInfo | null => {
    const current = records.get(name)?.title;
    return current ? { ...current } : null;
  };

  const info = (name: string): TerminalInfo | null => {
    const rec = records.get(name);
    if (!rec) return null;
    // Running until the exit event went out (contract 6.9), the same moment spawn() and rename() start to accept the name again.
    return { running: rec.running, generation: rec.generation, pid: rec.running ? rec.pid : null, cols: rec.mirror.cols, rows: rec.mirror.rows };
  };

  return {
    spawn,
    stop,
    stopAll,
    write,
    submit,
    resize,
    rename,
    forget,
    list: () => [...records.values()].map((rec) => ({ name: rec.name, generation: rec.generation, pid: rec.running ? rec.pid : null, running: rec.running, paste: rec.mirror.modes.bracketedPasteMode })),
    attach,
    screen,
    title: titleOf,
    outputBytes: (name) => records.get(name)?.bytes ?? 0,
    info,
    onEvent: (handler) => {
      handlers.push(handler);
      return () => {
        const index = handlers.indexOf(handler);
        if (index >= 0) handlers.splice(index, 1);
      };
    },
  };
}
