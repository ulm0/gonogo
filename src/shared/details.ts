/**
 * Agent detail chips: the engine, the model and the effort of one console, in words. Pure and shared: the page and the terminal
 * client draw the same three facts. The model shown is the one the console will START with (its own, else its position's, else the
 * room's for its engine) and says where it comes from when it is not its own; it is null when none of these is set, because the CLI's
 * own default is not something gonogo knows (never a guess). The effort is only ever the stored one: gonogo does not read the live one.
 */
import { providerInfo } from './protocol.js';
import type { AgentView, ModelDefaults } from './protocol.js';

export type ModelSource = 'console' | 'position' | 'room';

export interface Details {
  /** `Claude Code`, `pi`, ... as the hire form calls it. */
  engine: string;
  /** The model and where it comes from, or null when nothing sets one. */
  model: { name: string; from: ModelSource } | null;
  /** `high`, `xhigh`, ... or null. */
  effort: string | null;
}

/** The model a console starts with, as `claude` does it: own, then the position's (Claude Code only), then the engine's. */
export function effectiveModel(agent: Pick<AgentView, 'model' | 'provider' | 'position'>, defaults: ModelDefaults | null): Details['model'] {
  const own = agent.model?.trim();
  if (own) return { name: own, from: 'console' };
  if (defaults === null || providerInfo(agent.provider).model === null) return null;
  const byPosition = agent.provider === 'claude' && agent.position !== null ? defaults.positions?.[agent.position] : undefined;
  if (byPosition) return { name: byPosition, from: 'position' };
  const room = defaults.models[agent.provider];
  return room ? { name: room, from: 'room' } : null;
}

export function detailsOf(agent: Pick<AgentView, 'model' | 'provider' | 'position' | 'effort'>, defaults: ModelDefaults | null): Details {
  return { engine: providerInfo(agent.provider).label, model: effectiveModel(agent, defaults), effort: agent.effort ?? null };
}

const SOURCE_TEXT: Readonly<Record<ModelSource, string>> = { console: '', position: ' · position default', room: ' · room default' };

/** The model chip's text: `sonnet`, or `sonnet · room default` when the console did not choose it. */
export const modelText = (model: NonNullable<Details['model']>): string => `${model.name}${SOURCE_TEXT[model.from]}`;

/** One line for a place that has no chips (the terminal's room list, a label): `Claude Code · sonnet · high`. */
export function detailsLine(d: Details, short = false): string {
  return [short ? d.engine.replace(/ (CLI|Code|Agent)$/, '') : d.engine, d.model === null ? null : short ? d.model.name : modelText(d.model), d.effort].filter((x): x is string => x !== null).join(' · ');
}
