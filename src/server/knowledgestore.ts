/**
 * The Knowledge store (docs/knowledge-spec.md 0b.1): the Director's accepted claims about a repository, kept by gonogo itself, outside
 * the repository and outside any room, so that they survive a deleted room and a repository is the same one whichever room works on it.
 *
 *   <dir>/index.json            who each repository is, and which checkouts are bound to it
 *   <dir>/<repo-id>/claims.md   the accepted claims (claimsfile.ts), ids K-1, K-2, ... never used twice
 *   <dir>/<repo-id>/ritual.md   the Director's ritual template for the repository (read by the missions, not here)
 *
 * Several room processes share it, so every change is made under a lock file (`wx`, with a rule for a stale one), from what is on disk
 * at that moment, written whole to a temporary file and renamed: two writers never tear a file. Files are 0600 in 0700 folders.
 *
 * Binding (S11): an agent can edit its own `.git/config` and history, so a checkout could say it is another project. The index keeps,
 * per repository, the git common directories that are bound. The first checkout seen for a new id binds only when it is the top level of
 * an agent hired in this install; every later one waits for the Director's click, and both are shown. Until a root is bound, the agent
 * tools get nothing from the store for it.
 *
 * shortcut: the whole index is read from disk for each operation (a few KB per repository); cache it with the file's mtime if a store
 * ever holds thousands of repositories.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Claim, KnowledgeRepo, Logger } from '../shared/protocol.js';
import { DIR_MODE, FILE_MODE } from './constants.js';
import { cleanStatement, noLegs, parseClaimsFile, renderClaimsFile } from './claimsfile.js';
import type { ParseLegs, Row } from './claimsfile.js';
import { HubError } from './hub.js';
import type { RepoIdentity } from './repoid.js';

const INDEX_FILE = 'index.json';
const LOCK_FILE = '.lock';
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5000;
const REPO_ID = /^[0-9a-f]{16}$/;
const LEG_MAX_CHARS = 600;

export interface IndexRoot {
  /** The real path of a git common directory. */
  gitCommonDir: string;
  firstSeen: number;
  bound: boolean;
  /** The Director chose to leave it alone. */
  ignored?: boolean;
}
export interface IndexRepo {
  full: string;
  label: string;
  remoteKey: string | null;
  rootCommit: string | null;
  roots: IndexRoot[];
  /** Reads and writes of this id go to the canonical one. */
  alias?: string;
  /** The next number of a claim id: grows with every claim made, so an id is not given twice. */
  nextClaim: number;
  /** Repository ids the Director chose to keep apart from this one. */
  separate?: string[];
  /** Why `claims.md` could not be read; the file was kept as `claims.md.bad`. */
  damaged?: string;
}
interface Index {
  version: 1;
  repos: Record<string, IndexRepo>;
  /** Remote keys the Director chose to identify by remote alone (shallow clones). */
  remoteOnly: string[];
}

/** A refusal that carries what is wrong with the legs of a claim. */
export class ClaimsError extends HubError {
  constructor(message: string, diagnostics: Array<{ line: number; message: string }>) {
    super('bad_request', message, 'anchors');
    this.diagnostics = diagnostics;
  }
}

export interface StoreOptions {
  /** `<GONOGO_KNOWLEDGE_DIR>` or `<home>/knowledge`. */
  dir: string;
  now(): number;
  /** The grammar of the legs (K2). Default: anchor lines are kept as text and mean no leg. */
  parseLegs?: ParseLegs;
  log: Logger;
}

export interface Seen {
  /** The canonical id (an alias is followed). */
  repoId: string;
  /** The checkout is bound to it: the agent tools may read the store for it. */
  bound: boolean;
  /** A shallow clone or one with no commit: nothing is written for it. */
  provisional: boolean;
}

export interface ClaimInput {
  statement: string;
  /** The legs as typed, one anchor each, in the grammar without the comment wrapper or the claim id: `brain:src/** /x/ present`. */
  legs: string[];
  authority: string;
  /** Where it came from: `proposed by ana`, `from l17`. */
  source: string;
}

export interface KnowledgeStore {
  load(): Promise<void>;
  /** A checkout was seen; `hired` is true when it is the top level of an agent hired in this install. Writes the index when something is new. */
  see(who: RepoIdentity, hired: boolean): Promise<Seen>;
  /** Is this common directory bound to the repository? */
  isBound(repoId: string, gitCommonDir: string): Promise<boolean>;
  repos(): Promise<Record<string, IndexRepo>>;
  remoteOnly(): Promise<ReadonlySet<string>>;
  setRemoteOnly(remoteKey: string, on: boolean): Promise<void>;
  /** `bind`, `ignore` or `unbind` a git common directory of a repository. */
  bind(repoId: string, gitCommonDir: string, action: 'bind' | 'ignore' | 'unbind'): Promise<void>;
  /** Repositories that look like this one: the same remote and another root commit, or the same root commit and another remote, and not kept apart. */
  candidates(repoId: string): Promise<KnowledgeRepo['candidates']>;
  keepSeparate(a: string, b: string): Promise<void>;
  /** Takes the claims of `from` to `to` (one rename of the folder), and makes `from` an alias of `to`. A conflict when `to` has claims. */
  move(to: string, from: string): Promise<void>;
  /** Makes `from` an alias of `to`; what `from` holds stays where it is, not read. */
  alias(from: string, to: string): Promise<void>;
  claims(repoId: string): Promise<{ claims: Claim[]; diagnostics: Array<{ line: number; message: string }>; damaged: string | null }>;
  addClaim(repoId: string, input: ClaimInput): Promise<Claim>;
  updateClaim(repoId: string, id: string, patch: { statement?: string; legs?: string[]; state?: 'active' | 'retired' }): Promise<Claim>;
  deleteClaim(repoId: string, id: string): Promise<void>;
  /** The Director's ritual template for the repository, or null. */
  ritual(repoId: string): Promise<string | null>;
}

const bad = (message: string, field?: string): HubError => new HubError('bad_request', message, field);
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function createKnowledgeStore(options: StoreOptions): KnowledgeStore {
  const { dir, log } = options;
  const parseLegs = options.parseLegs ?? noLegs;
  const indexPath = join(dir, INDEX_FILE);
  const repoDir = (repoId: string): string => {
    if (!REPO_ID.test(repoId)) throw bad('not a repository id', 'repoId');
    return join(dir, repoId);
  };

  /** Written whole to a temporary file and renamed: a reader sees the old text or the new. */
  async function writeAtomic(path: string, text: string): Promise<void> {
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, text, { mode: FILE_MODE, flag: 'wx' });
      await rename(tmp, path);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  };

  /** One writer at a time across processes: a `wx` lock file; one older than 30 s, or of a process that is gone, is taken over. */
  async function locked<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    const lock = join(dir, LOCK_FILE);
    const until = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const handle = await open(lock, 'wx', FILE_MODE);
        await handle.writeFile(`${process.pid} ${Date.now()}`);
        await handle.close();
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const held = (await readFile(lock, 'utf8').catch(() => '')).split(' ');
        const pid = Number(held[0]);
        const at = Number(held[1]);
        // an empty or torn lock file is a writer that has only just made it: give it its time before calling it stale
        if (Number.isFinite(at) && (Date.now() - at > LOCK_STALE_MS || (Number.isInteger(pid) && pid > 0 && !alive(pid)))) {
          await rm(lock, { force: true });
          continue;
        }
        if (Date.now() > until) throw new HubError('unavailable', 'the knowledge store is busy: try again');
        await sleep(25);
      }
    }
    try {
      return await fn();
    } finally {
      await rm(lock, { force: true }).catch(() => undefined);
    }
  }

  async function readIndex(): Promise<Index> {
    try {
      const parsed: unknown = JSON.parse(await readFile(indexPath, 'utf8'));
      const rec = parsed as Partial<Index> | null;
      if (rec === null || typeof rec !== 'object' || rec.version !== 1 || typeof rec.repos !== 'object' || rec.repos === null) throw new Error('not a version 1 index');
      return { version: 1, repos: rec.repos, remoteOnly: Array.isArray(rec.remoteOnly) ? rec.remoteOnly.filter((k): k is string => typeof k === 'string') : [] };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { version: 1, repos: {}, remoteOnly: [] };
      if (code === undefined) {
        // moved aside only when its content is wrong; claims.md files are untouched, but nothing is bound until the Director binds again
        log.error(`${INDEX_FILE} could not be read; it is kept as ${INDEX_FILE}.bad and the store starts a new one`, error instanceof SyntaxError ? 'not valid JSON' : error);
        await rename(indexPath, `${indexPath}.bad`).catch(() => undefined);
        return { version: 1, repos: {}, remoteOnly: [] };
      }
      throw error;
    }
  }
  const writeIndex = (index: Index): Promise<void> => writeAtomic(indexPath, JSON.stringify(index, null, 2));

  /** Follows aliases (at most a few steps: a loop ends where it began). */
  const canonical = (index: Index, repoId: string): string => {
    let id = repoId;
    for (let i = 0; i < 5; i += 1) {
      const next = index.repos[id]?.alias;
      if (next === undefined || next === id) break;
      id = next;
    }
    return id;
  };
  const entry = (index: Index, repoId: string): IndexRepo => {
    const found = index.repos[canonical(index, repoId)];
    if (found === undefined) throw new HubError('not_found', 'unknown repository', 'repoId');
    return found;
  };

  async function readRows(repoId: string, index: Index): Promise<{ rows: Row[]; parsed: ReturnType<typeof parseClaimsFile> }> {
    const path = join(repoDir(repoId), 'claims.md');
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { rows: [], parsed: { rows: [], claims: [], diagnostics: [], damaged: index.repos[repoId]?.damaged ?? null } };
      throw e;
    }
    const parsed = parseClaimsFile(text, 'store', parseLegs);
    if (parsed.damaged !== null) {
      // S16: kept aside, and said so: never an empty claim set that looks fine
      await rename(path, `${path}.bad`).catch(() => undefined);
      const repo = index.repos[repoId];
      if (repo) repo.damaged = parsed.damaged;
      await writeIndex(index).catch(() => undefined);
      log.error(`${repoId}/claims.md is damaged (${parsed.damaged}) and is kept as claims.md.bad`);
      return { rows: [], parsed };
    }
    return { rows: parsed.rows, parsed };
  }

  const legLine = (id: string, leg: string): string => {
    const text = leg.trim();
    // eslint-disable-next-line no-control-regex
    if (text === '' || text.length > LEG_MAX_CHARS || /[\u0000-\u001f\u007f]/.test(text) || text.includes('-->') || text.includes('<!--')) throw new ClaimsError('an anchor must be one line of the grammar', [{ line: 0, message: 'an anchor is one line, at most 600 characters, with no comment marks' }]);
    return `<!-- @anchor ${id} ${text} -->`;
  };

  /** The anchor lines of a claim, checked by the grammar: a bad one refuses the whole write, naming the line. */
  function anchorsFor(id: string, legs: readonly string[]): string[] {
    const lines = legs.map((leg) => legLine(id, leg));
    const checked = parseLegs(lines.map((text, i) => ({ line: i + 1, text })), id);
    if (checked.diagnostics.length > 0) throw new ClaimsError('the anchors do not parse', checked.diagnostics);
    return lines;
  }

  async function saveRows(repoId: string, index: Index, rows: Row[]): Promise<void> {
    await mkdir(repoDir(repoId), { recursive: true, mode: DIR_MODE });
    await writeAtomic(join(repoDir(repoId), 'claims.md'), renderClaimsFile(rows));
    const repo = index.repos[repoId];
    if (repo) delete repo.damaged;
  }

  const toClaim = (rows: Row[], id: string): Claim => {
    const claim = parseClaimsFile(renderClaimsFile(rows), 'store', parseLegs).claims.find((c) => c.id === id);
    if (!claim) throw new Error('the claim was not read back');
    return claim;
  };

  return {
    async load() {
      await mkdir(dir, { recursive: true, mode: DIR_MODE });
    },

    async see(who, hired) {
      if (who.provisional) return { repoId: who.repoId, bound: false, provisional: true };
      return locked(async () => {
        const index = await readIndex();
        const id = canonical(index, who.repoId);
        let repo = index.repos[id];
        let changed = false;
        if (repo === undefined) {
          // a collision of the first 16 characters of two different ids is refused, not shared
          if (Object.values(index.repos).some((r) => r.full.startsWith(who.repoId) && r.full !== who.full)) throw new HubError('conflict', 'two repositories have the same short id', 'repoId');
          repo = { full: who.full, label: who.label, remoteKey: who.remoteKey, rootCommit: who.rootCommit, roots: [], nextClaim: 1 };
          index.repos[id] = repo;
          changed = true;
        }
        let root = repo.roots.find((r) => r.gitCommonDir === who.commonDir);
        if (root === undefined) {
          // the first checkout of a new id binds itself only when an agent of this install works at its top; every other one waits for a click
          root = { gitCommonDir: who.commonDir, firstSeen: options.now(), bound: hired && repo.roots.length === 0 };
          repo.roots.push(root);
          changed = true;
        }
        if (changed) await writeIndex(index);
        return { repoId: id, bound: root.bound, provisional: false };
      });
    },

    async isBound(repoId, gitCommonDir) {
      const index = await readIndex();
      return index.repos[canonical(index, repoId)]?.roots.some((r) => r.gitCommonDir === gitCommonDir && r.bound) === true;
    },

    async repos() {
      return (await readIndex()).repos;
    },

    async remoteOnly() {
      return new Set((await readIndex()).remoteOnly);
    },

    setRemoteOnly: (remoteKey, on) =>
      locked(async () => {
        const index = await readIndex();
        const set = new Set(index.remoteOnly);
        if (on) set.add(remoteKey);
        else set.delete(remoteKey);
        index.remoteOnly = [...set].sort();
        await writeIndex(index);
      }),

    bind: (repoId, gitCommonDir, action) =>
      locked(async () => {
        const index = await readIndex();
        const repo = entry(index, repoId);
        const root = repo.roots.find((r) => r.gitCommonDir === gitCommonDir);
        if (root === undefined) throw new HubError('not_found', 'no such checkout for this repository', 'path');
        if (action === 'bind') {
          root.bound = true;
          delete root.ignored;
        } else if (action === 'ignore') {
          root.bound = false;
          root.ignored = true;
        } else {
          root.bound = false;
          delete root.ignored;
        }
        await writeIndex(index);
      }),

    async candidates(repoId) {
      const index = await readIndex();
      const id = canonical(index, repoId);
      const me = index.repos[id];
      if (me === undefined) return [];
      const out: KnowledgeRepo['candidates'] = [];
      for (const [otherId, other] of Object.entries(index.repos)) {
        if (otherId === id || other.alias !== undefined || me.separate?.includes(otherId) === true || other.separate?.includes(id) === true) continue;
        if (me.remoteKey !== null && me.remoteKey === other.remoteKey && me.rootCommit !== other.rootCommit) out.push({ repoId: otherId, label: other.label, why: 'the same remote, another root commit' });
        else if (me.rootCommit !== null && me.rootCommit === other.rootCommit && me.remoteKey !== other.remoteKey) out.push({ repoId: otherId, label: other.label, why: 'the same root commit, another remote' });
      }
      return out;
    },

    keepSeparate: (a, b) =>
      locked(async () => {
        const index = await readIndex();
        const left = entry(index, a);
        const right = entry(index, b);
        left.separate = [...new Set([...(left.separate ?? []), canonical(index, b)])];
        right.separate = [...new Set([...(right.separate ?? []), canonical(index, a)])];
        await writeIndex(index);
      }),

    move: (to, from) =>
      locked(async () => {
        const index = await readIndex();
        const target = entry(index, to);
        const source = entry(index, from);
        const toId = canonical(index, to);
        const fromId = canonical(index, from);
        if (toId === fromId) throw bad('that is the same repository', 'from');
        // an empty folder of the target gives way; one with anything in it (claims, a ritual) does not, and nothing of it is deleted
        await rmdir(repoDir(toId)).catch((e: NodeJS.ErrnoException) => {
          if (e.code === 'ENOTEMPTY' || e.code === 'EEXIST') throw new HubError('conflict', 'the target already has claims: move or delete them first', 'from');
          if (e.code !== 'ENOENT') throw e;
        });
        // one rename: the claims arrive whole or not at all
        await rename(repoDir(fromId), repoDir(toId)).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== 'ENOENT') throw e;
        });
        target.nextClaim = Math.max(target.nextClaim, source.nextClaim);
        // the checkouts come along unbound: the Director binds them again here
        for (const r of source.roots) if (!target.roots.some((t) => t.gitCommonDir === r.gitCommonDir)) target.roots.push({ ...r, bound: false });
        source.alias = toId;
        source.roots = [];
        await writeIndex(index);
      }),

    alias: (from, to) =>
      locked(async () => {
        const index = await readIndex();
        const source = entry(index, from);
        entry(index, to);
        const fromId = canonical(index, from);
        const toId = canonical(index, to);
        if (fromId === toId) throw bad('that is the same repository', 'to');
        source.alias = toId;
        await writeIndex(index);
      }),

    // under the lock: a damaged file is moved aside and the index says so
    claims: (repoId) =>
      locked(async () => {
        const index = await readIndex();
        const id = canonical(index, repoId);
        const { parsed } = await readRows(id, index);
        return { claims: parsed.claims, diagnostics: parsed.diagnostics, damaged: parsed.damaged };
      }),

    addClaim: (repoId, input) =>
      locked(async () => {
        const index = await readIndex();
        const id = canonical(index, repoId);
        const repo = entry(index, id);
        const statement = cleanStatement(input.statement);
        if (statement === '') throw bad('a claim needs a statement', 'statement');
        const { rows } = await readRows(id, index);
        const claimId = `K-${repo.nextClaim}`;
        repo.nextClaim += 1;
        rows.push({ id: claimId, statement, authority: input.authority, state: 'active', date: day(options.now()), source: input.source, anchors: anchorsFor(claimId, input.legs) });
        await saveRows(id, index, rows);
        await writeIndex(index);
        return toClaim(rows, claimId);
      }),

    updateClaim: (repoId, claimId, patch) =>
      locked(async () => {
        const index = await readIndex();
        const id = canonical(index, repoId);
        entry(index, id);
        const { rows } = await readRows(id, index);
        const row = rows.find((r) => r.id === claimId);
        if (row === undefined) throw new HubError('not_found', 'unknown claim');
        if (patch.statement !== undefined) {
          const statement = cleanStatement(patch.statement);
          if (statement === '') throw bad('a claim needs a statement', 'statement');
          row.statement = statement;
        }
        if (patch.legs !== undefined) row.anchors = anchorsFor(claimId, patch.legs);
        if (patch.state !== undefined) row.state = patch.state;
        await saveRows(id, index, rows);
        await writeIndex(index);
        return toClaim(rows, claimId);
      }),

    deleteClaim: (repoId, claimId) =>
      locked(async () => {
        const index = await readIndex();
        const id = canonical(index, repoId);
        entry(index, id);
        const { rows } = await readRows(id, index);
        if (!rows.some((r) => r.id === claimId)) throw new HubError('not_found', 'unknown claim');
        await saveRows(
          id,
          index,
          rows.filter((r) => r.id !== claimId),
        );
        await writeIndex(index);
      }),

    async ritual(repoId) {
      const index = await readIndex();
      const text = await readFile(join(repoDir(canonical(index, repoId)), 'ritual.md'), 'utf8').catch(() => null);
      return text === null || text.length > 16 * 1024 ? null : text;
    },
  };
}
