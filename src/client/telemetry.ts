import type { ToolCall } from '../shared/protocol.js';
import { splitReason, toolText } from './room.js';

// Telemetry (docs/telemetry-spec.md): the rows of an agent's tool-call waterfall, kept out of the component for the tests.

/** The panel asks the server again this often while Telemetry is open. */
export const TELEMETRY_REFRESH_MS = 5000;

/** `340 ms`, `4.2 s`, `3 m 05 s`; a call with no end yet reads `running`. */
export function durationText(ms: number | null): string {
  if (ms === null) return 'running';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)} m ${String(s % 60).padStart(2, '0')} s`;
}

/** The start time on the local clock, `14:03:27`. */
export function clockText(at: number): string {
  const d = new Date(at);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

export interface TelemetryRow {
  key: string;
  time: string;
  duration: string;
  tool: string;
  /** The summary without the tool's name; empty when the summary is only the name. */
  detail: string;
  failed: boolean;
  /** The bar's width, 2 to 100 % of the longest call in the list; 0 for a call that has not ended. */
  bar: number;
}

/** The calls as the panel shows them, in the server's order (newest first). */
export function telemetryRows(calls: readonly ToolCall[]): TelemetryRow[] {
  const longest = Math.max(1, ...calls.map((c) => c.ms ?? 0));
  return calls.map((c, i) => {
    const { tool, detail } = splitReason(c.summary);
    return {
      key: `${c.at}:${i}`,
      time: clockText(c.at),
      duration: durationText(c.ms),
      tool: toolText(c.tool),
      detail: tool === null && c.summary === c.tool ? '' : detail,
      failed: c.failed,
      bar: c.ms === null ? 0 : Math.max(2, Math.round((c.ms / longest) * 100)),
    };
  });
}
