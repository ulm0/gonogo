import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_LIVERIES,
  checkLivery,
  CONTRAST_PAIRS,
  CONTROL_PAIRS,
  contrast,
  contrastRules,
  DEFAULT_LIVERY,
  isColour,
  LIVERIES_MAX,
  LIVERY_NAMES,
  LIVERY_TOKENS,
  liveryProperties,
  luminance,
  MIN_CONTRAST,
  schemeOf,
  slugOf,
  toHex,
} from '../src/shared/livery.js';
import type { LiveryFrame, Logger, UserMessageRequest } from '../src/shared/protocol.js';
import { LIVERY_DIR, LIVERY_FILE } from '../src/server/constants.js';
import { HubError } from '../src/server/hub.js';
import { createLiveries, designBody } from '../src/server/livery.js';
import type { Liveries } from '../src/server/livery.js';

const css = (name: string): string => readFileSync(new URL(`../src/client/${name}`, import.meta.url), 'utf8');
const instrument = BUILTIN_LIVERIES[0]!;
/** A livery that passes: Instrument with another body colour it still reads on. */
const good = (over: Record<string, string> = {}): Record<string, string> => ({ ...instrument.tokens, '--body': '#dcdad3', ...over });

describe('colours', () => {
  it('reads hex, rgb, hsl and oklch, with commas or with spaces', () => {
    for (const ok of ['#fff', '#FFF', '#e4e2dc', 'rgb(1 2 3)', 'rgb(1, 2, 3)', 'rgb(10%, 20%, 30%)', 'hsl(210 40% 20%)', 'hsl(210deg, 40%, 20%)', 'oklch(0.62 0.19 264)', 'oklch(62% 0.19 264deg)', ' #fff ']) {
      expect(isColour(ok), ok).toBe(true);
    }
  });

  it('refuses anything else: names, alpha, var(), eight digits, mixed separators, ranges, and what could end a declaration', () => {
    for (const bad of [
      'red', 'transparent', 'currentColor', 'inherit', '#ffff', '#fffff', '#ffffffff', '#ggg', '#', 'rgb(1 2 3 / 50%)', 'rgba(1, 2, 3, 0.5)', 'rgb(1, 2 3)', 'rgb(256 0 0)', 'rgb(10% 20 30)', 'rgb(1 2)', 'rgb(1 2 3 4)',
      'hsl(10 40 20)', 'hsl(10 140% 20%)', 'oklch(1.5 0 0)', 'oklch(0.5 -1 0)', 'oklch(0.5 0.1)', 'var(--text)', 'rgb(var(--x) 2 3)', 'calc(1 + 2)', 'url(x)', '#fff; color: red', '#fff} body { display: none', 'rgb(1 2 3);', 'rgb(1 2 3) !important', '',
      'x'.repeat(65),
    ]) {
      expect(isColour(bad), bad).toBe(false);
    }
    expect([1, null, undefined, {}].some((v) => isColour(v))).toBe(false);
  });

  it('gives the WCAG luminance and ratio: 21 for black on white, 1 for the same colour, the known 4.48 of #777 on white', () => {
    expect(luminance('#000')).toBe(0);
    expect(luminance('#ffffff')).toBeCloseTo(1, 10);
    expect(contrast('#000', '#fff')).toBeCloseTo(21, 10);
    expect(contrast('#fff', '#000')).toBeCloseTo(21, 10);
    expect(contrast('#123456', '#123456')).toBe(1);
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
    expect(contrast('#767676', '#ffffff')).toBeGreaterThan(4.5);
    expect(contrast('red', '#fff')).toBeNull();
  });

  it('means the same colour in every notation', () => {
    expect(toHex('#abc')).toBe('#aabbcc');
    expect(toHex('rgb(228 226 220)')).toBe('#e4e2dc');
    expect(toHex('rgb(50%, 0%, 100%)')).toBe('#8000ff');
    expect(toHex('hsl(0 100% 50%)')).toBe('#ff0000');
    expect(toHex('hsl(120, 100%, 25%)')).toBe('#008000');
    expect(toHex('hsl(-240 100% 50%)')).toBe('#00ff00');
    expect(toHex('oklch(1 0 0)')).toBe('#ffffff');
    expect(toHex('oklch(0 0 0)')).toBe('#000000');
    expect(toHex('oklch(0.628 0.2577 29.23)')).toBe('#ff0000');
    expect(toHex('oklch(50% 0 0)')).toBe('#636363');
    expect(toHex('nope')).toBeNull();
    expect(contrast('hsl(0 0% 0%)', 'oklch(1 0 0)')).toBeCloseTo(21, 4);
  });

  it('calls a livery dark from its body', () => {
    expect(schemeOf(instrument.tokens)).toBe('light');
    expect(schemeOf({ '--body': '#16181d' })).toBe('dark');
    expect(schemeOf({})).toBe('light');
  });
});

describe('the token list and the rule', () => {
  it('names each token once, with a role, and the contrast pairs name only tokens of the list', () => {
    expect(new Set(LIVERY_NAMES).size).toBe(LIVERY_NAMES.length);
    for (const t of LIVERY_TOKENS) expect(t.role.length, t.name).toBeGreaterThan(5);
    for (const [text, surfaces] of [...CONTRAST_PAIRS, ...CONTROL_PAIRS]) for (const name of [text, ...surfaces]) expect(LIVERY_NAMES, name).toContain(name);
    expect(contrastRules()).toHaveLength(CONTRAST_PAIRS.length + CONTROL_PAIRS.length + 1);
  });

  it('keeps every livery that ships equal to its block of tokens.css, every token of it', () => {
    const tokens = css('tokens.css');
    // the blocks whose selector names the livery (Instrument's is also :root); a token in a second block of the same livery counts too
    const declared = (slug: string): Record<string, string> => {
      const found: Record<string, string> = {};
      for (const block of tokens.matchAll(/^([^\s/{}][^{}]*?)\{([^{}]*)\}/gm)) {
        if (!block[1]!.split(',').some((s) => s.trim() === `[data-livery='${slug}']`)) continue;
        for (const m of block[2]!.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)) found[m[1]!] = m[2]!.trim();
      }
      return found;
    };
    expect(/^:root,\n\[data-livery='instrument'\] \{/m.test(tokens), 'Instrument is the :root block').toBe(true);
    for (const livery of BUILTIN_LIVERIES) {
      const block = declared(livery.slug);
      for (const name of LIVERY_NAMES) expect(livery.tokens[name as keyof typeof livery.tokens], `${livery.slug} ${name}`).toBe(block[name]);
      // nothing of the colour tokens of a block is left out of the list
      expect(Object.keys(block).filter((n) => isColour(block[n])).sort(), livery.slug).toEqual([...LIVERY_NAMES].sort());
    }
    // no other stylesheet of the app declares a colour token: tokens.css is the one source
    for (const file of readdirSync(new URL('../src/client/', import.meta.url)).filter((f) => f.endsWith('.css') && f !== 'tokens.css')) {
      for (const name of LIVERY_NAMES) expect(css(file), `${file} declares ${name}`).not.toMatch(new RegExp(`^\\s*${name}\\s*:`, 'm'));
    }
  });

  it('passes every livery that ships, and the high-contrast one at 7:1 or better', () => {
    expect(BUILTIN_LIVERIES.map((l) => l.slug)).toEqual(['instrument', 'night-shift', 'low-ink', 'high-contrast']);
    for (const l of BUILTIN_LIVERIES) {
      expect(checkLivery(l.tokens), l.slug).toEqual([]);
      expect(checkLivery(l.tokens, true), l.slug).toEqual([]);
      expect(slugOf(l.name), l.slug).toBe(l.slug);
      expect(new Set(Object.keys(l.tokens)), l.slug).toEqual(new Set(LIVERY_NAMES));
    }
    const high = BUILTIN_LIVERIES[3]!;
    for (const [text, surfaces] of CONTRAST_PAIRS) for (const s of surfaces) expect(contrast(high.tokens[text as keyof typeof high.tokens], high.tokens[s as keyof typeof high.tokens])!, `${text} on ${s}`).toBeGreaterThanOrEqual(7);
  });

  it('makes four looks that differ: no two share a body, and only the night one is dark', () => {
    expect(new Set(BUILTIN_LIVERIES.map((l) => l.tokens['--body'])).size).toBe(4);
    expect(BUILTIN_LIVERIES.map((l) => schemeOf(l.tokens))).toEqual(['light', 'dark', 'light', 'light']);
  });

  it('rejects a livery whose text falls under 4.5:1, and says which pair and by how much', () => {
    // a livery made before the checked-box pair existed still loads; a new one must hold it
    const old = good({ '--go-ink': instrument.tokens['--key']! });
    expect(checkLivery(old).join(' ')).not.toMatch(/--go-ink on --key/);
    expect(checkLivery(old, true).join(' ')).toMatch(/--go-ink on --key/);
    const found = checkLivery(good({ '--muted': '#8a8780' }));
    expect(found.some((p) => p.startsWith('--muted on --body is ') && p.endsWith(`, it needs ${MIN_CONTRAST}:1`))).toBe(true);
    expect(checkLivery(good({ '--text': '#f1f0ec' })).length).toBeGreaterThan(3);
    expect(checkLivery(good({ '--lcd-text': '#3a3f3a' }))).toEqual([expect.stringMatching(/^--lcd-text on --lcd is 1\.\d\d:1/)]);
    // a pair that is exactly the limit passes: the ratio is not rounded up
    expect(contrast('#767676', '#ffffff')!).toBeGreaterThanOrEqual(MIN_CONTRAST);
    expect(checkLivery(good({ '--muted': '#777777', '--body': '#ffffff', '--panel': '#ffffff', '--key': '#ffffff', '--well': '#ffffff' })).some((p) => p.startsWith('--muted on --body'))).toBe(true);
  });

  it('wants every token, no other, each a colour, and a dark screen', () => {
    const { '--go': _go, ...missing } = good();
    expect(checkLivery(missing)).toEqual(['missing: --go']);
    expect(checkLivery({ ...good(), '--shadow': '#000' })).toEqual(['--shadow is not a token of a livery']);
    expect(checkLivery(good({ '--go': 'green' }))[0]).toMatch(/^--go must be a colour/);
    expect(checkLivery(good({ '--go': 5 as unknown as string }))[0]).toMatch(/^--go must be a colour/);
    expect(checkLivery(good({ '--lcd': '#e4e2dc', '--lcd-text': '#222222', '--lcd-dim': '#333333', '--lcd-warm': '#444444' }))).toContain('--lcd must be a dark screen (relative luminance under 0.2)');
    for (const not of [null, 'x', [], 5]) expect(checkLivery(not), String(not)).toEqual(['tokens must be an object of token names and colours']);
    expect(checkLivery({})[0]).toMatch(/^missing: --body, /);
  });

  it('builds the properties of the page from the tokens that pass, with the colour scheme, and nothing else', () => {
    const night = BUILTIN_LIVERIES[1]!;
    const set = liveryProperties(night.tokens);
    expect(set).toHaveLength(LIVERY_NAMES.length + 1);
    expect(set.at(-1)).toEqual(['color-scheme', 'dark']);
    expect(set).toContainEqual(['--body', '#16181d']);
    const hostile = liveryProperties({ '--body': '#fff; background: url(x)', '--text': ' #000 ', '--evil': '#f00', 'color-scheme': 'dark' });
    expect(hostile).toEqual([['--text', '#000'], ['color-scheme', 'light']]);
  });

  it('turns a name into a slug', () => {
    expect(slugOf('Night Shift')).toBe('night-shift');
    expect(slugOf('  Dusk -- 2!  ')).toBe('dusk-2');
    expect(slugOf('Ünï')).toBe('n');
    expect(slugOf('!!!')).toBe('');
    expect(slugOf('a'.repeat(60))).toHaveLength(40);
    expect(slugOf(`${'a'.repeat(39)} b`)).toBe('a'.repeat(39));
  });
});

describe('Livery: the store', () => {
  let dir: string;
  let frames: LiveryFrame[];
  let events: Array<[string, string]>;
  let sent: UserMessageRequest[];
  let warnings: string[];

  const quiet: Logger = { debug: () => undefined, info: () => undefined, warn: (m) => void warnings.push(m), error: () => undefined, child: () => quiet };
  const make = (): Liveries =>
    createLiveries({
      dir,
      emit: (frame) => void frames.push(frame),
      notify: (kind, text) => void events.push([kind, text]),
      send: (request) => {
        sent.push(request);
        return { ok: true, id: 'm1', to: request.to === 'boss' ? 'flight' : request.to, status: 'queued', note: null };
      },
      log: quiet,
    });
  const loaded = async (): Promise<Liveries> => {
    const l = make();
    await l.load();
    return l;
  };
  const refused = async (run: () => Promise<unknown> | unknown): Promise<{ code: string; field: string | undefined; message: string }> => {
    try {
      await run();
    } catch (e) {
      if (e instanceof HubError) return { code: e.code, field: e.field, message: e.message };
      throw e;
    }
    throw new Error('it was not refused');
  };
  const dusk = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ name: 'Dusk', description: 'Blue hour.', tokens: good(), ...over });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gonogo-livery-'));
    frames = [];
    events = [];
    sent = [];
    warnings = [];
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('starts with the four that ship and the default chosen, and writes nothing until something changes', async () => {
    const l = await loaded();
    const v = l.view();
    expect(v.current).toBe(DEFAULT_LIVERY);
    expect(v.liveries.map((e) => [e.slug, e.builtin, e.author])).toEqual([['instrument', true, null], ['night-shift', true, null], ['low-ink', true, null], ['high-contrast', true, null]]);
    expect(await readdir(join(dir, LIVERY_DIR))).toEqual([]);
    expect((await stat(join(dir, LIVERY_DIR))).mode & 0o777).toBe(0o700);
    expect(await readdir(dir)).toEqual([LIVERY_DIR]);
    // a copy: nobody can change what ships by changing what the view gave
    v.liveries[0]!.tokens['--body'] = '#000000';
    expect(l.view().liveries[0]!.tokens['--body']).toBe('#e4e2dc');
  });

  it('keeps a submitted livery in a private file, tells the browsers and the Director, and does not apply it', async () => {
    const l = await loaded();
    const entry = await l.submit('ana', dusk());
    expect(entry).toMatchObject({ slug: 'dusk', name: 'Dusk', description: 'Blue hour.', builtin: false, author: 'ana' });
    const file = join(dir, LIVERY_DIR, 'dusk.json');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, name: 'Dusk', description: 'Blue hour.', author: 'ana', tokens: good() });
    expect(l.view().current).toBe('instrument');
    expect(l.view().liveries.map((e) => e.slug)).toEqual(['instrument', 'night-shift', 'low-ink', 'high-contrast', 'dusk']);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.livery.current).toBe('instrument');
    expect(events).toEqual([['livery', 'ana submitted the livery "Dusk". Pick it in the Livery view to try it.']]);
    expect((await readdir(join(dir, LIVERY_DIR))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('trims what it stores, replaces a livery of the same name, and keeps the new author', async () => {
    const l = await loaded();
    await l.submit('ana', dusk({ name: '  Dusk  ', tokens: good({ '--work': ' #3344aa ' }) }));
    expect(l.view().liveries.at(-1)!.tokens['--work']).toBe('#3344aa');
    await l.submit('ben', dusk({ name: 'DUSK', description: undefined }));
    const all = l.view().liveries.filter((e) => !e.builtin);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ name: 'DUSK', description: '', author: 'ben' });
    expect(await readdir(join(dir, LIVERY_DIR))).toEqual(['dusk.json']);
  });

  it('never replaces the livery in use: that would change the look without the Director', async () => {
    const l = await loaded();
    await l.submit('ana', dusk());
    await l.select({ slug: 'dusk' });
    frames.length = 0;
    expect(await refused(() => l.submit('ben', dusk({ tokens: good({ '--work': '#3344aa' }) })))).toMatchObject({ code: 'conflict', field: 'name' });
    expect(l.view().liveries.at(-1)).toMatchObject({ author: 'ana', tokens: good() });
    expect(frames).toEqual([]);
  });

  it('refuses a bad submit with what to fix, and writes nothing', async () => {
    const l = await loaded();
    const weak = await refused(() => l.submit('ana', dusk({ tokens: good({ '--muted': '#a09d96' }) })));
    expect(weak).toMatchObject({ code: 'bad_request', field: 'tokens' });
    expect(weak.message).toMatch(/^--muted on --body is \d\.\d\d:1, it needs 4\.5:1/);
    const many = await refused(() => l.submit('ana', dusk({ tokens: Object.fromEntries(LIVERY_NAMES.map((n) => [n, '#808080'])) })));
    expect(many.message).toMatch(/; and \d+ more$/);
    expect((await refused(() => l.submit('ana', dusk({ tokens: { '--body': '#fff' } })))).message).toMatch(/^missing: /);
    for (const [input, field] of [
      [dusk({ name: '' }), 'name'],
      [dusk({ name: '!!!' }), 'name'],
      [dusk({ name: 'x'.repeat(41) }), 'name'],
      [dusk({ name: 'two\nlines' }), 'name'],
      [dusk({ name: 5 }), 'name'],
      [dusk({ name: 'Instrument' }), 'name'],
      [dusk({ name: 'High  Contrast!' }), 'name'],
      [dusk({ description: 'y'.repeat(201) }), 'description'],
      [dusk({ description: 'a\nb' }), 'description'],
      [dusk({ description: 5 }), 'description'],
      [{ ...dusk(), extra: 1 }, 'extra'],
      [dusk({ tokens: undefined }), 'tokens'],
    ] as const) {
      expect(await refused(() => l.submit('ana', input)), JSON.stringify(input).slice(0, 80)).toMatchObject({ code: 'bad_request', field });
    }
    expect((await refused(() => l.submit('ana', [1]))).code).toBe('bad_request');
    expect(await readdir(join(dir, LIVERY_DIR))).toEqual([]);
    expect(frames).toEqual([]);
    expect(events).toEqual([]);
  });

  it('holds at most LIVERIES_MAX custom liveries, and a replace is not a new one', async () => {
    const l = await loaded();
    for (let i = 1; i <= LIVERIES_MAX; i++) await l.submit('ana', dusk({ name: `Look ${i}` }));
    expect(await refused(() => l.submit('ana', dusk({ name: 'One more' })))).toMatchObject({ code: 'conflict' });
    await l.submit('ana', dusk({ name: 'look 3', description: 'again' }));
    expect(l.view().liveries.filter((e) => !e.builtin)).toHaveLength(LIVERIES_MAX);
    await l.remove('look-3');
    await l.submit('ana', dusk({ name: 'One more' }));
    expect(l.view().liveries.filter((e) => !e.builtin)).toHaveLength(LIVERIES_MAX);
  });

  it('keeps the choice in livery.json (mode 0600), tells the browsers, and finds it again at the next start', async () => {
    const l = await loaded();
    await l.submit('ana', dusk());
    frames.length = 0;
    expect((await l.select({ slug: 'dusk' })).current).toBe('dusk');
    expect(frames.map((f) => f.livery.current)).toEqual(['dusk']);
    expect(JSON.parse(await readFile(join(dir, LIVERY_FILE), 'utf8'))).toEqual({ version: 1, current: 'dusk' });
    expect((await stat(join(dir, LIVERY_FILE))).mode & 0o777).toBe(0o600);
    await l.select({ slug: 'night-shift' });
    // the same slug again changes nothing and tells nobody
    frames.length = 0;
    await l.select({ slug: 'night-shift' });
    expect(frames).toEqual([]);
    const again = await loaded();
    expect(again.view().current).toBe('night-shift');
    expect(again.view().liveries.some((e) => e.slug === 'dusk')).toBe(true);
  });

  it('refuses to choose what does not exist, and a body that is not { slug }', async () => {
    const l = await loaded();
    expect(await refused(() => l.select({ slug: 'nope' }))).toMatchObject({ code: 'not_found', field: 'slug' });
    for (const input of [{}, { slug: 5 }, { slug: '../etc' }, { slug: 'Night Shift' }, { slug: 'dusk', extra: 1 }, [1], 'dusk', null]) {
      expect((await refused(() => l.select(input))).code, JSON.stringify(input)).toBe('bad_request');
    }
    expect(l.view().current).toBe('instrument');
  });

  it('deletes a custom livery with its file, falls back to the default when it was the chosen one, and never deletes one that ships', async () => {
    const l = await loaded();
    await l.submit('ana', dusk());
    await l.submit('ana', dusk({ name: 'Other' }));
    await l.select({ slug: 'dusk' });
    frames.length = 0;
    const after = await l.remove('dusk');
    expect([after.current, after.liveries.some((e) => e.slug === 'dusk')]).toEqual(['instrument', false]);
    expect(await readdir(join(dir, LIVERY_DIR))).toEqual(['other.json']);
    expect(JSON.parse(await readFile(join(dir, LIVERY_FILE), 'utf8')).current).toBe('instrument');
    expect(frames).toHaveLength(1);
    // a livery that is not the chosen one leaves the choice alone
    await l.select({ slug: 'night-shift' });
    await l.remove('other');
    expect(l.view().current).toBe('night-shift');
    expect(await refused(() => l.remove('night-shift'))).toMatchObject({ code: 'forbidden' });
    expect(await refused(() => l.remove('dusk'))).toMatchObject({ code: 'not_found' });
    expect(await refused(() => l.remove('../livery'))).toMatchObject({ code: 'not_found' });
    expect(await loaded().then((x) => x.view().liveries.filter((e) => !e.builtin))).toEqual([]);
  });

  it('removes a livery whose file was deleted by hand', async () => {
    const l = await loaded();
    await l.submit('ana', dusk());
    await rm(join(dir, LIVERY_DIR, 'dusk.json'));
    expect((await l.remove('dusk')).liveries.some((e) => e.slug === 'dusk')).toBe(false);
  });

  it('skips a file that is not a livery with a warning, keeps it, and starts with the default when the choice is not readable', async () => {
    await mkdir(join(dir, LIVERY_DIR), { recursive: true });
    const put = (name: string, value: unknown): Promise<void> => writeFile(join(dir, LIVERY_DIR, name), typeof value === 'string' ? value : JSON.stringify(value));
    await put('good.json', { version: 1, name: 'Good', description: '', author: 'ana', tokens: good() });
    await put('broken.json', '{ not json');
    await put('weak.json', { version: 1, name: 'Weak', tokens: good({ '--muted': '#b0ada6' }) });
    await put('hostile.json', { version: 1, name: 'Hostile', tokens: good({ '--body': '#fff; } body { display: none' }) });
    await put('v2.json', { version: 2, name: 'V2', tokens: good() });
    await put('other-name.json', { version: 1, name: 'Something Else', tokens: good() });
    await put('instrument.json', { version: 1, name: 'Instrument', tokens: good() });
    await put('notes.txt', 'ignored');
    await writeFile(join(dir, LIVERY_FILE), '{ "version": 1, "current": "gone" }');
    const l = await loaded();
    expect(l.view().liveries.filter((e) => !e.builtin).map((e) => e.slug)).toEqual(['good']);
    expect(l.view().liveries.find((e) => e.slug === 'good')).toMatchObject({ author: 'ana', description: '' });
    expect(l.view().current).toBe('instrument');
    expect(warnings.filter((w) => w.startsWith(`${LIVERY_DIR}/`))).toHaveLength(6);
    expect(warnings.some((w) => w.includes('livery.json'))).toBe(true);
    expect((await readdir(join(dir, LIVERY_DIR))).sort()).toEqual(['broken.json', 'good.json', 'hostile.json', 'instrument.json', 'notes.txt', 'other-name.json', 'v2.json', 'weak.json']);
    await writeFile(join(dir, LIVERY_FILE), 'garbage');
    expect((await loaded()).view().current).toBe('instrument');
  });

  it('asks the boss by default, or an agent by name, with the brief, every token with its role, and the rule', () => {
    const l = make();
    expect(l.design({ brief: '  A calm look for night.  ' })).toMatchObject({ ok: true, to: 'flight' });
    expect(l.design({ to: 'ana', brief: 'Warm.' })).toMatchObject({ to: 'ana' });
    expect(sent.map((s) => [s.to, s.subject])).toEqual([['boss', 'Livery: design request'], ['ana', 'Livery: design request']]);
    const body = sent[0]!.body;
    expect(body).toContain('Brief: A calm look for night.');
    expect(body).toContain('mcp__gonogo__livery_submit');
    for (const t of LIVERY_TOKENS) expect(body, t.name).toContain(`${t.name}: ${t.role}`);
    for (const rule of contrastRules()) expect(body).toContain(`- ${rule}`);
    expect(body).toContain('4.5:1');
    expect(body).toContain('does not apply it');
    expect(body.length).toBeLessThan(5000);
    expect(designBody('x')).toBe(designBody('x'));
  });

  it('refuses a design request that names user or nobody, has no brief, or has a brief that is too long', async () => {
    const l = make();
    for (const [input, field] of [
      [{ brief: '' }, 'brief'],
      [{ brief: '   ' }, 'brief'],
      [{ brief: 5 }, 'brief'],
      [{}, 'brief'],
      [{ brief: 'x'.repeat(501) }, 'brief'],
      [{ to: 'user', brief: 'x' }, 'to'],
      [{ to: 'Ana Bell', brief: 'x' }, 'to'],
      [{ to: 5, brief: 'x' }, 'to'],
      [{ brief: 'x', extra: 1 }, 'extra'],
    ] as const) {
      expect(await refused(() => l.design(input)), JSON.stringify(input)).toMatchObject({ code: 'bad_request', field });
    }
    expect((await refused(() => l.design('x'))).code).toBe('bad_request');
    expect(sent).toEqual([]);
    expect(l.design({ brief: 'x'.repeat(500) }).ok).toBe(true);
  });
});
