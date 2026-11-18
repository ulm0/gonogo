/**
 * Livery (docs/livery-spec.md): the colour tokens a look is made of, the rule a livery must pass, and the four that ship.
 *
 * A livery is a value for every token of LIVERY_TOKENS (the colour tokens of src/client/tokens.css), each a plain CSS colour:
 * `#rgb`, `#rrggbb`, `rgb()`, `hsl()` or `oklch()`, with no alpha, written with commas or with spaces. The server checks a
 * submitted livery with `checkLivery` and the page sets its custom properties from `liveryProperties`, which filters through the
 * same rules, so a value that is not a colour never reaches the page. Contrast is the WCAG 2 ratio of relative luminances.
 *
 * shortcut: an `oklch()` colour outside the sRGB gamut is clipped per channel for the contrast check, where a browser maps it
 * more gently; the ratio can differ by a little for a colour that vivid, so keep text colours inside the gamut.
 */
import type { LiveryEntry, LiveryView } from './protocol.js';

/** The tokens a livery sets, with what each one is for. The role is what an agent that designs a livery reads. */
export const LIVERY_TOKENS = [
  { name: '--body', role: 'the page and the body of the device' },
  { name: '--panel', role: 'a module, one step lighter or darker than the body' },
  { name: '--key', role: 'a key, a console, an input: the most raised surface' },
  { name: '--well', role: 'a sunk surface: a stopped console, a read-only field' },
  { name: '--edge', role: 'the thin line around a module or a key' },
  { name: '--edge-2', role: 'a dashed line: an open seat' },
  { name: '--text', role: 'the main text, and the fill of the primary key' },
  { name: '--text-2', role: 'second text, on a surface and on a tint' },
  { name: '--muted', role: 'small quiet text, on the body, a module or a key' },
  { name: '--lcd', role: 'the dark screen of the terminal, the clock and the numbers' },
  { name: '--lcd-text', role: 'text on the screen' },
  { name: '--lcd-dim', role: 'quiet text on the screen' },
  { name: '--lcd-warm', role: 'text on the screen of a console that needs the Director' },
  { name: '--work', role: 'the working signal: a light and a chip outline' },
  { name: '--you', role: 'the signal that needs the Director' },
  { name: '--you-tint', role: 'the fill of what needs the Director' },
  { name: '--you-edge', role: 'the line around that fill' },
  { name: '--you-ink', role: 'text on that fill' },
  { name: '--you-key', role: 'the line of a key that sits on that fill' },
  { name: '--go', role: 'the go signal' },
  { name: '--go-tint', role: 'the fill of a go' },
  { name: '--go-ink', role: 'text on that fill' },
  { name: '--go-lit', role: 'the go light on a dark key' },
  { name: '--nogo', role: 'the no-go signal and the line of a danger' },
  { name: '--nogo-text', role: 'danger text, on the page and on its tint' },
  { name: '--nogo-tint', role: 'the fill of a no-go or an error' },
  { name: '--track', role: 'an empty ring, a vote that has not come' },
  { name: '--seq-base', role: 'the empty line of a sequence track' },
] as const;

export type LiveryTokenName = (typeof LIVERY_TOKENS)[number]['name'];
export type LiveryTokens = Readonly<Record<string, string>>;

export const LIVERY_NAMES: readonly string[] = LIVERY_TOKENS.map((t) => t.name);
export const LIVERY_NAME_MAX_CHARS = 40;
export const LIVERY_DESCRIPTION_MAX_CHARS = 200;
export const LIVERY_BRIEF_MAX_CHARS = 500;
/** How many custom liveries the folder holds. */
export const LIVERIES_MAX = 12;
export const LIVERY_SLUG_PATTERN = '^[a-z0-9][a-z0-9-]{0,39}$';
export const DEFAULT_LIVERY = 'instrument';
export const MIN_CONTRAST = 4.5;
/** The screen of the terminal stays dark: the terminal draws its own colours (the ANSI palette) for a dark screen. */
export const LCD_MAX_LUMINANCE = 0.2;

/** [text, the surfaces it sits on]. Every pair must reach MIN_CONTRAST; this is the one list, used by the check, the brief and the tests. */
export const CONTRAST_PAIRS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['--text', ['--body', '--panel', '--key', '--well', '--you-tint', '--go-tint', '--nogo-tint']],
  ['--text-2', ['--body', '--panel', '--key', '--well', '--you-tint', '--go-tint', '--nogo-tint']],
  ['--muted', ['--body', '--panel', '--key', '--well']],
  ['--work', ['--panel', '--key']],
  ['--nogo-text', ['--body', '--panel', '--key', '--nogo-tint']],
  ['--you-ink', ['--you-tint']],
  ['--go-ink', ['--go-tint']],
  ['--panel', ['--text']],
  ['--lcd-text', ['--lcd']],
  ['--lcd-dim', ['--lcd']],
  ['--lcd-warm', ['--lcd']],
];

/**
 * Pairs added after liveries were already made (a checked box or switch: the dark of the box, the mark in the key's colour). They are asked of a
 * NEW livery only (`checkLivery(tokens, true)`, the submit): a livery the Director made before is still loaded, not dropped for a rule it never had.
 */
export const CONTROL_PAIRS: ReadonlyArray<readonly [string, readonly string[]]> = [['--go-ink', ['--key']]];

/** The slug of a name: lowercase words joined by dashes, at most 40 characters; '' when no letter or digit is left. */
export const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');

/* ---- colours ---- */

type Rgb = readonly [number, number, number];

const NUMBER = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)';
const NUMBER_RE = new RegExp(`^${NUMBER}$`);
const PERCENT_RE = new RegExp(`^${NUMBER}%$`);
const ANGLE_RE = new RegExp(`^${NUMBER}(?:deg)?$`);
const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const FUNCTION_RE = /^(rgb|hsl|oklch)\(\s*([^()]*?)\s*\)$/i;

const clamp = (n: number, low = 0, high = 1): number => Math.min(high, Math.max(low, n));
const decode = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const encode = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/** The three parts of a function body: all separated by commas or all by spaces; null otherwise. */
function parts(body: string): string[] | null {
  const list = body.includes(',') ? body.split(/\s*,\s*/) : body.split(/\s+/);
  return list.length === 3 && list.every((p) => p !== '') ? list : null;
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

/** Linear-light sRGB of an OKLCH colour, each channel clipped to 0..1. */
function oklchToLinear(l: number, c: number, h: number): Rgb {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    clamp(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    clamp(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    clamp(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
  ];
}

/** Linear-light sRGB (0..1 per channel) of a colour value, or null when the text is not a colour of the allowed kinds. */
export function toLinear(value: string): Rgb | null {
  const text = value.trim();
  if (HEX_RE.test(text)) {
    const hex = text.length === 4 ? [...text.slice(1)].map((d) => d + d).join('') : text.slice(1);
    return [0, 2, 4].map((i) => decode(parseInt(hex.slice(i, i + 2), 16) / 255)) as unknown as Rgb;
  }
  const found = FUNCTION_RE.exec(text);
  const p = found ? parts(found[2] ?? '') : null;
  if (!found || !p) return null;
  const [x = '', y = '', z = ''] = p;
  switch ((found[1] ?? '').toLowerCase()) {
    case 'rgb': {
      // three numbers 0..255, or three percentages
      const percent = PERCENT_RE.test(x);
      if (!p.every((q) => (percent ? PERCENT_RE.test(q) : NUMBER_RE.test(q)))) return null;
      const channels = p.map((q) => parseFloat(q) / (percent ? 100 : 255));
      return channels.every((n) => n >= 0 && n <= 1) ? (channels.map(decode) as unknown as Rgb) : null;
    }
    case 'hsl': {
      if (!ANGLE_RE.test(x) || !PERCENT_RE.test(y) || !PERCENT_RE.test(z)) return null;
      const s = parseFloat(y) / 100;
      const l = parseFloat(z) / 100;
      if (s < 0 || s > 1 || l < 0 || l > 1) return null;
      return hslToRgb((((parseFloat(x) % 360) + 360) % 360), s, l).map(decode) as unknown as Rgb;
    }
    default: {
      // oklch(L C H): L a number 0..1 or a percentage, C a number of 0 or more, H degrees
      const l = PERCENT_RE.test(x) ? parseFloat(x) / 100 : NUMBER_RE.test(x) ? parseFloat(x) : Number.NaN;
      if (!(l >= 0 && l <= 1) || !NUMBER_RE.test(y) || parseFloat(y) < 0 || !ANGLE_RE.test(z)) return null;
      return oklchToLinear(l, parseFloat(y), parseFloat(z));
    }
  }
}

export const isColour = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 && toLinear(value) !== null;

/** `#rrggbb` of a colour value (for xterm, which wants plain colours); null when it is not one. */
export function toHex(value: string): string | null {
  const linear = toLinear(value);
  return linear === null ? null : `#${linear.map((c) => Math.round(clamp(encode(c)) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** WCAG 2 relative luminance, 0 (black) to 1 (white). */
export function luminance(value: string): number | null {
  const linear = toLinear(value);
  return linear === null ? null : 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/** WCAG 2 contrast ratio, 1 to 21; null when either is not a colour. */
export function contrast(a: string, b: string): number | null {
  const x = luminance(a);
  const y = luminance(b);
  return x === null || y === null ? null : (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** The colour scheme of a livery, from its body: the browser draws scrollbars and native controls for it. */
export const schemeOf = (tokens: LiveryTokens): 'light' | 'dark' => ((luminance(tokens['--body'] ?? '') ?? 1) < 0.18 ? 'dark' : 'light');

/** One line per fault; an empty list means the livery is whole, made of colours, and readable. Unknown names are faults too. */
export function checkLivery(tokens: unknown, forNew = false): string[] {
  if (typeof tokens !== 'object' || tokens === null || Array.isArray(tokens)) return ['tokens must be an object of token names and colours'];
  const record = tokens as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of Object.keys(record)) if (!LIVERY_NAMES.includes(key)) problems.push(`${key} is not a token of a livery`);
  const missing = LIVERY_NAMES.filter((name) => !Object.hasOwn(record, name));
  if (missing.length > 0) problems.push(`missing: ${missing.join(', ')}`);
  for (const name of LIVERY_NAMES) {
    if (Object.hasOwn(record, name) && !isColour(record[name])) problems.push(`${name} must be a colour written as #rgb, #rrggbb, rgb(), hsl() or oklch() with no alpha`);
  }
  if (problems.length > 0) return problems;
  const value = record as Record<string, string>;
  for (const [text, surfaces] of forNew ? [...CONTRAST_PAIRS, ...CONTROL_PAIRS] : CONTRAST_PAIRS) {
    for (const surface of surfaces) {
      const ratio = contrast(value[text] ?? '', value[surface] ?? '') ?? 0;
      if (ratio < MIN_CONTRAST) problems.push(`${text} on ${surface} is ${ratio.toFixed(2)}:1, it needs ${MIN_CONTRAST}:1`);
    }
  }
  if ((luminance(value['--lcd'] ?? '') ?? 1) >= LCD_MAX_LUMINANCE) problems.push(`--lcd must be a dark screen (relative luminance under ${LCD_MAX_LUMINANCE})`);
  return problems;
}

/** The contrast rule in words, one line per text token, from CONTRAST_PAIRS. */
export const contrastRules = (): string[] => [
  ...[...CONTRAST_PAIRS, ...CONTROL_PAIRS].map(([text, surfaces]) => `${text} on ${surfaces.join(', ')}: at least ${MIN_CONTRAST}:1`),
  `--lcd: dark, relative luminance under ${LCD_MAX_LUMINANCE}`,
];

/**
 * What a livery sets on :root, as [property, value]: only whitelisted names with colour values, then the colour scheme. A token that
 * fails is left out. The page sets them through the CSSOM (`style.setProperty`), which a Content-Security-Policy of a reverse proxy
 * does not block the way it blocks a style element.
 */
export function liveryProperties(tokens: LiveryTokens): Array<[string, string]> {
  return [...LIVERY_NAMES.flatMap((name): Array<[string, string]> => (isColour(tokens[name]) ? [[name, (tokens[name] as string).trim()]] : [])), ['color-scheme', schemeOf(tokens)]];
}

/* ---- the four that ship ---- */

export interface BuiltinLivery {
  slug: string;
  name: string;
  description: string;
  tokens: Readonly<Record<LiveryTokenName, string>>;
}

export const BUILTIN_LIVERIES: readonly BuiltinLivery[] = [
  {
    slug: 'instrument',
    name: 'Instrument',
    description: 'The default: a warm grey device with a small green screen.',
    // the values of tokens.css (a test keeps every livery that ships equal to its block there)
    tokens: {
      '--body': '#e4e2dc',
      '--panel': '#f1f0ec',
      '--key': '#faf9f6',
      '--well': '#e9e7e1',
      '--edge': '#c9c6be',
      '--edge-2': '#b1aea6',
      '--text': '#26272b',
      '--text-2': '#44463f',
      '--muted': '#61605b',
      '--lcd': '#2b2f2a',
      '--lcd-text': '#cfe6c9',
      '--lcd-dim': '#9fb79b',
      '--lcd-warm': '#f1d79a',
      '--work': '#4a5bd4',
      '--you': '#e0a93a',
      '--you-tint': '#f4e3b7',
      '--you-edge': '#d9b45a',
      '--you-ink': '#5c4a1c',
      '--you-key': '#b8933f',
      '--go': '#5e9e73',
      '--go-tint': '#d7e8da',
      '--go-ink': '#2c5a3a',
      '--go-lit': '#7cc493',
      '--nogo': '#c2414b',
      '--nogo-text': '#a8323c',
      '--nogo-tint': '#f5d9da',
      '--track': '#d6d3cb',
      '--seq-base': '#e2dfd7',
    },
  },
  {
    slug: 'night-shift',
    name: 'Night Shift',
    description: 'A dark graphite device with a mint screen, for working at night.',
    tokens: {
      '--body': '#16181d',
      '--panel': '#1e2127',
      '--key': '#272b33',
      '--well': '#121418',
      '--edge': '#353a44',
      '--edge-2': '#4a5160',
      '--text': '#e8e9ec',
      '--text-2': '#c5c8cf',
      '--muted': '#9ba1ac',
      '--lcd': '#0b0e0d',
      '--lcd-text': '#a9ecd4',
      '--lcd-dim': '#6fb8a0',
      '--lcd-warm': '#f4cf80',
      '--work': '#93a0ff',
      '--you': '#e5b04c',
      '--you-tint': '#3a2f15',
      '--you-edge': '#8d6f27',
      '--you-ink': '#f6d890',
      '--you-key': '#b8933f',
      '--go': '#5cbf86',
      '--go-tint': '#17352a',
      '--go-ink': '#a3e6bf',
      '--go-lit': '#7bd9a0',
      '--nogo': '#e5606b',
      '--nogo-text': '#ff9ea6',
      '--nogo-tint': '#43191f',
      '--track': '#353a44',
      '--seq-base': '#2a2e36',
    },
  },
  {
    slug: 'low-ink',
    name: 'Low Ink',
    description: 'Near-white paper with thin grey lines and pale tints: little toner when printed.',
    tokens: {
      '--body': '#f7f6f2',
      '--panel': '#fbfaf7',
      '--key': '#ffffff',
      '--well': '#efede7',
      '--edge': '#bdb9af',
      '--edge-2': '#8c887d',
      '--text': '#141414',
      '--text-2': '#333330',
      '--muted': '#55524b',
      '--lcd': '#2a2a2a',
      '--lcd-text': '#f0f0ea',
      '--lcd-dim': '#b8b8b0',
      '--lcd-warm': '#f2d98e',
      '--work': '#2f3fa8',
      '--you': '#b77a05',
      '--you-tint': '#fcf4dc',
      '--you-edge': '#d2b25a',
      '--you-ink': '#4f3b08',
      '--you-key': '#a07a1a',
      '--go': '#2f7d52',
      '--go-tint': '#e8f3ec',
      '--go-ink': '#1f4d33',
      '--go-lit': '#7cc493',
      '--nogo': '#b3261e',
      '--nogo-text': '#96211a',
      '--nogo-tint': '#fbe9e7',
      '--track': '#cfcbc1',
      '--seq-base': '#e6e3db',
    },
  },
  {
    slug: 'high-contrast',
    name: 'High Contrast',
    description: 'Black on white with black lines and strong signals: every text is 7:1 or better.',
    tokens: {
      '--body': '#ffffff',
      '--panel': '#ffffff',
      '--key': '#ffffff',
      '--well': '#ebebeb',
      '--edge': '#1a1a1a',
      '--edge-2': '#555555',
      '--text': '#000000',
      '--text-2': '#111111',
      '--muted': '#2e2e2e',
      '--lcd': '#000000',
      '--lcd-text': '#ffffff',
      '--lcd-dim': '#cfcfcf',
      '--lcd-warm': '#ffe27a',
      '--work': '#0b1bb3',
      '--you': '#8a5a00',
      '--you-tint': '#ffeeb0',
      '--you-edge': '#5c3d00',
      '--you-ink': '#2e1d00',
      '--you-key': '#5c3d00',
      '--go': '#00692f',
      '--go-tint': '#cdf2da',
      '--go-ink': '#00290f',
      '--go-lit': '#5be08c',
      '--nogo': '#b00020',
      '--nogo-text': '#7d0017',
      '--nogo-tint': '#ffd6dc',
      '--track': '#6b6b6b',
      '--seq-base': '#c4c4c4',
    },
  },
];

/** The default livery as the table of tokens, for a fallback. */
export const INSTRUMENT = BUILTIN_LIVERIES[0] as BuiltinLivery;

/** The four that ship as entries of a view; a copy each call, so that no caller can change what ships. */
export const builtinEntries = (): LiveryEntry[] => BUILTIN_LIVERIES.map((b) => ({ ...b, tokens: { ...b.tokens }, builtin: true, author: null }));
/** What a page shows before the server has said: the default livery chosen, the four that ship. */
export const defaultView = (): LiveryView => ({ current: DEFAULT_LIVERY, liveries: builtinEntries() });
