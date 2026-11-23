import { describe, expect, it } from 'vitest';
import { forbiddenHostText } from '../src/server/forbiddenhost.js';

describe('the 403 for a Host name gonogo does not answer to', () => {
  it('is exactly "forbidden host" for a program: the docking check and scripts read it', () => {
    expect(forbiddenHostText('evil.example', undefined)).toBe('forbidden host');
    expect(forbiddenHostText('evil.example', 'application/json')).toBe('forbidden host');
    expect(forbiddenHostText('evil.example', '*/*')).toBe('forbidden host');
  });

  it('tells a browser what to set, with the name it used', () => {
    const text = forbiddenHostText('zimaos.local:7777', 'text/html,application/xhtml+xml');
    expect(text.split('\n')[0]).toBe('forbidden host');
    expect(text).toContain('GONOGO_ALLOWED_HOSTS=zimaos.local');
    expect(text).toContain('--allow-host zimaos.local');
    expect(text).toContain('.env next to compose.yaml');
    expect(text).toContain('docker compose up -d');
  });

  it('prints back only what a host name holds', () => {
    const text = forbiddenHostText('a"b<script>alert(1)</script>.test:80', 'text/html');
    expect(text).not.toContain('<script>');
    expect(text).toContain('GONOGO_ALLOWED_HOSTS=abscriptalert1script.test');
    expect(forbiddenHostText(undefined, 'text/html')).toContain('GONOGO_ALLOWED_HOSTS=this-name');
    expect(forbiddenHostText('x'.repeat(500), 'text/html').length).toBeLessThan(900);
  });
});
