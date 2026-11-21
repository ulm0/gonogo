/**
 * The identity of a repository for the Knowledge store (docs/knowledge-spec.md 0b.1): `sha256(remoteKey + "\n" + rootCommit)`, so two
 * clones of one history share their claims, and a worktree or a Clean Room worktree has the id of its main checkout.
 *
 * The remote URL can hold a token (`https://user:ghp_...@github.com/o/r?x=y`): it is read, reduced to `host/path` here, and the raw
 * text is never returned, logged, stored or shown. Only `git config`, `git remote`, `git rev-parse` and `git rev-list` run (no network).
 */
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { SafeGit } from './safegit.js';

export interface RepoIdentity {
  /** The 16 hex characters used as a folder name. */
  repoId: string;
  /** All 64. */
  full: string;
  /** `host/path`, or null for a repository with no remote (then the id is from the root commit alone and `local` is true). */
  remoteKey: string | null;
  /** The smallest root commit; null while it is not known (a shallow clone, or no commit yet). */
  rootCommit: string | null;
  /** A shallow clone, or one with no commit: claims can be read, proposals and binding wait. */
  provisional: boolean;
  local: boolean;
  /** The name of the top-level folder, for people. */
  label: string;
  /** The real path of the top level of this checkout. */
  top: string;
  /** The real path of the git common directory: the same for a main checkout and all its worktrees. */
  commonDir: string;
}

/**
 * `host/path` of a remote URL, or null for one that names no host (a local path) or that is empty. The scheme, the user and password,
 * the port, a query, a fragment, a trailing `.git` and slashes are dropped and the host is lower-cased; `git@host:o/r`, `ssh://host/o/r`
 * and `https://host/o/r` all give `host/o/r`.
 */
export function normalizeRemote(url: string): string | null {
  let text = url.trim();
  if (text === '' || text.length > 2048) return null;
  let host: string;
  let path: string;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/.exec(text);
  if (scheme) {
    if (scheme[1]?.toLowerCase() === 'file') return null;
    let rest = scheme[2] ?? '';
    rest = rest.split(/[?#]/)[0] ?? '';
    const slash = rest.indexOf('/');
    let authority = slash < 0 ? rest : rest.slice(0, slash);
    path = slash < 0 ? '' : rest.slice(slash + 1);
    authority = authority.slice(authority.lastIndexOf('@') + 1);
    host = authority.replace(/:\d*$/, '');
  } else {
    // scp-like: [user@]host:path
    text = text.split(/[?#]/)[0] ?? '';
    const scp = /^(?:[^@/:]+@)?([^/:@]+):(?!\/\/)(.*)$/.exec(text);
    if (!scp) return null;
    host = scp[1] ?? '';
    path = scp[2] ?? '';
  }
  host = host.toLowerCase();
  path = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  // a one-letter host is a drive (C:\repos), not a server
  if (host.length < 2 || path === '' || /[\s\0\\]/.test(host + path)) return null;
  return `${host}/${path}`;
}

/** The repository id of a remote key and a root commit. */
export const repoIdOf = (remoteKey: string | null, rootCommit: string): string => createHash('sha256').update(`${remoteKey ?? ''}\n${rootCommit}`).digest('hex');

const cleanLabel = (name: string): string =>
  // eslint-disable-next-line no-control-regex
  name.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '').slice(0, 80) || 'repository';

/**
 * Who this checkout is, or null when `dir` is not in a git repository. `remoteOnly` holds remote keys the Director chose to identify
 * by remote alone, which gives a shallow clone of them a final id instead of a provisional one.
 */
export async function identify(git: SafeGit, dir: string, remoteOnly: ReadonlySet<string> = new Set()): Promise<RepoIdentity | null> {
  const topRan = await git(dir, ['rev-parse', '--show-toplevel'], 4096);
  if (topRan.code !== 0) return null;
  const top = await realpath(topRan.out.trim()).catch(() => null);
  if (top === null) return null;
  const common = await git(top, ['rev-parse', '--git-common-dir'], 4096);
  if (common.code !== 0) return null;
  const commonDir = await realpath(resolve(top, common.out.trim())).catch(() => null);
  if (commonDir === null) return null;

  // origin, else the only remote, else none
  const names = (await git(top, ['remote'], 4096)).out.split('\n').map((n) => n.trim()).filter((n) => n !== '');
  const chosen = names.includes('origin') ? 'origin' : names.length === 1 ? names[0] : undefined;
  let remoteKey: string | null = null;
  if (chosen !== undefined) {
    const url = await git(top, ['config', '--get', `remote.${chosen}.url`], 4096);
    if (url.code === 0) remoteKey = normalizeRemote(url.out);
  }

  const shallow = (await git(top, ['rev-parse', '--is-shallow-repository'], 64)).out.trim() === 'true';
  const roots = (await git(top, ['rev-list', '--max-parents=0', 'HEAD'], 64 * 1024)).out.split('\n').map((c) => c.trim()).filter((c) => /^[0-9a-f]{40,64}$/.test(c));
  const smallest = roots.length === 0 ? null : [...roots].sort()[0] ?? null;
  const byRemote = shallow && remoteKey !== null && remoteOnly.has(remoteKey);
  // a shallow clone has not got its root commit: the id from what it has would change when it is unshallowed
  const rootCommit = shallow ? null : smallest;
  const provisional = !byRemote && rootCommit === null;
  const full = repoIdOf(remoteKey, rootCommit ?? '');
  return { repoId: full.slice(0, 16), full, remoteKey, rootCommit, provisional, local: remoteKey === null, label: cleanLabel(basename(top)), top, commonDir };
}
