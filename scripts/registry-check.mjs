#!/usr/bin/env node
/**
 * pnpm registry:check: checks every entry of src/shared/registry.ts against its real repository and package, with the network. Run it by hand
 * before changing an entry or its `checked` date; no test and no CI job runs it (a registry that fails a build because a third party moved is worse
 * than a stale one). It reads only public pages: GitHub's API (set GITHUB_TOKEN for a higher rate limit; it is sent to api.github.com only), the npm
 * registry and PyPI. It installs and runs nothing.
 *
 * Fails (exit 1) for: a repository that is gone or archived, a package or version that does not exist, a deprecated or yanked one, a skill folder
 * without a SKILL.md. Warns for: a pinned version that is not the latest, a licence that differs from the one the entry states, a repository
 * not pushed to in a year, and a remote server it cannot check.
 */
import { REGISTRY } from '../src/shared/registry.ts';

const token = process.env.GITHUB_TOKEN;
const problems = [];
const warnings = [];
const get = async (url, github = false) => {
  const res = await fetch(url, { headers: { 'user-agent': 'gonogo-registry-check', ...(github && token ? { authorization: `Bearer ${token}` } : {}) } });
  return { status: res.status, json: res.ok ? await res.json().catch(() => null) : null };
};

for (const e of REGISTRY) {
  const tag = `${e.kind} ${e.id}`;
  const fail = (why) => problems.push(`${tag}: ${why}`);
  const warn = (why) => warnings.push(`${tag}: ${why}`);
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)(?:\/tree\/[^/]+\/(.+))?$/.exec(e.source);
  if (m === null) {
    fail(`the source is not a GitHub repository address: ${e.source}`);
    continue;
  }
  const repo = await get(`https://api.github.com/repos/${m[1]}`, true);
  if (repo.json === null) fail(`the repository ${m[1]} answered ${repo.status}`);
  else {
    if (repo.json.archived) fail(`${m[1]} is archived`);
    const spdx = repo.json.license?.spdx_id ?? 'none';
    if (!e.licence.startsWith(spdx) && spdx !== 'NOASSERTION') warn(`the repository says ${spdx}, the entry says ${e.licence}`);
    if (Date.now() - Date.parse(repo.json.pushed_at) > 365 * 24 * 3600_000) warn(`${m[1]} was last pushed ${repo.json.pushed_at.slice(0, 10)}`);
  }
  if (e.kind === 'skill') {
    const file = await get(`https://api.github.com/repos/${m[1]}/contents/${e.folder}/SKILL.md`, true);
    if (file.status !== 200) fail(`${e.folder}/SKILL.md answered ${file.status}`);
    continue;
  }
  const { command, args = [], url } = e.server;
  if (url !== undefined) {
    warn(`a remote server (${new URL(url).origin}): not checked, it needs a key`);
    continue;
  }
  if (command === 'npx') {
    const spec = args.find((a) => !a.startsWith('-')) ?? '';
    const at = spec.lastIndexOf('@');
    const name = at > 0 ? spec.slice(0, at) : spec;
    const version = at > 0 ? spec.slice(at + 1) : '';
    if (version === '' || version === 'latest') fail(`${spec} is not pinned to a version`);
    const pkg = await get(`https://registry.npmjs.org/${name.replace('/', '%2f')}`);
    if (pkg.json === null) fail(`npm package ${name} answered ${pkg.status}`);
    else {
      const v = pkg.json.versions?.[version];
      if (v === undefined) fail(`${name}@${version} is not on npm`);
      else if (v.deprecated) fail(`${name}@${version} is deprecated: ${String(v.deprecated).slice(0, 80)}`);
      const latest = pkg.json['dist-tags']?.latest;
      if (latest !== undefined && latest !== version) warn(`${name} is pinned to ${version}, the latest is ${latest}`);
    }
  } else if (command === 'uvx') {
    const [name, version] = (args[0] ?? '').split('==');
    const pkg = await get(`https://pypi.org/pypi/${name}/json`);
    if (pkg.json === null) fail(`PyPI package ${name} answered ${pkg.status}`);
    else {
      const files = pkg.json.releases?.[version ?? ''];
      if (version === undefined) fail(`${name} is not pinned (name==version)`);
      else if (files === undefined) fail(`${name}==${version} is not on PyPI`);
      else if (files.some((f) => f.yanked)) fail(`${name}==${version} was yanked`);
      if (pkg.json.info?.version !== version) warn(`${name} is pinned to ${version}, the latest is ${pkg.json.info?.version}`);
    }
  } else fail(`the command ${command} is not one the check knows`);
}

for (const w of warnings) console.log(`warn  ${w}`);
for (const p of problems) console.log(`FAIL  ${p}`);
console.log(`${REGISTRY.length} entries: ${problems.length} failed, ${warnings.length} warnings`);
process.exit(problems.length === 0 ? 0 : 1);
