/**
 * Propellant: how many tokens the room (or one console) used in a rolling window, against the Director's limit for that
 * window. Over the limit, Redline stops the agents; at 80 % the light turns amber.
 */
import { useState } from 'react';
import type { CSSProperties, FormEvent, ReactElement } from 'react';
import { FUEL_WINDOWS } from '../shared/protocol.js';
import type { FuelGauge, FuelLimits, FuelWindow } from '../shared/protocol.js';
import { parseTokens, tokenText } from '../shared/fuel.js';
import * as api from './api.js';
import { useStore } from './store.js';
import { fuelLevel, withLimit } from './wall.js';
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

export function FuelMeter({ gauge, who, save }: { gauge: FuelGauge; who: string; save(limits: FuelLimits): Promise<unknown> }): ReactElement {
  const [window, setWindow] = useState<FuelWindow>(() => firstWindow(gauge));
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState(false);
  const { busy, error, run } = useRun();
  const used = gauge.used[window];
  const limit = gauge.limits[window];
  const level = fuelLevel(gauge, window);
  const share = limit === undefined ? 0 : Math.min(1, used / limit);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const tokens = parseTokens(text);
    setInvalid(tokens === null);
    if (tokens === null) return;
    run(async () => {
      await save(withLimit(gauge.limits, window, tokens));
      setText('');
    });
  };
  return (
    <div className="fuel" data-level={level}>
      <div className="fuel-windows" role="group" aria-label={`Window for ${who}`}>
        {FUEL_WINDOWS.map((w) => (
          <button key={w} type="button" className="btn fuel-window" data-kind="quiet" aria-pressed={w === window} onClick={() => setWindow(w)}>
            {WINDOW_WORDS[w]}
          </button>
        ))}
      </div>
      <div className="fuel-lcd lcd">
        <span className="led" style={{ '--led': LED[level] } as CSSProperties} data-on={level !== 'none'} data-blink={level === 'over'} aria-hidden="true" />
        <span className="lcd-num fuel-used">{tokenText(used)}</span>
        <span className="fuel-limit">{limit === undefined ? 'NO LIMIT' : `/ ${tokenText(limit)}`}</span>
      </div>
      <div
        className="fuel-bar"
        role="meter"
        aria-label={`${who}: tokens in ${WINDOW_WORDS[window].toLowerCase()}`}
        aria-valuemin={0}
        aria-valuemax={limit ?? Math.max(used, 1)}
        aria-valuenow={used}
        aria-valuetext={limit === undefined ? `${tokenText(used)} tokens, no limit` : `${tokenText(used)} of ${tokenText(limit)} tokens`}
      >
        <span style={{ width: `${share * 100}%` }} />
      </div>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <form className="fuel-form" onSubmit={submit}>
        <label className="sr-only" htmlFor={`fuel-${who}`}>
          {`Token limit for ${who} in ${WINDOW_WORDS[window].toLowerCase()}`}
        </label>
        <input
          id={`fuel-${who}`}
          className="input fuel-input"
          inputMode="decimal"
          autoComplete="off"
          placeholder={limit === undefined ? 'e.g. 2M' : tokenText(limit)}
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
        <button type="button" className="btn" data-kind="quiet" disabled={limit === undefined} aria-disabled={busy || undefined} onClick={() => run(() => save(withLimit(gauge.limits, window, null)))}>
          OFF
        </button>
      </form>
    </div>
  );
}

/** The wall module: the whole room. */
export function RoomFuel(): ReactElement {
  const room = useStore((s) => s.propellant.room);
  return <FuelMeter gauge={room} who="the room" save={(limits) => api.setPropellant({ room: limits })} />;
}

const EMPTY: FuelGauge = { used: { '5h': 0, day: 0, week: 0, month: 0 }, limits: {} };

/** One console's own use and limit, in its panel. */
export function AgentFuel({ name }: { name: string }): ReactElement {
  const gauge = useStore((s) => s.propellant.agents[name]) ?? EMPTY;
  return <FuelMeter gauge={gauge} who={name} save={(limits) => api.setPropellant({ agents: { [name]: limits } })} />;
}
