/**
 * Propellant: how many tokens (or dollars, with the switch) the room or one console used in a rolling window, against the
 * Director's limit (or budget) for that window. Over it, Redline stops the agents; at 80 % the light turns amber.
 * Dollars are an estimate at API list prices (docs/cost-spec.md).
 */
import { useState } from 'react';
import type { CSSProperties, FormEvent, ReactElement } from 'react';
import { FUEL_WINDOWS } from '../shared/protocol.js';
import type { Budget, CostGauge, CostView, DayCost, FuelGauge, FuelLimits, FuelWindow, PlanQuota } from '../shared/protocol.js';
import { ageText, NO_PLAN_TEXT, PLAN_LABEL, planRows } from './quota.js';
import { moneyText } from '../shared/prices.js';
import type { ModelPrice, PricesView } from '../shared/prices.js';
import { parseMoney, parseTokens, tokenText } from '../shared/fuel.js';
import * as api from './api.js';
import { useStore } from './store.js';
import { budgetLevel, fuelLevel, withBudget, withLimit } from './wall.js';
import type { FuelLevel } from './wall.js';
import { useRun } from './WallView.js';

const WINDOW_WORDS: Record<FuelWindow, string> = { '5h': '5 H', day: 'DAY', week: 'WEEK', month: 'MONTH' };
/** The window to show first: the tightest one that has a limit, else 5 h. */
function firstWindow(gauge: FuelGauge): FuelWindow {
  let best: FuelWindow = '5h';
  let ratio = -1;
  for (const w of FUEL_WINDOWS) {
    const limit = gauge.limits[w];
    if (limit !== undefined && gauge.used[w] / limit > ratio) {
      ratio = gauge.used[w] / limit;
      best = w;
    }
  }
  return best;
}

const LED: Record<FuelLevel, string | undefined> = { none: undefined, ok: 'var(--go)', warn: 'var(--you)', over: 'var(--nogo)' };

const NO_WINDOWS = { '5h': 0, day: 0, week: 0, month: 0 };
const NO_COST: CostGauge = { usd: NO_WINDOWS, unpriced: NO_WINDOWS, budget: {} };

export function FuelMeter({
  gauge,
  cost = NO_COST,
  who,
  save,
  saveBudget,
}: {
  gauge: FuelGauge;
  cost?: CostGauge;
  who: string;
  save(limits: FuelLimits): Promise<unknown>;
  saveBudget(budget: Budget): Promise<unknown>;
}): ReactElement {
  const [window, setWindow] = useState<FuelWindow>(() => firstWindow(gauge));
  const [unit, setUnit] = useState<'tokens' | 'dollars'>('tokens');
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState(false);
  const { busy, error, run } = useRun();
  const money = unit === 'dollars';
  const used = money ? cost.usd[window] : gauge.used[window];
  const limit = money ? cost.budget[window] : gauge.limits[window];
  const level = money ? budgetLevel(cost, window) : fuelLevel(gauge, window);
  const share = limit === undefined ? 0 : Math.min(1, used / limit);
  const show = (n: number): string => (money ? moneyText(n) : tokenText(n));
  const what = money ? 'dollars' : 'tokens';
  const unpriced = money ? cost.unpriced[window] : 0;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const amount = money ? parseMoney(text) : parseTokens(text);
    setInvalid(amount === null);
    if (amount === null) return;
    run(async () => {
      await (money ? saveBudget(withBudget(cost.budget, window, amount)) : save(withLimit(gauge.limits, window, amount)));
      setText('');
    });
  };
  return (
    <div className="fuel" data-level={level}>
      <div className="fuel-windows fuel-units" role="group" aria-label={`Unit for ${who}`}>
        {(['tokens', 'dollars'] as const).map((u) => (
          <button key={u} id={`fuel-${who}-${u}`} type="button" className="btn fuel-window" data-kind="quiet" aria-pressed={u === unit} onClick={() => setUnit(u)}>
            {u === 'tokens' ? 'TOKENS' : 'DOLLARS'}
          </button>
        ))}
      </div>
      <div className="fuel-windows" role="group" aria-label={`Window for ${who}`}>
        {FUEL_WINDOWS.map((w) => (
          <button key={w} type="button" className="btn fuel-window" data-kind="quiet" aria-pressed={w === window} onClick={() => setWindow(w)}>
            {WINDOW_WORDS[w]}
          </button>
        ))}
      </div>
      <div className="fuel-lcd lcd">
        <span className="led" style={{ '--led': LED[level] } as CSSProperties} data-on={level !== 'none'} data-blink={level === 'over'} aria-hidden="true" />
        <span className="lcd-num fuel-used">{show(used)}</span>
        <span className="fuel-limit">{limit === undefined ? (money ? 'NO BUDGET' : 'NO LIMIT') : `/ ${show(limit)}`}</span>
      </div>
      <div
        className="fuel-bar"
        role="meter"
        aria-label={`${who}: ${what} in ${WINDOW_WORDS[window].toLowerCase()}`}
        aria-valuemin={0}
        aria-valuemax={limit ?? Math.max(used, 1)}
        aria-valuenow={used}
        aria-valuetext={limit === undefined ? `${show(used)} ${what}, no ${money ? 'budget' : 'limit'}` : `${show(used)} of ${show(limit)} ${what}`}
      >
        <span style={{ width: `${share * 100}%` }} />
      </div>
      {money && <p className="hint fuel-note">API-equivalent estimate{unpriced > 0 ? `; ${tokenText(unpriced)} tokens unpriced` : ''}.</p>}
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <form className="fuel-form" onSubmit={submit}>
        <label className="sr-only" htmlFor={`fuel-${who}`}>
          {`${money ? 'Dollar budget' : 'Token limit'} for ${who} in ${WINDOW_WORDS[window].toLowerCase()}`}
        </label>
        <input
          id={`fuel-${who}`}
          className="input fuel-input"
          inputMode="decimal"
          autoComplete="off"
          placeholder={limit === undefined ? (money ? 'e.g. $10' : 'e.g. 2M') : show(limit)}
          value={text}
          aria-invalid={invalid || undefined}
          onChange={(e) => {
            setText(e.target.value);
            setInvalid(false);
          }}
        />
        <button type="submit" className="btn" aria-disabled={busy || undefined}>
          SET
        </button>
        <button type="button" className="btn" data-kind="quiet" disabled={limit === undefined} aria-disabled={busy || undefined} onClick={() => run(() => (money ? saveBudget(withBudget(cost.budget, window, null)) : save(withLimit(gauge.limits, window, null))))}>
          OFF
        </button>
      </form>
    </div>
  );
}

/** The plan's own number from Claude Code's status line, or the plain words that there is none. */
export function PlanBlock({ plan, now }: { plan: PlanQuota | undefined; now: number }): ReactElement {
  if (plan === undefined) return <p className="hint fuel-plan">{NO_PLAN_TEXT}</p>;
  const age = ageText(plan, now);
  return (
    <div className="fuel-plan" data-stale={plan.stale ? '' : undefined}>
      <h3 className="label">PLAN</h3>
      {planRows(plan, now).map((r) => (
        <div key={r.key} className="fuel-plan-row" data-level={r.level}>
          <span className="fuel-plan-name">{r.label}</span>
          <div className="fuel-bar" role="meter" aria-label={`Plan ${r.label.toLowerCase()} window`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(r.pct))} aria-valuetext={r.text}>
            <span style={{ width: `${Math.min(100, r.pct)}%`, background: r.level === "over" ? "var(--nogo)" : undefined }} />
          </div>
          <span className="fuel-plan-text">{r.text}</span>
        </div>
      ))}
      <p className="hint">
        {PLAN_LABEL}. {age}
      </p>
    </div>
  );
}

/** The wall module: the whole room. */
export function RoomFuel(): ReactElement {
  const room = useStore((s) => s.propellant.room);
  const cost = useStore((s) => s.propellant.cost);
  const plan = useStore((s) => s.propellant.plan);
  return (
    <>
      <PlanBlock plan={plan} now={Date.now()} />
      <FuelMeter gauge={room} cost={cost.room} who="the room" save={(limits) => api.setPropellant({ room: limits })} saveBudget={(room) => api.setPropellant({ budget: { room } })} />
      <details className="fuel-fold" id="fuel-days">
        <summary className="label">COST BY DAY</summary>
        <CostDays cost={cost} />
      </details>
      <PricesFold since={cost.pricedSince} />
    </>
  );
}

const hue = (i: number): string => `hsl(${(i * 67 + 140) % 360} 42% 52%)`;

/** The last 14 days, one stack per day, one colour per agent; the table is the same numbers for a screen reader. */
export function CostDays({ cost }: { cost: CostView }): ReactElement {
  const days: DayCost[] = cost.days;
  const names = [...new Set(days.flatMap((d) => Object.keys(d.byAgent)))].sort();
  const top = Math.max(0.01, ...days.map((d) => d.usd));
  const W = 14 * 20;
  const H = 80;
  const unpriced = days.reduce((n, d) => n + d.unpriced, 0);
  return (
    <div className="fuel-days">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Dollars per day, the last ${days.length} days, highest ${moneyText(top)}`} className="fuel-chart" preserveAspectRatio="none">
        {days.map((d, x) => {
          let y = H;
          return (
            <g key={d.date}>
              <title>{`${d.date}: ${moneyText(d.usd)}`}</title>
              {names.map((n, i) => {
                const h = ((d.byAgent[n] ?? 0) / top) * H;
                y -= h;
                return h > 0 ? <rect key={n} x={x * 20 + 2} y={y} width={16} height={h} fill={hue(i)} /> : null;
              })}
            </g>
          );
        })}
      </svg>
      <ul className="fuel-legend">
        {names.map((n, i) => (
          <li key={n}>
            <span className="fuel-swatch" style={{ background: hue(i) }} aria-hidden="true" />
            {n}
          </li>
        ))}
      </ul>
      <table className="fuel-table">
        <caption className="sr-only">Dollars per day and agent</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Total</th>
            <th scope="col">By agent</th>
          </tr>
        </thead>
        <tbody>
          {days
            .filter((d) => d.usd > 0 || d.unpriced > 0)
            .map((d) => (
              <tr key={d.date}>
                <th scope="row">{d.date}</th>
                <td>{moneyText(d.usd)}</td>
                <td>{Object.entries(d.byAgent).map(([n, v]) => `${n} ${moneyText(v)}`).join(', ')}</td>
              </tr>
            ))}
        </tbody>
      </table>
      <p className="hint">
        An API-equivalent estimate, not a bill. Clean Room agents and subagent (Task tool) transcripts are not counted.
        {unpriced > 0 && ` ${tokenText(unpriced)} tokens in these days are unpriced.`}
      </p>
    </div>
  );
}

type PriceField = keyof ModelPrice;
const PRICE_FIELDS: [PriceField, string][] = [
  ['input', 'Input'],
  ['output', 'Output'],
  ['cacheWrite', 'Cache write'],
  ['cacheRead', 'Cache read'],
];

/** The price table: the defaults and your rows over them; dollars per million tokens. Nothing is fetched from the web. */
export function PricesFold({ since }: { since: number | null }): ReactElement {
  const [view, setView] = useState<PricesView | null>(null);
  const [prefix, setPrefix] = useState('');
  const [fields, setFields] = useState<Record<PriceField, string>>({ input: '', output: '', cacheWrite: '', cacheRead: '' });
  const { busy, error, run } = useRun();
  const load = (): void => run(async () => setView(await api.getPrices()));
  const own = (v: PricesView): Record<string, ModelPrice> =>
    Object.fromEntries(Object.entries(v.rows).filter(([, r]) => r.source === 'file').map(([p, r]) => [p, { input: r.input, output: r.output, cacheWrite: r.cacheWrite, cacheRead: r.cacheRead }]));
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (view === null) return;
    if (PRICE_FIELDS.some(([k]) => fields[k].trim() === '' || !Number.isFinite(Number(fields[k])))) return;
    const nums = PRICE_FIELDS.map(([k]) => [k, Number(fields[k])] as const);
    const price = Object.fromEntries(nums) as unknown as ModelPrice;
    run(async () => {
      setView(await api.setPrices({ ...own(view), [prefix.trim()]: price }));
      setPrefix('');
    });
  };
  const oldest = view === null ? null : Object.values(view.rows).map((r) => r.asOf).filter((d): d is string => d !== undefined).sort()[0];
  return (
    <details className="fuel-fold" id="fuel-prices" onToggle={(e) => e.currentTarget.open && view === null && load()}>
      <summary className="label">PRICES</summary>
      <p className="hint">
        Dollars per million tokens, at the list prices of the vendor{oldest ? ` (defaults as of ${oldest})` : ''}; your rows win. Check the vendor's page before you trust them.
        {since !== null && ` Priced since ${new Date(since).toLocaleDateString()}: older use shows as unpriced.`}
      </p>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {view !== null && (
        <>
          <table className="fuel-table">
            <caption className="sr-only">Model prices in dollars per million tokens</caption>
            <thead>
              <tr>
                <th scope="col">Model prefix</th>
                {PRICE_FIELDS.map(([k, label]) => (
                  <th key={k} scope="col">
                    {label}
                  </th>
                ))}
                <th scope="col">Source</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(view.rows)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([p, r]) => (
                  <tr key={p}>
                    <th scope="row">{p}</th>
                    {PRICE_FIELDS.map(([k]) => (
                      <td key={k}>{r[k]}</td>
                    ))}
                    <td>
                      {r.source === 'file' ? (
                        <button type="button" className="btn" data-kind="quiet" aria-disabled={busy || undefined} onClick={() => run(async () => setView(await api.removePrice(p)))}>
                          RESET {p}
                        </button>
                      ) : (
                        `default ${r.asOf ?? ''}`
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
          <form className="fuel-form fuel-prices-form" onSubmit={submit}>
            <label className="sr-only" htmlFor="price-prefix">
              Model prefix
            </label>
            <input id="price-prefix" className="input fuel-input" placeholder="claude-sonnet-5" autoComplete="off" required pattern="[A-Za-z0-9._\-]{1,80}" value={prefix} onChange={(e) => setPrefix(e.target.value)} />
            {PRICE_FIELDS.map(([k, label]) => (
              <span key={k} className="fuel-price-field">
                <label className="sr-only" htmlFor={`price-${k}`}>
                  {label} dollars per million tokens
                </label>
                <input id={`price-${k}`} className="input fuel-input" inputMode="decimal" placeholder={label} autoComplete="off" required value={fields[k]} onChange={(e) => setFields({ ...fields, [k]: e.target.value })} />
              </span>
            ))}
            <button type="submit" className="btn" aria-disabled={busy || undefined}>
              SET
            </button>
          </form>
        </>
      )}
    </details>
  );
}

const EMPTY: FuelGauge = { used: { '5h': 0, day: 0, week: 0, month: 0 }, limits: {} };

/** One console's own use and limit, in its panel. */
export function AgentFuel({ name }: { name: string }): ReactElement {
  const gauge = useStore((s) => s.propellant.agents[name]) ?? EMPTY;
  const cost = useStore((s) => s.propellant.cost.agents[name]) ?? NO_COST;
  return <FuelMeter gauge={gauge} cost={cost} who={name} save={(limits) => api.setPropellant({ agents: { [name]: limits } })} saveBudget={(b) => api.setPropellant({ budget: { agents: { [name]: b } } })} />;
}
