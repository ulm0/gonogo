/** The hire and edit forms each show the worktree box and the tool rules fold exactly once. */
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { HireForm } from '../src/client/HireForm.js';
import { openEdit, openHire, store } from '../src/client/store.js';
import type { AgentView } from '../src/shared/protocol.js';

const count = (html: string, text: string): number => html.split(text).length - 1;
const agent = { name: 'ana', role: 'r', dir: '/w', mode: 'default', provider: 'claude', boss: false, state: 'idle' } as unknown as AgentView;

afterEach(() => store.setState((s) => ({ ...s, form: null, agents: {} }) as never));

describe('the staffing forms', () => {
  it('hire shows Own git worktree and TOOL PERMISSIONS once', () => {
    openHire();
    const html = renderToString(createElement(HireForm));
    expect(count(html, 'Own git worktree')).toBe(1);
    expect(count(html, 'TOOL PERMISSIONS')).toBe(1);
  });

  it('edit shows them once, not twice', () => {
    store.setState((s) => ({ ...s, agents: { ana: agent } }) as never);
    openEdit('ana');
    const html = renderToString(createElement(HireForm));
    expect(count(html, 'Own git worktree')).toBe(1);
    expect(count(html, 'TOOL PERMISSIONS')).toBe(1);
  });
});

describe('MORE SETTINGS of the staffing forms', () => {
  const more = (html: string): string => /<details class="staff-fold staff-more"[^>]*>/.exec(html)?.[0] ?? '';
  const at = (html: string, text: string): number => html.indexOf(text);

  it('a new console shows engine, name, folder up front, and the optional rest folded', () => {
    openHire();
    const html = renderToString(createElement(HireForm));
    expect(more(html)).not.toBe('');
    expect(more(html)).not.toContain('open');
    expect(at(html, 'Working directory')).toBeLessThan(at(html, 'MORE SETTINGS'));
    expect(at(html, 'MORE SETTINGS')).toBeLessThan(at(html, 'Own git worktree'));
    // no position: the role is not filled in, so it stays up front
    expect(at(html, '>Role<')).toBeLessThan(at(html, 'MORE SETTINGS'));
  });

  it('a seeded position carries its role, which goes under MORE SETTINGS', () => {
    openHire('fao');
    const html = renderToString(createElement(HireForm));
    expect(at(html, '>Role<')).toBeGreaterThan(at(html, 'MORE SETTINGS'));
  });

  it('editing an agent with the defaults keeps the fold closed; one with a model set opens it', () => {
    store.setState((s) => ({ ...s, agents: { ana: agent } }) as never);
    openEdit('ana');
    expect(more(renderToString(createElement(HireForm)))).not.toContain('open');
    store.setState((s) => ({ ...s, agents: { ana: { ...agent, model: 'opus' } } }) as never);
    openEdit('ana');
    expect(more(renderToString(createElement(HireForm)))).toContain('open');
  });
});

describe('differsFromDefault and the role', () => {
  it('a seated agent with the text of its position does not differ; one with a rewritten role does', async () => {
    const { differsFromDefault, initialValues } = await import('../src/client/form.js');
    const base = initialValues({ mode: 'hire', position: 'fao' }, null, {}, '/w');
    expect(differsFromDefault(base, 0)).toBe(false);
    expect(differsFromDefault({ ...base, role: `${base.role} Also review.` }, 0)).toBe(true);
    // no position: the role is up front, not in the fold
    expect(differsFromDefault({ ...base, position: '', role: 'mine' }, 0)).toBe(false);
  });
});
