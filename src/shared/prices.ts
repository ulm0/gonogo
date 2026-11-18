/**
 * Prices of models in dollars per million tokens, and what a split of tokens costs (docs/cost-spec.md). Pure: no file, no network.
 *
 * The defaults are Anthropic's list prices (platform.claude.com/docs/en/about-claude/pricing), copied by hand at `asOf`; the
 * owner's `~/.gonogo/prices.json` wins over them. A model that matches no prefix is unpriced: its tokens are shown, never costed.
 * Cache writes are priced at the 5-minute rate; the 1-hour rate and long-context surcharges are not modelled.
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

export const PRICES_AS_OF = '2026-11-18';
const p = (input: number, cacheWrite: number, cacheRead: number, output: number): ModelPrice => ({ input, output, cacheWrite, cacheRead });

/** Prefix of a model id to its list price. Longest prefix wins, so `claude-opus-4-1` beats `claude-opus-4`. */
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
export function priceFor(table: Record<string, ModelPrice>, model: string | undefined): ModelPrice | null {
  if (!model) return null;
  let best: string | null = null;
  for (const prefix of Object.keys(table)) {
    if (model.startsWith(prefix) && (best === null || prefix.length > best.length)) best = prefix;
  }
  return best === null ? null : (table[best] ?? null);
}

/** Dollars for a split at a price. Not rounded: round to a cent only to show it. */
export function costOf(split: TokenSplit, price: ModelPrice): number {
  return (split.i * price.input + split.cw * price.cacheWrite + split.o * price.output + split.cr * price.cacheRead) / 1_000_000;
}

/** Dollars as people read them: $0.42, $12.40, $1.2k. */
export function moneyText(usd: number): string {
  if (usd < 1000) return `$${usd.toFixed(2)}`;
  return `$${+(usd / 1000).toFixed(1)}k`;
}
