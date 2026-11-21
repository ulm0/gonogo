/**
 * Flight Rules: SKILLS. The skill folders of the room and of each agent in one place: which the room gives every Claude Code agent, which an agent has of its own,
 * and who switched a room skill off. A skill is a folder on the machine with a SKILL.md; gonogo links it into the agent's session and never copies or fetches it.
 * "Add from the list" shows how to get a checked one (a line you run yourself). Adding and removing a room skill is the room's PAYLOAD DEFAULTS storage; an agent's own
 * skills are changed in its Edit form.
 */
import { useEffect, useId, useState } from 'react';
import type { ReactElement } from 'react';
import type { PayloadDefaults } from '../shared/protocol.js';
import * as api from './api.js';
import { Item } from './PayloadDefaults.js';
import { RegistryPicker } from './RegistryPicker.js';
import { skillRows } from './registry.js';
import { openEdit, useStore } from './store.js';
import { useRun } from './WallView.js';

export function SkillsBlock(): ReactElement {
  const id = useId();
  const agents = useStore((s) => s.agents);
  const [defaults, setDefaults] = useState<PayloadDefaults | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [folder, setFolder] = useState('');
  const add = useRun();
  useEffect(() => {
    let live = true;
    api.payloadDefaults().then(
      (found) => live && setDefaults(found),
      (e: unknown) => live && setProblem(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, []);
  const rows = skillRows(defaults?.skills ?? [], Object.values(agents));
  const ownOnly = rows.filter((r) => !r.room);
  return (
    <section className="module rules-block" aria-labelledby={`${id}-title`}>
      <h2 className="label" id={`${id}-title`}>
        SKILLS
      </h2>
      <p className="hint">
        A skill is a folder with a SKILL.md that Claude Code loads for one session. The room&apos;s skills go to every Claude Code agent that is not in a Clean Room; an agent can have skills of its own (its Edit form, PAYLOAD) and can switch a room skill off. Other engines take no skills.
        gonogo links the folder, so an edit to a skill shows at the next start; it never copies or downloads one.
      </p>
      {problem !== null && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      {defaults !== null && (
        <>
          <h3 className="label">THE ROOM&apos;S SKILLS</h3>
          {defaults.skills.length === 0 ? (
            <p className="hint">None. Skills are for Claude Code agents. Add a folder below, or get one from the list.</p>
          ) : (
            <ul className="rules-model-list">
              {defaults.skills.map((s) => {
                const row = rows.find((r) => r.name === s.name);
                return (
                  <li key={s.name} className="skills-room">
                    <Item name={s.name} chip="room" detail={s.path} remove={() => api.removeDefaultSkill(s.name)} onSaved={setDefaults} />
                    <p className="hint skills-use">
                      {row === undefined || row.gets.length === 0 ? 'No agent gets it now.' : `Reaches ${row.gets.join(', ')}.`}
                      {row !== undefined && row.own.length > 0 ? ` Replaced by their own for ${row.own.join(', ')}.` : ''}
                      {row !== undefined && row.off.length > 0 ? ` Switched off by ${row.off.join(', ')}.` : ''}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="rules-model">
            <label htmlFor={`${id}-folder`} className="rules-call">
              Skill folder
            </label>
            <input id={`${id}-folder`} className="input" type="text" value={folder} placeholder="/Users/you/skills/my-skill" autoComplete="off" autoCapitalize="none" spellCheck={false} onChange={(event) => setFolder(event.target.value)} />
            <button
              type="button"
              className="btn"
              aria-disabled={folder.trim() === '' || add.busy || undefined}
              onClick={() =>
                folder.trim() !== '' &&
                !add.busy &&
                add.run(async () => {
                  setDefaults(await api.addDefaultSkill(folder.trim()));
                  setFolder('');
                })
              }
            >
              Add folder
            </button>
            {add.error !== null && (
              <p className="error" role="alert">
                {add.error}
              </p>
            )}
          </div>
          <RegistryPicker payload="all" only="skill" has={() => false} onAdd={() => undefined} />
          <h3 className="label">SKILLS OF AN AGENT&apos;S OWN</h3>
          {ownOnly.length === 0 ? (
            <p className="hint">No agent has a skill of its own that is not the room&apos;s.</p>
          ) : (
            <ul className="rules-model-list">
              {ownOnly.map((r) => (
                <li key={r.name} className="rules-model">
                  <span className="rules-call">{r.name}</span>
                  <span className="hint">{r.paths.join(', ')}</span>
                  {r.own.map((name) => (
                    <button key={name} type="button" className="btn" data-kind="quiet" aria-label={`Edit ${name} to change its skills`} onClick={() => openEdit(name)}>
                      {name}: Edit
                    </button>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
