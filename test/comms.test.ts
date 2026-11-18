/** COMMS: one view with three tabs; the old show functions are aliases; the tab is remembered; the agent filter; the keys of the bars. */
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivityItem } from '../src/shared/protocol.js';
import { Comms } from '../src/client/Comms.js';
import { ofAgent } from '../src/client/loop.js';
import { chooseCommsTab, COMMS_TAB_STORAGE_KEY, emptyState, openConsole, readStored, setCommsAgent, showComms, showDownlink, showLoop, showParty, showTraffic, store } from '../src/client/store.js';

afterEach(() => {
  vi.unstubAllGlobals();
  store.setState({ ...emptyState() });
});

const item = (id: string, from: string, to: string): ActivityItem => ({ id, from, to, subject: 's', body: '', at: 1, status: 'delivered' }) as unknown as ActivityItem;

describe('the aliases', () => {
  it('Loop, Downlink and Party Line are tabs of COMMS, and a console that was open is left', () => {
    openConsole('ana');
    showLoop();
    expect(store.getState()).toMatchObject({ view: 'comms', commsTab: 'traffic', consoleOpen: false, commsAgent: null });
    showDownlink();
    expect(store.getState()).toMatchObject({ view: 'comms', commsTab: 'inbox' });
    showParty();
    expect(store.getState()).toMatchObject({ view: 'comms', commsTab: 'threads' });
  });

  it('the console link opens TRAFFIC filtered to that agent; the other tabs keep the filter for the way back', () => {
    showTraffic('ana');
    expect(store.getState()).toMatchObject({ commsTab: 'traffic', commsAgent: 'ana' });
    setCommsAgent(null);
    expect(store.getState().commsAgent).toBeNull();
  });

  it('COMMS with no tab opens the one last used', () => {
    chooseCommsTab('threads');
    store.setState((s) => ({ ...s, view: 'room' }));
    showComms();
    expect(store.getState()).toMatchObject({ view: 'comms', commsTab: 'threads' });
  });
});

describe('the remembered tab', () => {
  it('is written when a tab is chosen in the bar, and not by an alias', () => {
    const kept = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) });
    chooseCommsTab('traffic');
    expect(readStored(COMMS_TAB_STORAGE_KEY)).toBe('traffic');
    showParty();
    expect(readStored(COMMS_TAB_STORAGE_KEY)).toBe('traffic');
  });
});

describe('the agent filter', () => {
  it('keeps what an agent sent or got, and everything for null', () => {
    const items = [item('1', 'ana', 'ben'), item('2', 'ben', 'user'), item('3', 'cy', 'ana')];
    expect(ofAgent(items, 'ana').map((i) => i.id)).toEqual(['1', '3']);
    expect(ofAgent(items, null)).toBe(items);
    expect(ofAgent(items, 'nobody')).toEqual([]);
  });
});

describe('the view', () => {
  it('draws three tabs, the selected one marked, with the hint of the tab under the bar', () => {
    store.setState({ ...emptyState(), commsTab: 'traffic' });
    const out = renderToString(createElement(Comms));
    expect(out).toContain('role="tablist"');
    expect(out.match(/role="tab"/g)).toHaveLength(3);
    expect(out).toMatch(/aria-selected="true"[^>]*>TRAFFIC|TRAFFIC[\s\S]*aria-selected="true"/);
    expect(out).toContain('Everything the agents send each other and you.');
    expect(out).toContain('role="tabpanel"');
  });

  it('shows the unread count on INBOX only', () => {
    store.setState({ ...emptyState(), commsTab: 'inbox', downlink: { unread: 3, items: [] } });
    const out = renderToString(createElement(Comms));
    expect(out).toMatch(/INBOX<span class="chip" data-tone="amber" aria-hidden="true">3</);
    expect(out).not.toMatch(/TRAFFIC<span class="chip"/);
  });
});
