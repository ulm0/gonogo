// The docked chip of the status strip: its words, and that it shows only with a dock.
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { dockChipName, dockChipText } from '../src/client/dockChip.js';
import { StatusStrip } from '../src/client/StatusStrip.js';
import { store } from '../src/client/store.js';
import type { DockView } from '../src/shared/protocol.js';

const dock = (name: string, status: DockView['status'] = 'ok'): DockView => ({ id: `d-${name}`, name, url: 'https://x', since: 1, status, seenAt: 1, error: null, agents: [] });

afterEach(() => store.setState((s) => ({ ...s, docking: { station: 'main', docks: [] } }) as never));

describe('the words of the chip', () => {
  it('names the stations, and counts them on a phone', () => {
    expect(dockChipText([dock('lab'), dock('ops')], false)).toBe('Docked: lab, ops');
    expect(dockChipText([dock('lab'), dock('ops')], true)).toBe('Docked 2');
    expect(dockChipText([], false)).toBeNull();
  });
  it('says which one does not answer', () => {
    expect(dockChipText([dock('lab', 'down'), dock('ops')], false)).toBe('lab down');
    expect(dockChipText([dock('lab', 'down'), dock('ops', 'down')], false)).toBe('lab, ops down');
    expect(dockChipText([dock('lab', 'down'), dock('ops')], true)).toBe('1 down');
  });
  it('tells a screen reader every station and its state', () => {
    expect(dockChipName([dock('lab'), dock('ops', 'new')])).toBe('Docked with lab, answering; ops, waiting for the first answer. Open Docking in Flight Rules');
  });
});

describe('the strip', () => {
  const html = (): string => renderToString(createElement(StatusStrip, { phone: false }));
  it('has no chip without a dock, and one with: amber when a station is down', () => {
    expect(html()).not.toContain('dock-chip');
    store.setState((s) => ({ ...s, docking: { station: 'main', docks: [dock('lab'), dock('ops')] } }) as never);
    expect(html()).toContain('dock-chip');
    expect(html()).toContain('Docked: lab, ops');
    expect(html()).not.toContain('data-tone="amber"');
    store.setState((s) => ({ ...s, docking: { station: 'main', docks: [dock('lab', 'down')] } }) as never);
    expect(html()).toContain('data-tone="amber"');
    expect(html()).toContain('lab down');
  });
});

describe('the name of the chip', () => {
  it('starts with the words on the key (WCAG label in name)', () => {
    store.setState((s) => ({ ...s, docking: { station: 'main', docks: [dock('lab'), dock('ops')] } }) as never);
    const html = renderToString(createElement(StatusStrip, { phone: false }));
    expect(html).toContain('aria-label="Docked: lab, ops. Docked with lab, answering; ops, answering.');
  });
});
