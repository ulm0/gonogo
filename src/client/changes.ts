import { RECORDER_MESSAGE_MAX_CHARS } from '../shared/protocol.js';
import type { RecorderFile, RecorderScope } from '../shared/protocol.js';

// What the Recorder page decides, kept out of Recorder.tsx so that it can be tested without a DOM.

const LETTERS: Readonly<Record<string, string>> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed', U: 'unmerged' };
const CONFLICTS = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'];

export interface FileLabel {
  text: string;
  /** Staged changes are in the next commit under "Only what is staged". */
  staged: boolean;
}

/** What git says about one file, in words: "staged: modified", "not staged: deleted", "untracked", "conflict". */
export function fileLabels(file: RecorderFile): FileLabel[] {
  if (file.index === '?' && file.tree === '?') return [{ text: 'untracked', staged: false }];
  if (CONFLICTS.includes(file.index + file.tree)) return [{ text: 'conflict', staged: false }];
  const labels: FileLabel[] = [];
  const index = LETTERS[file.index];
  const tree = LETTERS[file.tree];
  if (index !== undefined) labels.push({ text: `staged: ${index}${file.from === undefined ? '' : ` from ${file.from}`}`, staged: true });
  if (tree !== undefined) labels.push({ text: `not staged: ${tree}`, staged: false });
  return labels;
}

export const stagedCount = (files: readonly RecorderFile[]): number => files.filter((f) => fileLabels(f).some((l) => l.staged)).length;

export const shortHash = (hash: string): string => hash.slice(0, 7);

export type DiffKind = 'meta' | 'hunk' | 'add' | 'del' | 'ctx';
export interface DiffLine {
  kind: DiffKind;
  text: string;
}

/** The lines of a diff with what each is, for the colour. The sign stays in the text, so the colour is never the only mark. */
export function diffLines(diff: string): DiffLine[] {
  if (diff === '') return [];
  const lines = diff.endsWith('\n') ? diff.slice(0, -1).split('\n') : diff.split('\n');
  let inHunk = false;
  return lines.map((text) => {
    if (text.startsWith('diff --git ')) inHunk = false;
    if (text.startsWith('@@')) {
      inHunk = true;
      return { kind: 'hunk', text };
    }
    if (!inHunk) return { kind: 'meta', text };
    return { kind: text.startsWith('+') ? 'add' : text.startsWith('-') ? 'del' : 'ctx', text };
  });
}

/** Why a commit cannot be made yet, or null. The server judges it again. */
export function commitProblem(message: string, scope: RecorderScope, files: readonly RecorderFile[], hasAuthor: boolean): string | null {
  if (!hasAuthor) return 'git has no author: set user.name and user.email first.';
  if (message.trim() === '') return 'Write a message for the commit.';
  if (message.length > RECORDER_MESSAGE_MAX_CHARS) return `At most ${RECORDER_MESSAGE_MAX_CHARS} characters.`;
  if (files.length === 0) return 'Nothing has changed.';
  if (scope === 'staged' && stagedCount(files) === 0) return 'Nothing is staged.';
  return null;
}
