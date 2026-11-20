/**
 * Link previews (Open Graph and Twitter cards) for every page of the docs site. WhatsApp and LinkedIn read these tags from the page's own HTML, with
 * absolute addresses; the card image is docs/brand/og.png (scripts/og-image.mjs makes it, 1200x630, well under the 300 KB WhatsApp accepts).
 * A page's title is its first heading and its description its frontmatter `description`; without one the site's description is used.
 */
import type { HeadConfig } from 'vitepress';

export const SITE_URL = 'https://gonogo.ulm0.com';
export const OG_IMAGE = `${SITE_URL}/og.png`;
export const OG_ALT = 'gonogo: mission control for coding agents. Two keys, one green light and one red, and the word gonogo in dots.';

/** The address the site serves a page at: no `.md`, no `.html`, a folder's index as the folder. */
export function pageUrl(relativePath: string): string {
  const clean = relativePath.replace(/\.(md|html)$/, '').replace(/(^|\/)index$/, '$1');
  return `${SITE_URL}/${clean}`;
}

export interface OgPage {
  relativePath: string;
  title: string;
  frontmatter: Record<string, unknown>;
}

/** The tags of one page, or none for the 404 page (it is not a page anyone shares). */
export function ogHead(page: OgPage, siteDescription: string): HeadConfig[] {
  if (page.relativePath === '404.md') return [];
  const home = page.relativePath === 'index.md';
  const url = pageUrl(page.relativePath);
  const given = typeof page.frontmatter.description === 'string' ? page.frontmatter.description.trim() : '';
  const description = given === '' ? siteDescription : given;
  const title = home ? 'gonogo: mission control for coding agents' : `${page.title.trim() === '' ? 'gonogo' : page.title.trim()} · gonogo`;
  return [
    ['link', { rel: 'canonical', href: url }],
    ['meta', { name: 'description', content: description }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'gonogo' }],
    ['meta', { property: 'og:title', content: title }],
    ['meta', { property: 'og:description', content: description }],
    ['meta', { property: 'og:url', content: url }],
    ['meta', { property: 'og:image', content: OG_IMAGE }],
    ['meta', { property: 'og:image:type', content: 'image/png' }],
    ['meta', { property: 'og:image:width', content: '1200' }],
    ['meta', { property: 'og:image:height', content: '630' }],
    ['meta', { property: 'og:image:alt', content: OG_ALT }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:title', content: title }],
    ['meta', { name: 'twitter:description', content: description }],
    ['meta', { name: 'twitter:image', content: OG_IMAGE }],
  ];
}
