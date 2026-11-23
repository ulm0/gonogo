/**
 * The status strip (docs/ui-semantic.md, "The wall"): the five panels of the wall as one row of keys, each showing its main value and opening its panel as a popover. A panel set to
 * "Panel" in Layout is shown as a box under the strip instead, and one set to "Hidden" is not shown. The panels are the wall's own components, so what opens is what the wall has.
 */
import { useMemo } from 'react';
import type { ReactElement } from 'react';
import { dockChipName, dockChipText } from './dockChip.js';
import { Pop } from './Pop.js';
import { DOCKING_ROW, openRules } from './rulesTarget.js';
import { clockText, currentMission, pollWord } from './wall.js';
import { PANELS, useRoomPrefs } from './roomPrefs.js';
import type { PanelId } from './roomPrefs.js';
import { showRules, useFeature, useNow, useStore } from './store.js';
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
  const panels = useRoomPrefs((s) => s.panels);
  const tminus = useFeature('tminus');
  const maxq = useFeature('maxq');
  const poll = useStore((s) => s.poll);
  const values = useValues();
  const docks = useStore((s) => s.docking.docks);
  const dockText = dockChipText(docks, phone);
  const allowed = (id: PanelId): boolean => !(id === 'tminus' && !tminus) && !(id === 'maxq' && !maxq);
  // a poll or a static fire that is open is shown whatever the layout says: it asks for an answer
  const live = !pollWord(poll).ghost;
  const chips = PANELS.filter((p) => (panels[p.id] === 'strip' || (p.id === 'tminus' && panels[p.id] === 'hidden' && live)) && allowed(p.id));
  const boxes = PANELS.filter((p) => panels[p.id] === 'panel' && allowed(p.id));
  if (chips.length === 0 && boxes.length === 0 && dockText === null) return null;
  return (
    <section className="lay-strip" aria-label="Status of the room" data-phone={phone || undefined}>
      {(chips.length > 0 || dockText !== null) && (
        <div className="lay-strip-row">
          {chips.map((p) => {
            const Block = BLOCK[p.id];
            return (
              <Pop key={p.id} label={values[p.id]} name={values[p.id]} dialog={p.label} className="lay-chip">
                {() => (
                  <div className="lay-block">
                    <Block />
                  </div>
                )}
              </Pop>
            );
          })}
          {dockText !== null && (
            <span className="lay-anchor">
              <button type="button" className="btn dock-chip" data-tone={docks.some((d) => d.status === 'down') ? 'amber' : undefined} aria-label={`${dockText}. ${dockChipName(docks)}`} onClick={() => { openRules(DOCKING_ROW.group, DOCKING_ROW.row); showRules(); }}>
                {docks.map((d) => <span key={d.id} className="led" data-on={d.status === 'ok'} data-kind={d.status === 'ok' ? 'idle' : d.status === 'down' ? 'needs' : 'stopped'} aria-hidden="true" />)}
                {dockText}
              </button>
            </span>
          )}
        </div>
      )}
      {boxes.length > 0 && (
        <div className="lay-panels">
          {boxes.map((p) => {
            const Block = BLOCK[p.id];
            return <Block key={p.id} />;
          })}
        </div>
      )}
    </section>
  );
}
