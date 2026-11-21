/** The registry picker and the SKILLS block (docs/features/registry.md): what the page offers, what it fills, and what it never does. */
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { HireForm } from '../src/client/HireForm.js';
import { asDefault, checkedText, entriesFor, hasServer, mergeServer, safeSource, serversOf, skillRows, skillsOf } from '../src/client/registry.js';
import { RegistryPicker } from '../src/client/RegistryPicker.js';
import { SkillsBlock } from '../src/client/SkillsBlock.js';
import { emptyState, store } from '../src/client/store.js';
import { REGISTRY, REGISTRY_STALE_DAYS, REGISTRY_WARNINGS } from '../src/shared/registry.js';
import type { AgentView } from '../src/shared/protocol.js';

const server = serversOf(REGISTRY)[0]!;
const withNeeds = serversOf(REGISTRY).find((e) => e.needs.length > 0)!;
const skill = skillsOf(REGISTRY)[0]!;
const draw = (node: ReturnType<typeof createElement>): string => renderToString(node).replace(/<!-- -->/g, '');
const picker = (props: Partial<Parameters<typeof RegistryPicker>[0]> = {}): string => draw(createElement(RegistryPicker, { payload: 'all', has: () => false, onAdd: () => undefined, ...props }));

describe('what an engine is offered', () => {
  it('Claude Code gets servers and skills, an engine with servers only gets no skill, an engine with no payload gets nothing', () => {
    expect(entriesFor('all').map((e) => e.kind)).toContain('skill');
    expect(entriesFor('all')).toHaveLength(REGISTRY.length);
    expect(entriesFor('servers').every((e) => e.kind === 'mcp')).toBe(true);
    expect(entriesFor('servers').length).toBeGreaterThan(0);
    expect(entriesFor(null)).toEqual([]);
  });
  it('every entry of the shipped list links only to https, and a server that needs a key holds its name as a placeholder, never a value', () => {
    for (const entry of REGISTRY) expect(safeSource(entry), entry.id).not.toBeNull();
    for (const entry of serversOf(REGISTRY)) for (const name of entry.needs) expect(JSON.stringify(entry.server), `${entry.id} ${name}`).toContain('${' + name + '}');
  });
  it('refuses a link that is not https', () => {
    expect(safeSource({ ...server, source: 'javascript:alert(1)' })).toBeNull();
    expect(safeSource({ ...server, source: 'http://example.test' })).toBeNull();
    expect(safeSource({ ...server, source: 'https://example.test/a b' })).toBeNull();
  });
});

describe('filling the servers box', () => {
  it('adds the server under its id to an empty box, and keeps what was there, pretty printed', () => {
    const empty = mergeServer('', server);
    expect(empty).toEqual({ ok: true, text: JSON.stringify({ [server.id]: server.server }, null, 2) });
    const mine = '{"mine": {"command": "x"}}';
    const both = mergeServer(mine, server);
    expect(both.ok && JSON.parse(both.text)).toEqual({ mine: { command: 'x' }, [server.id]: server.server });
    expect(mergeServer('   \n', server).ok).toBe(true);
  });
  it('never overwrites a server of the same name (the person may have edited it) and says so', () => {
    const text = JSON.stringify({ [server.id]: { command: 'edited' } });
    expect(mergeServer(text, server)).toEqual({ ok: false, why: 'exists' });
    expect(hasServer(text, server.id)).toBe(true);
    expect(hasServer('', server.id)).toBe(false);
  });
  it('leaves a box that is not a JSON object alone', () => {
    for (const bad of ['{not json', '[1]', '"x"', 'null', '5']) expect(mergeServer(bad, server), bad).toEqual({ ok: false, why: 'not-object' });
    expect(hasServer('{not json', server.id)).toBe(false);
  });
  it('the Payload defaults form gets the name and the JSON of the server', () => {
    expect(asDefault(server)).toEqual({ name: server.id, config: JSON.stringify(server.server, null, 2) });
  });
});

describe('how old a check is', () => {
  const day = 86_400_000;
  const at = Date.parse('2026-11-21T00:00:00Z');
  it('says how many days ago, and warns after the limit the registry names', () => {
    expect(checkedText('2026-11-21', at)).toEqual({ text: 'checked today (2026-11-21)', old: false, days: 0 });
    expect(checkedText('2026-11-21', at + day).text).toBe('checked 1 day ago (2026-11-21)');
    expect(checkedText('2026-11-21', at + REGISTRY_STALE_DAYS * day).old).toBe(false);
    const old = checkedText('2026-11-21', at + (REGISTRY_STALE_DAYS + 1) * day);
    expect(old).toMatchObject({ old: true, days: REGISTRY_STALE_DAYS + 1 });
    expect(checkedText('not a date', at)).toMatchObject({ old: false, days: 0 });
  });
});

describe('the picker', () => {
  it('a server: its summary, licence, the link to read first, what it needs, a key that fills the box, and that nothing is installed', () => {
    const html = picker({ only: 'mcp' });
    expect(html).toContain('Add from the list');
    expect(html).toContain(server.summary.slice(0, 20));
    expect(html).toContain(`href="${server.source}"`);
    expect(html).toContain('rel="noreferrer noopener"');
    expect(html).toContain(`Add ${server.name} to the box`);
    expect(html).toContain('installs and runs nothing');
    expect(html).toContain('checked ');
    expect(html).toContain(`By ${server.publisher}.`);
  });
  it('a server: what it runs in bold, where it sends, and the registry own warnings verbatim (pin only for stdio, keys only when it needs some)', () => {
    const stdio = serversOf(REGISTRY).find((e) => e.transport === 'stdio' && e.needs.length === 0)!;
    const draw1 = (entry: (typeof REGISTRY)[number]): string => picker({ payload: 'servers', only: 'mcp', now: Date.parse('2026-11-22T00:00:00Z'), first: entry.id });
    const escape = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;');
    const a = draw1(stdio);
    expect(a).toContain(`<strong>${escape(stdio.runs)}</strong>`);
    expect(a).toContain(escape(REGISTRY_WARNINGS.runs));
    expect(a).toContain(escape(REGISTRY_WARNINGS.pin));
    expect(a).toContain(escape(REGISTRY_WARNINGS.descriptions));
    expect(a).not.toContain(escape(REGISTRY_WARNINGS.keys));
    const keyed = serversOf(REGISTRY).find((e) => e.needs.length > 0)!;
    const b = draw1(keyed);
    expect(b).toContain(escape(REGISTRY_WARNINGS.keys));
    expect(b).toContain(keyed.needs[0]!);
    const remote = serversOf(REGISTRY).find((e) => e.transport === 'http');
    if (remote !== undefined) expect(draw1(remote)).not.toContain(escape(REGISTRY_WARNINGS.pin));
    const sends = serversOf(REGISTRY).find((e) => e.sendsTo !== null);
    if (sends !== undefined) expect(draw1(sends)).toContain(`Sends to: ${escape(sends.sendsTo!)}`);
  });

  it('a server already in the box is not added over: the key is disabled and says so', () => {
    const html = picker({ only: 'mcp', has: () => true });
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('is already in the box: edit it there.');
  });
  it('a skill: the line to run yourself, a key that copies it, the folder, and no key that fills a box', () => {
    const html = picker({ only: 'skill' });
    expect(html).toContain('gonogo does not fetch skills');
    expect(html).toContain(skill.install.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
    expect(html).toContain('Copy the line');
    expect(html).toContain(skill.folder);
    expect(html).not.toContain(`Add ${skill.name} to the box`);
  });
  it('an engine with servers only is not offered skills, and one with nothing has no picker', () => {
    expect(picker({ payload: 'servers' })).not.toContain('optgroup label="Skills"');
    expect(picker({ payload: 'servers', only: 'skill' })).toBe('');
  });
  it('a check older than six months is marked', () => {
    const html = picker({ now: Date.parse('2027-12-01T00:00:00Z') });
    expect(html).toContain('it may be out of date');
    expect(html).toContain('Checked more than 90 days ago');
    expect(picker({ now: Date.parse('2026-11-22T00:00:00Z') })).not.toContain('it may be out of date');
  });
});

describe('the hire and edit form', () => {
  const agent = (provider: string): AgentView => ({ name: 'ana', role: 'r', dir: '/w', mode: 'default', desk: 1, boss: false, state: 'idle', provider, model: null, effort: null, position: null, command: null, payload: null, payloadOff: null, cleanRoom: null, worktree: null, history: [], keys: {} }) as unknown as AgentView;
  const open = (provider: string): string => {
    store.setState({ ...emptyState(), agents: { ana: agent(provider) }, form: { mode: 'edit', name: 'ana' } });
    return draw(createElement(HireForm));
  };
  beforeEach(() => store.setState(emptyState()));
  it('the Payload fold of a Claude Code agent has the picker; one of an engine with no payload has no fold', () => {
    expect(open('claude')).toContain('Add from the list');
    expect(open('codex')).not.toContain('Add from the list');
  });
});

describe('who uses which skill', () => {
  const a = (name: string, patch: Record<string, unknown> = {}): Parameters<typeof skillRows>[1][number] => ({ name, provider: 'claude', ...patch }) as never;
  const room = [{ name: 'review', path: '/s/review' }, { name: 'triage', path: '/s/triage' }];
  it('lists the room skills first, with who gets each, who has one of its own, and who switched it off', () => {
    const rows = skillRows(room, [a('ana'), a('ben', { payload: { skills: ['/mine/review'] } }), a('cy', { payloadOff: { skills: ['triage'] } }), a('dot', { cleanRoom: {} }), a('eve', { provider: 'codex' })]);
    const review = rows.find((r) => r.name === 'review')!;
    expect(review).toMatchObject({ room: true, own: ['ben'], gets: ['ana', 'cy'], off: [] });
    expect(review.paths).toEqual(['/s/review', '/mine/review']);
    expect(rows.find((r) => r.name === 'triage')).toMatchObject({ off: ['cy'], gets: ['ana', 'ben'] });
  });
  it('an agent\'s own skill that is not the room\'s is its own row, after the room\'s', () => {
    const rows = skillRows(room, [a('ana', { payload: { skills: ['/mine/extra/'] } })]);
    expect(rows.map((r) => r.name)).toEqual(['review', 'triage', 'extra']);
    expect(rows[2]).toMatchObject({ room: false, own: ['ana'], gets: [] });
  });
  it('a switch for a skill the room does not have makes no row', () => {
    expect(skillRows([], [a('ana', { payloadOff: { skills: ['gone'] } })])).toEqual([]);
  });
});

describe('the SKILLS block', () => {
  it('draws its title and what a skill is before the room answers, and never a folder it has not been told of', () => {
    const html = draw(createElement(SkillsBlock));
    expect(html).toContain('SKILLS');
    expect(html).toContain('never copies or downloads one');
    expect(html).not.toContain('<textarea');
  });
});
