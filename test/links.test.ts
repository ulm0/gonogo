// Docking 2 link views: the words of the card line, the board and the attachments.
import { describe, expect, it } from 'vitest';
import { attachmentHref, boardRows, canRecall, canReturn, costLine, dueLine, incoming, linkLine, outgoing, overCap, progressLine, reviewCount, trailLine, waitingLine } from '../src/client/links.js';
import { groupThreads, linkOfSubject } from '../src/client/threads.js';
import type { ActivityItem, DockView, LinkView } from '../src/shared/protocol.js';

const link = (patch: Partial<LinkView> = {}): LinkView => ({ id: 'dl_1', kind: 'task', role: 'sender', peer: 'd1', peerName: 'lab', mine: 't4', theirs: 't9', title: 'Fix the login', state: 'accepted', theirStatus: 'doing', stale: false, waiting: 0, updatedAt: 100, onward: false, trail: [], ...patch });

describe('the line of a card', () => {
  it('says where it is and what it is doing, with the last note', () => {
    expect(linkLine(link({ note: 'waiting on a key' }))).toBe('at lab: doing · “waiting on a key”');
    expect(linkLine(link())).toBe('at lab: doing');
  });
  it('shows a chain hop by hop', () => {
    expect(linkLine(link({ chain: [{ station: 'ops', task: 't2' }], via: 'ops' }))).toBe('at lab → at ops: doing');
  });
  it('says every state in words', () => {
    expect(linkLine(link({ state: 'offered', theirStatus: undefined }))).toBe('offered to lab, not taken yet');
    expect(linkLine(link({ state: 'delivered' }))).toContain('ready for you to accept');
    expect(linkLine(link({ state: 'returned' }))).toBe('returned by lab');
    expect(linkLine(link({ state: 'detached' }))).toBe('undocked from lab (last known: doing)');
    expect(linkLine(link({ role: 'receiver', state: 'accepted' }))).toBe('from lab');
  });
  it('counts what waits for a station that does not answer', () => {
    const down = { status: 'down' } as DockView;
    expect(waitingLine(link({ waiting: 3 }), down)).toBe('lab: not reachable, 3 events waiting');
    expect(waitingLine(link({ waiting: 1 }), down)).toContain('1 event waiting');
    expect(waitingLine(link({ waiting: 3 }), { status: 'ok' } as DockView)).toBeNull();
    expect(waitingLine(link(), down)).toBeNull();
  });
});

describe('progress, cost, due', () => {
  it('words a split and a mission', () => {
    expect(progressLine(link({ progress: { done: 2, total: 3 } }))).toBe('2 of 3 delivered');
    expect(progressLine(link({ kind: 'mission', progress: { done: 3, total: 5 } }))).toBe('at lab: 3 of 5');
    expect(progressLine(link())).toBeNull();
  });
  it('words the cost as an estimate, against the cap, or as not reported', () => {
    expect(costLine(link({ cost: { usd: 3.1, cap: 5 } }))).toBe('lab: $3.10 of $5.00 (estimate)');
    expect(costLine(link({ cost: { usd: 3.1 } }))).toBe('lab: $3.10 (estimate)');
    expect(costLine(link({ cost: null }))).toBe('cost not reported');
    expect(costLine(link())).toBe('cost not reported');
    expect(overCap(link({ cost: { usd: 5, cap: 5 } }))).toBe(true);
    expect(overCap(link({ cost: { usd: 1, cap: 5 } }))).toBe(false);
  });
  it('says due and a priority that is not normal', () => {
    expect(dueLine(link({ due: '2026-12-01', priority: 'high' }))).toBe('due 2026-12-01 · high priority');
    expect(dueLine(link({ priority: 'normal' }))).toBeNull();
  });
});

describe('the trail and the deliverables', () => {
  it('writes one line for an event and one for a loss', () => {
    const at = new Date(2026, 10, 23, 14, 3).getTime();
    expect(trailLine({ author: 'd1', seq: 1, at, kind: 'status', by: 'ana@lab', text: 'doing' }, at)).toBe('14:03 ana@lab: status doing');
    expect(trailLine({ author: 'd1', seq: 2, at, kind: 'lost', by: 'lab', text: '3 status events were not delivered' }, at)).toBe('14:03 3 status events were not delivered');
  });
  it('opens only an https address of a PR or a link; the rest is text', () => {
    expect(attachmentHref({ kind: 'pr', ref: 'https://github.com/o/r/pull/1', label: 'PR' })).toBe('https://github.com/o/r/pull/1');
    expect(attachmentHref({ kind: 'url', ref: 'http://x.example/', label: 'x' })).toBeNull();
    expect(attachmentHref({ kind: 'url', ref: 'https://u:p@x.example/', label: 'x' })).toBeNull();
    expect(attachmentHref({ kind: 'url', ref: 'javascript:alert(1)', label: 'x' })).toBeNull();
    expect(attachmentHref({ kind: 'branch', ref: 'main', label: 'b' })).toBeNull();
    expect(attachmentHref({ kind: 'file', ref: 'https://x.example/', label: 'f' })).toBeNull();
  });
});

describe('what a card and the board take from the list', () => {
  const list = [link(), link({ id: 'dl_2', mine: 't5', state: 'delivered', updatedAt: 50 }), link({ id: 'dl_3', role: 'receiver', mine: 't7', peer: 'd2', peerName: 'ops' }), link({ id: 'dl_4', mine: 't4', kind: 'mission' }), link({ id: 'dl_5', state: 'done', mine: 't6', stale: true })];
  it('finds the outgoing links of a task and its one incoming link', () => {
    expect(outgoing(list, 'task', 't4').map((l) => l.id)).toEqual(['dl_1']);
    expect(incoming(list, 'task', 't7')?.id).toBe('dl_3');
    expect(incoming(list, 'task', 't4')).toBeUndefined();
  });
  it('lists OUT with the ones to review first, by station and by state group', () => {
    expect(boardRows(list, 'out', '', 'all').map((l) => l.id)).toEqual(['dl_2', 'dl_5', 'dl_1', 'dl_4']);
    expect(boardRows(list, 'out', '', 'review').map((l) => l.id)).toEqual(['dl_2']);
    expect(boardRows(list, 'out', '', 'closed').map((l) => l.id)).toEqual(['dl_5']);
    expect(boardRows(list, 'out', '', 'open').map((l) => l.id)).toEqual(['dl_2', 'dl_1', 'dl_4']);
    expect(boardRows(list, 'in', '', 'all').map((l) => l.id)).toEqual(['dl_3']);
    expect(boardRows(list, 'in', 'd1', 'all')).toEqual([]);
    expect(reviewCount(list)).toBe(1);
  });
  it('lets the receiver give back and the sender withdraw, only while it is open', () => {
    expect(canReturn(link({ role: 'receiver', state: 'accepted' }))).toBe(true);
    expect(canReturn(link({ role: 'receiver', state: 'done' }))).toBe(false);
    expect(canReturn(link({ state: 'accepted' }))).toBe(false);
    expect(canRecall(link({ state: 'accepted' }))).toBe(true);
    expect(canRecall(link({ state: 'delivered' }))).toBe(false);
  });
});

describe('the line of a link on a card (rendered)', () => {
  const render = async (l: LinkView): Promise<string> => {
    const { renderToString } = await import('react-dom/server');
    const { createElement } = await import('react');
    const { LinkLines } = await import('../src/client/LinkLines.js');
    return renderToString(createElement(LinkLines, { links: [l] }));
  };
  it('offers Accept and Send back for a delivery, with the deliverable as a safe link', async () => {
    const html = await render(link({ state: 'delivered', theirStatus: 'review', trail: [{ author: 'd1', seq: 1, at: 1, kind: 'status', by: 'cara@lab', text: 'done', attachments: [{ kind: 'pr', ref: 'https://github.com/o/r/pull/1', label: 'PR 1' }, { kind: 'file', ref: 'docs/x.md', label: 'Notes' }] }] }));
    expect(html).toContain('Accept t4 from lab');
    expect(html).toContain('Send t4 back to lab');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('href="https://github.com/o/r/pull/1"');
    expect(html).not.toContain('href="docs/x.md"');
    expect(html).toContain('ready for you to accept');
  });
  it('offers Withdraw while it is open, nothing once it is done, Give back to the receiver', async () => {
    expect(await render(link())).toContain('Withdraw t4 from lab');
    const done = await render(link({ state: 'done' }));
    expect(done).not.toContain('Withdraw');
    expect(done).not.toContain('Accept');
    expect(await render(link({ role: 'receiver' }))).toContain('Give t4 back to lab');
  });
  it('says the cap is passed and that nothing is reported', async () => {
    expect(await render(link({ cost: { usd: 5.2, cap: 5 } }))).toContain('past the cap');
    expect(await render(link({ cost: null }))).toContain('cost not reported');
    expect(await render(link({ role: 'receiver' }))).not.toContain('cost');
  });
});

describe('conversations by link', () => {
  const msg = (id: string, from: string, to: string, subject: string, inReplyTo: string | null = null): ActivityItem => ({ id, from, to, subject, body: 'b', at: Number(id.slice(1)), inReplyTo, truncated: false, kind: 'message', status: 'delivered' }) as unknown as ActivityItem;
  const ID = 'dl_0123456789abcdef';
  const items = [msg('m3', 'cara@lab', 'flight', `Re: [${ID}] Fix the login`), msg('m2', 'flight', 'ana', `[${ID}] Fix the login`), msg('m1', 'user', 'flight', 'Something else')];
  it('puts every message of a known link in one conversation, whoever writes, titled without the tag', () => {
    const threads = groupThreads(items, new Set([ID]));
    expect(threads).toHaveLength(2);
    const linked = threads.find((t) => t.link === ID);
    expect(linked?.items.map((i) => i.id)).toEqual(['m2', 'm3']);
    expect(linked?.title).toBe('Fix the login');
    expect(linked?.subject).toContain(ID); // a reply keeps the tag, so it joins the conversation
  });
  it('does not group on a tag this station does not hold: an agent cannot write itself into a link', () => {
    const threads = groupThreads(items, new Set());
    expect(threads.every((t) => t.link === undefined)).toBe(true);
    expect(threads).toHaveLength(3);
  });
  it('reads the id after any Re:, and only a well-formed one', () => {
    expect(linkOfSubject(`Re: Re: [${ID}] x`)).toBe(ID);
    expect(linkOfSubject('[dl_xyz] x')).toBeNull();
    expect(linkOfSubject(`x [${ID}]`)).toBeNull();
  });
});

describe('the board (rendered)', () => {
  it('shows the sent ones to review first with their count, and the held ones under Held', async () => {
    const { renderToString } = await import('react-dom/server');
    const { createElement } = await import('react');
    const { LinkBoard } = await import('../src/client/LinkBoard.js');
    const { setLinks } = await import('../src/client/linksData.js');
    setLinks([link({ id: 'dl_1', title: 'Open one' }), link({ id: 'dl_2', title: 'Delivered one', state: 'delivered', updatedAt: 1 }), link({ id: 'dl_3', role: 'receiver', title: 'Held one' })]);
    const html = renderToString(createElement(LinkBoard));
    expect(html).toMatch(/1[^0-9]*to review/);
    expect(html.indexOf('Delivered one')).toBeLessThan(html.indexOf('Open one'));
    expect(html).not.toContain('Held one');
    expect(html).toMatch(/Sent[^0-9]*2/);
    expect(html).toMatch(/Held[^0-9]*1/);
    setLinks([]);
    expect(renderToString(createElement(LinkBoard))).toBe('');
  });
});
