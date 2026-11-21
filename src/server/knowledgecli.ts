/**
 * `gonogo knowledge list | export | import | alias | move | keep` (docs/features/knowledge.md): what the Director does about the Knowledge store from the
 * machine gonogo runs on. CLI only: none of it has a route, so none of it is reachable from the page or with an API key, and it asks for nothing
 * more than the right to write the store's folder (0700, the Director's own). It changes the store under the same lock a running gonogo uses.
 *
 * `export` and `import` move the accepted claims as a bundle (knowledgeio.ts); `alias`, `move` and `keep` are the three answers to "this looks like
 * another repository": the same knowledge for a fork, the claims carried to the new id after a rewritten root or a moved remote, or two repositories
 * that are kept apart. Nothing here reads or writes a repository.
 */
import { lstat, writeFile } from 'node:fs/promises';
import { parseLegLines } from './anchorgrammar.js';
import { nullLogger } from './constants.js';
import { applyImport, exportBundle, planImport, readBundleFile } from './knowledgeio.js';
import { createKnowledgeStore } from './knowledgestore.js';
import type { KnowledgeStore } from './knowledgestore.js';
import { identify } from './repoid.js';
import { createSafeGit } from './safegit.js';

export const KNOWLEDGE_USAGE = `Usage: gonogo knowledge list [--home <dir>]
       gonogo knowledge export [--repo <id|path>] [--out <file>] [--multivac] [--home <dir>]
       gonogo knowledge import <file> [--apply] [--replace] [--home <dir>]
       gonogo knowledge alias <fork-id> <canonical-id> [--home <dir>]
       gonogo knowledge move <from-id> <to-id> [--home <dir>]
       gonogo knowledge keep <id> <id> [--home <dir>]

  list      the repositories of the store, how many claims each holds, and the ones that look like another
  export    the accepted claims as one JSON bundle (stdout, or --out: a new file, mode 0600). No checkout path, binding or proposal is in it.
            --multivac adds, per repository, the claims as a multivac invariants.md ("literal" legs rewritten as escaped regexes)
  import    reads a bundle and says what it would add, skip and reject; --apply writes it (a claim whose id is there is skipped, or replaced with --replace).
            Nothing is bound: the first checkout seen for the repository asks for it
  alias     a fork reads and writes the knowledge of another repository
  move      after a rewritten root commit or a moved remote: the claims of <from-id> go to <to-id> (one rename), and <from-id> becomes an alias of it
  keep      two repositories that look alike are kept apart

None of this is reachable from the page or with an API key. A running gonogo may stay up.
`;

export interface KnowledgeIo {
  out(text: string): void;
  err(text: string): void;
}
export interface KnowledgeContext {
  /** The store's folder: GONOGO_KNOWLEDGE_DIR, else <home>/knowledge. */
  dir: string;
  io: KnowledgeIo;
  now(): number;
  /** For tests: the store to use instead of the one in `dir`. */
  store?: KnowledgeStore;
}

const ID = /^[0-9a-f]{16}$/;

function flags(args: string[], allowed: Record<string, 'bool' | 'value'>): { rest: string[]; got: Record<string, string | true> } | string {
  const got: Record<string, string | true> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    const kind = allowed[arg];
    if (kind === 'bool') got[arg] = true;
    else if (kind === 'value') {
      const value = args[i + 1];
      if (value === undefined || value === '') return `${arg} needs a value`;
      got[arg] = value;
      i += 1;
    } else if (arg.startsWith('-')) return `unexpected ${arg}`;
    else rest.push(arg);
  }
  return { rest, got };
}

/** Runs one command and returns the exit code. Never throws: what went wrong is on `io.err`. */
export async function runKnowledgeCli(args: string[], ctx: KnowledgeContext): Promise<number> {
  const { io } = ctx;
  const fail = (message: string): number => {
    io.err(`gonogo knowledge: ${message}\n`);
    return 1;
  };
  const [command = '', ...rest] = args;
  if (!['list', 'export', 'import', 'alias', 'move', 'keep'].includes(command)) {
    io.err(KNOWLEDGE_USAGE);
    return command === '' || command === 'help' || command === '--help' ? 0 : 1;
  }
  const store = ctx.store ?? createKnowledgeStore({ dir: ctx.dir, now: ctx.now, parseLegs: parseLegLines, log: nullLogger });
  try {
    if (command === 'list') {
      if (rest.length > 0) return fail('list takes no arguments');
      const repos = await store.repos();
      const ids = Object.keys(repos).sort();
      if (ids.length === 0) io.out('no repositories in the store\n');
      for (const id of ids) {
        const repo = repos[id];
        if (repo === undefined) continue;
        const where = repo.remoteKey === null ? 'no remote' : repo.remoteKey;
        if (repo.alias !== undefined) {
          io.out(`${id}  ${repo.label}  (${where})  alias of ${repo.alias}\n`);
          continue;
        }
        const read = await store.claims(id);
        const note = read.damaged === null ? `${read.claims.length} claims` : `claims.md damaged (${read.damaged})`;
        io.out(`${id}  ${repo.label}  (${where})  ${note}  ${repo.roots.filter((r) => r.bound).length} bound\n`);
        for (const c of await store.candidates(id)) io.out(`    looks like ${c.repoId} ${c.label}: ${c.why}\n`);
      }
      return 0;
    }

    if (command === 'export') {
      const parsed = flags(rest, { '--repo': 'value', '--out': 'value', '--multivac': 'bool' });
      if (typeof parsed === 'string' || parsed.rest.length > 0) return fail(typeof parsed === 'string' ? `export: ${parsed}` : `export: unexpected ${parsed.rest[0]}`);
      let only: string | undefined;
      const repoArg = parsed.got['--repo'];
      if (typeof repoArg === 'string') {
        if (ID.test(repoArg)) only = repoArg;
        else {
          const who = await identify(createSafeGit(), repoArg);
          if (who === null) return fail(`export: ${repoArg} is not a repository id (16 hexadecimal characters) or a folder in a git repository`);
          only = who.repoId;
        }
      }
      const made = await exportBundle(store, ctx.dir, { ...(only === undefined ? {} : { only }), multivac: parsed.got['--multivac'] === true, now: ctx.now });
      for (const note of made.notes) io.err(`${note}\n`);
      const text = `${JSON.stringify(made.bundle, null, 2)}\n`;
      const out = parsed.got['--out'];
      if (typeof out !== 'string') {
        io.out(text);
        return 0;
      }
      // a new file: `wx` fails on anything that is there, a link included, so nothing is written through one
      if ((await lstat(out).catch(() => null)) !== null) return fail(`export: ${out} exists: gonogo does not replace a file`);
      await writeFile(out, text, { flag: 'wx', mode: 0o600 });
      io.err(`wrote ${made.bundle.repos.length} repositories to ${out} (mode 0600)\n`);
      return 0;
    }

    if (command === 'import') {
      const parsed = flags(rest, { '--apply': 'bool', '--replace': 'bool' });
      if (typeof parsed === 'string' || parsed.rest.length !== 1) return fail(typeof parsed === 'string' ? `import: ${parsed}` : 'import needs one file');
      const file = parsed.rest[0] as string;
      const replace = parsed.got['--replace'] === true;
      const apply = parsed.got['--apply'] === true;
      const plans = await planImport(store, await readBundleFile(file), file, { replace });
      let wrong = 0;
      for (const p of plans) {
        if (p.refused !== undefined) {
          wrong += 1;
          io.out(`${p.repoId}  ${p.label}: REFUSED, ${p.refused}\n`);
          continue;
        }
        io.out(`${p.repoId}  ${p.label}: ${apply ? '' : 'would '}add ${p.add.length}, ${replace ? 'replace' : 'skip'} ${(replace ? p.replace : p.skip).length}, reject ${p.rejected.length}, ritual ${p.ritual}\n`);
        if (p.add.length > 0) io.out(`    add: ${p.add.join(', ')}\n`);
        if (p.replace.length > 0) io.out(`    replace: ${p.replace.join(', ')}\n`);
        if (p.skip.length > 0) io.out(`    skip (the id is there; --replace takes the bundle's): ${p.skip.join(', ')}\n`);
        for (const r of p.rejected.slice(0, 20)) io.out(`    rejected ${r.id}: ${r.why}\n`);
      }
      if (!apply) {
        io.out(`dry run: nothing was written. Add --apply to write ${plans.length - wrong} of ${plans.length} repositories.\n`);
        return 0;
      }
      const done = await applyImport(store, plans, { replace });
      io.out(`imported into ${done.length} repositories; no checkout was bound (the first checkout seen asks for it).\n`);
      return 0;
    }

    const parsed = flags(rest, {});
    if (typeof parsed === 'string') return fail(`${command}: ${parsed}`);
    const [a, b] = parsed.rest;
    if (parsed.rest.length !== 2 || a === undefined || b === undefined || !ID.test(a) || !ID.test(b)) return fail(`${command} needs two repository ids (16 hexadecimal characters each: gonogo knowledge list shows them)`);
    if (command === 'alias') {
      await store.alias(a, b);
      io.out(`${a} now reads and writes the knowledge of ${b}. What ${a} held stays where it is, not read.\n`);
    } else if (command === 'move') {
      await store.move(b, a);
      io.out(`the claims of ${a} are now ${b}'s, and ${a} is an alias of it. Its checkouts came along unbound: bind them in the page.\n`);
    } else {
      await store.keepSeparate(a, b);
      io.out(`${a} and ${b} are kept apart: neither is offered as the other's twin again.\n`);
    }
    return 0;
  } catch (error) {
    return fail(`${command}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
