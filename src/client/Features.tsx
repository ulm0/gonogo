/**
 * Flight Rules, FEATURES (docs/features/features.md): every feature of the room with a switch. A switch opens the server's own plan
 * (what else goes off, what loses something) and nothing changes until it is confirmed. A core feature has a lock and its reason.
 */
import { useId, useState } from 'react';
import type { ReactElement } from 'react';
import { FEATURE_GROUPS, FEATURES, featureById } from '../shared/features.js';
import type { Feature, FeaturePlan } from '../shared/features.js';
import * as api from './api.js';
import { useStore } from './store.js';

const nameOf = (id: string): string => featureById(id)?.label ?? id;
const names = (ids: readonly string[]): string => ids.map(nameOf).join(', ');

/** The words of a plan, as the panel and the live region say them. */
export function planText(plan: FeaturePlan, turningOn: boolean): string[] {
  const lines: string[] = [];
  if (plan.turnOff.length > 0) lines.push(`Turning off ${names(plan.turnOff)}${plan.forced.length > 0 ? ` also turns off ${names(plan.forced)}, which need${plan.forced.length === 1 ? 's' : ''} it` : ''}.`);
  else if (plan.forced.length > 0) lines.push(`${names(plan.forced)} go${plan.forced.length === 1 ? 'es' : ''} off too.`);
  if (plan.turnOn.length > 0) lines.push(`Turning on ${turningOn ? 'this' : 'that'} also turns on ${names(plan.turnOn)}, which ${plan.turnOn.length === 1 ? 'it needs' : 'it needs'}.`);
  for (const d of plan.degraded) lines.push(`${nameOf(d.id)} loses something: ${d.lines.join(' ')}`);
  for (const b of plan.blocked) lines.push(b.why);
  return lines;
}

export function FeaturesBlock(): ReactElement {
  const id = useId();
  const off = useStore((s) => s.features);
  const [pending, setPending] = useState<{ feature: string; ask: string[]; plan: FeaturePlan } | null>(null);
  const [say, setSay] = useState('');
  const [busy, setBusy] = useState(false);

  const ask = (feature: Feature, turnOn: boolean): void => {
    if (busy) return;
    const next = turnOn ? off.filter((x) => x !== feature.id) : [...off, feature.id];
    setBusy(true);
    api
      .planFeatures(next)
      .then((plan) => setPending({ feature: feature.id, ask: next, plan }))
      .catch((e: unknown) => setSay(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  const confirm = (): void => {
    if (pending === null || busy) return;
    setBusy(true);
    api
      .applyFeatures(pending.ask, pending.plan.off)
      .then(() => {
        setSay(`${nameOf(pending.feature)} is ${off.includes(pending.feature) ? 'on' : 'off'}.`);
        setPending(null);
      })
      .catch((e: unknown) => setSay(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <section className="module rules-block rules-features" aria-labelledby={`${id}-title`}>
      <h2 className="label" id={`${id}-title`}>
        FEATURES
      </h2>
      <p className="hint">
        Switch off what you do not use. It is off everywhere: the keys, the Patch Panel, the agents&apos; tools and the server. Nothing is deleted; turning it on again brings the data back.
      </p>
      {FEATURE_GROUPS.map((group) => (
        <div key={group} className="feat-group">
          <h3 className="label">{group.toUpperCase()}</h3>
          <ul className="feat-list">
            {FEATURES.filter((feature) => feature.group === group).map((feature) => {
              const isOff = off.includes(feature.id);
              const needs = feature.requires.map(nameOf);
              const usedBy = FEATURES.filter((other) => other.requires.includes(feature.id)).map((other) => other.label);
              return (
                <li key={feature.id} className="feat-row" data-off={isOff ? '' : undefined}>
                  {feature.core !== undefined ? (
                    <span className="feat-lock" title={feature.core}>
                      <span className="icon" data-icon="lock" aria-hidden="true" />
                      <span className="sr-only">Core: </span>
                    </span>
                  ) : (
                    <input
                      id={`${id}-${feature.id}`}
                      type="checkbox" className="switch"
                      role="switch"
                      checked={!isOff}
                      disabled={!feature.wired && !isOff}
                      aria-describedby={`${id}-${feature.id}-about`}
                      onChange={() => ask(feature, isOff)}
                    />
                  )}
                  <label htmlFor={`${id}-${feature.id}`} className="feat-name">
                    {feature.label}
                  </label>
                  <span className="hint" id={`${id}-${feature.id}-about`}>
                    {feature.about}
                    {feature.core !== undefined ? ` Core: ${feature.core}.` : ''}
                    {!feature.wired && feature.core === undefined ? ' Cannot be switched off yet.' : ''}
                  </span>
                  {needs.length > 0 && <span className="chip" data-tone="quiet">needs {needs.join(', ')}</span>}
                  {usedBy.length > 0 && <span className="chip" data-tone="quiet">used by {usedBy.join(', ')}</span>}
                  {pending?.feature === feature.id && (
                    <div className="feat-plan" role="group" aria-label={`Plan for ${feature.label}`}>
                      {planText(pending.plan, isOff).map((line) => (
                        <p key={line}>{line}</p>
                      ))}
                      <button type="button" className="btn" onClick={() => setPending(null)}>
                        CANCEL
                      </button>
                      <button type="button" className="btn" data-kind="primary" aria-disabled={busy || pending.plan.blocked.length > 0 || undefined} onClick={() => pending.plan.blocked.length === 0 && confirm()}>
                        {isOff ? 'TURN ON' : 'TURN OFF'}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <p className="hint" role="status" aria-live="polite">
        {say}
      </p>
    </section>
  );
}
