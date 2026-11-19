// The shared stylesheet embeds its fonts as data: URIs, so every page that links it must allow data: in font-src, or it falls back to system fonts.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAuthHttp } from '../src/server/authhttp.js';
import { authPageHeaders } from '../src/server/authpage.js';
import { roomsPageHeaders } from '../src/server/roomspage.js';

const fontSrc = (csp: string | undefined): string[] => (/font-src ([^;]*)/.exec(csp ?? '')?.[1] ?? '').split(/\s+/).filter(Boolean);
const proxy = createAuthHttp({ auth: {} as never, legacyToken: () => null, hostOk: () => true, stylesheet: null, local: new WeakSet<IncomingMessage>() });

describe('the pages that link the shared stylesheet allow its data: fonts', () => {
  it('the login and setup pages, the room list, and the pages of a room', () => {
    expect(fontSrc(authPageHeaders()['Content-Security-Policy'])).toEqual(expect.arrayContaining(["'self'", 'data:']));
    expect(fontSrc(authPageHeaders(true)['Content-Security-Policy'])).toEqual(expect.arrayContaining(["'self'", 'data:']));
    expect(fontSrc(roomsPageHeaders()['Content-Security-Policy'])).toEqual(expect.arrayContaining(["'self'", 'data:']));
    expect(fontSrc(proxy.pageHeaders()['content-security-policy'])).toEqual(expect.arrayContaining(["'self'", 'data:']));
  });

  it('and, when the client is built, every font the stylesheet embeds is one of them', () => {
    const assets = join(new URL('../dist/client/assets', import.meta.url).pathname);
    if (!existsSync(assets)) return;
    const css = readdirSync(assets).filter((f) => f.endsWith('.css')).map((f) => readFileSync(join(assets, f), 'utf8')).join('\n');
    const embedded = css.match(/url\(\s*["']?data:font\//g) ?? [];
    // the claim of the report: the fonts are inline; if one day they are files, 'self' covers them and this stays true
    if (embedded.length > 0) for (const csp of [authPageHeaders()['Content-Security-Policy'], roomsPageHeaders()['Content-Security-Policy']]) expect(fontSrc(csp)).toContain('data:');
  });
});
