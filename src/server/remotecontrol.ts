/**
 * Remote Control (docs/phone-approvals-spec.md, Path B): a Claude Code agent started with `--remote-control gonogo-<name>`, so
 * the Director can open its session in the Claude app and approve there. gonogo gets nothing back through that channel.
 */
import type { Provider, RemoteControl } from '../shared/protocol.js';

export type RemoteControlCheck = { ok: true; remoteControl: RemoteControl } | { ok: false; error: string };

/** The one reader of the setting: the hub for hire and edit, home.ts for the roster file. `{}` is the only value. It needs Claude Code, and not a Clean Room (its token cannot open a session in the app). */
export function parseRemoteControl(value: unknown, provider: Provider | undefined, cleanRoom: boolean): RemoteControlCheck {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, error: 'remoteControl must be an object' };
  const unknown = Object.keys(value).find((key) => (value as Record<string, unknown>)[key] !== undefined);
  if (unknown !== undefined) return { ok: false, error: `remoteControl has no field "${unknown}"` };
  if ((provider ?? 'claude') !== 'claude') return { ok: false, error: 'Remote Control is for Claude Code agents only' };
  if (cleanRoom) return { ok: false, error: 'a Clean Room agent cannot use Remote Control: it has no claude.ai login' };
  return { ok: true, remoteControl: {} };
}

/** The session name the app shows. */
export const remoteControlName = (agent: string): string => `gonogo-${agent}`;
