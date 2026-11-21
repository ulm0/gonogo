/**
 * The anchor grammar and the evaluation of one leg (docs/knowledge-spec.md section 0b.3): `<!-- @anchor ID brain:<glob> [!<glob> ...] /regex/[i] | "literal" [mode] -->`.
 *
 * Ported from multivac (MIT, (c) 2026 Pierre Ugaz, the same person as gonogo's owner): `src/anchor/parse.ts` (the line grammar), `src/lib/regex.ts` (the dialect gate),
 * `src/anchor/match.ts` and `src/anchor/evaluate.ts` (the semantics of the legs: present, absent, unique, count=N, each, each!). Not ported: the rewriting of moved
 * anchors, git helpers, config, the SQL statement normalization, anything that writes a repository. What gonogo adds: the repo key is fixed to `brain` (one repo per claim
 * set), a `"literal"` in place of `/regex/` (a fixed string, no regex engine), and refusals multivac lacks (a repeated group that holds a quantifier, a pattern over 200
 * characters, an absolute, `..`, `~`, backslash, NUL or drive-letter glob). The results say `stale`, never "broken": an anchor is a hint, never a gate.
 *
 * THIS FILE IS ALSO THE WORKER (src/server/anchorengine.ts starts it with `worker_threads`): so it imports only Node and picomatch, with `import type` for the rest, and Node
 * can run it as it is (type stripping) in a test as well as compiled in `dist`. In a worker it reads the tracked files itself (realpath under the root, O_NOFOLLOW, the opened
 * file is the one `lstat` saw, regular files only) and evaluates the legs it was given; the main thread ends it at the total time.
 *
 * Nothing read from a repository goes into a note: notes are fixed words, counts, and for `present` at most one file name (the Director's page only).
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import picomatch from 'picomatch';
import type { Leg, LegState } from '../shared/protocol.js';

/* ---------------------------------------------------------------- the limits (docs/knowledge-spec.md 0b.3) */

export const ANCHOR_PATTERN_MAX_CHARS = 200;
export const ANCHOR_LITERAL_MAX_CHARS = 200;
export const ANCHOR_GLOB_MAX_CHARS = 200;
/** Bytes read of one file; a larger file is skipped (and counted). */
export const ANCHOR_FILE_MAX_BYTES = 1024 * 1024;
/** Bytes read in one run. */
export const ANCHOR_RUN_MAX_BYTES = 64 * 1024 * 1024;
/** Tracked files a run lists. */
export const ANCHOR_FILES_MAX = 20_000;
export const ANCHOR_CLAIMS_MAX = 200;
export const ANCHOR_LEGS_MAX = 500;

/* ---------------------------------------------------------------- the regex dialect gate (multivac src/lib/regex.ts, plus refusals) */

export class AnchorSyntaxError extends Error {}

const ESCAPE_HINTS: Record<string, string> = {
  s: '\\s is not POSIX ERE: use [[:space:]]',
  S: '\\S is not POSIX ERE: use [^[:space:]]',
  d: '\\d is not POSIX ERE: use [[:digit:]]',
  D: '\\D is not POSIX ERE: use [^[:digit:]]',
  w: '\\w is not POSIX ERE: use [[:alnum:]_]',
  W: '\\W is not POSIX ERE: use [^[:alnum:]_]',
  b: '\\b is not POSIX ERE: use (^|[^[:alnum:]_])...([^[:alnum:]_]|$)',
  B: '\\B is not POSIX ERE: no equivalent, restructure the pattern',
};

/** [:name:] -> the body of a JS bracket expression. */
const POSIX_CLASSES: Record<string, string> = {
  space: ' \\t\\r\\n\\v\\f',
  blank: ' \\t',
  digit: '0-9',
  alpha: 'a-zA-Z',
  alnum: 'a-zA-Z0-9',
  upper: 'A-Z',
  lower: 'a-z',
  xdigit: '0-9a-fA-F',
  punct: '!-/:-@\\[-`{-~',
};

/**
 * A group that is repeated (`*`, `+`, `{n,}`, `{n,m}`) and holds a quantifier inside (`(a+)+`, `(a*)*`, `(a|b+)*`, `(.*a){20}`): the shape that makes a backtracking
 * engine take exponential time. Refused here; the worker's end at the total time is the guard for the shapes this does not see. Scans the source the way the dialect walk
 * does: escapes and bracket expressions are skipped.
 */
function repeatedGroupWithQuantifier(source: string): boolean {
  const stack: boolean[] = []; // does the open group hold a quantifier yet
  const quant = (i: number): { len: number; many: boolean } | null => {
    const c = source[i];
    if (c === '*' || c === '+') return { len: 1, many: true };
    if (c === '?') return { len: 1, many: false };
    if (c === '{') {
      const m = /^\{(\d*)(,(\d*))?\}/.exec(source.slice(i, i + 24));
      if (m === null) return null;
      return { len: m[0].length, many: m[2] !== undefined || Number(m[1]) > 1 };
    }
    return null;
  };
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (c === '\\') {
      i += 1;
    } else if (c === '[') {
      let j = i + 1;
      if (source[j] === '^') j += 1;
      if (source[j] === ']') j += 1;
      while (j < source.length && source[j] !== ']') j += source[j] === '[' && source[j + 1] === ':' ? Math.max(2, source.indexOf(':]', j + 2) + 2 - j) : 1;
      i = j;
    } else if (c === '(') {
      stack.push(false);
    } else if (c === ')') {
      const holds = stack.pop() ?? false;
      const after = quant(i + 1);
      if (holds && after !== null && after.many) return true;
      if (stack.length > 0 && holds) stack[stack.length - 1] = true; // a group inside holds a quantifier for the group around it
    } else {
      const q = quant(i);
      if (q !== null && q.many && stack.length > 0) stack[stack.length - 1] = true;
      if (q !== null && c === '{') i += q.len - 1;
    }
  }
  return false;
}

/** Compiles an anchor regex (POSIX ERE with [[:class:]]) to a JS RegExp. Throws AnchorSyntaxError, with the fix in the message. */
export function compileAnchorRegex(source: string, flags = ''): RegExp {
  if (!/^i?$/.test(flags)) throw new AnchorSyntaxError(`unsupported regex flags "${flags}": only "i" is allowed, drop the rest`);
  if (source === '') throw new AnchorSyntaxError('an empty pattern matches every line: write what you look for');
  if (source.length > ANCHOR_PATTERN_MAX_CHARS) throw new AnchorSyntaxError(`a pattern is at most ${ANCHOR_PATTERN_MAX_CHARS} characters`);
  const classes: Array<{ start: number; end: number; name: string }> = [];
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (c === '\\') {
      const next = source[i + 1] ?? '';
      const hint = ESCAPE_HINTS[next];
      if (hint !== undefined) throw new AnchorSyntaxError(hint);
      if (next >= '0' && next <= '9') {
        throw new AnchorSyntaxError(
          next === '0'
            ? '\\0 is a NUL escape in JavaScript and means nothing in POSIX ERE: write the character, or use a bracket expression'
            : `\\${next} is a backreference: POSIX ERE has none; write the text out, or match it in two legs`,
        );
      }
      if (/[a-zA-Z]/.test(next)) throw new AnchorSyntaxError(`\\${next} has no meaning in POSIX ERE: escape punctuation only, or use a bracket expression`);
      i += 1;
      continue;
    }
    if (c === '[') {
      if (source[i + 1] === ':') {
        const close = source.indexOf(':]', i + 2);
        const name = close === -1 ? '' : source.slice(i + 2, close);
        throw new AnchorSyntaxError(`character class syntax is [[:${name || 'name'}:]], not [:${name || 'name'}:]: the class needs its own brackets inside the bracket expression`);
      }
      let j = i + 1;
      if (source[j] === '^') j += 1;
      if (source[j] === ']') j += 1;
      while (j < source.length) {
        if (source[j] === '[' && source[j + 1] === ':') {
          const end = source.indexOf(':]', j + 2);
          if (end === -1) break;
          classes.push({ start: j, end: end + 2, name: source.slice(j + 2, end) });
          j = end + 2;
          continue;
        }
        if (source[j] === ']') break;
        j += 1;
      }
      i = j;
      continue;
    }
    if (c === '(' && source[i + 1] === '?') throw new AnchorSyntaxError('POSIX ERE has no `(?...)`: no lookaround, no non-capturing groups; use a plain group');
    if ((c === '*' || c === '+' || c === '?' || c === '}') && source[i + 1] === '?') {
      throw new AnchorSyntaxError(`POSIX ERE quantifiers are greedy: \`${c}?\` is not lazy here; restructure the pattern`);
    }
  }
  if (repeatedGroupWithQuantifier(source)) {
    throw new AnchorSyntaxError('a repeated group that holds a quantifier ((a+)+, (a*)*, (a|b+)*) can take exponential time: write it without the nesting, or as two legs');
  }
  let translated = '';
  let at = 0;
  for (const cl of classes) {
    const body = POSIX_CLASSES[cl.name];
    if (body === undefined) throw new AnchorSyntaxError(`unknown POSIX class [:${cl.name}:]: use one of [:${Object.keys(POSIX_CLASSES).join(':] [:')}:]`);
    translated += source.slice(at, cl.start) + body;
    at = cl.end;
  }
  translated += source.slice(at);
  try {
    return new RegExp(translated, flags);
  } catch (error) {
    throw new AnchorSyntaxError(`invalid regex /${source}/${flags}: ${(error as Error).message}`);
  }
}

/* ---------------------------------------------------------------- globs */

const WINDOWS_DRIVE = /^[a-zA-Z]:/;
const UNSAFE_GLOB = new RegExp(`[\\u0000-\\u001f\\u007f-\\u009f]`);

/** Why a glob is refused, or null: relative to the repository, no `..`, `~`, backslash, NUL, drive letter or empty part. Everything else is picomatch's. */
export function globProblem(glob: string): string | null {
  if (glob === '' || glob.length > ANCHOR_GLOB_MAX_CHARS) return `a glob is 1 to ${ANCHOR_GLOB_MAX_CHARS} characters`;
  if (UNSAFE_GLOB.test(glob)) return 'a glob has a control character';
  if (glob.startsWith('/') || glob.startsWith('~') || WINDOWS_DRIVE.test(glob)) return 'a glob is relative to the repository: no leading "/", no "~", no drive letter';
  if (glob.includes('\\')) return 'a glob has no backslash: paths use "/"';
  if (glob.split('/').some((part) => part === '' || part === '..')) return 'a glob has no empty part and no "..": it stays inside the repository';
  try {
    picomatch(glob, { dot: true });
  } catch {
    return 'picomatch cannot read this glob';
  }
  return null;
}

const matchers = new Map<string, (file: string) => boolean>();
/** The matcher of a glob over repo-relative, "/"-separated paths: picomatch, dotfiles included. */
function globMatcher(glob: string): (file: string) => boolean {
  let found = matchers.get(glob);
  if (found === undefined) {
    found = picomatch(glob, { dot: true });
    if (matchers.size > 2000) matchers.clear();
    matchers.set(glob, found);
  }
  return found;
}

/** The files a leg looks at: its glob minus its exclusions. Zero means a vacuous glob. */
export function legFiles(leg: Pick<Leg, 'glob' | 'excludes'>, files: readonly string[]): string[] {
  const include = globMatcher(leg.glob);
  const excluded = leg.excludes.map(globMatcher);
  return files.filter((file) => include(file) && !excluded.some((m) => m(file)));
}

/* ---------------------------------------------------------------- the line grammar (multivac src/anchor/parse.ts) */

export interface AnchorDiagnostic {
  line: number;
  message: string;
}

export interface ParsedAnchor {
  claimId: string;
  leg: Leg;
}

/**
 * The opener of an anchor comment: the ONE definition of that shape, shared by the parser (a line that tries to declare a leg) and by the matcher (a line that
 * carries a whole anchor never matches: a claim's own regex must not satisfy another claim). No `g` flag: a stateful literal would make one line depend on the last.
 */
export const ANCHOR_LINE = /<!--\s*@anchor\b/;

const GRAMMAR = '<!-- @anchor <CLAIM-ID> brain:<glob> [!<glob> ...] /<regex>/[i] | "<text>" [present|absent|unique|count=N|each|each!] -->';
const GLOB_DIALECT = 'globs are picomatch patterns over repo-relative paths: `**` crosses directories, `{a,b}` alternates, and dotfiles match';
const nibble = (s: string): [string, string] => {
  const m = /^(\S+)\s*/.exec(s);
  return m === null ? ['', s] : [m[1] as string, s.slice(m[0].length)];
};
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** `"literal"` with `\"` and `\\` escapes: the text, and what is left of the line after it; or null. */
function readLiteral(rest: string): { text: string; after: string } | null {
  if (!rest.startsWith('"')) return null;
  let text = '';
  for (let i = 1; i < rest.length; i += 1) {
    const c = rest[i] as string;
    if (c === '\\') {
      const next = rest[i + 1];
      if (next !== '"' && next !== '\\') return null;
      text += next;
      i += 1;
    } else if (c === '"') {
      return { text, after: rest.slice(i + 1).trim() };
    } else {
      text += c;
    }
  }
  return null;
}

/** The anchor lines of a text: legs by claim id (in order), and a diagnostic with its line for each line that is not one. Fenced and indented code is documentation, not law. */
export function parseAnchors(text: string): { anchors: ParsedAnchor[]; diagnostics: AnchorDiagnostic[] } {
  const anchors: ParsedAnchor[] = [];
  const diagnostics: AnchorDiagnostic[] = [];
  const lines = text.split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = (lines[i] as string).replace(/\r$/, '');
    const line = i + 1;
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || /^ {4,}/.test(raw)) continue;
    const bad = (message: string): void => void diagnostics.push({ line, message });
    if (/^@anchor\b/.test(raw.trim())) {
      bad(`anchor is not an HTML comment: write ${GRAMMAR}`);
      continue;
    }
    if (!ANCHOR_LINE.test(raw)) continue;
    const cm = /<!--\s*@anchor\s+(.*?)\s*-->/.exec(raw);
    if (cm === null) {
      bad(`unterminated anchor comment: write it on one line: ${GRAMMAR}`);
      continue;
    }
    let rest = cm[1] as string;
    let claimId: string;
    [claimId, rest] = nibble(rest);
    if (!ID.test(claimId)) {
      bad(`missing or odd claim id before the repo spec: ${GRAMMAR}`);
      continue;
    }
    let spec: string;
    [spec, rest] = nibble(rest);
    const colon = spec.indexOf(':');
    if (colon <= 0 || colon === spec.length - 1) {
      bad(`"${spec.slice(0, 40) || '(nothing)'}" is not brain:<glob>: add the repo key, a colon and the glob; ${GLOB_DIALECT}`);
      continue;
    }
    if (spec.slice(0, colon) !== 'brain') {
      bad('this store has one repo: write brain:<glob> (other repo keys and "*:" are not supported)');
      continue;
    }
    const glob = spec.slice(colon + 1);
    const globBad = globProblem(glob);
    if (globBad !== null) {
      bad(globBad);
      continue;
    }
    const excludes: string[] = [];
    let malformed = false;
    while (rest.startsWith('!')) {
      let tok: string;
      [tok, rest] = nibble(rest);
      let g = tok.slice(1);
      if (g === '') {
        bad(`empty !exclusion: remove the bare "!" or attach a glob to it; ${GLOB_DIALECT}`);
        malformed = true;
        break;
      }
      // `!brain:<glob>` and `!*:<glob>` are the same as `!<glob>` in a store of one repo
      const cut = g.indexOf(':');
      if (cut > 0 && !WINDOWS_DRIVE.test(g)) {
        const key = g.slice(0, cut);
        if (key !== 'brain' && key !== '*') {
          bad('this store has one repo: an exclusion is !<glob> or !brain:<glob>');
          malformed = true;
          break;
        }
        g = g.slice(cut + 1);
      }
      const problem = globProblem(g);
      if (problem !== null) {
        bad(problem);
        malformed = true;
        break;
      }
      excludes.push(g);
    }
    if (malformed) continue;
    let pattern: Leg['pattern'];
    let modeTok: string | undefined;
    const lit = readLiteral(rest);
    if (lit !== null) {
      if (lit.text === '' || lit.text.length > ANCHOR_LITERAL_MAX_CHARS || /[\u0000-\u001f\u007f]/.test(lit.text)) {
        bad(`a "literal" is 1 to ${ANCHOR_LITERAL_MAX_CHARS} characters on one line, with no control character`);
        continue;
      }
      pattern = { kind: 'literal', text: lit.text };
      modeTok = lit.after === '' ? undefined : lit.after;
      if (modeTok !== undefined && /\s/.test(modeTok)) {
        bad(`unexpected text after the literal: ${GRAMMAR}`);
        continue;
      }
    } else {
      const rm = /^\/(.*)\/([a-zA-Z]*)(?:\s+(\S+))?$/.exec(rest);
      if (rm === null) {
        bad(`missing or malformed /regex/ or "literal": ${GRAMMAR}`);
        continue;
      }
      try {
        compileAnchorRegex(rm[1] as string, rm[2] as string);
      } catch (error) {
        if (error instanceof AnchorSyntaxError) {
          bad(error.message);
          continue;
        }
        throw error;
      }
      pattern = { kind: 'regex', source: rm[1] as string, i: rm[2] === 'i' };
      modeTok = rm[3];
    }
    let mode: Leg['mode'] = 'present';
    let count: number | undefined;
    if (modeTok !== undefined) {
      const cnt = /^count=(\d{1,9})$/.exec(modeTok);
      if (cnt !== null) {
        mode = 'count';
        count = Number(cnt[1]);
      } else if (modeTok === 'each' || modeTok === 'each!' || modeTok === 'present' || modeTok === 'absent' || modeTok === 'unique') {
        mode = modeTok;
      } else {
        bad(`unknown mode "${modeTok.slice(0, 20)}": use present, absent, unique, count=N, each or each!`);
        continue;
      }
    }
    anchors.push({ claimId, leg: { mode, ...(count === undefined ? {} : { count }), glob, excludes, pattern, line } });
  }
  return { anchors, diagnostics };
}

/* ---------------------------------------------------------------- matching and the semantics of the legs */

/** Where the files come from: their names (tracked, repo-relative), and their text, or null for a file that cannot be read here (binary, too large, a link, gone). */
export interface FileSource {
  files: readonly string[];
  read(file: string): string | null;
}

/** Thrown by `read` when the run has read all it may: the leg is `unevaluated`. */
export class ReadBudget extends Error {}

type Test = (line: string) => boolean;
const regexTests = new Map<string, Test>();
function testOf(pattern: Leg['pattern']): Test {
  if (pattern.kind === 'literal') {
    const { text } = pattern;
    return (line) => line.includes(text);
  }
  const key = `${pattern.i ? 'i' : ''}/${pattern.source}`;
  let found = regexTests.get(key);
  if (found === undefined) {
    const re = compileAnchorRegex(pattern.source, pattern.i ? 'i' : '');
    found = (line) => re.test(line);
    if (regexTests.size > 500) regexTests.clear();
    regexTests.set(key, found);
  }
  return found;
}

/** Matching lines of one file, 1-based. A CRLF line is a line. A line that carries a whole anchor comment never matches. */
export function matchingLines(text: string, test: Test): number[] {
  const out: number[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (ANCHOR_LINE.test(line) && line.includes('-->')) continue;
    if (test(line)) out.push(i + 1);
  }
  return out;
}

export interface LegVerdict {
  state: LegState;
  /** Written here from fixed words, counts and, for `present`, one file name. Never text of the repository. */
  note: string;
}

const LIKELY_REAL = ' (likely real)';
const MAY_HAVE_MOVED = ' (may have moved)';
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** One leg against the files of one checkout. Never throws for a file: an unreadable one is skipped and counted; a `ReadBudget` makes the leg `unevaluated`. */
export function evaluateLeg(leg: Leg, source: FileSource): LegVerdict {
  let test: Test;
  try {
    test = testOf(leg.pattern);
  } catch (error) {
    return { state: 'malformed', note: error instanceof AnchorSyntaxError ? error.message : 'the pattern cannot be used' };
  }
  const globProblemText = globProblem(leg.glob) ?? leg.excludes.map(globProblem).find((p) => p !== null) ?? null;
  if (globProblemText !== null) return { state: 'malformed', note: globProblemText };
  const files = legFiles(leg, source.files);
  if (files.length === 0) return { state: 'vacuous', note: 'the glob matches no tracked file: check the path' };
  let skipped = 0;
  const hits = new Map<string, number>();
  try {
    for (const file of files) {
      const text = source.read(file);
      if (text === null) {
        skipped += 1;
        continue;
      }
      const lines = matchingLines(text, test);
      if (lines.length > 0) hits.set(file, lines.length);
    }
  } catch (error) {
    if (error instanceof ReadBudget) return { state: 'unevaluated', note: 'too much to read in one run' };
    throw error;
  }
  const n = [...hits.values()].reduce((a, b) => a + b, 0);
  const where = `${plural(hits.size, 'file', 'files')} of ${files.length}`;
  const skip = skipped === 0 ? '' : `; ${plural(skipped, 'file was', 'files were')} not read (binary, over 1 MiB or a link)`;
  const ok = (): LegVerdict => ({ state: 'ok', note: `ok${skip}` });
  const stale = (what: string, hint: string): LegVerdict => ({ state: 'stale', note: `${what}${hint}${skip}` });
  switch (leg.mode) {
    case 'present':
      return n > 0 ? ok() : stale(`no match in ${plural(files.length, 'file', 'files')}`, MAY_HAVE_MOVED);
    case 'absent':
      return n === 0 ? ok() : stale(`forbidden text found: ${plural(n, 'match', 'matches')} in ${where}`, LIKELY_REAL);
    case 'unique':
      return n === 1 ? ok() : stale(`expected exactly one match, found ${n}`, MAY_HAVE_MOVED);
    case 'count':
      return n === leg.count ? ok() : stale(`count=${String(leg.count)} pinned, found ${n}`, LIKELY_REAL);
    case 'each': {
      const lacking = files.length - skipped - hits.size;
      return lacking <= 0 ? ok() : stale(`${plural(lacking, 'file lacks', 'files lack')} the pattern (of ${files.length})`, LIKELY_REAL);
    }
    case 'each!':
      return hits.size === 0 ? ok() : stale(`forbidden text in ${where}`, LIKELY_REAL);
  }
}

/**
 * For a `present` leg that found nothing: the one tracked file of the same kind that holds the pattern, when there is exactly one ("found in src/lib.ts instead"). Reads
 * at most `limit` other files. The name is a path of the repository: shown to the Director only, never put in a prompt or a message.
 */
export function movedTo(leg: Leg, source: FileSource, limit = 2000): string | null {
  const test = testOf(leg.pattern);
  const kind = /\.[a-z0-9]+$/i.exec(leg.glob)?.[0]?.toLowerCase() ?? null;
  const own = new Set(legFiles(leg, source.files));
  const excluded = leg.excludes.map(globMatcher);
  let found: string | null = null;
  let looked = 0;
  for (const file of source.files) {
    if (own.has(file) || excluded.some((m) => m(file))) continue;
    if (kind !== null && !file.toLowerCase().endsWith(kind)) continue;
    if (looked >= limit) return null;
    looked += 1;
    let text: string | null;
    try {
      text = source.read(file);
    } catch {
      return null;
    }
    if (text === null || matchingLines(text, test).length === 0) continue;
    if (found !== null) return null;
    found = file;
  }
  return found;
}

/* ---------------------------------------------------------------- reading a repository safely (S2, S14) */

export interface TrackedReader {
  read(file: string): string | null;
  /** Bytes read so far. */
  bytes(): number;
}

/**
 * Reads tracked files of one checkout. A file counts only when `lstat` says it is a regular file (not a link), its realpath lies under the realpath of the root, it opens with
 * O_NOFOLLOW, and the opened file is the one `lstat` saw (same device and inode: a swap between the two is refused). At most `fileMax` bytes of a file (a larger one is
 * skipped) and `runMax` bytes in all (past it `ReadBudget`). A binary file (a NUL in the first 8 KiB) is skipped. `between` is for a test: it runs between `lstat` and the open.
 */
export function trackedReader(root: string, caps: { fileMax?: number; runMax?: number } = {}, between?: (path: string) => void): TrackedReader {
  const fileMax = caps.fileMax ?? ANCHOR_FILE_MAX_BYTES;
  const runMax = caps.runMax ?? ANCHOR_RUN_MAX_BYTES;
  let realRoot: string | null = null;
  try {
    realRoot = realpathSync(root);
  } catch {
    realRoot = null;
  }
  let total = 0;
  return {
    bytes: () => total,
    read(file) {
      if (realRoot === null || file === '' || file.startsWith('/') || file.split('/').includes('..')) return null;
      const path = join(realRoot, file);
      let fd = -1;
      try {
        const before = lstatSync(path);
        if (!before.isFile() || before.isSymbolicLink() || before.size > fileMax) return null;
        const real = realpathSync(path);
        if (!real.startsWith(`${realRoot}${sep}`)) return null;
        between?.(path);
        fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW);
        const after = fstatSync(fd);
        if (!after.isFile() || after.ino !== before.ino || after.dev !== before.dev) return null;
        if (total + after.size > runMax) throw new ReadBudget('the run has read all it may');
        const buffer = Buffer.alloc(Math.min(after.size, fileMax));
        let got = 0;
        while (got < buffer.length) {
          const n = readSync(fd, buffer, got, buffer.length - got, got);
          if (n === 0) break;
          got += n;
        }
        total += got;
        const body = buffer.subarray(0, got);
        if (body.subarray(0, 8192).includes(0)) return null;
        return body.toString('utf8');
      } catch (error) {
        if (error instanceof ReadBudget) throw error;
        return null;
      } finally {
        if (fd >= 0) closeSync(fd);
      }
    },
  };
}

/* ---------------------------------------------------------------- the worker body */

/** What the main thread sends: one run over the claims of one checkout. */
export interface AnchorJob {
  kind: 'gonogo-anchor-run';
  root: string;
  /** `git ls-files -z`, split: tracked, repo-relative. */
  files: string[];
  claims: Array<{ index: number; legs: Leg[] }>;
  /** Legs already answered by another way (the fast path), by `index:leg`. */
  skip?: string[];
  caps?: { fileMax?: number; runMax?: number };
}

/** What the worker answers: a claim at a time, so that what is finished when the time is up is kept; then `done`. */
export type AnchorWorkerMessage =
  | { type: 'claim'; index: number; legs: Array<LegVerdict & { moved?: string }> }
  | { type: 'done'; bytes: number };

/** Runs a job; `post` gets each claim as it is finished. Exported for the worker entry below and for tests that run it in-process. */
export function runAnchorJob(job: AnchorJob, post: (message: AnchorWorkerMessage) => void): void {
  const reader = trackedReader(job.root, job.caps);
  const source: FileSource = { files: job.files, read: (file) => reader.read(file) };
  const skip = new Set(job.skip ?? []);
  for (const claim of job.claims) {
    const legs = claim.legs.map((leg, n): LegVerdict & { moved?: string } => {
      if (skip.has(`${claim.index}:${n}`)) return { state: 'unevaluated', note: 'answered another way' };
      try {
        const verdict = evaluateLeg(leg, source);
        if (verdict.state === 'stale' && leg.mode === 'present') {
          const moved = movedTo(leg, source);
          if (moved !== null) return { ...verdict, moved };
        }
        return verdict;
      } catch {
        return { state: 'unevaluated', note: 'this leg could not be evaluated' };
      }
    });
    post({ type: 'claim', index: claim.index, legs });
  }
  post({ type: 'done', bytes: reader.bytes() });
}

// When Node starts this file as a worker (src/server/anchorengine.ts), it is the entry: run the job, report, and let the thread end.
if (!isMainThread && parentPort !== null && typeof workerData === 'object' && workerData !== null && (workerData as { kind?: unknown }).kind === 'gonogo-anchor-run') {
  const port = parentPort;
  runAnchorJob(workerData as AnchorJob, (message) => port.postMessage(message));
}
