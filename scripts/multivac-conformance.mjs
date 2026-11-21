#!/usr/bin/env node
/**
 * node scripts/multivac-conformance.mjs [--keep] [--multivac <bin>]
 *
 * Does the Knowledge store's export read as multivac's own file (docs/features/knowledge.md, `gonogo knowledge export --multivac`)? The grammar is ported from
 * multivac (MIT, the same author) and the export turns a gonogo-only `"literal"` leg into an escaped POSIX regex, so the two must agree. This installs multivac at an EXACT
 * pinned version in a scratch folder (npm, --ignore-scripts, no network afterwards), and then:
 *
 *   1. makes a fixture store (claims with every mode, literals full of regex metacharacters, a glob exclusion, a dotfile);
 *   2. runs the BUILT gonogo (`node bin/gonogo.js knowledge export --multivac`, `pnpm build:server` first) on it;
 *   3. writes the converted claims as .multivac/invariants.md in a temp git repository that holds the files the anchors look at;
 *   4. runs `multivac verify --check` (read-only, offline, headless) and asserts that multivac parsed EVERY anchor (no "parse" line, no "anchor parse errors"), that
 *      every claim is \`ok\` (so each escaped literal matched exactly what it said and nothing else), and that the exit code is 0;
 *   5. proves the check has teeth: a line multivac must refuse (\\d) added to a copy makes it print a parse error and exit 1.
 *
 * Multivac runs headless: it is a CLI that reads files and git and needs no terminal, no network and no login (verified: version 0.9.0). The scratch folder, a throwaway HOME and
 * an empty git config keep it away from the person's own settings (\`multivac init\` projects git hooks and a door: it must never touch a real home).
 * The exit code is 1 when anything failed. \`--multivac <bin>\` uses a multivac you already have instead of installing one.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** The multivac this is checked against. A new version is a deliberate change here, after the conformance has been looked at. */
export const MULTIVAC_VERSION = '0.9.0';
const REPO_ID = '0123456789abcdef';

/** What `multivac verify` printed, as numbers: parse errors (the `parse` lines and the count), the states by count, and the exit code's meaning. */
export function readVerify(text) {
  const parseLines = text.split('\n').filter((l) => /^\s*parse\s/.test(l));
  const errors = /(\d+) anchor parse errors?/.exec(text);
  const counts = {};
  for (const m of text.matchAll(/^\s{2}(ok|broken|moved|vacuous|pending|unevaluated)\s+(\d+)\s*$/gm)) counts[m[1]] = Number(m[2]);
  const claims = /^(\d+) claims? ·/m.exec(text);
  return { parseLines, parseErrors: errors === null ? 0 : Number(errors[1]), counts, claims: claims === null ? null : Number(claims[1]) };
}

/** The fixture: [id, statement, anchor lines] and the tracked files the anchors look at. Every literal is something a regex would read wrongly if it were not escaped. */
export const FIXTURE = {
  claims: [
    ['K-1', 'The version constant is exported once.', ['brain:src/*.ts /export const VERSION/ unique', 'brain:src/*.ts "export const VERSION = 1;" present']],
    ['K-2', 'Dots, stars and brackets in a literal are text, not operators.', ['brain:src/dots.txt "a.b" count=1', 'brain:src/dots.txt "x*y" count=1', 'brain:src/dots.txt "[bracket]" present', 'brain:src/dots.txt "{brace}" present']],
    ['K-3', 'Parentheses, pipes, carets, dollars and slashes are text.', ['brain:src/meta.txt "(paren)" present', 'brain:src/meta.txt "a|b" present', 'brain:src/meta.txt "^caret$" present', 'brain:src/meta.txt "path/to/file" present', 'brain:src/meta.txt "plus+question?" present']],
    ['K-4', 'A backslash and a quote in a literal are text.', ['brain:src/meta.txt "back\\\\slash" present', 'brain:src/meta.txt "say \\"hi\\"" present']],
    ['K-5', 'A forbidden word is absent from the docs, but the changelog may keep it.', ['brain:docs/**/*.md !docs/changelog.md "FORBIDDEN" absent']],
    ['K-6', 'Every doc has a title; none has a draft marker; a dotfile is read.', ['brain:docs/*.md /^# / each', 'brain:docs/*.md /DRAFT/ each!', 'brain:.github/*.yml /uses: / count=2']],
    ['K-7', 'Regexes with classes and the i flag read the same.', ['brain:src/classes.txt /PIN[[:digit:]]{2}/ present', 'brain:src/classes.txt /(^|[^[:alnum:]_])token([^[:alnum:]_]|$)/i present', 'brain:src/classes.txt /(foo|bar)+/ present']],
  ],
  files: {
    'src/a.ts': 'export const VERSION = 1;\nimport x from "y";\n',
    'src/dots.txt': 'one a.b here\nand aXb here\nx*y and xxy\n[bracket] and {brace}\n',
    'src/meta.txt': 'a (paren) and a|b\n^caret$ and path/to/file\nplus+question? and back\\slash\nsay "hi"\n',
    'src/classes.txt': 'PIN42 and a Token here\nbarfoo\n',
    'docs/readme.md': '# Readme\nplain text\n',
    'docs/guide/guide.md': '# Guide\nnothing forbidden... almost\n',
    'docs/changelog.md': '# Changelog\nthe FORBIDDEN word, kept for history\n',
    '.github/ci.yml': 'steps:\n  - uses: a\n  - uses: b\n',
  },
};

const claimsFile = () => {
  const rows = ['# Claims', '', '| ID | statement | authority | state | date | source |', '| --- | --- | --- | --- | --- | --- |'];
  for (const [id, statement, legs] of FIXTURE.claims) {
    rows.push(`| ${id} | ${statement} | director | active | 2026-11-21 | store |`);
    for (const leg of legs) rows.push(`<!-- @anchor ${id} ${leg} -->`);
  }
  return `${rows.join('\n')}\n`;
};

function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

async function main() {
  const argv = process.argv.slice(2);
  const keep = argv.includes('--keep');
  const given = argv.includes('--multivac') ? argv[argv.indexOf('--multivac') + 1] : null;
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
  };
  const cli = join(ROOT, 'bin', 'gonogo.js');
  if (!existsSync(join(ROOT, 'dist', 'server', 'cli.js'))) {
    console.error('dist/server is not built: run `pnpm build:server` first');
    process.exit(1);
  }

  const scratch = mkdtempSync(join(tmpdir(), 'gonogo-multivac-conformance-'));
  // a throwaway HOME and no git config of the person's (multivac init writes hooks and doors)
  const env = { PATH: process.env.PATH, HOME: join(scratch, 'home'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C', npm_config_update_notifier: 'false' };
  mkdirSync(env.HOME, { recursive: true });
  try {
    /* ---- install multivac at an exact version, or use the one given ---- */
    let bin = given;
    if (bin === null) {
      const tool = join(scratch, 'tool');
      mkdirSync(tool, { recursive: true });
      writeFileSync(join(tool, 'package.json'), '{"name":"scratch","private":true}\n');
      const install = run('npm', ['install', `multivac@${MULTIVAC_VERSION}`, '--save-exact', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', tool], { env, cwd: tool });
      bin = join(tool, 'node_modules', '.bin', 'multivac');
      check(`multivac ${MULTIVAC_VERSION} installs from npm (exact, no scripts)`, install.code === 0 && existsSync(bin), install.code === 0 ? bin : install.out.slice(-300));
    }
    const version = run(bin, ['--version'], { env }).stdout.trim();
    check(`the multivac that runs is ${MULTIVAC_VERSION}`, given !== null || version === MULTIVAC_VERSION, version);

    /* ---- the fixture store, exported by the built gonogo ---- */
    const store = join(scratch, 'store');
    mkdirSync(join(store, REPO_ID), { recursive: true });
    writeFileSync(join(store, 'index.json'), JSON.stringify({ version: 1, repos: { [REPO_ID]: { full: REPO_ID, label: 'fixture', remoteKey: 'example.com/fixture', rootCommit: 'a'.repeat(40), roots: [], nextClaim: FIXTURE.claims.length + 1 } }, remoteOnly: [] }));
    writeFileSync(join(store, REPO_ID, 'claims.md'), claimsFile(), { mode: 0o600 });
    const bundleFile = join(scratch, 'bundle.json');
    const exported = run(process.execPath, [cli, 'knowledge', 'export', '--multivac', '--out', bundleFile], { env: { ...env, GONOGO_KNOWLEDGE_DIR: store, GONOGO_HOME: join(scratch, 'gonogo-home') } });
    check('gonogo knowledge export --multivac runs on the fixture store', exported.code === 0 && existsSync(bundleFile), exported.out.trim().split('\n').at(-1) ?? '');
    const bundle = existsSync(bundleFile) ? JSON.parse(readFileSync(bundleFile, 'utf8')) : { repos: [] };
    const multivacText = bundle.repos?.[0]?.multivac ?? '';
    const literalLegs = FIXTURE.claims.flatMap(([, , legs]) => legs).filter((l) => /\s"/.test(l)).length;
    check('every literal leg was rewritten to a regex (none is left as a literal)', multivacText !== '' && !/@anchor \S+ \S+ "/.test(multivacText) && (multivacText.match(/@anchor/g) ?? []).length === FIXTURE.claims.flatMap(([, , legs]) => legs).length, `${literalLegs} literals, ${(multivacText.match(/@anchor/g) ?? []).length} anchor lines`);

    /* ---- a brain with the files, and multivac verify --check ---- */
    const brain = join(scratch, 'brain');
    mkdirSync(brain, { recursive: true });
    const git = (...args) => execFileSync('git', ['-C', brain, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { env, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    const init = run(bin, ['init', '--quiet'], { env, cwd: brain });
    check('multivac init scaffolds the brain headless', init.code === 0 && existsSync(join(brain, '.multivac', 'invariants.md')), init.code === 0 ? '' : init.out.slice(-300));
    for (const [name, text] of Object.entries(FIXTURE.files)) {
      mkdirSync(dirname(join(brain, name)), { recursive: true });
      writeFileSync(join(brain, name), text);
    }
    writeFileSync(join(brain, '.multivac', 'invariants.md'), `# Invariants\n\n${multivacText.slice(multivacText.indexOf('| ID'))}`);
    git('add', '-A');
    git('commit', '-q', '-m', 'fixture');
    const verify = run(bin, ['verify', '--check'], { env, cwd: brain });
    const seen = readVerify(verify.out);
    console.log(verify.out.split('\n').map((l) => `      | ${l}`).join('\n'));
    check('multivac parses every converted anchor', seen.parseLines.length === 0 && seen.parseErrors === 0, seen.parseLines.length === 0 ? `${seen.claims} claims, no parse error` : seen.parseLines.join(' / '));
    check('every claim is ok in multivac (each escaped literal matches what it says and nothing else)', seen.counts.ok === FIXTURE.claims.length && !('broken' in seen.counts), JSON.stringify(seen.counts));
    check('multivac verify --check exits 0 and writes nothing', verify.code === 0 && git('status', '--porcelain').trim() === '', `exit ${verify.code}`);

    /* ---- the check has teeth ---- */
    const file = join(brain, '.multivac', 'invariants.md');
    const good = readFileSync(file, 'utf8');
    appendFileSync(file, '<!-- @anchor K-1 brain:docs/*.md /\\d+/ -->\n');
    const bad = run(bin, ['verify', '--check'], { env, cwd: brain });
    writeFileSync(file, good);
    const badSeen = readVerify(bad.out);
    check('a line multivac refuses (\\d) is caught: a parse error and exit 1', bad.code === 1 && badSeen.parseLines.length === 1 && badSeen.parseErrors === 1, `exit ${bad.code}, ${badSeen.parseLines[0]?.trim() ?? 'no parse line'}`);
    // and an unescaped dot would have matched the wrong line: the same fixture with the literal written as a bare regex breaks K-2's count
    writeFileSync(file, good.replace('/a\\.b/', '/a.b/'));
    const loose = readVerify(run(bin, ['verify', '--check'], { env, cwd: brain }).out);
    writeFileSync(file, good);
    check('and an UNescaped dot would have counted the wrong line (the escape is what keeps the literal exact)', (loose.counts.broken ?? 0) >= 1, JSON.stringify(loose.counts));
  } finally {
    if (keep) console.log(`kept: ${scratch}`);
    else rmSync(scratch, { recursive: true, force: true });
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = results.map((r) => `| ${r.ok ? 'PASS' : 'FAIL'} | ${r.name} | ${String(r.detail ?? '').replace(/\|/g, '/')} |`).join('\n');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## gonogo export read by multivac ${MULTIVAC_VERSION}\n\n| | check | detail |\n|---|---|---|\n${rows}\n`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length === 0 ? `\nall ${results.length} checks passed` : `\n${failed.length} of ${results.length} checks FAILED`);
  process.exit(failed.length === 0 ? 0 : 1);
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) await main();
