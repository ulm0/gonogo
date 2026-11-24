// COMMS "Needs you": which messages wait on the Director, and the strip that answers them in one place.
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { asksOf, isAsk, needsCount, needsTitle, wantsGoNoGo } from '../src/client/needsModel.js';
import { NeedsYou } from '../src/client/NeedsYou.js';
import { store } from '../src/client/store.js';
import type { DownlinkItem, DownlinkMessage } from '../src/shared/protocol.js';

const msg = (id: string, patch: Partial<DownlinkMessage> = {}): DownlinkMessage => ({ type: 'message', id, at: Number(id.slice(1)), from: 'flight', subject: 'Status', body: 'All fine.', truncated: false, inReplyTo: null, read: false, archived: false, ...patch });

afterEach(() => store.setState((s) => ({ ...s, downlink: { unread: 0, items: [] }, relief: [], agents: {}, order: [] }) as never));

describe('which messages ask', () => {
  it('takes a question mark in the subject or the start of the text, and go/no-go in either spelling', () => {
    expect(isAsk(msg('m1', { subject: 'Which branch?' }))).toBe(true);
    expect(isAsk(msg('m2', { body: 'Shall I merge it?' }))).toBe(true);
    expect(isAsk(msg('m3', { subject: 'Go/no-go: the release' }))).toBe(true);
    expect(isAsk(msg('m4', { body: 'go or no-go for 0.18' }))).toBe(true);
    expect(isAsk(msg('m5'))).toBe(false);
  });
  it('leaves out what was read, archived, an event, or a question far down a long text', () => {
    expect(isAsk(msg('m1', { subject: 'Which?', read: true }))).toBe(false);
    expect(isAsk(msg('m2', { subject: 'Which?', archived: true }))).toBe(false);
    expect(isAsk({ type: 'event', id: 'e1', at: 1, kind: 'relief', text: 'Hire request?', read: false, archived: false } as DownlinkItem)).toBe(false);
    expect(isAsk(msg('m3', { body: `${'x'.repeat(500)} really?` }))).toBe(false);
  });
  it('lists the newest first, and says go/no-go only for those', () => {
    const list = asksOf([msg('m9', { subject: 'new?' }), msg('m2', { subject: 'old?' }), msg('m5')]);
    expect(list.map((i) => i.id)).toEqual(['m9', 'm2']);
    expect(wantsGoNoGo(msg('m1', { subject: 'GO / NO-GO' }))).toBe(true);
    expect(wantsGoNoGo(msg('m1', { subject: 'Which?' }))).toBe(false);
  });
  it('counts messages, hire requests and handoffs, in words', () => {
    expect(needsCount(1, 2, 1, 1)).toBe(5);
    expect(needsTitle(1)).toBe('Needs you: 1 answer');
    expect(needsTitle(3)).toBe('Needs you: 3 answers');
  });
});

describe('the strip', () => {
  const html = (): string => renderToString(createElement(NeedsYou));
  it('is not drawn when nothing waits', () => {
    expect(html()).toBe('');
  });
  it('shows a console that asks for a go, with its count', () => {
    const ben = { name: 'ben', role: 'r', dir: '/w', mode: 'default', provider: 'claude', boss: false, state: 'needs_you', needsKind: 'permission', needsReason: 'Run: git push', transition: null } as never;
    store.setState((s) => ({ ...s, agents: { ben }, order: ['ben'] }) as never);
    const out = html();
    expect(out).toContain('Needs you: 1 answer');
    expect(out).toContain('BEN ASKS FOR A GO');
  });

  it('shows a question with a reply box, a go/no-go with GO and NO-GO keys, and the count', () => {
    store.setState((s) => ({ ...s, downlink: { unread: 2, items: [msg('m1', { subject: 'Which branch?', body: 'main or next?' }), msg('m2', { subject: 'Go/no-go: release 0.18' })] } }) as never);
    const out = html();
    expect(out).toContain('Needs you: 2 answers');
    expect(out).toContain('Which branch?');
    expect(out).toContain('Reply to');
    expect(out).toContain('GO: Go/no-go: release 0.18');
    expect(out).toContain('NO-GO: Go/no-go: release 0.18');
    expect(out).toContain('Mark handled: Which branch?');
  });
});

describe('the room and the Comms key', () => {
  it('draws the list in the room with no gutter of its own', () => {
    store.setState((s) => ({ ...s, downlink: { unread: 1, items: [msg('m1', { subject: 'Which branch?' })] } }) as never);
    const out = renderToString(createElement(NeedsYou, { room: true }));
    expect(out).toContain('data-room="true"');
    expect(renderToString(createElement(NeedsYou))).not.toContain('data-room');
  });
  it('puts the list under the Brief box on a desktop and at the top on a phone, and no longer docks floods in the room', () => {
    const screen = readFileSync('src/client/RoomScreen.tsx', 'utf8');
    expect(screen.indexOf('<YourConsole />')).toBeGreaterThan(-1);
    expect(screen.lastIndexOf('<NeedsYou room />')).toBeGreaterThan(screen.indexOf('<YourConsole />'));
    expect(screen).toContain('<StatusStrip phone />\n        <NeedsYou room />');
    expect(readFileSync('src/client/RoomView.tsx', 'utf8')).not.toContain('needs-dock');
  });
  it('names the Comms key with what needs you first, then what is unread', async () => {
    const { commsName } = await import('../src/client/inbox.js');
    expect(commsName(0)).toBe('Comms');
    expect(commsName(3)).toBe('Comms, 3 unread');
    expect(commsName(3, 1)).toBe('Comms, 1 needs you, 3 unread');
    expect(commsName(0, 2)).toBe('Comms, 2 need you');
  });
  it('counts every kind in the badge, from the same state as the list', () => {
    const ben = { name: 'ben', role: 'r', dir: '/w', mode: 'default', provider: 'claude', boss: false, state: 'needs_you', needsKind: 'permission', needsReason: 'Run: git push', transition: null } as never;
    store.setState((s) => ({ ...s, agents: { ben }, order: ['ben'], downlink: { unread: 1, items: [msg('m1', { subject: 'Which?' })] }, relief: [{ id: 'h1', by: 'flight', at: 1, expiresAt: 2, name: 'cara', position: null, role: 'r', dir: '/w', provider: 'claude', mode: 'default', cleanRoom: null }] }) as never);
    expect(renderToString(createElement(NeedsYou, { room: true }))).toContain('Needs you: 3 answers');
  });
});
