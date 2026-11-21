/**
 * What agents propose (docs/knowledge-spec.md 0b.2): `<room home>/knowledge-proposals/<repo-id>.json`, per room, so that a room never
 * sees what an agent of another room wrote unreviewed. A proposal is never a claim: it has no effect until the Director accepts it,
 * and its text is agent-written: cleaned, cut, labelled "unreviewed" by the page, and never put into a prompt.
 *
 * An agent gives structured legs, not a pasted comment. They are serialized here into the grammar with every part checked, so a glob or
 * a text cannot carry a comment mark, a newline or a second leg, and then read back by the same parser as any other anchor line.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ClaimResult, Proposal } from '../shared/protocol.js';
import { DIR_MODE, FILE_MODE } from './constants.js';
import { cleanStatement } from './claimsfile.js';
import type { ParseLegs } from './claimsfile.js';
import { HubError } from './hub.js';

export const PROPOSALS_PENDING_MAX = 20;
export const PROPOSALS_PER_HOUR = 10;
export const PROPOSAL_LEGS_MAX = 5;
export const PROPOSAL_REASON_MAX_CHARS = 200;
const HOUR_MS = 3_600_000;
const SEGMENT = /^[^\s\u0000-\u001f\u007f"<>`]{1,200}$/;

/** One leg as the tool takes it. */
export interface LegInput {
  mode: 'present' | 'absent' | 'unique' | 'count' | 'each' | 'each!';
  glob: string;
  exclude?: string[];
  regex?: string;
  flags?: 'i';
  literal?: string;
  count?: number;
}

const bad = (message: string, field = 'legs'): HubError => new HubError('bad_request', message, field);

/** The anchor text of a leg (without the comment wrapper and the claim id), or a HubError naming what is wrong. */
export function serializeLeg(input: unknown, at: number): string {
  const where = `leg ${at + 1}`;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw bad(`${where} must be an object`);
  const l = input as Record<string, unknown>;
  for (const key of Object.keys(l)) if (!['mode', 'glob', 'exclude', 'regex', 'flags', 'literal', 'count'].includes(key)) throw bad(`${where}: unknown field "${key}"`);
  const mode = l.mode;
  if (mode !== 'present' && mode !== 'absent' && mode !== 'unique' && mode !== 'count' && mode !== 'each' && mode !== 'each!') throw bad(`${where}: mode must be present, absent, unique, count, each or each!`);
  const glob = l.glob;
  if (typeof glob !== 'string' || !SEGMENT.test(glob) || glob.startsWith('/') || glob.startsWith('~') || glob.startsWith('!') || glob.split('/').some((p) => p === '..' || p === '')) {
    throw bad(`${where}: glob must be a relative path pattern of one word, with no "..", no "~" and no empty part`);
  }
  const exclude = l.exclude === undefined ? [] : l.exclude;
  if (!Array.isArray(exclude) || exclude.length > 5 || !exclude.every((e) => typeof e === 'string' && SEGMENT.test(e) && !e.startsWith('/') && !e.includes('..'))) throw bad(`${where}: exclude must be at most 5 patterns`);
  if ((l.regex === undefined) === (l.literal === undefined)) throw bad(`${where}: give either regex or literal`);
  let pattern: string;
  if (l.regex !== undefined) {
    // eslint-disable-next-line no-control-regex
    if (typeof l.regex !== 'string' || l.regex === '' || l.regex.length > 200 || /[\u0000-\u001f\u007f]/.test(l.regex) || l.regex.includes('-->')) throw bad(`${where}: regex must be 1 to 200 characters on one line`);
    if (l.flags !== undefined && l.flags !== 'i') throw bad(`${where}: flags can only be "i"`);
    // the delimiter is /: an unescaped one in the pattern is escaped, an escaped one stays
    pattern = `/${l.regex.replace(/\\.|\//g, (m) => (m === '/' ? '\\/' : m))}/${l.flags === 'i' ? 'i' : ''}`;
  } else {
    // eslint-disable-next-line no-control-regex
    if (typeof l.literal !== 'string' || l.literal === '' || l.literal.length > 200 || /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/.test(l.literal) || l.literal.includes('-->')) throw bad(`${where}: literal must be 1 to 200 characters on one line`);
    if (l.flags !== undefined) throw bad(`${where}: flags go with a regex`);
    pattern = `"${l.literal.replace(/[\\"]/g, '\\$&')}"`;
  }
  if (mode === 'count') {
    if (typeof l.count !== 'number' || !Number.isInteger(l.count) || l.count < 0 || l.count > 100_000) throw bad(`${where}: count needs a whole number`);
  } else if (l.count !== undefined) throw bad(`${where}: count goes with mode count`);
  const parts = [`brain:${glob}`, ...exclude.map((e) => `!${String(e)}`), pattern, mode === 'count' ? `count=${String(l.count)}` : mode];
  return parts.join(' ');
}

/** What the file keeps of a proposal besides its view: the anchor lines (for accept) and the claim made of it. */
interface Stored extends Proposal {
  legLines: string[];
  claimId?: string;
}

interface Doc {
  version: 1;
  next: number;
  proposals: Stored[];
}

export interface ProposalStore {
  /** Writes a pending proposal for the agent; the legs are checked and serialized, then read by `parseLegs`. Refused over the caps. */
  propose(repoId: string, who: { agent: string; branch: string; commit: string }, input: { statement: unknown; legs: unknown }): Promise<Proposal>;
  list(repoId: string): Promise<Proposal[]>;
  /** The anchor lines of a pending proposal, for accept. */
  lines(repoId: string, id: string): Promise<string[]>;
  setTrial(repoId: string, id: string, trial: ClaimResult): Promise<Proposal>;
  /** Pending to accepted/rejected; anything else is a conflict. */
  decide(repoId: string, id: string, status: 'accepted' | 'rejected', extra: { reason?: string; claimId?: string }): Promise<Proposal>;
}

export interface ProposalOptions {
  /** `<room home>/knowledge-proposals`. */
  dir: string;
  now(): number;
  /** The grammar of K2 turns anchor lines into legs and says what is wrong. */
  parseLegs: ParseLegs;
}

const REPO_ID = /^[0-9a-f]{16}$/;

export function createProposalStore(options: ProposalOptions): ProposalStore {
  let chain: Promise<unknown> = Promise.resolve();
  /** One change at a time in this process. */
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn);
    chain = run.catch(() => undefined);
    return run;
  };
  const path = (repoId: string): string => {
    if (!REPO_ID.test(repoId)) throw new HubError('bad_request', 'not a repository id', 'repoId');
    return join(options.dir, `${repoId}.json`);
  };
  async function read(repoId: string): Promise<Doc> {
    try {
      const doc = JSON.parse(await readFile(path(repoId), 'utf8')) as Partial<Doc>;
      if (doc.version !== 1 || !Array.isArray(doc.proposals) || typeof doc.next !== 'number') throw new Error('not a proposals file');
      return { version: 1, next: doc.next, proposals: doc.proposals };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, next: 1, proposals: [] };
      // kept aside, never read as empty and written over
      await rename(path(repoId), `${path(repoId)}.bad`).catch(() => undefined);
      return { version: 1, next: 1, proposals: [] };
    }
  }
  async function write(repoId: string, doc: Doc): Promise<void> {
    await mkdir(options.dir, { recursive: true, mode: DIR_MODE });
    const tmp = `${path(repoId)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(doc, null, 2), { mode: FILE_MODE, flag: 'wx' });
      await rename(tmp, path(repoId));
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  const view = ({ legLines: _l, claimId: _c, ...p }: Stored): Proposal => p;
  const find = (doc: Doc, id: string): Stored => {
    const p = doc.proposals.find((x) => x.id === id);
    if (!p) throw new HubError('not_found', 'unknown proposal');
    return p;
  };

  return {
    propose: (repoId, who, input) =>
      serial(async () => {
        const statement = typeof input.statement === 'string' ? cleanStatement(input.statement) : '';
        if (statement === '') throw bad('a proposal needs a statement', 'statement');
        if (!Array.isArray(input.legs) || input.legs.length === 0 || input.legs.length > PROPOSAL_LEGS_MAX) throw bad(`give 1 to ${PROPOSAL_LEGS_MAX} legs`);
        const legLines = input.legs.map((leg, i) => serializeLeg(leg, i));
        const parsed = options.parseLegs(legLines.map((text, i) => ({ line: i + 1, text: `<!-- @anchor p ${text} -->` })), 'p');
        if (parsed.diagnostics.length > 0) throw new HubError('bad_request', `the legs do not parse: ${parsed.diagnostics.map((d) => `leg ${d.line}: ${d.message}`).join('; ').slice(0, 300)}`, 'legs');
        const doc = await read(repoId);
        const now = options.now();
        const mine = doc.proposals.filter((p) => p.agent === who.agent);
        if (mine.filter((p) => p.status === 'pending').length >= PROPOSALS_PENDING_MAX) throw new HubError('rate_limited', `you have ${PROPOSALS_PENDING_MAX} proposals waiting: the Director has not answered them yet`);
        if (mine.filter((p) => now - p.at < HOUR_MS).length >= PROPOSALS_PER_HOUR) throw new HubError('rate_limited', `at most ${PROPOSALS_PER_HOUR} proposals an hour`);
        const stored: Stored = { id: `p${doc.next}`, agent: who.agent, branch: who.branch, commit: who.commit, at: now, statement, legs: parsed.legs, status: 'pending', legLines };
        doc.next += 1;
        doc.proposals.push(stored);
        await write(repoId, doc);
        return view(stored);
      }),

    async list(repoId) {
      return (await read(repoId)).proposals.map(view);
    },

    async lines(repoId, id) {
      const p = find(await read(repoId), id);
      if (p.status !== 'pending') throw new HubError('conflict', `${id} is ${p.status}`);
      return p.legLines;
    },

    setTrial: (repoId, id, trial) =>
      serial(async () => {
        const doc = await read(repoId);
        const p = find(doc, id);
        p.trial = trial;
        await write(repoId, doc);
        return view(p);
      }),

    decide: (repoId, id, status, extra) =>
      serial(async () => {
        const doc = await read(repoId);
        const p = find(doc, id);
        if (p.status !== 'pending') throw new HubError('conflict', `${id} is ${p.status} already`);
        p.status = status;
        if (extra.reason !== undefined) {
          const reason = cleanStatement(extra.reason).slice(0, PROPOSAL_REASON_MAX_CHARS);
          if (reason !== '') p.reason = reason;
        }
        if (extra.claimId !== undefined) p.claimId = extra.claimId;
        await write(repoId, doc);
        return view(p);
      }),
  };
}
