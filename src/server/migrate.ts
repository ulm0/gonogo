/**
 * Versions of the saved state (docs/release-readiness-spec.md, docs/reference/configuration.md "Versions of the saved state").
 *
 * Every JSON file under the home that has a format holds `"version": <n>`. `migrateHome` runs at start, under the home's lock and
 * before any store reads its file: a file of an older version is upgraded one version at a time, after a copy of it was made as
 * `<file>.bak-v<old>`; a file of a newer version stops the start with a message, because the older code would read it wrongly or
 * overwrite it. A file that is missing, is not JSON or has no version is left to the store that owns it: it reports it its own way.
 * The exception is a format marked `unversionedIs1` (propellant.json), which gonogo wrote without a version before: that is version 1.
 *
 * To change a format: add a step at the end of `steps` of its entry in FORMATS (version n to n + 1; it gets the parsed file and
 * returns the new one; the runner sets `version`), and change the store to read and write the new shape.
 *
 * Not run through here: the logs messages.jsonl, fuel.jsonl and the day files of the Black Box (a line a reader cannot parse is
 * skipped; a new line format needs a new file name), and the Mission Log entries and board.md (their front matter has `version`,
 * checked in missionlog.ts and board.ts).
 * shortcut: a home with one file too new and another to upgrade can upgrade the second before it refuses the first; the copy
 * makes that harmless, so there is no check pass.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, constants, copyFileSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Logger } from '../shared/protocol.js';
import {
  AGENTS_FILE,
  DOCKING_FILE,
  DOWNLINK_FILE,
  FILE_MODE,
  KEYS_FILE,
  LIVERY_DIR,
  LIVERY_FILE,
  PRICES_FILE,
  PROPELLANT_FILE,
  QUOTA_FILE,
  RELAY_FILE,
  ROLLOUT_FILE,
  SCHEDULES_FILE,
  STATION_FILE,
  TASKS_FILE,
  UPLINKS_FILE,
} from './constants.js';

export type Step = (data: Record<string, unknown>) => Record<string, unknown>;

export interface Format {
  /** A path under the home, or `<folder>/*.json` for every .json file of a folder. */
  file: string;
  /** steps[i] turns version i + 1 into version i + 2, so the version this gonogo writes is steps.length + 1. */
  steps: Step[];
  /** gonogo wrote this file before it had a version, so a file without one is version 1 (not left to the store). */
  unversionedIs1?: true;
}

const ALL_JSON = '/*.json';

/** Everything is still at version 1: no step yet. */
export const FORMATS: Format[] = [
  AGENTS_FILE,
  SCHEDULES_FILE,
  UPLINKS_FILE,
  TASKS_FILE,
  DOWNLINK_FILE,
  RELAY_FILE,
  DOCKING_FILE,
  STATION_FILE,
  LIVERY_FILE,
  PROPELLANT_FILE,
  PRICES_FILE,
  KEYS_FILE,
  QUOTA_FILE,
  ROLLOUT_FILE,
  LIVERY_DIR + ALL_JSON,
].map((file): Format => (file === PROPELLANT_FILE ? { file, steps: [], unversionedIs1: true } : { file, steps: [] }));

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function filesOf(home: string, file: string): string[] {
  if (!file.endsWith(ALL_JSON)) return [join(home, file)];
  const folder = join(home, file.slice(0, -ALL_JSON.length));
  try {
    return readdirSync(folder)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => join(folder, name));
  } catch {
    // no folder yet, or one the store will complain about
    return [];
  }
}

function migrateFile(path: string, { steps, unversionedIs1 }: Format, log: Logger): void {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return;
  }
  if (!isRecord(data)) return;
  const old = data.version === undefined && unversionedIs1 ? 1 : data.version;
  if (typeof old !== 'number' || !Number.isInteger(old) || old < 1) return;
  const known = steps.length + 1;
  if (old > known) {
    throw new Error(
      `${path} was saved by a newer gonogo (format version ${old}; this one reads up to ${known}). Start the gonogo that saved it, or move the file away to start without it.`,
    );
  }
  if (old === known) return;

  const backup = `${path}.bak-v${old}`;
  try {
    // an existing copy is the one made by an earlier try that failed after the copy: the file has not changed since
    copyFileSync(path, backup, constants.COPYFILE_EXCL);
    chmodSync(backup, FILE_MODE);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error(`cannot copy ${path} to ${backup}: ${errMessage(e)}; nothing was changed`);
  }
  let next: Record<string, unknown> = data;
  let version = old;
  for (const step of steps.slice(old - 1)) {
    try {
      next = { ...step(next), version: version + 1 };
    } catch (e) {
      throw new Error(`${path}: the step from version ${version} to ${version + 1} failed (${errMessage(e)}); the file was not changed, and a copy is ${backup}`);
    }
    version += 1;
  }
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: FILE_MODE, flag: 'wx' });
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // never written
    }
    throw new Error(`cannot write ${path}: ${errMessage(e)}; the file was not changed, and a copy is ${backup}`);
  }
  log.info(`${path} was upgraded from format version ${old} to ${known}; the old file is kept as ${backup}`);
}

/** Throws an Error whose message names the file; the caller lets the start fail with it. */
export function migrateHome(home: string, log: Logger, formats: Format[] = FORMATS): void {
  for (const format of formats) for (const path of filesOf(home, format.file)) migrateFile(path, format, log);
}
