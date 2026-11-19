/**
 * Prices of models in dollars per million tokens, and what a split of tokens costs (docs/cost-spec.md). Pure: no file, no network.
 *
 * The defaults are copied by hand from Anthropic's pricing page (https://platform.claude.com/docs/en/about-claude/pricing, the
 * "Model pricing" table) on PRICES_AS_OF; the owner's `~/.gonogo/prices.json` wins over them. Cache writes are the 5-minute
 * column; cache reads are the page's "cache hits" column as printed. The page's cache-read ratio is not the same for every model
 * (0.1x of input for most, 0.05x for Opus 5.5 and Sonnet 5.5, 0.025x for Fable 5.2 and 5.1), so each row below is the printed
 * number, not a formula. Not modelled: the 1-hour cache write, Haiku 5.5 above 100,000 prompt tokens, batch and per-call fees.
 * Mythos models are left out (limited availability).
 *
 * A model that matches no row is unpriced: its tokens are shown, never costed. A default row matches only its own id, with a
 * date (`-20260101`), `-latest` or `[1m]` after it: a newer model that merely starts with the same letters (`claude-sonnet-5-6`)
 * is not guessed to cost the same. Your own rows are prefixes, as you type them.
 */

export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** What one stretch of use burnt, per kind: input, cache write, output, cache read. */
export interface TokenSplit {
  i: number;
  cw: number;
  o: number;
  cr: number;
}

export type PriceTable = Record<string, ModelPrice>;
export type PriceSource = 'default' | 'file';
export interface PriceRow extends ModelPrice {
  source: PriceSource;
  /** Only default rows: the day their numbers were copied. */
  asOf?: string;
}

/** GET /api/prices: the merged table, and the label of its currency. */
export interface PricesView {
  currency: string;
  rows: Record<string, PriceRow>;
}

export const PRICES_AS_OF = '2026-11-18';
const p = (input: number, cacheWrite: number, cacheRead: number, output: number): ModelPrice => ({ input, output, cacheWrite, cacheRead });

/** Model id (or your prefix) to its list price. */
export const DEFAULT_PRICES: PriceTable = {
  'claude-fable-5-2': p(8, 10, 0.2, 40),
  'claude-fable-5-1': p(10, 12.5, 0.25, 50),
  'claude-fable-5': p(10, 12.5, 1, 50),
  'claude-opus-5-5': p(4, 5, 0.2, 20),
  'claude-opus-5': p(5, 6.25, 0.5, 25),
  'claude-opus-4-8': p(5, 6.25, 0.5, 25),
  'claude-opus-4-7': p(5, 6.25, 0.5, 25),
  'claude-opus-4-6': p(5, 6.25, 0.5, 25),
  'claude-opus-4-5': p(5, 6.25, 0.5, 25),
  'claude-opus-4-1': p(15, 18.75, 1.5, 75),
  'claude-opus-4': p(15, 18.75, 1.5, 75),
  'claude-sonnet-5-5': p(2, 2.5, 0.1, 10),
  'claude-sonnet-5': p(2, 2.5, 0.2, 10),
  'claude-sonnet-4-6': p(3, 3.75, 0.3, 15),
  'claude-sonnet-4-5': p(3, 3.75, 0.3, 15),
  'claude-sonnet-4': p(3, 3.75, 0.3, 15),
  'claude-haiku-5-5': p(0.1, 0.125, 0.01, 0.5),
  'claude-haiku-4-5': p(1, 1.25, 0.1, 5),
};

/** A prefix as the table and the routes accept it. */
export const PRICE_PREFIX_PATTERN = '^[A-Za-z0-9._-]{1,80}$';
export const PRICE_MAX = 10_000;

/** The default table, then the owner's rows over it. */
export function mergePrices(file: PriceTable = {}): Record<string, PriceRow> {
  const rows: Record<string, PriceRow> = {};
  for (const [prefix, price] of Object.entries(DEFAULT_PRICES)) rows[prefix] = { ...price, source: 'default', asOf: PRICES_AS_OF };
  for (const [prefix, price] of Object.entries(file)) rows[prefix] = { ...price, source: 'file' };
  return rows;
}

/** The price of a model by the longest matching prefix, or null (unpriced). */
export function priceFor(table: Record<string, ModelPrice | PriceRow>, model: string | undefined): ModelPrice | null {
  if (!model) return null;
  let best: string | null = null;
  for (const [prefix, row] of Object.entries(table)) {
    if (!model.startsWith(prefix)) continue;
    // a built-in row is one model, not a family: only a date, -latest or [1m] may follow it
    if ('source' in row && row.source === 'default' && !/^(-\d{8}|-latest)?(\[1m\])?$/.test(model.slice(prefix.length))) continue;
    if (best === null || prefix.length > best.length) best = prefix;
  }
  return best === null ? null : (table[best] ?? null);
}

/** Dollars for a split at a price. Not rounded: round to a cent only to show it. */
export function costOf(split: TokenSplit, price: ModelPrice): number {
  return (split.i * price.input + split.cw * price.cacheWrite + split.o * price.output + split.cr * price.cacheRead) / 1_000_000;
}

/** The same dollars kept apart by kind of token. */
export interface UsdSplit {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}
export function costSplit(split: TokenSplit, price: ModelPrice): UsdSplit {
  return { input: (split.i * price.input) / 1_000_000, output: (split.o * price.output) / 1_000_000, cacheWrite: (split.cw * price.cacheWrite) / 1_000_000, cacheRead: (split.cr * price.cacheRead) / 1_000_000 };
}

/** Dollars as people read them: $0.42, $12.40, $1.2k. */
export function moneyText(usd: number): string {
  if (usd < 1000) return `$${usd.toFixed(2)}`;
  return `$${+(usd / 1000).toFixed(1)}k`;
}
