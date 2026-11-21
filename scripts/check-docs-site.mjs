#!/usr/bin/env node
/**
 * node scripts/check-docs-site.mjs <base-url> [expected-origin]
 *
 * Fetches the home page and one feature page of the docs site and checks what a link preview reads: og:title, og:description,
 * og:url, og:image, twitter:card and the canonical link, and that /og.png answers 200 image/png. The site is the one just
 * deployed, so a miss is retried for about two minutes (the CDN may still hold the old page). The expected origin is where the
 * tags must point (default: the base URL), so a local copy can be checked against the real address.
 * Prints `ok <page>` per page; a failure prints `check-docs-site: FAIL ...` and exits 1.
 */
import { pathToFileURL } from 'node:url';

const PAGES = ['/', '/features/relay'];

const attr = (html, re) => re.exec(html)?.[1] ?? null;
const meta = (html, key) => attr(html, new RegExp(`<meta[^>]+(?:property|name)="${key}"[^>]+content="([^"]*)"`));

/** What is wrong with one page's tags, [] when nothing. `path` is the page's path, `origin` the expected origin without a slash. */
export function pageProblems(html, path, origin) {
  const problems = [];
  const url = origin + (path === '/' ? '/' : path);
  const want = { 'og:url': url, 'og:image': `${origin}/og.png`, 'twitter:card': 'summary_large_image' };
  for (const key of ['og:title', 'og:description']) if (!meta(html, key)) problems.push(`${key} is missing or empty`);
  for (const [key, value] of Object.entries(want)) if (meta(html, key) !== value) problems.push(`${key} is ${JSON.stringify(meta(html, key))}, expected ${JSON.stringify(value)}`);
  const canonical = attr(html, /<link[^>]+rel="canonical"[^>]+href="([^"]*)"/);
  if (canonical !== url) problems.push(`canonical is ${JSON.stringify(canonical)}, expected ${JSON.stringify(url)}`);
  return problems;
}

async function once(base, origin) {
  const problems = [];
  for (const path of PAGES) {
    const res = await fetch(new URL(path, base));
    if (res.status !== 200) problems.push(`${path} answered ${res.status}`);
    else problems.push(...pageProblems(await res.text(), path, origin).map((p) => `${path}: ${p}`));
  }
  const png = await fetch(new URL('/og.png', base));
  if (png.status !== 200 || !(png.headers.get('content-type') ?? '').startsWith('image/png')) problems.push(`/og.png answered ${png.status} ${png.headers.get('content-type')}`);
  return problems;
}

async function main() {
  const [base, expected] = process.argv.slice(2);
  if (!base) throw new Error('usage: check-docs-site.mjs <base-url> [expected-origin]');
  const origin = new URL(expected ?? base).origin;
  let problems = [];
  for (let i = 0; i < 7; i++) {
    problems = await once(base, origin).catch((e) => [`request failed: ${e.message}`]);
    if (problems.length === 0) break;
    if (i < 6) await new Promise((r) => setTimeout(r, 20_000));
  }
  if (problems.length > 0) {
    console.error(`check-docs-site: FAIL\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  for (const path of PAGES) console.log(`ok ${path}`);
  console.log('ok /og.png');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
