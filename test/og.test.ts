/** Link previews: the tags every page of the docs site carries, the card image, and the description of the top pages. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { OG_IMAGE, ogHead, pageUrl, SITE_URL } from '../.vitepress/og.js';

const SITE = 'The site description.';
const tags = (head: ReturnType<typeof ogHead>): Record<string, string> =>
  Object.fromEntries(head.flatMap(([tag, attrs]) => (tag === 'meta' ? [[String(attrs.property ?? attrs.name), String(attrs.content)]] : tag === 'link' ? [[`link:${attrs.rel}`, String(attrs.href)]] : [])));

describe('the tags of a page', () => {
  it('a feature page: its title and description, its own address, the card as an absolute address', () => {
    const t = tags(ogHead({ relativePath: 'features/payload.md', title: 'Payload: MCP servers and skills per agent', frontmatter: { description: 'Servers and skills for one agent.' } }, SITE));
    expect(t).toMatchObject({
      'og:type': 'website',
      'og:site_name': 'gonogo',
      'og:title': 'Payload: MCP servers and skills per agent · gonogo',
      'og:description': 'Servers and skills for one agent.',
      'og:url': 'https://gonogo.ulm0.com/features/payload',
      'link:canonical': 'https://gonogo.ulm0.com/features/payload',
      'og:image': 'https://gonogo.ulm0.com/og.png',
      'og:image:type': 'image/png',
      'og:image:width': '1200',
      'og:image:height': '630',
      'twitter:card': 'summary_large_image',
      'twitter:image': 'https://gonogo.ulm0.com/og.png',
    });
    expect(t['og:image:alt']).toContain('gonogo');
  });

  it('the home page: the site name as the title, the root as its address; no description falls back to the site\'s', () => {
    const t = tags(ogHead({ relativePath: 'index.md', title: 'gonogo', frontmatter: {} }, SITE));
    expect(t).toMatchObject({ 'og:title': 'gonogo: mission control for coding agents', 'og:description': SITE, 'og:url': `${SITE_URL}/`, 'link:canonical': `${SITE_URL}/` });
    expect(tags(ogHead({ relativePath: 'guide/getting-started.md', title: '', frontmatter: { description: '  ' } }, SITE))).toMatchObject({ 'og:title': 'gonogo · gonogo', 'og:description': SITE });
  });

  it('every address is absolute and clean: no .md, no .html, a folder index is the folder', () => {
    expect(pageUrl('features/payload.md')).toBe(`${SITE_URL}/features/payload`);
    expect(pageUrl('expose/index.md')).toBe(`${SITE_URL}/expose/`);
    expect(pageUrl('index.md')).toBe(`${SITE_URL}/`);
    expect(pageUrl('guide/docker.html')).toBe(`${SITE_URL}/guide/docker`);
    expect(OG_IMAGE.startsWith('https://')).toBe(true);
  });

  it('the 404 page carries none', () => {
    expect(ogHead({ relativePath: '404.md', title: '404', frontmatter: {} }, SITE)).toEqual([]);
  });

  it('the site config puts them on every page, through transformHead', () => {
    const config = readFileSync(new URL('../.vitepress/config.mts', import.meta.url), 'utf8');
    expect(config).toMatch(/transformHead:\s*\(\{ pageData \}\)\s*=>\s*ogHead\(pageData, SITE_DESCRIPTION\)/);
  });
});

describe('the top pages say something specific', () => {
  const top = ['index.md', 'guide/getting-started.md', 'guide/docker.md', 'guide/the-room.md', 'features/rooms.md', 'features/login.md', 'features/update.md'];
  it.each(top)('%s has its own description of a sentence or two', (page) => {
    const front = /^---\n([\s\S]*?)\n---/.exec(readFileSync(new URL(`../docs/${page}`, import.meta.url), 'utf8'))?.[1] ?? '';
    const description = /^description: "(.*)"$/m.exec(front)?.[1] ?? '';
    expect(description.length).toBeGreaterThan(60);
    // a link preview shows about 150 characters
    expect(description.length).toBeLessThanOrEqual(220);
  });
});

describe('the card image', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gng-og-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const committed = new URL('../docs/brand/og.png', import.meta.url).pathname;

  it('is a 1200 x 630 PNG under the 300 KB WhatsApp accepts', () => {
    const bytes = readFileSync(committed);
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([1200, 630]);
    expect(statSync(committed).size).toBeLessThan(300 * 1024);
  });

  it('is what scripts/og-image.mjs makes: the same bytes again', () => {
    const out = join(dir, 'og.png');
    execFileSync(process.execPath, ['scripts/og-image.mjs', '--out', out], { cwd: new URL('..', import.meta.url).pathname });
    expect(readFileSync(out).equals(readFileSync(committed))).toBe(true);
  });
});
