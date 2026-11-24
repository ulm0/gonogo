/** Engine switch handoff (src/server/handoff.ts): the last turns of the old engine's transcript, for the first session of the new one. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newestOpencodeSession, claudeTurns, HANDOFF_CHARS, HANDOFF_TURNS, handoffMarker, handoffNote, handoffText, lastTurns, opencodeTurns, piTurns, readTranscript } from '../src/server/handoff.js';

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

  it('opencode 2: the export of `session export`, the text of the user and the assistant only (reasoning, tools and synthetic notes left out); only a session recorded for this sessionId', async () => {
    const exported = 'Exporting session: ses_1\n' + JSON.stringify({ info: { id: 'ses_1' }, messages: [
      { type: 'user', text: 'go', files: [] },
      { type: 'synthetic', payload: { text: 'a note' } },
      { type: 'assistant', content: [{ type: 'reasoning', text: 'hmm' }, { type: 'tool', name: 'shell' }, { type: 'text', text: 'done' }] },
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

describe('sessions that gonogo did not name (an older version): found by the folder and the time', () => {
  const NOW = Date.parse('2026-11-24T12:00:00Z');
  const piLine = (cwd: string): string => j({ type: 'session', version: 3, id: 'x', cwd });
  const piMsg = (text: string): string => j({ type: 'message', id: 'a', parentId: null, message: { role: 'user', content: text } });
  const at = async (path: string, ms: number): Promise<void> => (await import('node:fs/promises')).utimes(path, new Date(ms), new Date(ms));

  it('pi: the newest session in its own folder that was started in this working folder, not after the switch; a session of another folder is not it', async () => {
    const piDir = join(tmp, 'pi');
    await mkdir(join(piDir, 'sessions', '--w--'), { recursive: true });
    await mkdir(join(piDir, 'sessions', '--other--'), { recursive: true });
    const old = join(piDir, 'sessions', '--w--', 'a.jsonl');
    const newer = join(piDir, 'sessions', '--w--', 'b.jsonl');
    const later = join(piDir, 'sessions', '--w--', 'c.jsonl');
    const foreign = join(piDir, 'sessions', '--other--', 'd.jsonl');
    await writeFile(old, [piLine('/w'), piMsg('first')].join('\n'));
    await writeFile(newer, [piLine('/w'), piMsg('second')].join('\n'));
    await writeFile(later, [piLine('/w'), piMsg('after the switch')].join('\n'));
    await writeFile(foreign, [piLine('/elsewhere'), piMsg('not mine')].join('\n'));
    await at(old, NOW - 3_600_000);
    await at(newer, NOW - 600_000);
    await at(later, NOW + 3_600_000);
    await at(foreign, NOW - 10_000);
    const side = { name: 'ana', provider: 'pi' as const, sessionId: 'not-in-the-agents-folder' };
    const found = await readTranscript(side, { agentDir: join(tmp, 'agent'), cwd: '/w', piDir, until: NOW });
    expect(found?.path).toBe(newer);
    expect(found?.turns).toStrictEqual([{ role: 'user', text: 'second' }]);
    // the session gonogo named wins over the guess
    await mkdir(join(tmp, 'agent', 'pi-sessions'), { recursive: true });
    await writeFile(join(tmp, 'agent', 'pi-sessions', '2026_not-in-the-agents-folder.jsonl'), [piLine('/w'), piMsg('named')].join('\n'));
    expect((await readTranscript(side, { agentDir: join(tmp, 'agent'), cwd: '/w', piDir, until: NOW }))?.turns).toStrictEqual([{ role: 'user', text: 'named' }]);
    // no working folder or no folder of pi's: nothing is guessed
    expect(await readTranscript({ ...side, sessionId: 'x' }, { agentDir: join(tmp, 'agent2'), piDir })).toBeNull();
  });

  it('Claude Code: the newest session of the folder\'s project when the session id has no file', async () => {
    const claude = join(tmp, 'claude');
    await mkdir(join(claude, 'projects', '-w-proj'), { recursive: true });
    const file = join(claude, 'projects', '-w-proj', 'other-id.jsonl');
    await writeFile(file, CLAUDE.join('\n'));
    await at(file, NOW - 1000);
    const found = await readTranscript({ name: 'ana', sessionId: 'unknown-id' }, { agentDir: tmp, claudeConfigDir: claude, cwd: '/w/proj', until: NOW });
    expect(found?.path).toBe(file);
    expect(found?.turns).toHaveLength(3);
    expect(await readTranscript({ name: 'ana', sessionId: 'unknown-id' }, { agentDir: tmp, claudeConfigDir: claude, cwd: '/w/other', until: NOW })).toBeNull();
  });

  it('opencode: with no recorded id, the newest session of this folder created before the switch, from `opencode session list`', async () => {
    const listing = 'noise\n' + JSON.stringify([
      { id: 'ses_new', updated: 3000, created: 2000, directory: '/w' },
      { id: 'ses_other', updated: 9000, created: 8000, directory: '/elsewhere' },
      { id: 'ses_old', updated: 1500, created: 1000, directory: '/w' },
      { id: 'ses_future', updated: 99_000, created: 98_000, directory: '/w' },
    ]);
    expect(newestOpencodeSession(listing, '/w', 5000)).toBe('ses_new');
    expect(newestOpencodeSession(listing, '/nowhere', 5000)).toBeNull();
    expect(newestOpencodeSession('not json', '/w', 5000)).toBeNull();
    const exported = JSON.stringify({ messages: [{ type: 'user', text: 'hi' }] });
    const asked: string[] = [];
    const found = await readTranscript({ name: 'ana', provider: 'opencode', sessionId: 's' }, { agentDir: tmp, cwd: '/w', until: 5000, listOpencode: async () => listing, exportOpencode: async (id) => (asked.push(id), exported) });
    expect(found?.turns).toStrictEqual([{ role: 'user', text: 'hi' }]);
    expect(asked).toStrictEqual(['ses_new']);
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
    // the recap names the engines and the time, in one line
    expect(handoffNote(text, 'new', '/a/handoff.md')).toContain('moved you from Claude Code (until 1970-01-01T00:00:00.000Z) to pi: this is a new session');
    expect(handoffNote(text, 'other', '/a/handoff.md')).toBeNull();
    expect(handoffNote(null, 'new', '/a/handoff.md')).toBeNull();
  });

  it('says so when the old transcript cannot be read', () => {
    const text = handoffText({ name: 'ana', provider: 'codex', sessionId: 'old' }, { name: 'ana', sessionId: 'new' }, null, new Date(0));
    expect(text).toContain('cannot read the transcript of Codex');
  });
});
