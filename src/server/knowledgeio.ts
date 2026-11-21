/**
 * Export and import of the Knowledge store (docs/knowledge-spec.md 0b.1, K3): the Director's accepted claims as one JSON bundle, to move them to
 * another machine, keep them, or hand them to multivac. CLI only: there is no route for it, so it is not reachable from the page or with a key.
 *
 * A bundle holds, per repository, its id, label, remote key and root commit, the text of `claims.md` and optionally of `ritual.md`. It holds no
 * checkout path, no binding and no proposal. Import is a plan first (what would be added, skipped and rejected) and writes only on `apply`; the bundle
 * is a file from somewhere else, so it is size-capped BEFORE it is parsed, every id is checked against its remote and root commit, every claim goes
 * through the same parser as the store (statements cleaned as when a claim is accepted, S6) and nothing in it can bind a checkout.
 */
import { open, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Claim } from '../shared/protocol.js';
import { ANCHOR_PATTERN_MAX_CHARS, parseLegLines } from './anchorgrammar.js';
import { CLAIMS_FILE_MAX_BYTES, parseClaimsFile, renderClaimsFile } from './claimsfile.js';
import type { Row } from './claimsfile.js';
import type { ImportRepo, IndexRepo, KnowledgeStore } from './knowledgestore.js';
import { repoIdOf } from './repoid.js';

export const BUNDLE_MAX_BYTES = 8 * 1024 * 1024;
export const BUNDLE_REPOS_MAX = 50;
export const BUNDLE_RITUAL_MAX_BYTES = 16 * 1024;

export interface BundleRepo {
  repoId: string;
  label: string;
  remoteKey: string | null;
  rootCommit: string | null;
  claims: string;
  ritual?: string;
  /** With --multivac: the claims as a multivac `invariants.md` (a "literal" leg rewritten as an escaped regex). */
  multivac?: string;
}
export interface Bundle {
  version: 1;
  exportedAt: string;
  repos: BundleRepo[];
}

const WORD = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g;

/* ---------------------------------------------------------------- multivac */

/** The text as a POSIX ERE that matches exactly it: every character the dialect reads as an operator is escaped (letters never are: `\w` is refused by the gate). */
export const escapeEre = (text: string): string => text.replace(/[\\.^$*+?()[\]{}|/]/g, '\\$&');

/**
 * `claims.md` as multivac reads it: a `"literal"` leg becomes `/escaped/`, which is the only leg multivac does not have. A leg whose regex would pass
 * the pattern limit of the grammar is left out and named in `notes` (the claim then has fewer legs there: never a leg that means something else).
 */
export function toMultivac(claimsText: string): { text: string; notes: string[] } {
  const notes: string[] = [];
  const out = claimsText.split('\n').map((line) => {
    const m = /^(<!--\s*@anchor\s+(\S+)\s+)(\S+)((?:\s+!\S+)*)\s+(".*")(?:\s+(\S+))?\s*-->$/.exec(line.trim());
    if (m === null) return line;
    const [, head = '', id = '', glob = '', excludes = '', , mode] = m;
    const one = parseLegLines([{ line: 1, text: line.trim() }], id).legs[0];
    if (one === undefined || one.pattern.kind !== 'literal') return line;
    const source = escapeEre(one.pattern.text);
    if (source.length > ANCHOR_PATTERN_MAX_CHARS) {
      notes.push(`${id.slice(0, 20)}: a leg was left out: its escaped regex is over ${ANCHOR_PATTERN_MAX_CHARS} characters`);
      return null;
    }
    return `${head}${glob}${excludes} /${source}/${mode === undefined ? '' : ` ${mode}`} -->`;
  });
  return { text: out.filter((l): l is string => l !== null).join('\n'), notes };
}

/* ---------------------------------------------------------------- export */

export interface ExportResult {
  bundle: Bundle;
  notes: string[];
}

/** The bundle for these repositories (all of them with claims, or the one asked for). Only what the store says; nothing is written. */
export async function exportBundle(
  store: KnowledgeStore,
  dir: string,
  options: { only?: string; multivac: boolean; now(): number },
): Promise<ExportResult> {
  const index = await store.repos();
  const notes: string[] = [];
  const repos: BundleRepo[] = [];
  const wanted = options.only === undefined ? Object.keys(index).sort() : [options.only];
  for (const id of wanted) {
    const repo: IndexRepo | undefined = index[id];
    if (repo === undefined) throw new Error(`no repository ${id} in the store`);
    // an alias holds nothing of its own: what it says is kept where it points
    if (repo.alias !== undefined) {
      if (options.only !== undefined) notes.push(`${id} is an alias of ${repo.alias}: nothing exported (ask for ${repo.alias})`);
      continue;
    }
    const read = await store.claims(id);
    if (read.damaged !== null) {
      notes.push(`${repo.label} (${id}): claims.md is damaged (${read.damaged}): not exported`);
      continue;
    }
    const ritual = await store.ritual(id);
    if (read.claims.length === 0 && ritual === null) {
      if (options.only !== undefined) notes.push(`${repo.label} (${id}) has no claims`);
      continue;
    }
    const text = await claimsText(dir, id);
    const entry: BundleRepo = { repoId: id, label: repo.label, remoteKey: repo.remoteKey, rootCommit: repo.rootCommit, claims: text };
    if (ritual !== null) entry.ritual = ritual;
    if (options.multivac) {
      const converted = toMultivac(text);
      entry.multivac = converted.text;
      for (const n of converted.notes) notes.push(`${repo.label}: ${n}`);
    }
    repos.push(entry);
  }
  return { bundle: { version: 1, exportedAt: new Date(options.now()).toISOString(), repos }, notes };
}

/** `claims.md` of a repository, read again and written again by the store's own format: only rows that parse, and the anchors under them. */
async function claimsText(dir: string, id: string): Promise<string> {
  const raw = await readFile(join(dir, id, 'claims.md'), 'utf8').catch(() => '');
  const parsed = parseClaimsFile(raw, 'store', parseLegLines);
  return renderClaimsFile(parsed.rows);
}

/* ---------------------------------------------------------------- import */

export interface RepoPlan {
  repoId: string;
  label: string;
  /** Claims that would be added, replaced or skipped (their ids), and what is wrong with the rest. */
  add: string[];
  replace: string[];
  skip: string[];
  rejected: Array<{ id: string; why: string }>;
  ritual: 'write' | 'keep' | 'none';
  /** The whole repository is refused. */
  refused?: string;
  meta?: ImportRepo;
  rows: Row[];
  ritualText?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const cleanLine = (text: string, max: number): string => text.replace(WORD, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
/** A normalized remote key (repoid.ts `normalizeRemote`): host and path, no scheme, no credentials, no query. */
const REMOTE_KEY = /^[A-Za-z0-9.-]{1,253}(?:\/[A-Za-z0-9._~+-]{1,100}){0,8}$/;

/** The text of a bundle file: refused before anything is parsed when it is not a plain file or is over the cap. */
export async function readBundleFile(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('the bundle is not a plain file');
    if (info.size > BUNDLE_MAX_BYTES) throw new Error(`the bundle is over ${BUNDLE_MAX_BYTES / 1024 / 1024} MiB: nothing was read`);
    const buffer = Buffer.alloc(Math.min(info.size, BUNDLE_MAX_BYTES) + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    // the file grew while it was read
    if (bytesRead > BUNDLE_MAX_BYTES) throw new Error(`the bundle is over ${BUNDLE_MAX_BYTES / 1024 / 1024} MiB: nothing was read`);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/** What importing this bundle would do. Throws (a plain Error with the reason) for a bundle that is not one; a repository that is wrong is `refused` in its plan. */
export async function planImport(store: KnowledgeStore, text: string, fileName: string, options: { replace: boolean }): Promise<RepoPlan[]> {
  if (Buffer.byteLength(text) > BUNDLE_MAX_BYTES) throw new Error(`the bundle is over ${BUNDLE_MAX_BYTES / 1024 / 1024} MiB`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('the bundle is not JSON');
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.repos)) throw new Error('not a knowledge bundle of version 1');
  if (parsed.repos.length > BUNDLE_REPOS_MAX) throw new Error(`the bundle has ${parsed.repos.length} repositories: at most ${BUNDLE_REPOS_MAX}`);
  const source = `import: ${cleanLine(basename(fileName), 60)}`;
  const index = await store.repos();
  const plans: RepoPlan[] = [];
  const seen = new Set<string>();
  for (const raw of parsed.repos) {
    const plan: RepoPlan = { repoId: '?', label: '?', add: [], replace: [], skip: [], rejected: [], ritual: 'none', rows: [] };
    plans.push(plan);
    if (!isRecord(raw)) {
      plan.refused = 'not an object';
      continue;
    }
    const id = typeof raw.repoId === 'string' ? raw.repoId : '';
    plan.repoId = /^[0-9a-f]{16}$/.test(id) ? id : '?';
    plan.label = typeof raw.label === 'string' ? cleanLine(raw.label, 80) || 'repository' : 'repository';
    if (plan.repoId === '?') {
      plan.refused = 'the id is not 16 hexadecimal characters';
      continue;
    }
    if (seen.has(id)) {
      plan.refused = 'the repository is in the bundle twice';
      continue;
    }
    seen.add(id);
    const remoteKey = raw.remoteKey === null ? null : typeof raw.remoteKey === 'string' ? raw.remoteKey : undefined;
    const rootCommit = raw.rootCommit === null ? null : typeof raw.rootCommit === 'string' ? raw.rootCommit : undefined;
    if (remoteKey === undefined || rootCommit === undefined || (remoteKey !== null && !REMOTE_KEY.test(remoteKey)) || (rootCommit !== null && !/^[0-9a-f]{40,64}$/.test(rootCommit))) {
      plan.refused = 'the remote or the root commit is not what gonogo writes (a remote has no scheme, user or query)';
      continue;
    }
    // the id is a hash of what the repository is: a bundle cannot put claims under the id of another repository
    const full = repoIdOf(remoteKey, rootCommit ?? '');
    if (rootCommit === null || full.slice(0, 16) !== id) {
      plan.refused = 'the id does not match its remote and root commit';
      continue;
    }
    plan.meta = { repoId: id, full, label: plan.label, remoteKey, rootCommit };
    const claimsRaw = typeof raw.claims === 'string' ? raw.claims : '';
    if (Buffer.byteLength(claimsRaw) > CLAIMS_FILE_MAX_BYTES) {
      plan.refused = `claims are over ${CLAIMS_FILE_MAX_BYTES / 1024} KiB`;
      continue;
    }
    const read = parseClaimsFile(claimsRaw, 'store', parseLegLines);
    if (read.damaged !== null) {
      plan.refused = `claims: ${read.damaged}`;
      continue;
    }
    for (const d of read.diagnostics) plan.rejected.push({ id: `line ${d.line}`, why: d.message });
    const have = new Set((await store.claims(id)).claims.map((c: Claim) => c.id));
    for (const row of read.rows) {
      const claim = read.claims.find((c) => c.id === row.id);
      if (claim === undefined || claim.diagnostics.length > 0) {
        plan.rejected.push({ id: row.id, why: claim?.diagnostics[0]?.message ?? 'not read' });
        continue;
      }
      // authority and source say where it came from; the statement was cleaned by the parser as on accept
      plan.rows.push({ ...row, authority: 'imported', source: source.slice(0, 80) });
      if (have.has(row.id)) (options.replace ? plan.replace : plan.skip).push(row.id);
      else plan.add.push(row.id);
    }
    const ritual = typeof raw.ritual === 'string' ? raw.ritual : undefined;
    if (ritual !== undefined && Buffer.byteLength(ritual) <= BUNDLE_RITUAL_MAX_BYTES) {
      plan.ritualText = ritual;
      const there = index[id] !== undefined && (await store.ritual(id)) !== null;
      plan.ritual = there && !options.replace ? 'keep' : 'write';
    }
  }
  return plans;
}

/** Writes what `planImport` planned. A repository that is refused is left alone. */
export async function applyImport(store: KnowledgeStore, plans: readonly RepoPlan[], options: { replace: boolean }): Promise<Array<{ repoId: string; label: string; added: number; replaced: number; skipped: number; ritual: string }>> {
  const done: Array<{ repoId: string; label: string; added: number; replaced: number; skipped: number; ritual: string }> = [];
  for (const plan of plans) {
    if (plan.refused !== undefined || plan.meta === undefined) continue;
    const result = await store.importRepo(plan.meta, plan.rows, { replace: options.replace, ...(plan.ritualText === undefined ? {} : { ritual: plan.ritualText }) });
    done.push({ repoId: plan.repoId, label: plan.label, added: result.added.length, replaced: result.replaced.length, skipped: result.skipped.length, ritual: result.ritual });
  }
  return done;
}
