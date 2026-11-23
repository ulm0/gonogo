/** The first screens of a new install (docs/first-run-audit.md, points 3, 4 and 11): the setup step, the old address after the setup, the glossary. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GLOSSARY_URL } from '../src/client/wording.js';

const read = (file: string): string => readFileSync(file, 'utf8');

describe('the first step: no login yet', () => {
  const strip = read('src/client/SetupStrip.tsx');
  const app = read('src/client/App.tsx');

  it('says there is no login, who can use the install meanwhile, where the setup token is, and leads to /setup', () => {
    expect(strip).toContain('Step one: set up your login.');
    expect(strip).toContain('anyone who has this address can use gonogo');
    expect(strip).toContain('<code>setup-token</code>');
    expect(strip).toMatch(/href="\/setup"/);
  });

  it('shows only when the server says there is no account, and says nothing when it cannot be read', () => {
    expect(strip).toContain("status.state !== 'account'");
    expect(strip).toMatch(/\(\) => undefined/);
  });

  it('is the first thing under the top bar of the room', () => {
    expect(app.indexOf('<SetupStrip />')).toBeGreaterThan(app.indexOf('<TopBar'));
    expect(app.indexOf('<SetupStrip />')).toBeLessThan(app.indexOf('<GoneStrip />'));
  });
});

describe('the address of the first setup, after the setup', () => {
  it('says that link was for the first setup and asks to sign in, instead of a bare refusal', () => {
    const app = read('src/client/App.tsx');
    expect(app).toContain('api.hadSetupLink()');
    expect(app).toContain('This link was for the first setup.');
    expect(app).toContain('SIGN IN');
    expect(read('src/client/api.ts')).toMatch(/openedWithKey = token !== null;/);
  });
});

describe('the glossary', () => {
  it('is linked from the Commissioning card, to the docs page of the words', () => {
    expect(GLOSSARY_URL).toBe('https://gonogo.ulm0.com/guide/glossary');
    expect(read('src/client/Rules.tsx')).toMatch(/href=\{GLOSSARY_URL\}[^>]*>\s*What do these words mean\?/);
  });
});

describe('the Commissioning card, as a newcomer meets it', () => {
  const rules = read('src/client/Rules.tsx');

  it('has a step that briefs FLIGHT, with the box it points to and where the answer shows', () => {
    expect(rules).toContain("brief: { title: 'Brief FLIGHT'");
    expect(rules).toContain('The answer shows in FLIGHT');
    expect(rules).toContain("document.querySelector<HTMLElement>('.brief-input')?.focus()");
  });

  it('on a phone shows one line once FLIGHT is staffed, and a key opens the steps', () => {
    expect(rules).toContain('const open = asked ?? !(phone && steps[0]?.done === true);');
    expect(rules).toMatch(/aria-expanded=\{open\} onClick=\{\(\) => setAsked\(!open\)\}/);
    expect(rules).toContain('<ol className="commission-steps" hidden={!open}>');
  });

  it('has the security note and the docs as keys, not as bare text', () => {
    expect(rules).toMatch(/<summary className="btn" data-kind="quiet">\s*Show the note\s*<\/summary>/);
    expect(rules).toMatch(/<a className="btn" data-kind="quiet" href=\{DOCS_URL\}[^>]*>\s*Read the docs\s*<\/a>/);
  });
});
