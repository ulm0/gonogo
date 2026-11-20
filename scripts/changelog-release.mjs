// pnpm changelog:release <version> <date> "<intro>": folds changes/*.md (one file per change, bullets for the next release) and any
// bullets left under "## Unreleased" into a new "## <version> (<date>)" section of CHANGELOG.md, then deletes the fragments.
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The new CHANGELOG text: Unreleased emptied, the section for `version` right under it. Pure, so a test can run it. */
export function fold(changelog, fragments, version, date, intro) {
  const at = changelog.indexOf('\n## Unreleased\n');
  if (at < 0) throw new Error('CHANGELOG.md has no "## Unreleased" heading');
  const bodyStart = at + '\n## Unreleased\n'.length;
  const next = changelog.indexOf('\n## ', bodyStart);
  const end = next < 0 ? changelog.length : next + 1;
  const left = changelog.slice(bodyStart, end).trim();
  const bullets = [left, ...fragments.map((f) => f.trim())].filter(Boolean).join('\n');
  if (bullets === '') throw new Error('nothing to release: no fragment in changes/ and nothing under "## Unreleased"');
  const section = `## ${version} (${date})\n\n${intro.trim()}\n\n${bullets}\n\n`;
  return `${changelog.slice(0, bodyStart)}\n${section}${changelog.slice(end)}`;
}

/** A release version as release.yml reads it: x.y.z, with an optional pre-release (1.0.0-rc.1). */
export const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** The fragment files, in name order; README.md is the explanation, not a change. Anything else that is not a .md file (a folder made from a branch name with a slash) is an error, not skipped. */
export function fragmentFiles(dir) {
  const odd = readdirSync(dir, { withFileTypes: true }).filter((e) => e.name !== 'README.md' && !(e.isFile() && e.name.endsWith('.md')));
  if (odd.length > 0) throw new Error(`${dir}/ holds ${odd.map((e) => e.name).join(', ')}: a fragment is one .md file, with a - for each / of the branch name`);
  return readdirSync(dir).filter((f) => f !== 'README.md').sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [version, date, intro] = process.argv.slice(2);
  if (!VERSION.test(version ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !intro) {
    console.error('usage: pnpm changelog:release <x.y.z[-pre]> <yyyy-mm-dd> "<intro>"');
    process.exit(2);
  }
  const files = fragmentFiles('changes');
  const out = fold(readFileSync('CHANGELOG.md', 'utf8'), files.map((f) => readFileSync(`changes/${f}`, 'utf8')), version, date, intro);
  writeFileSync('CHANGELOG.md', out);
  for (const f of files) rmSync(`changes/${f}`);
  console.log(`CHANGELOG.md: ${version} made from ${files.length} fragment(s).`);
}
