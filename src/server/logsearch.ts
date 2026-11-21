/**
 * Mission Log search (docs/mission-log-spec.md): BM25 over the title and the body, in memory.
 *
 * The title and the tags count as TITLE_WEIGHT copies of themselves, so a word in a title weighs more than the same word in a body (the
 * usual way to weight a field in BM25). A word is a run of letters or digits, lowercased, two characters or more. The index holds the
 * STEM of each word (`stem`), and a query is stemmed the same way, so "builds", "building" and "build" find each other; a query word of
 * three letters or more also finds the longer words it begins ("anch" finds "anchor"), at half the weight of a whole-word match (the order of entries
 * that hold the same word does not change). The index holds only counts: the text stays with the entry, and `snippet` reads it.
 *
 * shortcut: the stemmer strips a few English and Spanish endings and knows no irregular word ("built" does not find "build"), a word
 * of three letters or fewer keeps its ending ("using" does not find "use"), there is no phrase search, and the words are Unicode
 * letters and digits, so Chinese or Japanese text is one long word; upgrade to a real stemmer, or to meaning search, if that is not enough.
 */
import { LOG_SNIPPET_CHARS, LOG_SNIPPET_LEAD_CHARS } from './constants.js';

const K1 = 1.2;
const B = 0.75;
const TITLE_WEIGHT = 3;
const WORD = /[\p{L}\p{N}]{2,}/gu;

/** The words of a text, lowercased. */
export const tokenize = (text: string): string[] => text.toLowerCase().match(WORD) ?? [];

/**
 * A word without its ending, for matching only (never shown): accents folded; plural `-s`, `-es` after l n r d z or `-ches -shes -xes -zes -sses`,
 * `-ies` as `-y`, Spanish `-ciones` as `-cion`; `-ing` and `-ed` (a doubled final consonant, but not l s z, is undone); then a final `e`. A stem keeps at least
 * three letters, so "is", "use" and "bus" stay as they are, and a word that is not made of letters (a number) is left alone.
 */
export function stem(word: string): string {
  let w = word.normalize('NFD').replace(/\p{M}/gu, '');
  if (!/^\p{L}+$/u.test(w)) return w;
  const cut = (suffix: string, keep: string, min: number): boolean => {
    if (!w.endsWith(suffix) || w.length - suffix.length < min) return false;
    w = w.slice(0, w.length - suffix.length) + keep;
    return true;
  };
  if (!(cut('ies', 'y', 3) || cut('sses', 'ss', 2) || cut('ches', 'ch', 2) || cut('shes', 'sh', 2) || cut('xes', 'x', 2) || cut('zes', 'z', 2) || (w.length > 4 && /[lnrd]es$/.test(w) && cut('es', '', 3)))) {
    if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  }
  if (cut('ing', '', 3) || cut('ed', '', 3)) {
    const [a, b] = [w.at(-1) ?? '', w.at(-2) ?? ''];
    if (a === b && !/[aeiouylsz]/.test(a)) w = w.slice(0, -1);
  }
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

/** The stems of the words of a text. */
const stems = (text: string): string[] => tokenize(text).map(stem);

/** A query word this short or longer also finds the stems it begins. */
const PREFIX_MIN = 3;
/** Half of a whole-word match. */
const PREFIX_WEIGHT = 0.5;
/** The most stems one query word may expand to. */
const PREFIX_MAX_TERMS = 50;

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
      count(stems(`${doc.title} ${doc.tags.join(' ')}`), TITLE_WEIGHT);
      count(stems(doc.body), 1);
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
      /** The weight of each term the query reaches: a whole stem counts 1, a longer stem it begins counts PREFIX_WEIGHT. */
      const reach = new Map<string, number>();
      for (const word of new Set(tokenize(query))) {
        reach.set(stem(word), 1);
        if (word.length < PREFIX_MIN) continue;
        let added = 0;
        for (const term of postings.keys()) {
          if (added >= PREFIX_MAX_TERMS) break;
          if (term.length > word.length && term.startsWith(word) && !reach.has(term)) {
            reach.set(term, PREFIX_WEIGHT);
            added += 1;
          }
        }
      }
      for (const [term, weight] of reach) {
        const posting = postings.get(term);
        if (posting === undefined) continue;
        const idf = Math.log(1 + (docs.size - posting.size + 0.5) / (posting.size + 0.5));
        for (const [id, tf] of posting) {
          const length = docs.get(id)?.length ?? 0;
          scores.set(id, (scores.get(id) ?? 0) + (weight * idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * length) / average)));
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
  const words = tokenize(query);
  const wanted = new Set(words.map(stem));
  // a word of the text is a hit when its stem is wanted, or it begins a query word of PREFIX_MIN letters or more
  const hit = (w: string): boolean => wanted.has(stem(w)) || words.some((q) => q.length >= PREFIX_MIN && w.length > q.length && w.startsWith(q));
  const hits = [...text.matchAll(WORD)].filter((m) => hit(m[0].toLowerCase()));
  let at = 0;
  let best = -1;
  for (let i = 0; i < hits.length; i += 1) {
    const start = hits[i]?.index ?? 0;
    const seen = new Set<string>();
    for (let j = i; j < hits.length && (hits[j]?.index ?? 0) < start + LOG_SNIPPET_CHARS - LOG_SNIPPET_LEAD_CHARS; j += 1) seen.add(stem(hits[j]?.[0].toLowerCase() ?? ''));
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
