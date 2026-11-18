/**
 * Telemetry: the tool calls of each agent, from the hooks gonogo already receives (docs/telemetry-spec.md).
 *
 * A PreToolUse opens a call; the PostToolUse or PostToolUseFailure with the same `tool_use_id` closes it (Gemini CLI sends
 * no id: the oldest open call of the same tool is closed). Each agent keeps its newest TELEMETRY_PER_AGENT calls in memory.
 * A closed call is appended to telemetry.jsonl; at start the file is read back and rewritten with only the kept calls,
 * and during a run it is rewritten the same way once it holds TELEMETRY_FILE_SLACK more lines than were kept.
 *
 * shortcut: calls are keyed by agent name, so a renamed agent starts an empty list and a removed agent's calls stay on disk
 * (at most TELEMETRY_PER_AGENT per name); key by record id and drop them on remove if that ever matters.
 */
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TELEMETRY_PER_AGENT } from '../shared/protocol.js';
import type { HookEvent, Logger, ToolCall } from '../shared/protocol.js';
import { FILE_MODE } from './constants.js';
import { describeDoing } from './hub.js';

const FILE = 'telemetry.jsonl';
/** Lines appended since the last rewrite before the file is cut back to the kept calls. */
export const TELEMETRY_FILE_SLACK = 2000;

interface Open extends ToolCall {
  id: string | null;
}

export interface TelemetryOptions {
  /** gonogo's home: telemetry.jsonl lives here. */
  dir: string;
  now(): number;
  log: Logger;
}

export interface Telemetry {
  load(): Promise<void>;
  hook(agent: string, event: HookEvent, payload: Record<string, unknown>): void;
  /** Newest first. An unknown agent has none. */
  calls(agent: string): ToolCall[];
  close(): Promise<void>;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

function isCall(v: unknown): v is ToolCall & { agent: string } {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return typeof c.agent === 'string' && typeof c.at === 'number' && (c.ms === null || typeof c.ms === 'number') && typeof c.tool === 'string' && typeof c.summary === 'string' && typeof c.failed === 'boolean';
}

const plain = (c: Open): ToolCall => ({ at: c.at, ms: c.ms, tool: c.tool, summary: c.summary, failed: c.failed });

export function createTelemetry(options: TelemetryOptions): Telemetry {
  const { now, log } = options;
  const path = join(options.dir, FILE);
  /** Agent to its calls, oldest first, at most TELEMETRY_PER_AGENT. */
  const byAgent = new Map<string, Open[]>();
  let appended = 0;
  let chain: Promise<void> = Promise.resolve();
  const later = (step: () => Promise<void>): void => {
    chain = chain.then(step).catch((error: unknown) => log.warn(`${FILE} could not be written`, error));
  };

  const push = (agent: string, call: Open): void => {
    const list = byAgent.get(agent) ?? [];
    list.push(call);
    if (list.length > TELEMETRY_PER_AGENT) list.splice(0, list.length - TELEMETRY_PER_AGENT);
    byAgent.set(agent, list);
  };

  const snapshot = (): string =>
    [...byAgent].flatMap(([agent, list]) => list.filter((c) => c.ms !== null).map((c) => JSON.stringify({ agent, ...plain(c) }) + '\n')).join('');

  return {
    async load() {
      let text = '';
      try {
        text = await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`${FILE} could not be read; telemetry starts empty`, error);
        return;
      }
      const read: Array<ToolCall & { agent: string }> = [];
      for (const line of text.split('\n')) {
        if (line === '') continue;
        try {
          const v: unknown = JSON.parse(line);
          if (isCall(v)) read.push(v);
        } catch {
          // a torn last line after a crash: skipped
        }
      }
      // lines are written when a call ends; the list is in start order
      for (const v of read.sort((x, y) => x.at - y.at)) push(v.agent, { at: v.at, ms: v.ms, tool: v.tool, summary: v.summary, failed: v.failed, id: null });
      const kept = snapshot();
      if (kept !== text) later(() => writeFile(path, kept, { mode: FILE_MODE }));
    },

    hook(agent, event, payload) {
      const tool = str(payload.tool_name) ?? 'tool';
      const id = str(payload.tool_use_id);
      if (event === 'PreToolUse') {
        push(agent, { id, at: now(), ms: null, tool, summary: describeDoing(payload.tool_name, payload.tool_input), failed: false });
        return;
      }
      if (event !== 'PostToolUse' && event !== 'PostToolUseFailure') return;
      const list = byAgent.get(agent) ?? [];
      const call = id !== null ? list.find((c) => c.id === id && c.ms === null) : list.find((c) => c.ms === null && c.tool === tool);
      if (call === undefined) return;
      call.ms = Math.max(0, now() - call.at);
      call.failed = event === 'PostToolUseFailure';
      appended += 1;
      if (appended >= TELEMETRY_FILE_SLACK) {
        appended = 0;
        const kept = snapshot();
        later(() => writeFile(path, kept, { mode: FILE_MODE }));
      } else {
        const line = JSON.stringify({ agent, ...plain(call) }) + '\n';
        later(() => appendFile(path, line, { mode: FILE_MODE }));
      }
    },

    calls(agent) {
      return (byAgent.get(agent) ?? []).map(plain).reverse();
    },

    close() {
      return chain;
    },
  };
}
