/** The HISTORY tab (docs/features/triggers.md): the filter and its query, the links from the cards, the tab, and what a row says. */
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import type { TriggerEntry } from '../src/shared/protocol.js';
import { LaunchWindow } from '../src/client/LaunchWindow.js';
import { setLaunchTab, showHistory, store } from '../src/client/store.js';
import { filterOf, lineOf, NO_FILTER, queryOf, sourcesOf, toneOf } from '../src/client/triggers.js';

afterEach(() => store.setState((s) => ({ ...s, launchTab: 'triggers', historyFilter: NO_FILTER, view: 'room' })));

const entry = (over: Partial<TriggerEntry> = {}): TriggerEntry => ({ at: 1, kind: 'uplink', source: 'u1', name: 'GitHub', outcome: 'queued', what: 'push to main', ...over });

describe('the filter', () => {
  it('becomes the query of GET /api/triggers, with only what is set, and a limit', () => {
    expect(queryOf(NO_FILTER)).toBe('limit=100');
    expect(queryOf({ kind: 'schedule', source: 's1', outcome: 'failed' }, 20)).toBe('kind=schedule&source=s1&outcome=failed&limit=20');
  });

  it('drops anything a link could carry that is not a kind, an id or an outcome', () => {
    expect(filterOf({ kind: 'nonsense' as never, source: '../etc', outcome: 'a b' })).toEqual(NO_FILTER);
    expect(filterOf({ kind: 'docking', source: 'u1', outcome: 'refused' })).toEqual({ kind: 'docking', source: 'u1', outcome: 'refused' });
  });

  it('a card\'s History link opens the tab filtered to its own source; the tab can be left again', () => {
    showHistory({ kind: 'schedule', source: 's3' });
    expect(store.getState()).toMatchObject({ view: 'window', launchTab: 'history', historyFilter: { kind: 'schedule', source: 's3', outcome: '' } });
    setLaunchTab('triggers');
    expect(store.getState().launchTab).toBe('triggers');
    showHistory();
    expect(store.getState().historyFilter).toEqual(NO_FILTER);
  });
});

describe('the rows', () => {
  it('say what, to whom and which message; an outcome that went wrong is the red one', () => {
    expect(lineOf(entry({ agent: 'ana', message: 'm7' }))).toBe('push to main · to ana · m7');
    expect(lineOf(entry({ what: '' }))).toBe('(nothing kept)');
    expect(toneOf('refused')).toBe('nogo');
    expect(toneOf('failed')).toBe('nogo');
    expect(toneOf('queued')).toBe('amber');
    expect(toneOf('delivered')).toBe('quiet');
  });

  it('offers every uplink and schedule as a source, and a source that is only in the log', () => {
    const got = sourcesOf([entry({ source: 'telegram', kind: 'telegram', name: 'Telegram' })], [{ kind: 'uplink', id: 'u1', name: 'GitHub' }, { kind: 'schedule', id: 's1', name: 'Standup' }]);
    expect(got.map((s) => s.id).sort()).toEqual(['s1', 'telegram', 'u1']);
    expect(got.find((s) => s.id === 's1')?.label).toBe('Standup (Schedule)');
  });
});

describe('Launch Window', () => {
  it('has the two tabs; History shows the filters, the schedules tab shows the schedules (the webhooks, Relay and Docking are in Flight Rules)', () => {
    const triggers = renderToString(createElement(LaunchWindow));
    expect(triggers).toContain('aria-label="Launch Window views"');
    expect(triggers).toContain('aria-pressed="true"');
    expect(triggers).toContain('No schedules yet');
    expect(triggers).not.toContain('New uplink');
    expect(triggers).not.toContain('RELAY');
    expect(triggers).not.toContain('DOCKING');
    expect(triggers).not.toContain('Filter the history');
    showHistory({ source: 'u1' });
    const history = renderToString(createElement(LaunchWindow));
    expect(history).toContain('Filter the history');
    expect(history).toContain('All kinds');
    expect(history).not.toContain('No schedules yet');
  });
});
