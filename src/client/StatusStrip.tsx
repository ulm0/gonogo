/**
 * The status strip (docs/ui-semantic.md, "The wall"): the five panels of the wall as one row of keys, each showing its main value and opening its panel as a popover. A panel set to
 * "Panel" in Layout is shown as a box under the strip instead, and one set to "Hidden" is not shown. The panels are the wall's own components, so what opens is what the wall has.
 */
import { useMemo } from 'react';
import type { ReactElement } from 'react';
import { NextPop } from './NextPop.js';
import { clockText, currentMission, pollWord } from './wall.js';
import { PANELS, useNext } from './nextState.js';
import type { PanelId } from './nextState.js';
import { useFeature, useNow, useStore } from './store.js';
import { MaxQ, Mission, Propellant, Sequence, TMinus } from './WallView.js';

const BLOCK: Readonly<Record<PanelId, () => ReactElement>> = { mission: Mission, sequence: Sequence, tminus: TMinus, maxq: MaxQ, propellant: Propellant };

/** What each chip says: one value. */
function useValues(): Record<PanelId, string> {
  const activity = useStore((s) => s.activity);
  const missions = useStore((s) => s.missions);
  const agents = useStore((s) => s.agents);
  const order = useStore((s) => s.order);
  const poll = useStore((s) => s.poll);
  const governor = useStore((s) => s.governor);
  const now = useNow();
  const boss = order.find((name) => Object.hasOwn(agents, name) && agents[name].boss) ?? null;
  const mission = useMemo(() => currentMission(missions, activity, boss), [missions, activity, boss]);
  return {
    mission: mission === null ? 'No mission' : `Mission ${clockText(now - mission.at)}`,
    sequence: `Activity: ${governor.working} working`,
    tminus: `Poll: ${pollWord(poll).word}`,
    maxq: `Max Q: ${governor.limit === null ? 'off' : `${governor.working}/${governor.limit}`}`,
    propellant: 'Fuel',
  };
}

export function StatusStrip({ phone }: { phone: boolean }): ReactElement | null {
  const panels = useNext((s) => s.panels);
  const tminus = useFeature('tminus');
  const maxq = useFeature('maxq');
  const values = useValues();
  const allowed = (id: PanelId): boolean => !(id === 'tminus' && !tminus) && !(id === 'maxq' && !maxq);
  const chips = PANELS.filter((p) => panels[p.id] === 'strip' && allowed(p.id));
  const boxes = PANELS.filter((p) => panels[p.id] === 'panel' && allowed(p.id));
  if (chips.length === 0 && boxes.length === 0) return null;
  return (
    <section className="next-strip" aria-label="Status of the room" data-phone={phone || undefined}>
      {chips.length > 0 && (
        <div className="next-strip-row">
          {chips.map((p) => {
            const Block = BLOCK[p.id];
            return (
              <NextPop key={p.id} label={values[p.id]} name={p.label} className="next-chip">
                {() => (
                  <div className="next-block">
                    <Block />
                  </div>
                )}
              </NextPop>
            );
          })}
        </div>
      )}
      {boxes.length > 0 && (
        <div className="next-panels">
          {boxes.map((p) => {
            const Block = BLOCK[p.id];
            return <Block key={p.id} />;
          })}
        </div>
      )}
    </section>
  );
}
