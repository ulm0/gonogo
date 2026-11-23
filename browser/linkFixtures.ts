/** Stand-in answers of the Docking 2 routes for the screens (the stand-in install has no second station): the shapes of src/shared/protocol.ts (LinkView, LinkEventView, OutboundEntry), with what the page reads beyond them (src/client/links.ts, LinkExtras). */
const T = Date.now();
const min = (n: number): number => T - n * 60_000;

const base = { theirs: null, due: null, priority: 'normal', onward: false, budget: null, waiting: 0 };

export const LINKS = [
  { ...base, id: 'dl_aaaaaaaaaaaaaaaa', role: 'sender', peer: 'dk1', peerName: 'lab', mine: 't1', theirs: 't9', title: 'Write the release notes', state: 'delivered', peerStatus: 'review', due: '2026-12-01', priority: 'high', budget: 5, cost: { usd: 3.1, estimate: true }, events: 3, updatedAt: min(5) },
  { ...base, id: 'dl_bbbbbbbbbbbbbbbb', role: 'sender', peer: 'dk2', peerName: 'ops', mine: 't2', theirs: 't3', title: 'Review the notes', state: 'accepted', peerStatus: 'doing', chain: [{ station: 'lab', task: 't5' }], via: 'lab: doing', onward: true, progress: { done: 2, total: 3, blocked: 0, review: 1 }, cost: null, events: 1, updatedAt: min(2000) },
  { ...base, id: 'dl_cccccccccccccccc', kind: 'mission', role: 'sender', peer: 'dk1', peerName: 'lab', mine: 'ms1', theirs: 'ms4', title: 'Ship the release', state: 'accepted', peerStatus: null, progress: { done: 3, total: 5, blocked: 0, review: 1 }, cost: { usd: 1.2, estimate: true }, events: 0, updatedAt: min(30) },
  { ...base, id: 'dl_dddddddddddddddd', role: 'receiver', peer: 'dk2', peerName: 'ops', mine: 't7', theirs: 't11', title: 'Check the install on arm64', state: 'accepted', peerStatus: 'todo', due: '2026-11-30', waiting: 2, events: 1, updatedAt: min(15) },
];

/** GET /api/links/<id>: the trail, oldest first. Deliverables ride on an event (the page reads `attachments` when the server sends them). */
export const TRAILS: Record<string, unknown[]> = {
  dl_aaaaaaaaaaaaaaaa: [
    { link: 'dl_aaaaaaaaaaaaaaaa', from: 'us', seq: 1, at: min(300), kind: 'offer', by: 'flight@main', text: 'Write the release notes' },
    { link: 'dl_aaaaaaaaaaaaaaaa', from: 'them', seq: 1, at: min(120), kind: 'accept', by: 'boss@lab', text: 'taken by cara' },
    { link: 'dl_aaaaaaaaaaaaaaaa', from: 'them', seq: 2, at: min(5), kind: 'status', by: 'cara@lab', text: 'done: ready for review', status: 'review', attachments: [{ kind: 'pr', ref: 'https://github.com/example/notes/pull/12', label: 'Release notes PR' }, { kind: 'branch', ref: 'notes/0.15', label: 'Branch' }] },
  ],
};

export const OUTBOUND = [
  { at: min(300), link: 'dl_aaaaaaaaaaaaaaaa', seq: 1, kind: 'offer', by: 'flight@main', text: 'Write the release notes\n\nOne page, for 0.15. Keep it to what changed for the person who uses gonogo.', ackedAt: min(299) },
  { at: min(5), link: 'dl_aaaaaaaaaaaaaaaa', seq: 2, kind: 'accept', by: 'director@main', text: 'accepted: thank you', ackedAt: null },
];
