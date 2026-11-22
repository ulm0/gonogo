/** The words of the Runtime settings row of Flight Rules (docs/runtime-settings-spec.md): what each setting is called and says, where its value comes from, when it applies, and what a refusal means. */
import type { RuntimeSettingKey, RuntimeSettingRow, RuntimeSettingScope } from '../shared/protocol.js';

export interface SettingText {
  label: string;
  help: string;
  /** How the value is typed: a field, or a choice of fixed words. */
  input: { kind: 'text'; placeholder: string } | { kind: 'choice'; options: readonly string[] };
  /** A plain warning shown with the editor, for a setting that decides what runs or what an agent can see. */
  warning?: string;
}

export const SETTING_TEXT: Readonly<Record<RuntimeSettingKey, SettingText>> = {
  maxHops: { label: 'Message hops', help: 'How many times a message may be passed on from agent to agent before gonogo stops it. The built-in limit is 8.', input: { kind: 'text', placeholder: 'a number from 1 to 100' } },
  maxWorking: { label: 'Max Q', help: 'How many Claude agents may work at once. Empty means no limit. The Max Q control of the room is this same setting.', input: { kind: 'text', placeholder: 'a number, or empty for no limit' } },
  agentCmd: {
    label: 'Agent command',
    help: 'The program that runs an agent, in place of claude. Read at the next start of an agent; the ones that are running keep theirs.',
    input: { kind: 'text', placeholder: 'e.g. claude, or a wrapper' },
    warning: 'This command runs with the agents’ rights, for every agent it reaches. Only your own signed-in session can change it.',
  },
  cleanRoomImage: { label: 'Clean Room image', help: 'The Docker image a Clean Room agent runs in. Read at the next start of a Clean Room agent.', input: { kind: 'text', placeholder: 'an image name or id' } },
  scrubEnv: {
    label: 'Scrubbed variables',
    help: 'Names of environment variables kept away from every agent, on top of the built-in list: names only, separated by commas (a name ending in _ is a prefix), never values. It can add to the list, not take from it.',
    input: { kind: 'text', placeholder: 'e.g. AWS_, MY_TOKEN' },
    warning: 'A name left out of the scrub reaches every agent. Only your own signed-in session can change it.',
  },
  logLevel: { label: 'Log level', help: 'How much gonogo writes to its log. It is one setting for all rooms.', input: { kind: 'choice', options: ['debug', 'info', 'warn', 'error'] } },
  station: { label: 'Station name', help: 'How this gonogo is named to the stations it docks with. It is one setting for all rooms.', input: { kind: 'text', placeholder: 'a name of up to 31 characters' } },
  updateCheck: { label: 'Update check', help: 'Whether gonogo asks the npm registry once a day for a newer version. It is one setting for all rooms.', input: { kind: 'choice', options: ['on', 'off'] } },
};

export const SOURCE_TEXT: Readonly<Record<RuntimeSettingRow['source'], string>> = { room: 'this room', global: 'all rooms', env: 'environment', default: 'built-in default' };

export const APPLIES_TEXT: Readonly<Record<RuntimeSettingRow['applies'], string>> = {
  live: 'applies at once',
  'next-start': 'applies at the next start of an agent',
  restart: 'needs a restart of gonogo',
};

/** What the value is, in words: an empty Max Q is "no limit"; nothing set anywhere is "not set" (the chip beside it says it is the built-in default). */
export function valueText(row: Pick<RuntimeSettingRow, 'key' | 'value'>): string {
  if (row.value === null) return 'not set';
  if (row.value === '') return row.key === 'maxWorking' ? 'no limit' : 'empty';
  return row.value;
}

/** The layer an editor opens on: the one that has a value of its own, this room's first; a setting for all rooms only is always that one. */
export function startScope(row: Pick<RuntimeSettingRow, 'scope' | 'room' | 'global'>): RuntimeSettingScope {
  if (row.scope === 'global') return 'global';
  if (row.room !== null) return 'room';
  return row.global !== null ? 'global' : 'room';
}

/** What a layer holds, for the field (an unset layer starts empty). */
export const layerValue = (row: Pick<RuntimeSettingRow, 'room' | 'global'>, scope: RuntimeSettingScope): string => (scope === 'room' ? row.room : row.global) ?? '';

/** Whether Reset has something to remove: the layer in question holds a value. */
export const canReset = (row: Pick<RuntimeSettingRow, 'room' | 'global'>, scope: RuntimeSettingScope): boolean => (scope === 'room' ? row.room : row.global) !== null;

/** The line of the row of Flight Rules: how many settings are changed from the built-in or the environment. */
export function summary(rows: readonly Pick<RuntimeSettingRow, 'source'>[]): string {
  const changed = rows.filter((r) => r.source === 'room' || r.source === 'global').length;
  return changed === 0 ? 'all as the environment has them' : `${changed} changed here`;
}

/** A refusal in words: the parser's reason as it is; a 403 that is not a step-up; the 409 of a room started by hand. */
export function refusalText(error: { message: string; status?: number }, scope: RuntimeSettingScope): string {
  if (error.status === 403) return 'Only the owner’s own signed-in session can change this.';
  if (error.status === 409 && scope === 'global') return 'This room was started by hand, without the supervisor, so there is no setting for all rooms to change. Change it for this room.';
  return error.message;
}
