/** Token amounts as people read and type them: 950, 12.5k, 1.2M. Shared by the server's trip reasons and the client. */

/** Whole tokens as 950, 12.5k or 1.2M. */
export function tokenText(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${+(n / 1000).toFixed(1)}k`;
  return `${+(n / 1_000_000).toFixed(1)}M`;
}

/** "12", "$12.40", "1.5k" (a dollar sign, spaces and commas ignored) to dollars in whole cents; null when it is not from 0.01 to 1,000,000. */
export function parseMoney(text: string): number | null {
  const m = /^\$?(\d+(?:\.\d{1,2})?)([kK]?)$/.exec(text.replace(/[\s,_]/g, ''));
  if (!m) return null;
  const usd = Math.round(Number(m[1]) * (m[2] === '' ? 1 : 1000) * 100) / 100;
  return usd >= 0.01 && usd <= 1_000_000 ? usd : null;
}

/** "2000000", "500k", "1.5M" (any case, spaces and commas ignored) to whole tokens; null when it is not a positive amount. */
export function parseTokens(text: string): number | null {
  const m = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(text.replace(/[\s,_]/g, ''));
  if (!m) return null;
  const unit = m[2]?.toLowerCase();
  const n = Math.round(Number(m[1]) * (unit === 'k' ? 1e3 : unit === 'm' ? 1e6 : 1));
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}
