import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTelemetry, TELEMETRY_FILE_SLACK } from '../src/server/telemetry.js';
import type { Telemetry } from '../src/server/telemetry.js';
import { clockText, durationText, telemetryRows } from '../src/client/telemetry.js';
import { TELEMETRY_PER_AGENT } from '../src/shared/protocol.js';
import type { Logger } from '../src/shared/protocol.js';

const quiet: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => quiet } as unknown as Logger;

let home: string;
let clock: number;

const make = async (): Promise<Telemetry> => {
  const t = createTelemetry({ dir: home, now: () => clock, log: quiet });
  await t.load();
  return t;
};
const file = (): Promise<string> => readFile(join(home, 'telemetry.jsonl'), 'utf8').catch(() => '');
const bash = (command: string, id?: string): Record<string, unknown> => ({ tool_name: 'Bash', tool_input: { command }, ...(id ? { tool_use_id: id } : {}) });

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gonogo-telemetry-'));
  clock = 1_000_000;
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('Telemetry recorder', () => {
  it('pairs Pre and Post by tool_use_id, newest first, and marks a failure', async () => {
    const t = await make();
    t.hook('ana', 'PreToolUse', bash('npm test', 't1'));
    clock += 100;
    t.hook('ana', 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/x' }, tool_use_id: 't2' });
    clock += 50;
    t.hook('ana', 'PostToolUseFailure', { tool_name: 'Read', tool_use_id: 't2' });
    clock += 250;
    t.hook('ana', 'PostToolUse', { tool_name: 'Bash', tool_use_id: 't1' });
    expect(t.calls('ana')).toEqual([
      { at: 1_000_100, ms: 50, tool: 'Read', summary: 'Read: /x', failed: true },
      { at: 1_000_000, ms: 400, tool: 'Bash', summary: 'Bash: npm test', failed: false },
    ]);
    expect(t.calls('ben')).toEqual([]);
  });

  it('without an id (Gemini CLI) closes the oldest open call of the same tool; a Post with no Pre is ignored', async () => {
    const t = await make();
    t.hook('gem', 'PostToolUse', { tool_name: 'Bash' });
    t.hook('gem', 'PreToolUse', bash('a'));
    t.hook('gem', 'PreToolUse', bash('b'));
    clock += 10;
    t.hook('gem', 'PostToolUse', { tool_name: 'Bash' });
    expect(t.calls('gem').map((c) => [c.summary, c.ms])).toEqual([
      ['Bash: b', null],
      ['Bash: a', 10],
    ]);
  });

  it('keeps TELEMETRY_PER_AGENT calls per agent', async () => {
    const t = await make();
    for (let i = 0; i < TELEMETRY_PER_AGENT + 5; i += 1) t.hook('ana', 'PreToolUse', bash(`n${i}`));
    const calls = t.calls('ana');
    expect(calls).toHaveLength(TELEMETRY_PER_AGENT);
    expect(calls[0].summary).toBe(`Bash: n${TELEMETRY_PER_AGENT + 4}`);
  });

  it('writes ended calls to telemetry.jsonl and reads them back in start order after a restart', async () => {
    const t = await make();
    t.hook('ana', 'PreToolUse', bash('slow', 's'));
    clock += 5;
    t.hook('ana', 'PreToolUse', bash('fast', 'f'));
    clock += 5;
    t.hook('ana', 'PostToolUse', { tool_name: 'Bash', tool_use_id: 'f' });
    t.hook('ana', 'PreToolUse', bash('never ends', 'n'));
    clock += 5;
    t.hook('ana', 'PostToolUse', { tool_name: 'Bash', tool_use_id: 's' });
    await t.close();
    expect((await file()).trim().split('\n')).toHaveLength(2);
    const again = await make();
    expect(again.calls('ana').map((c) => [c.summary, c.ms])).toEqual([
      ['Bash: fast', 5],
      ['Bash: slow', 15],
    ]);
  });

  it('at start skips a torn line and cuts the file to the kept calls', async () => {
    const lines = Array.from({ length: TELEMETRY_PER_AGENT + 3 }, (_, i) => JSON.stringify({ agent: 'ana', at: i, ms: 1, tool: 'Bash', summary: `Bash: ${i}`, failed: false }));
    await writeFile(join(home, 'telemetry.jsonl'), lines.join('\n') + '\n{"agent":"ana","at":');
    const t = await make();
    await t.close();
    expect(t.calls('ana')).toHaveLength(TELEMETRY_PER_AGENT);
    expect(t.calls('ana').at(-1)?.at).toBe(3);
    expect((await file()).trim().split('\n')).toHaveLength(TELEMETRY_PER_AGENT);
  });

  it('cuts the file back during a run after TELEMETRY_FILE_SLACK appended lines', async () => {
    const t = await make();
    for (let i = 0; i < TELEMETRY_FILE_SLACK; i += 1) {
      t.hook('ana', 'PreToolUse', bash(`n${i}`, `t${i}`));
      t.hook('ana', 'PostToolUse', { tool_name: 'Bash', tool_use_id: `t${i}` });
    }
    await t.close();
    expect((await file()).trim().split('\n')).toHaveLength(TELEMETRY_PER_AGENT);
  });
});

describe('Telemetry rows', () => {
  it('words a duration', () => {
    expect(durationText(null)).toBe('running');
    expect(durationText(340)).toBe('340 ms');
    expect(durationText(4_240)).toBe('4.2 s');
    expect(durationText(185_000)).toBe('3 m 05 s');
  });

  it('prints the local clock', () => {
    expect(clockText(new Date(2026, 10, 18, 9, 3, 7).getTime())).toBe('09:03:07');
  });

  it('splits the tool from the summary, scales the bars to the longest call and keeps the order', () => {
    const rows = telemetryRows([
      { at: 2, ms: null, tool: 'mcp__gonogo__read_messages', summary: 'mcp__gonogo__read_messages', failed: false },
      { at: 1, ms: 1000, tool: 'Bash', summary: 'Bash: npm test', failed: true },
      { at: 0, ms: 10, tool: 'Read', summary: 'Read: /x', failed: false },
    ]);
    expect(rows.map((r) => [r.tool, r.detail, r.duration, r.bar, r.failed])).toEqual([
      ['read_messages', '', 'running', 0, false],
      ['Bash', 'npm test', '1.0 s', 100, true],
      ['Read', '/x', '10 ms', 2, false],
    ]);
  });
});
