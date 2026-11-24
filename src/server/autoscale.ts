/**
 * Autoscale (docs/hire-fire-spec.md 9.3): FLIGHT's crew grows and shrinks with the Flight Plan, inside the Director's rules. Off by default, and a dry run first:
 * `dry-run` only writes what it would do to the Downlink.
 *
 * One action of any kind per tick (a hire, a stop or a removal); every tick re-reads the rules, so automatic approval switched off stops it at once. It acts only through
 * Relief (the same rule hire as `hire_agent`, the same judge and caps) and only on agents the boss hired by rule, never on one the Director hired. A new agent is left alone for
 * GRACE_MS (no hire-stop flapping). Idleness is the hub's own state (an agent in a long tool call is working, not idle), not the time of its last message.
 */
import type { AgentView, DownlinkNotify, Logger, ReliefRules, Task } from '../shared/protocol.js';
import type { Relief } from './relief.js';

export const AUTOSCALE_TICK_MS = 60_000;
/** No stop or removal this soon after a hire. */
export const AUTOSCALE_GRACE_MS = 10 * 60_000;
/** A dry-run line, or a refusal line, is posted at most once per position (or agent) per hour. */
export const AUTOSCALE_NOTE_MS = 3_600_000;

export interface AutoscaleOptions {
  rules: { view(): ReliefRules; check(): Promise<void> };
  tasks: { list(): Array<Pick<Task, 'status' | 'assignee' | 'position'>> };
  views(): AgentView[];
  relief: Pick<Relief, 'staff' | 'retire'>;
  now(): number;
  notify?: DownlinkNotify;
  log: Logger;
}

export interface Autoscale {
  /** One look at the board and the crew; does at most one thing. Resolves with what it did, for the tests and the log. */
  tick(): Promise<string | null>;
}

export function createAutoscale(options: AutoscaleOptions): Autoscale {
  const noted = new Map<string, number>();
  let running = false;

  /** A line for the Downlink, at most once an hour per key. */
  const note = (key: string, text: string): void => {
    const at = options.now();
    if (at - (noted.get(key) ?? -Infinity) < AUTOSCALE_NOTE_MS) return;
    noted.set(key, at);
    options.notify?.('relief', text);
  };

  return {
    async tick() {
      // a tick that is still working is not started twice
      if (running) return null;
      running = true;
      try {
        await options.rules.check();
        // the rules are read again every tick: automatic approval off, or autoscale off, and nothing happens
        const rules = options.rules.view();
        if (!rules.autoApprove || rules.autoscale === 'off') return null;
        const dry = rules.autoscale === 'dry-run';
        const views = options.views();
        const boss = views.find((v) => v.boss);
        if (boss === undefined) return null;
        const who = { agent: boss.name, generation: boss.generation };
        const crew = views.filter((v) => v.hiredBy === 'boss');
        const tasks = options.tasks.list();
        const now = options.now();

        // 1. scale up: enough unassigned todo tasks name a position that no boss-hired agent of it is running
        for (const position of rules.positions) {
          const waiting = tasks.filter((t) => t.status === 'todo' && t.assignee === null && t.position === position).length;
          if (waiting < rules.scaleUpTodo) continue;
          if (crew.some((v) => v.position === position && v.state !== 'stopped')) continue;
          const answer = await options.relief.staff(who, position, dry ? 'dry' : 'rules-only');
          if (answer.status === 'hired') return `hired ${answer.name ?? position}`;
          if (answer.status === 'dry') {
            note(`up:${position}`, `autoscale (dry run): would hire ${answer.name ?? position} for ${waiting} unassigned ${position.toUpperCase()} tasks`);
            return `would hire ${answer.name ?? position}`;
          }
          note(`refused:${position}`, `autoscale wants ${position.toUpperCase()} (${waiting} unassigned tasks) but a rule says no: ${answer.note}`);
        }

        // 2. scale down: a boss-hired agent with nothing to do for long enough is stopped
        if (rules.idleStopMinutes !== null && rules.mayStop) {
          for (const v of crew) {
            if (v.state !== 'idle' || v.transition !== null || v.protected === true) continue;
            if (tasks.some((t) => t.status !== 'done' && t.assignee === v.name)) continue;
            if (now - (v.hiredAt ?? now) < AUTOSCALE_GRACE_MS) continue;
            if (now - v.stateSince < rules.idleStopMinutes * 60_000) continue;
            if (dry) {
              note(`stop:${v.name}`, `autoscale (dry run): would stop ${v.name}, idle for ${Math.round((now - v.stateSince) / 60_000)} minutes with no task`);
              return `would stop ${v.name}`;
            }
            try {
              await options.relief.retire(who, v.name, 'stop', `idle for ${Math.round((now - v.stateSince) / 60_000)} minutes with no task`);
              return `stopped ${v.name}`;
            } catch (error) {
              options.log.debug(`autoscale could not stop ${v.name}`, error);
            }
          }
        }

        // 3. removal: a boss-hired agent stopped for long enough (the folder is kept renamed)
        if (rules.removeStoppedHours !== null && rules.mayRemove) {
          for (const v of crew) {
            if (v.state !== 'stopped' || v.protected === true) continue;
            if (now - (v.hiredAt ?? now) < AUTOSCALE_GRACE_MS || now - v.stateSince < rules.removeStoppedHours * 3_600_000) continue;
            if (tasks.some((t) => t.status !== 'done' && t.assignee === v.name)) continue;
            if (dry) {
              note(`remove:${v.name}`, `autoscale (dry run): would remove ${v.name}, stopped for ${Math.round((now - v.stateSince) / 3_600_000)} hours`);
              return `would remove ${v.name}`;
            }
            try {
              await options.relief.retire(who, v.name, 'remove', `stopped for ${Math.round((now - v.stateSince) / 3_600_000)} hours`);
              return `removed ${v.name}`;
            } catch (error) {
              options.log.debug(`autoscale could not remove ${v.name}`, error);
            }
          }
        }
        return null;
      } finally {
        running = false;
      }
    },
  };
}
