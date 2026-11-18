/**
 * Livery: the look of the page, and an agent that designs one (docs/livery-spec.md).
 *
 * Four liveries ship (src/shared/livery.ts). Custom ones are `<home>/liveries/<slug>.json` (mode 0600, in a 0700 folder), each
 * `{ version, name, description, author, tokens }`; the chosen slug is `<home>/livery.json`. Both are written whole through a
 * temporary file and a rename, before the memory changes. A livery is checked on the way in (every token present, each a plain
 * colour, every text pair readable: checkLivery) and again when a file is read, so a hand-made file cannot put a value that is not a
 * colour into the page. An agent submits one with the tool livery_submit; the Director chooses it. Submitting never applies a
 * livery. The send and the clock are injected for tests.
 *
 * shortcut: the custom liveries are read once, at start, so a file put in the folder by hand shows after a restart; watch the
 * folder if that gets in the way.
 * shortcut: a submit under the name of a custom livery replaces it, whoever made it (never the one in use); keep a version per
 * author if that ever matters.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AGENT_NAME_PATTERN } from '../shared/protocol.js';
import type { DownlinkNotify, LiveryEntry, LiveryFrame, LiveryView, Logger, SendResult, UserMessageRequest } from '../shared/protocol.js';
import {
  builtinEntries,
  checkLivery,
  contrastRules,
  DEFAULT_LIVERY,
  LIVERIES_MAX,
  LIVERY_BRIEF_MAX_CHARS,
  LIVERY_DESCRIPTION_MAX_CHARS,
  LIVERY_NAME_MAX_CHARS,
  LIVERY_SLUG_PATTERN,
  LIVERY_TOKENS,
  MIN_CONTRAST,
  slugOf,
} from '../shared/livery.js';
import { DIR_MODE, FILE_MODE, LIVERY_DIR, LIVERY_FILE } from './constants.js';
import { isRecord } from './hooks.js';
import { HubError } from './hub.js';
import { UNSAFE_IN_NAME } from './schedules.js';

const NAME_RE = new RegExp(AGENT_NAME_PATTERN);
const SLUG_RE = new RegExp(LIVERY_SLUG_PATTERN);
const FILE_RE = /^([a-z0-9][a-z0-9-]{0,39})\.json$/;
const SUBMIT_FIELDS = ['name', 'description', 'tokens'];
/** The answer to a refused submit names this many faults, then says how many more there are. */
const PROBLEMS_SHOWN = 12;

export interface LiveriesOptions {
  /** gonogo's home: livery.json and the folder liveries/ live here. */
  dir: string;
  /** Hub.sendFromUser: the design request, a message from the Director. May throw a HubError. */
  send(request: UserMessageRequest): SendResult;
  /** The list or the chosen livery changed. */
  emit(frame: LiveryFrame): void;
  /** Downlink: a livery was submitted. */
  notify?: DownlinkNotify;
  log: Logger;
}

export interface Liveries {
  /** Reads the chosen slug and the custom liveries; a file that is not a livery is skipped with a warning and kept. */
  load(): Promise<void>;
  view(): LiveryView;
  /** The input is a JSON value from the wire, `{ slug }`; a bad one throws a HubError (bad_request, field). */
  select(input: unknown): Promise<LiveryView>;
  /** A custom livery only; the one that is chosen falls back to the default. */
  remove(slug: string): Promise<LiveryView>;
  /** The tool livery_submit: `{ name, description?, tokens }`. A bad one throws a HubError (bad_request, field) that says what to fix. */
  submit(author: string, input: unknown): Promise<LiveryEntry>;
  /** `{ to?, brief }`: sends the agent (the boss by default) the brief and the rules. */
  design(input: unknown): SendResult;
  close(): Promise<void>;
}

const bad = (message: string, field?: string): HubError => new HubError('bad_request', message, field);

/** The message that asks an agent for a livery: the brief, the tokens with their roles, the contrast rule and what to call. */
export function designBody(brief: string): string {
  return [
    'The Director asks you to design a livery, a colour theme for gonogo.',
    '',
    `Brief: ${brief}`,
    '',
    `Call mcp__gonogo__livery_submit with a name (1 to ${LIVERY_NAME_MAX_CHARS} characters), a one-line description and tokens: an object that holds every token below and no other. Each value is a CSS colour written as #rgb, #rrggbb, rgb(), hsl() or oklch(), with no alpha, no colour names and no var().`,
    '',
    'Tokens:',
    ...LIVERY_TOKENS.map((t) => `${t.name}: ${t.role}`),
    '',
    `Contrast (WCAG 2): a text must reach ${MIN_CONTRAST}:1 on the surfaces it sits on.`,
    ...contrastRules().map((line) => `- ${line}`),
    '',
    'If the livery is refused, the answer lists what fails: fix it and submit again. Submitting does not apply it; the Director picks it in the Livery view.',
  ].join('\n');
}

export function createLiveries(options: LiveriesOptions): Liveries {
  const { log } = options;
  const dir = join(options.dir, LIVERY_DIR);
  const choice = join(options.dir, LIVERY_FILE);
  const builtin = builtinEntries();
  const custom = new Map<string, LiveryEntry>();
  let current = DEFAULT_LIVERY;
  let chain: Promise<unknown> = Promise.resolve();

  /** One write at a time, so the limit holds; a failure goes to the caller and the next write goes on. */
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn);
    chain = run.catch(() => undefined);
    return run;
  };

  const writeAtomic = async (path: string, value: unknown): Promise<void> => {
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2), { mode: FILE_MODE, flag: 'wx' });
    await rename(tmp, path);
  };

  const view = (): LiveryView => ({
    current,
    liveries: [...builtin, ...[...custom.values()].sort((a, b) => (a.slug < b.slug ? -1 : 1))].map((e) => ({ ...e, tokens: { ...e.tokens } })),
  });
  const changed = (): LiveryView => {
    const now = view();
    options.emit({ t: 'livery', livery: now });
    return now;
  };
  const exists = (slug: string): boolean => builtin.some((b) => b.slug === slug) || custom.has(slug);

  /** A livery from the wire or a file: the name, the description and the tokens, checked. Throws a HubError that says what to fix. */
  function read(input: Record<string, unknown>): { name: string; description: string; tokens: Record<string, string> } {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name === '' || name.length > LIVERY_NAME_MAX_CHARS || UNSAFE_IN_NAME.test(name) || slugOf(name) === '') {
      throw bad(`name must be 1 to ${LIVERY_NAME_MAX_CHARS} characters on one line, with a letter or a digit`, 'name');
    }
    const description = input.description === undefined ? '' : typeof input.description === 'string' ? input.description.trim() : null;
    if (description === null || description.length > LIVERY_DESCRIPTION_MAX_CHARS || UNSAFE_IN_NAME.test(description)) {
      throw bad(`description must be at most ${LIVERY_DESCRIPTION_MAX_CHARS} characters on one line`, 'description');
    }
    const problems = checkLivery(input.tokens, true);
    if (problems.length > 0) {
      const shown = problems.slice(0, PROBLEMS_SHOWN).join('; ');
      throw bad(problems.length > PROBLEMS_SHOWN ? `${shown}; and ${problems.length - PROBLEMS_SHOWN} more` : shown, 'tokens');
    }
    const tokens = Object.fromEntries(Object.entries(input.tokens as Record<string, string>).map(([k, v]) => [k, v.trim()]));
    return { name, description, tokens };
  }

  return {
    async load() {
      await mkdir(dir, { recursive: true, mode: DIR_MODE });
      for (const file of await readdir(dir)) {
        const slug = FILE_RE.exec(file)?.[1];
        if (slug === undefined) continue;
        try {
          const saved: unknown = JSON.parse(await readFile(join(dir, file), 'utf8'));
          if (!isRecord(saved) || saved.version !== 1) throw new Error('not a version 1 livery file');
          if (builtin.some((b) => b.slug === slug)) throw new Error('the name is taken by a livery that ships');
          const { name, description, tokens } = read(saved);
          if (slugOf(name) !== slug) throw new Error('the name does not match the name of the file');
          custom.set(slug, { slug, name, description, builtin: false, author: typeof saved.author === 'string' ? saved.author : null, tokens });
        } catch (error) {
          // the file stays as it is: it may be a hand edit that the Director wants to mend
          log.warn(`${LIVERY_DIR}/${file} was skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      try {
        const saved: unknown = JSON.parse(await readFile(choice, 'utf8'));
        if (isRecord(saved) && saved.version === 1 && typeof saved.current === 'string' && exists(saved.current)) current = saved.current;
        else log.warn(`${LIVERY_FILE} does not name a livery that exists; the default is used`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`${LIVERY_FILE} could not be read; the default is used`);
      }
    },

    view,

    select(input) {
      return locked(async () => {
        if (!isRecord(input)) throw bad('request body must be a JSON object');
        for (const key of Object.keys(input)) if (key !== 'slug') throw bad(`unknown field "${key}"`, key);
        if (typeof input.slug !== 'string' || !SLUG_RE.test(input.slug)) throw bad('slug must be the slug of a livery', 'slug');
        if (!exists(input.slug)) throw new HubError('not_found', 'unknown livery', 'slug');
        if (input.slug === current) return view();
        await writeAtomic(choice, { version: 1, current: input.slug });
        current = input.slug;
        return changed();
      });
    },

    remove(slug) {
      return locked(async () => {
        if (builtin.some((b) => b.slug === slug)) throw new HubError('forbidden', 'a livery that ships cannot be deleted');
        if (!SLUG_RE.test(slug) || !custom.has(slug)) throw new HubError('not_found', 'unknown livery');
        if (current === slug) {
          await writeAtomic(choice, { version: 1, current: DEFAULT_LIVERY });
          current = DEFAULT_LIVERY;
        }
        // force: a file already deleted by hand must not leave a livery that can never be removed
        await rm(join(dir, `${slug}.json`), { force: true });
        custom.delete(slug);
        return changed();
      });
    },

    submit(author, input) {
      return locked(async () => {
        if (!isRecord(input)) throw bad('request body must be a JSON object');
        for (const key of Object.keys(input)) if (!SUBMIT_FIELDS.includes(key)) throw bad(`unknown field "${key}"`, key);
        const { name, description, tokens } = read(input);
        const slug = slugOf(name);
        if (builtin.some((b) => b.slug === slug)) throw bad(`"${name}" is the name of a livery that ships: pick another name`, 'name');
        // a replace of the one in use would change the look on every device: the Director chooses, an agent only submits
        if (slug === current) throw new HubError('conflict', `"${name}" is the livery in use: pick another name`, 'name');
        if (!custom.has(slug) && custom.size >= LIVERIES_MAX) {
          throw new HubError('conflict', `there are ${LIVERIES_MAX} custom liveries already: the Director has to delete one first`, 'livery');
        }
        const entry: LiveryEntry = { slug, name, description, builtin: false, author, tokens };
        await writeAtomic(join(dir, `${slug}.json`), { version: 1, name, description, author, tokens });
        custom.set(slug, entry);
        changed();
        options.notify?.('livery', `${author} submitted the livery "${name}". Pick it in the Livery view to try it.`);
        return { ...entry, tokens: { ...tokens } };
      });
    },

    design(input) {
      if (!isRecord(input)) throw bad('request body must be a JSON object');
      for (const key of Object.keys(input)) if (key !== 'to' && key !== 'brief') throw bad(`unknown field "${key}"`, key);
      const to = input.to === undefined ? 'boss' : input.to;
      if (typeof to !== 'string' || (to !== 'boss' && (to === 'user' || !NAME_RE.test(to)))) throw bad('to must be an agent name or "boss"', 'to');
      const brief = typeof input.brief === 'string' ? input.brief.trim() : '';
      if (brief === '' || brief.length > LIVERY_BRIEF_MAX_CHARS) throw bad(`brief must be 1 to ${LIVERY_BRIEF_MAX_CHARS} characters`, 'brief');
      return options.send({ to, subject: 'Livery: design request', body: designBody(brief) });
    },

    close() {
      return chain.then(() => undefined);
    },
  };
}
