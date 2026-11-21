import { describe, expect, it } from 'vitest';
import { pageProblems } from '../scripts/check-docs-site.mjs';

const page = (o: string, path: string) =>
  `<link rel="canonical" href="${o}${path}"><meta property="og:title" content="t"><meta property="og:description" content="d"><meta property="og:url" content="${o}${path}"><meta property="og:image" content="${o}/og.png"><meta name="twitter:card" content="summary_large_image">`;

describe('check-docs-site: the tags a link preview reads', () => {
  it('a complete page has no problem', () => {
    expect(pageProblems(page('https://x.test', '/features/relay'), '/features/relay', 'https://x.test')).toEqual([]);
    expect(pageProblems(page('https://x.test', '/'), '/', 'https://x.test')).toEqual([]);
  });

  it('names each missing or wrong tag', () => {
    const html = page('https://x.test', '/').replace('og:title', 'og:titel').replace('summary_large_image', 'summary');
    const problems = pageProblems(html, '/', 'https://x.test') as string[];
    expect(problems.some((p) => p.startsWith('og:title'))).toBe(true);
    expect(problems.some((p) => p.startsWith('twitter:card'))).toBe(true);
    expect(pageProblems(page('https://x.test', '/a'), '/', 'https://x.test')).not.toEqual([]);
  });
});
