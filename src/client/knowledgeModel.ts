/**
 * Knowledge (docs/knowledge-spec.md section 0b): the pure parts of the Knowledge block, the tile count and the promote key. A claim is a statement with anchors that
 * gonogo checks read-only against a repository: `stale` means "not confirmed on this branch", never "false", and nothing here blocks anything. Every text the
 * server hands over (a statement, a proposal) is shown as plain text and labelled by who stands behind it.
 */
import type { Claim, ClaimResult, ClaimSource, KnowledgeRepo, Leg, LegState } from '../shared/protocol.js';

/** The word and tone of a state: always a word, never a colour alone. */
export const STATE_WORDS: Readonly<Record<LegState | 'unanchored', { word: string; tone: 'go' | 'amber' | 'quiet' | 'nogo' }>> = {
  ok: { word: 'confirmed', tone: 'go' },
  stale: { word: 'not confirmed', tone: 'amber' },
  vacuous: { word: 'path matches nothing', tone: 'amber' },
  unevaluated: { word: 'could not check', tone: 'quiet' },
  malformed: { word: 'cannot be read', tone: 'nogo' },
  unanchored: { word: 'no anchor', tone: 'quiet' },
};

/** `abc12345`: the first eight characters of a repo id, for a heading. */
export const shortId = (repoId: string): string => repoId.slice(0, 8);

/** Where a claim is kept: the store (the Director's), the repo's own file, or a Mission Log entry. */
export const sourceBadge = (claim: Pick<Claim, 'source' | 'from'>): string => (claim.source === 'log' ? `log ${claim.from ?? ''}`.trim() : claim.source);

/** One leg as the grammar writes it, for the edit box and the proposal: `src/**\/*.ts !src/gen/** /old/i absent`, or a fixed string in quotes. */
export function legText(leg: Leg): string {
  const globs = [leg.glob, ...leg.excludes.map((e) => `!${e}`)].join(' ');
  const pattern = leg.pattern.kind === 'regex' ? `/${leg.pattern.source}/${leg.pattern.i ? 'i' : ''}` : JSON.stringify(leg.pattern.text);
  const mode = leg.mode === 'count' ? `count=${leg.count ?? 0}` : leg.mode === 'present' ? '' : leg.mode;
  return [globs, pattern, mode].filter((part) => part !== '').join(' ');
}

/** The legs of a claim as typed in the edit box, one per line. */
export const anchorsText = (claim: Pick<Claim, 'legs'>): string => claim.legs.map(legText).join('\n');

/** "likely real" for a failure of absent, count or each (something that must not be there is), "may have moved" for present and unique (the text may live elsewhere now). Display only. */
export function severityOf(claim: Pick<Claim, 'legs'>, result: ClaimResult | undefined): '' | 'likely real' | 'may have moved' {
  if (result === undefined || (result.worst !== 'stale' && result.worst !== 'vacuous')) return '';
  const failing = result.legs.findIndex((l) => l.state === 'stale' || l.state === 'vacuous');
  const mode = claim.legs[failing]?.mode;
  if (mode === undefined) return '';
  return mode === 'absent' || mode === 'count' || mode === 'each' || mode === 'each!' ? 'likely real' : 'may have moved';
}

/** The results of one claim, one per root. */
export const resultsOf = (repo: KnowledgeRepo, claim: Pick<Claim, 'id'>): ClaimResult[] => repo.results.filter((r) => r.id === claim.id);

/** How many active claims of the repo have a result in each state, by their worst root. A claim with no result yet counts as none of them. */
export function countsOf(repo: KnowledgeRepo): { stale: number; vacuous: number; unevaluated: number; malformed: number; pending: number } {
  const counts = { stale: 0, vacuous: 0, unevaluated: 0, malformed: 0, pending: repo.proposals.filter((p) => p.status === 'pending').length };
  for (const claim of repo.claims) {
    if (claim.state !== 'active') continue;
    const worst = resultsOf(repo, claim).map((r) => r.worst);
    for (const state of ['malformed', 'stale', 'vacuous', 'unevaluated'] as const) {
      if (worst.includes(state)) {
        counts[state] += 1;
        break;
      }
    }
  }
  return counts;
}

/** "again in 20 s" for a refused RECHECK; '' without a time. */
export const retryText = (seconds: number | undefined): string => (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0 ? '' : ` Try again in ${Math.ceil(seconds)} s.`);

/** The pending proposals first, newest first; then the decided ones. */
export function proposalsOrder<T extends { status: string; at: number }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || b.at - a.at);
}

/** The roots that need the Director: not bound, or an id that two checkouts claim. */
export const unboundRoots = (repo: KnowledgeRepo): KnowledgeRepo['roots'] => repo.roots.filter((r) => !r.bound);
export const claimedTwice = (repo: KnowledgeRepo): boolean => repo.roots.length > 1 && repo.roots.some((r) => !r.bound);

export type { ClaimSource };

/** A character the page never draws from text a repo or an agent could have written: control, bidi, zero-width, byte order mark. The server cleans too; this is the second wall. */
// eslint-disable-next-line no-control-regex
const NOT_DRAWN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

/** Text to draw: without the characters above, on one line, cut to `max`. It goes in as text, never as markup. */
export const plain = (text: string, max = 300): string => {
  const clean = text.replace(NOT_DRAWN, '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

/** The last folder of a path, for a line of roots. */
export const folderOf = (path: string): string => plain(path.replace(/\/+$/, '').split('/').pop() ?? path, 80);

/** `main@abc1234`. */
export const atText = (branch: string, commit: string): string => `${plain(branch, 60)}@${plain(commit, 12)}`;
