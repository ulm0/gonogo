import type { ManagedOllamaView, SemanticView } from '../shared/protocol.js';

const n = (x: number): string => x.toLocaleString('en-US');
/** Bytes as MB (or GB from 1,000 MB), whole numbers. */
export const megabytes = (bytes: number): string => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${n(Math.round(bytes / 1e6))} MB`);

/** One line about the index: "Indexing 340 of 1,900 chunks · nomic-embed-text, 768 numbers · 120 of 20,000 used today." */
export function semanticStatusText(v: SemanticView): string {
  const state =
    v.state === 'off'
      ? 'Off.'
      : v.state === 'error'
        ? v.mode === 'managed'
          ? `The Ollama that gonogo runs does not answer: ${v.reason}.`
          : `The endpoint does not answer: ${v.reason}.`
        : v.state === 'cap'
          ? `Today's limit of ${n(v.cap)} chunks is reached: word search goes on.`
          : v.state === 'indexing'
            ? `Indexing ${n(v.indexed)} of ${n(v.total)} chunks.`
            : v.total === 0
              ? 'Nothing to index yet.'
              : `${n(v.indexed)} of ${n(v.total)} chunks indexed.`;
  return `${state}${v.dimension > 0 ? ` ${v.model}, ${n(v.dimension)} numbers.` : ''} ${n(v.used)} of ${n(v.cap)} used today.`;
}

/** The managed Ollama in a sentence: what it is doing, with the numbers of a download or a pull. */
export function managedStatusText(m: ManagedOllamaView): string {
  const share = m.progress !== null && m.progress.total > 0 ? ` ${megabytes(m.progress.done)} of ${megabytes(m.progress.total)} (${Math.min(100, Math.floor((m.progress.done / m.progress.total) * 100))}%).` : '';
  switch (m.state) {
    case 'unsupported':
      return m.reason;
    case 'downloading':
      return `Downloading Ollama ${m.version}, once.${share} Only the part a CPU needs is kept.`;
    case 'starting':
      return m.reason === '' ? 'Starting.' : `${m.reason[0]?.toUpperCase() ?? ''}${m.reason.slice(1)}.`;
    case 'pulling':
      return `Pulling the model.${share}`;
    case 'ready':
      return `Running on 127.0.0.1:${m.port ?? '?'}${m.rssMb === null ? '' : `, ${n(m.rssMb)} MB in memory`}${m.restarts > 0 ? `, restarted ${n(m.restarts)} time${m.restarts === 1 ? '' : 's'}` : ''}.`;
    case 'error':
      return `Stopped: ${m.reason}.`;
    default:
      return m.reason === '' ? 'Not running: it starts when an entry is indexed, and stops when it is idle.' : `Not running (${m.reason}).`;
  }
}

/** The models offered for the model field: small embedding models Ollama has. The field takes any name. */
export const EMBEDDING_MODELS: ReadonlyArray<{ name: string; note: string }> = [
  { name: 'nomic-embed-text', note: '274 MB download (the default)' },
  { name: 'all-minilm', note: '46 MB download, the smallest' },
  { name: 'mxbai-embed-large', note: '670 MB download' },
  { name: 'bge-m3', note: '1.2 GB download, many languages' },
];
