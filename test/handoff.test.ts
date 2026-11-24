/** Engine switch handoff (src/server/handoff.ts): the last turns of the old engine's transcript, for the first session of the new one. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeTurns, HANDOFF_CHARS, HANDOFF_TURNS, handoffMarker, handoffNote, handoffText, lastTurns, opencodeTurns, piTurns, readTranscript } from '../src/server/handoff.js';

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'gonogo-handoff-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const j = (value: unknown): string => JSON.stringify(value);
const CLAUDE = [
  j({ type: 'user', message: { role: 'user', content: 'Fix the login bug.' } }),
  j({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Looking at auth.ts.' }, { type: 'tool_use', name: 'Read' }] } }),
  j({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'file text' }] } }),
  j({ type: 'user', isMeta: true, message: { role: 'user', content: 'meta' } }),
  j({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: 'a subagent' } }),
  j({ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } }),
  '{"type":"assistant","mess',
  j({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed: the token expired early.' }] } }),
];

describe('reading transcripts', () => {
  it('Claude Code: user and assistant text only (no tools, thinking, meta, subagents, slash commands or a cut line)', () => {
    expect(claudeTurns(CLAUDE)).toStrictEqual([
      { role: 'user', text: 'Fix the login bug.' },
      { role: 'assistant', text: 'Looking at auth.ts.' },
      { role: 'assistant', text: 'Fixed: the token expired early.' },
    ]);
  });

  it('pi: the path from the last entry to the root, so an abandoned branch is left out', () => {
    const lines = [
      j({ type: 'session', version: 3, id: 'sid', cwd: '/w' }),
      j({ type: 'message', id: 'a', parentId: null, message: { role: 'system', content: 'sys' } }),
      j({ type: 'message', id: 'b', parentId: 'a', message: { role: 'user', content: 'first' } }),
      j({ type: 'message', id: 'c', parentId: 'b', message: { role: 'assistant', content: [{ type: 'text', text: 'old branch' }] } }),
      j({ type: 'message', id: 'd', parentId: 'b', message: { role: 'assistant', content: [{ type: 'text', text: 'new branch' }] } }),
      j({ type: 'message', id: 'e', parentId: 'd', message: { role: 'toolResult', content: [{ type: 'text', text: 'tool out' }] } }),
    ];
    expect(piTurns(lines)).toStrictEqual([
      { role: 'user', text: 'first' },
      { role: 'assistant', text: 'new branch' },
    ]);
  });

  it('opencode: the export after its own lines, text parts only, synthetic ones and tool parts left out; only a session recorded for this sessionId', async () => {
    const exported = 'Exporting session: ses_1\n' + JSON.stringify({ info: { id: 'ses_1' }, messages: [
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'go' }, { type: 'text', text: 'context', synthetic: true }] },
      { info: { role: 'assistant' }, parts: [{ type: 'tool', tool: 'bash' }, { type: 'text', text: 'done' }] },
    ] });
    expect(opencodeTurns(exported)).toStrictEqual([{ role: 'user', text: 'go' }, { role: 'assistant', text: 'done' }]);
    expect(opencodeTurns('no json')).toStrictEqual([]);
    const asked: string[] = [];
    const exportOpencode = async (id: string): Promise<string> => { asked.push(id); return exported; };
    const side = { name: 'ana', provider: 'opencode' as const, sessionId: 's1', engineSession: { for: 's1', id: 'ses_1' } };
    expect((await readTranscript(side, { agentDir: tmp, exportOpencode }))?.turns).toHaveLength(2);
    expect(await readTranscript({ ...side, engineSession: { for: 'old', id: 'ses_1' } }, { agentDir: tmp, exportOpencode })).toBeNull();
    expect(asked).toStrictEqual(['ses_1']);
  });

  it('finds Claude Code\'s file by session id under projects/, and pi\'s in the agent\'s pi-sessions', async () => {
    const claude = join(tmp, 'claude');
    await mkdir(join(claude, 'projects', '-w-proj'), { recursive: true });
    await writeFile(join(claude, 'projects', '-w-proj', 'sid-1.jsonl'), CLAUDE.join('\n'));
    const found = await readTranscript({ name: 'ana', sessionId: 'sid-1' }, { agentDir: join(tmp, 'agent'), claudeConfigDir: claude });
    expect(found?.path).toBe(join(claude, 'projects', '-w-proj', 'sid-1.jsonl'));
    expect(found?.turns).toHaveLength(3);
    await mkdir(join(tmp, 'agent', 'pi-sessions', '--w--'), { recursive: true });
    await writeFile(join(tmp, 'agent', 'pi-sessions', '--w--', '2026-01-01_sid-2.jsonl'), j({ type: 'message', id: 'a', parentId: null, message: { role: 'user', content: 'hi' } }));
    expect((await readTranscript({ name: 'ana', provider: 'pi', sessionId: 'sid-2' }, { agentDir: join(tmp, 'agent') }))?.turns).toStrictEqual([{ role: 'user', text: 'hi' }]);
    expect(await readTranscript({ name: 'ana', provider: 'pi', sessionId: 'none' }, { agentDir: join(tmp, 'agent') })).toBeNull();
    expect(await readTranscript({ name: 'ana', provider: 'codex', sessionId: 'sid-1' }, { agentDir: join(tmp, 'agent') })).toBeNull();
  });
});

describe('the handoff file', () => {
  it('keeps the newest turns within the limits, oldest first, and cuts a long one', () => {
    const many = Array.from({ length: HANDOFF_TURNS + 10 }, (_, i) => ({ role: 'user' as const, text: `t${i}` }));
    const kept = lastTurns(many);
    expect(kept).toHaveLength(HANDOFF_TURNS);
    expect(kept[kept.length - 1]?.text).toBe(`t${HANDOFF_TURNS + 9}`);
    const big = lastTurns([{ role: 'user', text: 'x'.repeat(HANDOFF_CHARS * 2) }]);
    expect(big[0]?.text.length).toBeLessThan(5_000);
    expect(big[0]?.text).toContain('cut:');
  });

  it('names the session it is for, both engines, the transcript and the turns; the note goes to that session only', () => {
    const text = handoffText({ name: 'ana', sessionId: 'old' }, { name: 'ana', provider: 'pi', sessionId: 'new' }, { path: '/t.jsonl', turns: claudeTurns(CLAUDE) }, new Date(0));
    expect(text.startsWith(handoffMarker('new'))).toBe(true);
    expect(text).toContain('running on Claude Code');
    expect(text).toContain('moved you to pi');
    expect(text).toContain('/t.jsonl');
    expect(text).toContain('## User\n\nFix the login bug.');
    expect(text).toContain('## You\n\nFixed: the token expired early.');
    expect(handoffNote(text, 'new', '/a/handoff.md')).toContain('/a/handoff.md');
    expect(handoffNote(text, 'other', '/a/handoff.md')).toBeNull();
    expect(handoffNote(null, 'new', '/a/handoff.md')).toBeNull();
  });

  it('says so when the old transcript cannot be read', () => {
    const text = handoffText({ name: 'ana', provider: 'codex', sessionId: 'old' }, { name: 'ana', sessionId: 'new' }, null, new Date(0));
    expect(text).toContain('cannot read the transcript of Codex');
  });
});
