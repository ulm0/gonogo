/**
 * The closing ritual of a Mission (docs/features/missions.md, "The closing ritual"): a short checklist, copied into the mission when it is made, shown when it is
 * closed. Printed, never checked, never a gate. The template is `<home>/ritual.md` (the Director's own file), or `<repo>/.gonogo/ritual.md` when the mission has a repo.
 *
 * A repo file is written by agents, so it is DATA: read through its realpath (which must lie inside the repo's realpath) with O_NOFOLLOW, regular files only, at most
 * RITUAL_FILE_MAX_BYTES; every line is cleaned like any text of the page and labelled "from the repo". A hostile line stays a line of plain text.
 */
import { execFile } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { MISSION_RITUAL_MAX, MISSION_RITUAL_TEXT_MAX } from '../shared/protocol.js';
import type { RitualItem } from '../shared/protocol.js';

export const RITUAL_FILE_MAX_BYTES = 16 * 1024;
/** Control, bidi and zero-width characters (and line and paragraph separators): never in a line of the ritual. */
/** Built from code points, so that no invisible character sits in this file. */
const UNSAFE = new RegExp(`[${['0000-001f', '007f-009f', '061c', '180e', '200b-200f', '2028-2029', '202a-202e', '2060-2064', '2066-2069', 'feff', 'fff9-fffb'].map((r) => r.split('-').map((c) => `\\u${c}`).join('-')).join('')}\\u{e0000}-\\u{e007f}]`, 'gu');

/** One line of text, cleaned and cut. */
export function cleanLine(text: string): string {
  const line = text.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
  return line.length <= MISSION_RITUAL_TEXT_MAX ? line : `${line.slice(0, MISSION_RITUAL_TEXT_MAX - 1).trimEnd()}…`;
}

/**
 * The lines of a ritual file: blank lines, headings (`#`) and comments (`<!-- -->`, also over several lines) dropped, a list marker (`-`, `*`, `+`, `1.` and a `[ ]` or `[x]` box)
 * taken off. Returns the first MISSION_RITUAL_MAX and how many there were.
 */
export function parseRitual(content: string): { lines: string[]; total: number } {
  const all: string[] = [];
  let inComment = false;
  for (const raw of content.replace(/\r\n?/g, '\n').split('\n')) {
    let text = raw;
    if (inComment) {
      const end = text.indexOf('-->');
      if (end < 0) continue;
      inComment = false;
      text = text.slice(end + 3);
    }
    for (let start = text.indexOf('<!--'); start >= 0; start = text.indexOf('<!--')) {
      const end = text.indexOf('-->', start + 4);
      if (end < 0) {
        inComment = true;
        text = text.slice(0, start);
        break;
      }
      text = text.slice(0, start) + text.slice(end + 3);
    }
    const trimmed = text.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const line = cleanLine(trimmed.replace(/^(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?/, ''));
    if (line !== '') all.push(line);
  }
  return { lines: all.slice(0, MISSION_RITUAL_MAX), total: all.length };
}

/** A regular file read through its realpath, which must be `root` itself or lie under it, without following a link at the end; null when it is not one or cannot be read. */
export function readInside(root: string, file: string): string | null {
  let fd = -1;
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(file);
    if (real !== realRoot && !real.startsWith(`${realRoot}${sep}`)) return null;
    fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile()) return null;
    const buffer = Buffer.alloc(Math.min(info.size, RITUAL_FILE_MAX_BYTES));
    let got = 0;
    while (got < buffer.length) {
      const n = readSync(fd, buffer, got, buffer.length - got, got);
      if (n === 0) break;
      got += n;
    }
    return buffer.subarray(0, got).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

export interface RitualTemplate {
  items: RitualItem[];
  /** How many lines the file had when more than MISSION_RITUAL_MAX (the rest was dropped), else 0. */
  omitted: number;
}

/** The template of a new mission: the repo's file when there is a repo and it holds lines, else the room's, else none. `home` is the room's folder. */
export function readTemplate(home: string, repo: string | null): RitualTemplate {
  if (repo !== null) {
    const found = readInside(repo, join(repo, '.gonogo', 'ritual.md'));
    if (found !== null) {
      const { lines, total } = parseRitual(found);
      if (lines.length > 0) return { items: lines.map((text) => ({ text, done: false, from: 'repo' as const })), omitted: total - lines.length };
    }
  }
  const room = readInside(home, join(home, 'ritual.md'));
  if (room === null) return { items: [], omitted: 0 };
  const { lines, total } = parseRitual(room);
  return { items: lines.map((text) => ({ text, done: false, from: 'room' as const })), omitted: total - lines.length };
}

/** What git may see of the environment: none of gonogo's own GIT_* variable, no credential. */
const KEEP_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'XDG_CONFIG_HOME', 'TMPDIR'];

/**
 * The git top level of a folder, as a real path, or null (not a repository, git missing, too slow). Hooks and the file system monitor off, as the Recorder runs git:
 * a repository's own config is written by agents and must not run a program here.
 */
export function gitTopLevel(dir: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const clean: Record<string, string> = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
  for (const key of KEEP_ENV) if (env[key] !== undefined) clean[key] = env[key] as string;
  return new Promise((resolve) => {
    execFile('git', ['--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel'], { cwd: dir, env: clean, timeout: 5000, killSignal: 'SIGTERM', maxBuffer: 8192, encoding: 'utf8' }, (error, stdout) => {
      if (error !== null) return resolve(null);
      try {
        resolve(realpathSync(stdout.trim()));
      } catch {
        resolve(null);
      }
    });
  });
}
