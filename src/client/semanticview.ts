import type { SemanticView } from '../shared/protocol.js';

/** One line about the index: "Indexing 340 of 1,900 chunks · nomic-embed-text, 768 numbers · 120 of 20,000 used today." */
export function semanticStatusText(v: SemanticView): string {
  const n = (x: number): string => x.toLocaleString('en-US');
  const state =
    v.state === 'off'
      ? 'Off.'
      : v.state === 'error'
        ? `The endpoint does not answer: ${v.reason}.`
        : v.state === 'cap'
          ? `Today's limit of ${n(v.cap)} chunks is reached: word search goes on.`
          : v.state === 'indexing'
            ? `Indexing ${n(v.indexed)} of ${n(v.total)} chunks.`
            : v.total === 0
              ? 'Nothing to index yet.'
              : `${n(v.indexed)} of ${n(v.total)} chunks indexed.`;
  return `${state}${v.dimension > 0 ? ` ${v.model}, ${n(v.dimension)} numbers.` : ''} ${n(v.used)} of ${n(v.cap)} used today.`;
}
