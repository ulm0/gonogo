/**
 * Mission Log search (docs/mission-log-spec.md): BM25 over the title and the body, in memory.
 *
 * The title and the tags count as TITLE_WEIGHT copies of themselves, so a word in a title weighs more than the same word in a body (the
 * usual way to weight a field in BM25). A word is a run of letters or digits, lowercased, two characters or more; there is no stemming,
 * so "builds" does not find "build". The index holds only counts: the text stays with the entry, and `snippet` reads it.
 *
 * shortcut: no stemming, no phrase or prefix search, and the words are Unicode letters and digits, so Chinese or Japanese text is one
 * long word; upgrade if the log is not mostly in a language that a space separates.
 */
import { LOG_SNIPPET_CHARS, LOG_SNIPPET_LEAD_CHARS } from './constants.js';

const K1 = 1.2;
const B = 0.75;
const TITLE_WEIGHT = 3;
const WORD = /[\p{L}\p{N}]{2,}/gu;

/** The words of a text, lowercased. */
export const tokenize = (text: string): string[] => text.toLowerCase().match(WORD) ?? [];

export interface IndexedDoc {
  id: string;
  title: string;
  tags: readonly string[];
  body: string;
  /** Breaks a tie: the newer entry first. */
  at: number;
}

export interface LogIndex {
  /** Adds an entry, or replaces the one with the same id. */
  add(doc: IndexedDoc): void;
  remove(id: string): void;
  /** Entries that hold at least one word of the query, best first. */
  search(query: string, limit: number): Array<{ id: string; score: number }>;
}

interface Stored {
  length: number;
  terms: string[];
  at: number;
}

export function createIndex(): LogIndex {
  /** word -> id -> weighted count */
  const postings = new Map<string, Map<string, number>>();
  const docs = new Map<string, Stored>();
  let total = 0;

  const remove = (id: string): void => {
    const doc = docs.get(id);
    if (doc === undefined) return;
    for (const term of doc.terms) {
      const posting = postings.get(term);
      posting?.delete(id);
      if (posting?.size === 0) postings.delete(term);
    }
    total -= doc.length;
    docs.delete(id);
  };

  return {
    add(doc) {
      remove(doc.id);
      const counts = new Map<string, number>();
      let length = 0;
      const count = (words: string[], weight: number): void => {
        for (const word of words) counts.set(word, (counts.get(word) ?? 0) + weight);
        length += words.length * weight;
      };
      count(tokenize(`${doc.title} ${doc.tags.join(' ')}`), TITLE_WEIGHT);
      count(tokenize(doc.body), 1);
      for (const [term, n] of counts) {
        const posting = postings.get(term) ?? new Map<string, number>();
        posting.set(doc.id, n);
        postings.set(term, posting);
      }
      docs.set(doc.id, { length, terms: [...counts.keys()], at: doc.at });
      total += length;
    },

    remove,

    search(query, limit) {
      const average = total / Math.max(docs.size, 1);
      const scores = new Map<string, number>();
      for (const term of new Set(tokenize(query))) {
        const posting = postings.get(term);
        if (posting === undefined) continue;
        const idf = Math.log(1 + (docs.size - posting.size + 0.5) / (posting.size + 0.5));
        for (const [id, tf] of posting) {
          const length = docs.get(id)?.length ?? 0;
          scores.set(id, (scores.get(id) ?? 0) + (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * length) / average)));
        }
      }
      return [...scores]
        .map(([id, score]) => ({ id, score }))
        .sort((a, b) => b.score - a.score || (docs.get(b.id)?.at ?? 0) - (docs.get(a.id)?.at ?? 0))
        .slice(0, limit);
    },
  };
}

/**
 * A piece of `text` around the place where the most different words of the query come close together (the first such place on a
 * tie), on one line, with "…" where it was cut. A text with no match gives its start.
 */
export function snippet(text: string, query: string): string {
  const wanted = new Set(tokenize(query));
  const hits = [...text.matchAll(WORD)].filter((m) => wanted.has(m[0].toLowerCase()));
  let at = 0;
  let best = -1;
  for (let i = 0; i < hits.length; i += 1) {
    const start = hits[i]?.index ?? 0;
    const seen = new Set<string>();
    for (let j = i; j < hits.length && (hits[j]?.index ?? 0) < start + LOG_SNIPPET_CHARS - LOG_SNIPPET_LEAD_CHARS; j += 1) seen.add(hits[j]?.[0].toLowerCase() ?? '');
    if (seen.size > best) {
      best = seen.size;
      at = start;
    }
  }
  // a match near the end gets the window back, so that the piece is as long as it can be
  let from = Math.max(0, Math.min(at - LOG_SNIPPET_LEAD_CHARS, text.length - LOG_SNIPPET_CHARS));
  // start at a word, unless that would cut off the match itself
  if (from > 0 && /\S/.test(text[from - 1] ?? '')) {
    const space = text.slice(from, at).search(/\s/);
    if (space >= 0) from += space + 1;
  }
  let to = Math.min(text.length, from + LOG_SNIPPET_CHARS);
  if (to < text.length && /\S/.test(text[to] ?? '')) {
    const space = text.slice(at, to).search(/\s\S*$/);
    if (space > 0) to = at + space;
  }
  const piece = text.slice(from, to).replace(/\s+/g, ' ').trim();
  return `${from > 0 ? '…' : ''}${piece}${to < text.length ? '…' : ''}`;
}
