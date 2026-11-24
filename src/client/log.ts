import { LOG_BODY_MAX_CHARS, LOG_TAG_PATTERN, LOG_TAGS_MAX, LOG_TITLE_MAX_CHARS } from '../shared/protocol.js';
import type { LogEntry, LogHead, LogRequest, LogSearch } from '../shared/protocol.js';

// What Mission Log shows and asks, kept out of MissionLog.tsx so that it can be tested without a DOM.

/** What the last `log` frame said: ids and titles of what changed, ids of what was removed. `rev` counts the frames (and the states), so a view can fetch again. */
export interface LogNews {
  rev: number;
  changed: LogHead[];
  removed: string[];
}

export const NO_LOG_NEWS: LogNews = { rev: 0, changed: [], removed: [] };

export interface Values {
  title: string;
  /** Words separated by spaces or commas. */
  tags: string;
  body: string;
}
export type Field = 'title' | 'tags' | 'body';
export type Problems = Partial<Record<Field, string>>;
/** In the order of the form, which is the order the keyboard goes to the first mistake. */
export const FIELDS: readonly Field[] = ['title', 'tags', 'body'];

export const emptyValues = (): Values => ({ title: '', tags: '', body: '' });
export const valuesOf = (entry: LogEntry): Values => ({ title: entry.title, tags: entry.tags.join(' '), body: entry.body });

/** Tags as typed: lowercase, each once. */
export const parseTags = (text: string): string[] => [...new Set(text.toLowerCase().split(/[\s,]+/).filter(Boolean))];

export function validate(v: Values): Problems {
  const problems: Problems = {};
  const title = v.title.trim();
  if (title === '') problems.title = 'Give it a title.';
  else if (title.length > LOG_TITLE_MAX_CHARS) problems.title = `At most ${LOG_TITLE_MAX_CHARS} characters.`;
  else if (title.includes('\n')) problems.title = 'One line.';
  const tags = parseTags(v.tags);
  if (tags.length > LOG_TAGS_MAX) problems.tags = `At most ${LOG_TAGS_MAX} tags.`;
  else if (!tags.every((t) => new RegExp(LOG_TAG_PATTERN).test(t))) problems.tags = 'A tag is 1 to 30 letters, digits, dots, dashes or underscores.';
  const body = v.body.trim();
  if (body === '') problems.body = 'Write the entry.';
  else if (body.length > LOG_BODY_MAX_CHARS) problems.body = `At most ${LOG_BODY_MAX_CHARS} characters.`;
  return problems;
}

export const requestOf = (v: Values): LogRequest => ({ title: v.title.trim(), body: v.body.trim(), tags: parseTags(v.tags) });

/** The path of a search: words alone (`meaning=0`) while a key is typed, meaning too once the query has settled. */
export const searchPath = (query: string, meaning: boolean): string => `/log?q=${encodeURIComponent(query)}${meaning ? '' : '&meaning=0'}`;

/** "20 newest of 340 entries." for no query, "3 found in 340 entries." for one. */
export function countText(query: string, search: LogSearch, labelled = false): string {
  const entries = `${search.total} ${search.total === 1 ? 'entry' : 'entries'}`;
  if (query.trim() === '') return search.total === 0 ? 'No entries yet.' : search.hits.length < search.total ? `${search.hits.length} newest of ${entries}.` : `${entries}.`;
  // with Search by meaning on, a result list says which search it was
  return `${search.hits.length === 0 ? 'Nothing' : `${search.hits.length} found`} in ${entries}.${labelled ? (search.mode === 'meaning' ? ' Meaning + word search.' : ' Word search.') : ''}`;
}

/** What a `log` frame says, for the status line: "Written or changed: Cache key", "Removed: l3". */
export function newsText(news: LogNews): string {
  return [news.changed.length > 0 ? `Written or changed: ${news.changed.map((h) => h.title).join(', ')}` : '', news.removed.length > 0 ? `Removed: ${news.removed.join(', ')}` : ''].filter(Boolean).join('. ');
}

/** The id of a row's element, for the focus that follows closing an entry. */
export const rowId = (id: string): string => `log-row-${id}`;
