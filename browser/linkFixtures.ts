/** Stand-in answers of the Docking 2 routes for the screens (the stand-in install has no second station): the same shapes as src/shared/protocol.ts. */
const T = Date.now();
const min = (n: number): number => T - n * 60_000;

export const LINKS = [
  {
    id: 'dl_aaaaaaaaaaaaaaaa', kind: 'task', role: 'sender', peer: 'dk1', peerName: 'lab', mine: 't1', theirs: 't9', title: 'Write the release notes', state: 'delivered', theirStatus: 'review', stale: false, waiting: 0, updatedAt: min(5), onward: false, due: '2026-12-01', priority: 'high',
    cost: { usd: 3.1, cap: 5 },
    trail: [
      { author: 'dk1', seq: 1, at: min(120), kind: 'accept', by: 'boss@lab', text: 'taken by cara' },
      { author: 'dk1', seq: 2, at: min(60), kind: 'status', by: 'cara@lab', text: 'doing' },
      { author: 'dk1', seq: 3, at: min(5), kind: 'status', by: 'cara@lab', text: 'done: ready for review', attachments: [{ kind: 'pr', ref: 'https://github.com/example/notes/pull/12', label: 'Release notes PR' }, { kind: 'branch', ref: 'notes/0.15', label: 'Branch' }] },
    ],
  },
  {
    id: 'dl_bbbbbbbbbbbbbbbb', kind: 'task', role: 'sender', peer: 'dk2', peerName: 'ops', mine: 't2', theirs: 't3', title: 'Review the notes', state: 'accepted', theirStatus: 'doing', note: 'waiting on a key', chain: [{ station: 'lab', task: 't5' }], via: 'lab', stale: true, waiting: 0, updatedAt: min(2000), onward: true,
    progress: { done: 2, total: 3 }, cost: null,
    trail: [{ author: 'dk2', seq: 1, at: min(2000), kind: 'accept', by: 'boss@ops', text: 'taken' }],
  },
  {
    id: 'dl_cccccccccccccccc', kind: 'mission', role: 'sender', peer: 'dk1', peerName: 'lab', mine: 'ms1', theirs: 'ms4', title: 'Ship the release', state: 'accepted', stale: false, waiting: 0, updatedAt: min(30), onward: false, progress: { done: 3, total: 5 }, cost: { usd: 1.2 }, trail: [],
  },
  {
    id: 'dl_dddddddddddddddd', kind: 'task', role: 'receiver', peer: 'dk2', peerName: 'ops', mine: 't7', theirs: 't11', title: 'Check the install on arm64', state: 'accepted', stale: false, waiting: 2, updatedAt: min(15), onward: false, due: '2026-11-30',
    trail: [{ author: 'dk2', seq: 1, at: min(15), kind: 'offer', by: 'boss@ops', text: 'Check the install on arm64' }],
  },
];
