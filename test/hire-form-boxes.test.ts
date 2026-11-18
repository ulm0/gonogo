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
