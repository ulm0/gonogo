/** The link to the online docs on the page: the Commissioning checklist, drawn to a string. */
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultView } from '../src/shared/livery.js';
import { DOCS_URL } from '../src/shared/protocol.js';
import type { AgentView } from '../src/shared/protocol.js';
import { Commissioning } from '../src/client/Rules.js';
import { applyServerFrame, emptyState, NO_PROPELLANT, store } from '../src/client/store.js';

afterEach(() => store.setState(emptyState()));

describe('the docs link on the page', () => {
  it('is in the Commissioning checklist, opening a new tab without an opener', () => {
    const flight = { name: 'flight', desk: 0, boss: true, state: 'idle', position: 'flight', provider: 'claude' } as AgentView;
    store.setState(applyServerFrame(emptyState(), { t: 'state', state: { agents: [flight], activity: [], info: { cwd: '/' }, poll: null, governor: { limit: null, working: 0, holding: 0 }, propellant: NO_PROPELLANT, schedules: [], uplinks: [], tasks: [], downlink: { unread: 0, items: [] }, livery: defaultView() } } as never, 1));
    const out = renderToString(createElement(Commissioning));
    expect(out).toContain(`href="${DOCS_URL}"`);
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('target="_blank"');
  });
});
