/**
 * The owner's model prices: `prices.json` in gonogo's home, over the defaults of src/shared/prices.ts (docs/cost-spec.md).
 * Local and editable; nothing is fetched. `currency` is a label only, there is no conversion.
 */
import { randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mergePrices, PRICE_MAX, PRICE_PREFIX_PATTERN } from '../shared/prices.js';
import type { ModelPrice, PriceRow, PriceTable } from '../shared/prices.js';
import type { Logger } from '../shared/protocol.js';
import { FILE_MODE, PRICES_FILE } from './constants.js';

const PREFIX_RE = new RegExp(PRICE_PREFIX_PATTERN);
const PRICE_KEYS = ['input', 'output', 'cacheWrite', 'cacheRead'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One price from untrusted JSON: exactly the four numbers, each from 0 to PRICE_MAX; anything else is a message. */
export function parsePrice(value: unknown, what: string): ModelPrice | string {
  if (!isRecord(value)) return `${what} must be an object with ${PRICE_KEYS.join(', ')}`;
  for (const key of Object.keys(value)) if (!(PRICE_KEYS as readonly string[]).includes(key)) return `${what}: unknown field "${key}"`;
  const price = {} as ModelPrice;
  for (const key of PRICE_KEYS) {
    const v = value[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > PRICE_MAX) return `${what}.${key} must be a number of dollars per million tokens from 0 to ${PRICE_MAX}`;
    price[key] = v;
  }
  return price;
}

/** The body of PUT /api/prices: `{ models: { <prefix>: price } }` (and `currency`, a label). Strict: unknown fields are refused. */
export function parsePricesRequest(body: Record<string, unknown>): { ok: true; models: PriceTable } | { ok: false; error: string; field: string } {
  for (const key of Object.keys(body)) {
    if (key !== 'models' && key !== 'currency' && key !== 'version') return { ok: false, error: `unknown field "${key}"`, field: key };
  }
  if (body.currency !== undefined && (typeof body.currency !== 'string' || !/^[A-Za-z]{3}$/.test(body.currency))) {
    return { ok: false, error: 'currency must be a three-letter label such as USD', field: 'currency' };
  }
  if (!isRecord(body.models)) return { ok: false, error: 'models must be an object of model prefixes', field: 'models' };
  const models: PriceTable = {};
  for (const [prefix, raw] of Object.entries(body.models)) {
    if (!PREFIX_RE.test(prefix)) return { ok: false, error: `models: invalid prefix "${prefix}"`, field: 'models' };
    const price = parsePrice(raw, `models.${prefix}`);
    if (typeof price === 'string') return { ok: false, error: price, field: 'models' };
    models[prefix] = price;
  }
  return { ok: true, models };
}

export interface PricesView {
  currency: string;
  rows: Record<string, PriceRow>;
}

export interface Prices {
  load(): Promise<void>;
  /** The merged table: defaults, then the owner's rows. */
  table(): Record<string, PriceRow>;
  view(): PricesView;
  /** Replaces the file's part. */
  replace(models: PriceTable, currency?: string): Promise<PricesView>;
  /** Drops one row of the file (back to the default); false when the file had none. */
  remove(prefix: string): Promise<boolean>;
  close(): Promise<void>;
}

export interface PricesOptions {
  dir: string;
  log: Logger;
}

export function createPrices(options: PricesOptions): Prices {
  const { dir, log } = options;
  const path = join(dir, PRICES_FILE);
  let file: PriceTable = {};
  let currency = 'USD';
  let merged = mergePrices(file);
  let chain: Promise<unknown> = Promise.resolve();

  const save = (): Promise<void> => {
    const json = JSON.stringify({ version: 1, currency, models: file }, null, 2);
    const run = chain.then(async () => {
      const tmp = join(dir, `.${PRICES_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
      await writeFile(tmp, json, { mode: FILE_MODE, flag: 'wx' });
      await rename(tmp, path);
    });
    chain = run.catch((error: unknown) => log.error('prices could not write', error));
    return run;
  };

  const view = (): PricesView => ({ currency, rows: merged });

  return {
    async load() {
      try {
        const data: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (isRecord(data)) {
          const parsed = parsePricesRequest({ models: data.models ?? {}, ...(typeof data.currency === 'string' ? { currency: data.currency } : {}) });
          if (parsed.ok) {
            file = parsed.models;
            if (typeof data.currency === 'string') currency = data.currency;
          } else log.warn(`${PRICES_FILE} is not valid (${parsed.error}); the default prices are used`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`${PRICES_FILE} could not be read; the default prices are used`, error);
      }
      merged = mergePrices(file);
    },
    table: () => merged,
    view,
    async replace(models, label) {
      file = { ...models };
      if (label !== undefined) currency = label.toUpperCase();
      merged = mergePrices(file);
      await save();
      return view();
    },
    async remove(prefix) {
      if (!(prefix in file)) return false;
      delete file[prefix];
      merged = mergePrices(file);
      await save();
      return true;
    },
    close: () => chain.then(() => undefined),
  };
}
