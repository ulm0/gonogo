// Rooms: the page under /r/<id>/ must keep every request under that prefix. A request that forgets it works at / and breaks in a room,
// so this reads the client's source for the ways a page can reach the server.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { baseOf } from '../src/client/base.js';

const dir = new URL('../src/client/', import.meta.url).pathname;
const files = readdirSync(dir).filter((f) => /\.tsx?$/.test(f));
const text = (f: string): string => readFileSync(join(dir, f), 'utf8');

describe('baseOf', () => {
  it('is empty at the root and for a path that is not a room', () => {
    for (const path of ['/', '/index.html', '/rooms/x/', '/r/', '/r/Bad/', '/r/x', '/r/-x/', '/x/r/a/']) expect(baseOf(path), path).toBe('');
  });
  it('is the room prefix under /r/<id>/', () => {
    expect(baseOf('/r/main/')).toBe('/r/main');
    expect(baseOf('/r/team-2/index.html')).toBe('/r/team-2');
  });
});

describe('every way the page reaches the server keeps the prefix', () => {
  it('only api.ts calls fetch or opens a WebSocket', () => {
    for (const f of files) {
      if (f === 'api.ts') continue;
      expect(text(f), f).not.toMatch(/\bfetch\s*\(|new WebSocket\s*\(|new EventSource\s*\(|sendBeacon\s*\(|XMLHttpRequest/);
    }
  });

  it('each fetch and the WebSocket of api.ts put the path through withBase', () => {
    const api = text('api.ts');
    const calls = [...api.matchAll(/\bfetch\s*\(([^,)]*)/g)].map((m) => m[1] ?? '');
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const arg of calls) expect(arg, `fetch(${arg})`).toContain('withBase(');
    expect(api).toMatch(/new WebSocket\(`[^`]*\$\{withBase\(WS_PATH\)\}`/);
  });

  it('no absolute URL path in the client source: links and assets are relative or built with the prefix', () => {
    for (const f of files) {
      const src = text(f);
      expect(src, `${f}: a link or image to an absolute path`).not.toMatch(/(?:href|src|action)=\{?["'`]\/(?!\/)/);
      expect(src, `${f}: url(/...)`).not.toMatch(/url\(\s*["']?\/(?!\/)/);
    }
  });

  it('the address other machines use (webhooks, docking) comes from roomOrigin, not from location.origin', () => {
    for (const f of files) {
      if (f === 'base.ts' || f === 'App.tsx') continue; // App.tsx shows the address of the supervisor, where the token is, as text
      expect(text(f), f).not.toMatch(/location\.origin/);
    }
  });

  it('the page and its assets are built with relative paths', () => {
    expect(readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8')).toMatch(/base:\s*'\.\/'/);
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    expect(html).not.toMatch(/(?:href|src)="\/(?!src\/client\/main\.tsx)/);
  });
});
