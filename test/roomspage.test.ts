// The list page of the rooms supervisor (src/server/roomspage.ts): its scripts run here against a small stand-in for the DOM (no
// browser exists on this host), so the cards, the keys and the livery are tried as the page builds them. What a real browser draws
// (the look, the focus ring, the phone layout) is not covered here.
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { isColour, LIVERY_NAMES } from '../src/shared/livery.js';
import { roomsPage } from '../src/server/roomspage.js';

class Node {
  className = '';
  dataset: Record<string, string> = {};
  children: Node[] = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, Array<(e: unknown) => void>> = {};
  own = '';
  hidden = false;
  disabled = false;
  value = '';
  href = '';
  type = '';
  maxLength = 0;
  elements: Record<string, Node> = {};
  constructor(readonly tag: string) {}
  get childNodes(): Node[] {
    return this.children;
  }
  get textContent(): string {
    return this.own + this.children.map((c) => c.textContent).join('');
  }
  set textContent(text: string) {
    this.own = text;
    this.children = [];
  }
  append(...nodes: Node[]): void {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: Node[]): void {
    this.children = nodes;
    this.own = '';
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  addEventListener(type: string, fn: (e: unknown) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  fire(type: string, event: unknown = {}): void {
    for (const fn of this.listeners[type] ?? []) fn(event);
  }
  all(): Node[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  contains(other: Node | null): boolean {
    return other !== null && (other === this || this.all().includes(other));
  }
  querySelector(selector: string): Node | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  querySelectorAll(selector: string): Node[] {
    const f = /^\[data-f="(.*)"\]$/.exec(selector);
    if (f !== null) return this.all().filter((n) => n.dataset.f === f[1]);
    const byClass = /^\.([\w-]+)$/.exec(selector);
    if (byClass !== null) return this.all().filter((n) => n.className.split(' ').includes(byClass[1] as string));
    const byName = /^\[name=(\w+)\]$/.exec(selector);
    if (byName !== null) return this.all().filter((n) => (n as Node & { name?: string }).name === byName[1]);
    if (selector === '[data-at]') return this.all().filter((n) => n.dataset.at !== undefined);
    return this.all().filter((n) => n.tag === selector);
  }
  focus(): void {
    doc.activeElement = this;
  }
  select(): void {}
  reset(): void {
    for (const e of Object.values(this.elements)) e.value = '';
  }
}

let doc: { activeElement: Node | null; title: string; documentElement: Node & { style: { setProperty(n: string, v: string): void; props: Record<string, string> } } };
const make = (tag: string): Node => new Node(tag);

interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}

function run(options: { token?: string; rooms: unknown[]; layout?: unknown; livery?: string; hash?: string; status?: number; respond?: (call: Call) => { status: number; body: unknown } | undefined }): { calls: Call[]; byId: Record<string, Node>; saved: Record<string, string>; replaced: string[]; sent: Array<Record<string, string>>; root: Node & { style: { props: Record<string, string> } } } {
  const replaced: string[] = [];
  const sent: Array<Record<string, string>> = [];
  const calls: Call[] = [];
  const html = roomsPage(null, '1.2.3');
  const scripts = [...html.matchAll(/<script>([^]*?)<\/script>/g)].map((m) => m[1] ?? '');
  const byId: Record<string, Node> = {};
  for (const id of ['rooms', 'move', 'note', 'add', 'gate', 'sum', 'live', 'title', 'loading', 'new', 'cancel']) byId[id] = make(id === 'add' ? 'form' : 'div');
  byId.gate?.append(make('h2'), make('p'));
  byId.add?.elements && Object.assign(byId.add.elements, { id: make('input'), name: make('input') });
  const root = Object.assign(make('html'), { style: { props: {} as Record<string, string>, setProperty(n: string, v: string) { this.props[n] = v; } } });
  doc = { activeElement: null, title: '', documentElement: root };
  const saved: Record<string, string> = {};
  if (options.livery !== undefined) saved['gonogo.livery'] = options.livery;
  if (options.token !== undefined) saved['gonogo.token'] = options.token;
  const context = {
    document: Object.assign(doc, { getElementById: (id: string) => byId[id] ?? null, createElement: make }),
    localStorage: { getItem: (k: string) => saved[k] ?? null, setItem: (k: string, v: string) => (saved[k] = v) },
    location: { hash: options.hash ?? '', pathname: '/', replace: (to: string) => void replaced.push(to), assign: (to: string) => void replaced.push(`assign:${to}`) },
    history: { replaceState() {} },
    URLSearchParams,
    fetch: async (url: string, init: { headers?: Record<string, string>; method?: string; body?: string } = {}) => {
      sent.push(init.headers ?? {});
      const call: Call = { method: init.method ?? 'GET', url, ...(init.body === undefined ? {} : { body: JSON.parse(init.body) as Record<string, unknown> }) };
      calls.push(call);
      const custom = call.method === 'GET' ? undefined : options.respond?.(call);
      if (custom !== undefined) return { status: custom.status, ok: custom.status < 300, json: async () => custom.body };
      const status = options.status ?? 200;
      return { status, ok: status < 300, json: async () => ({ rooms: options.rooms, ...(options.layout === undefined ? {} : { layout: options.layout }) }) };
    },
    setInterval: () => 0,
    JSON,
    Number,
    String,
    Math,
    Date,
    Object,
    parseInt,
    encodeURIComponent,
  };
  vm.createContext(context);
  for (const script of scripts) vm.runInContext(script, context);
  return { calls, byId, saved, replaced, sent, root };
}

const room = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({ id: 'main', name: 'Main', state: 'running', agents: 15, running: 15, needsYou: 0, working: 0, lastActivity: null, tabName: null, note: null, ...patch });
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10));
const text = (n: Node | undefined): string => n?.textContent ?? '';

describe('the rooms list page script', () => {
  it('shows what the room costs today as an estimate, and nothing when it is zero or unknown', async () => {
    const { byId } = run({ token: 'a'.repeat(64), rooms: [room({ costToday: 2.5 }), room({ id: 'zero', name: 'Zero', costToday: 0 }), room({ id: 'unknown', name: 'Unknown', costToday: null })] });
    await settle();
    const [a, b, c] = (byId.rooms?.children ?? []) as [Node, Node, Node];
    expect(text(a)).toContain('about $2.50 today (estimate)');
    expect(text(b)).not.toContain('today (estimate)');
    expect(text(c)).not.toContain('today (estimate)');
  });

  it('draws a card for each room: name, state word, counts, last activity, tab name, and the keys', async () => {
    const { byId } = run({ token: 'a'.repeat(64), rooms: [room({ needsYou: 1, working: 3, lastActivity: Date.now() - 4 * 60_000, tabName: 'Ops' }), room({ id: 'ninah', name: 'ninah', state: 'running', agents: 2, running: 2 }), room({ id: 'old', name: 'Old', state: 'crashed', agents: null, note: 'gonogo: port in use' })] });
    await settle();
    const cards = byId.rooms?.children ?? [];
    expect(cards).toHaveLength(3);
    const [main, ninah, old] = cards as [Node, Node, Node];
    expect(main.dataset.kind).toBe('needs');
    expect(text(main)).toContain('Main');
    expect(text(main)).toContain('NEEDS YOU');
    expect(text(main)).toContain('15 of 15 agents running');
    expect(text(main)).toContain('1 need you · 3 working');
    expect(text(main)).toContain('last activity 4 min ago');
    expect(text(main)).toContain('tab: Ops');
    // today's estimate, said to be one, only when there is something
    expect(text(main)).not.toContain('today');
    expect(main.querySelector('[data-f="open:main"]')?.href).toBe('/r/main/');
    // main has no rename or remove
    expect(main.querySelector('[data-f="rename:main"]')).toBeNull();
    // a name that is the id shows once as the name and as r/<id>
    expect(ninah.dataset.kind).toBeUndefined();
    expect(text(ninah)).toContain('RUNNING');
    expect(text(ninah)).toContain('r/ninah');
    expect(ninah.querySelector('[data-f="rename:ninah"]')).not.toBeNull();
    // a crashed room: the reason is on the card, and OPEN is a disabled key, not a link
    expect(old.dataset.kind).toBe('crashed');
    expect(text(old)).toContain('gonogo: port in use');
    expect(old.querySelector('[data-f="open:old"]')?.disabled).toBe(true);
    expect(text(byId.sum)).toContain('3 rooms');
    expect(text(byId.sum)).toContain('1 need you');
    expect(doc.title).toBe('(1) rooms · gonogo');
  });

  it('a tap anywhere on a running room\'s card opens it, a tap on one of its own keys does not, and a stopped room\'s card does nothing', async () => {
    const { byId, replaced } = run({ token: 'a'.repeat(64), rooms: [room(), room({ id: 'ninah', name: 'ninah', state: 'running', agents: 2, running: 2 }), room({ id: 'old', name: 'Old', state: 'crashed', agents: null })] });
    await settle();
    const [main, ninah, old] = (byId.rooms?.children ?? []) as [Node, Node, Node];
    expect(ninah.className).toContain('rl-open');
    expect(old.className).not.toContain('rl-open');
    ninah.fire('click', { target: { closest: () => null } });
    expect(replaced).toEqual(['assign:/r/ninah/']);
    // the target is inside a key, a link or a field (RENAME, OPEN itself, the name box): the key does its own work
    main.fire('click', { target: { closest: () => ({}) } });
    old.fire('click', { target: { closest: () => null } });
    expect(replaced).toEqual(['assign:/r/ninah/']);
  });

  it('with only main, the empty state offers a new room', async () => {
    const { byId } = run({ token: 'a'.repeat(64), rooms: [room()] });
    await settle();
    const cards = byId.rooms?.children ?? [];
    expect(cards).toHaveLength(2);
    expect(text(cards[1])).toContain('Only main so far');
    expect(cards[1]?.dataset.kind).toBe('open');
    cards[1]?.querySelector('[data-f="empty-new"]')?.fire('click');
    expect(byId.add?.hidden).toBe(false);
  });

  it('REMOVE asks first, in the card, and says the folder stays; KEEP puts it away', async () => {
    const { byId } = run({ token: 'a'.repeat(64), rooms: [room(), room({ id: 'team', name: 'Team B' })] });
    await settle();
    const card = (): Node => (byId.rooms?.children ?? [])[1] as Node;
    card().querySelector('[data-f="remove:team"]')?.fire('click');
    expect(text(card())).toContain('Remove Team B? gonogo stops the room and its agents. Its folder stays on disk (rooms/team); nothing is deleted.');
    expect(doc.activeElement?.dataset.f).toBe('keep:team');
    card().querySelector('[data-f="keep:team"]')?.fire('click');
    expect(text(card())).not.toContain('nothing is deleted');
  });

  it('a tap on the card does not open the room in the middle of a remove or a rename: the half-done action is kept', async () => {
    const { byId, replaced } = run({ token: 'a'.repeat(64), rooms: [room(), room({ id: 'team', name: 'Team B', state: 'running', agents: 1, running: 1 })] });
    await settle();
    const card = (): Node => (byId.rooms?.children ?? [])[1] as Node;
    const tapCard = (): void => card().fire('click', { target: { closest: () => null } });
    // removing: a tap on the question (not on one of its keys) leaves it open
    card().querySelector('[data-f="remove:team"]')?.fire('click');
    tapCard();
    expect(replaced).toEqual([]);
    expect(text(card())).toContain('nothing is deleted');
    card().querySelector('[data-f="keep:team"]')?.fire('click');
    // renaming: the card is the form, and a tap on its label does not leave the page
    card().querySelector('[data-f="rename:team"]')?.fire('click');
    tapCard();
    expect(replaced).toEqual([]);
    // when nothing is half done a tap on the card opens the room
    card().querySelector('[data-f="cancel:team"]')?.fire('click');
    tapCard();
    expect(replaced).toEqual(['assign:/r/team/']);
  });

  it('without a token it asks anyway (the login cookie is the credential) and sends no Authorization', async () => {
    const { byId, sent, replaced } = run({ rooms: [room()] });
    await settle();
    expect(sent[0]).toEqual({});
    expect(replaced).toEqual([]);
    expect(byId.rooms?.children.length).toBeGreaterThan(0);
  });

  it('a 401, with or without a token, goes to the login page; nothing else is drawn', async () => {
    for (const token of [undefined, 'a'.repeat(64)]) {
      const { byId, replaced } = run({ rooms: [room()], status: 401, ...(token === undefined ? {} : { token }) });
      await settle();
      expect(replaced).toEqual(['/login']);
      expect(byId.rooms?.children).toHaveLength(0);
    }
  });

  const whole = (value: string | ((name: string) => string)): Record<string, string> => Object.fromEntries(LIVERY_NAMES.map((n) => [n, typeof value === 'string' ? value : value(n)]));
  const applied = (tokens: unknown, slug = 'night'): Record<string, string> => run({ rooms: [], livery: JSON.stringify({ slug, tokens }) }).root.style.props;

  it('puts a whole livery of the last visit on the page, scheme included', () => {
    const tokens = whole((n) => (n === '--body' ? '#101418' : '#e0e0e0'));
    const { root } = run({ rooms: [], livery: JSON.stringify({ slug: 'night', tokens }) });
    expect(root.style.props).toMatchObject({ '--body': '#101418', '--text': '#e0e0e0', 'color-scheme': 'dark' });
    expect(Object.keys(root.style.props)).toHaveLength(LIVERY_NAMES.length + 1);
    expect(root.dataset).toMatchObject({ scheme: 'dark', livery: 'night' });
    expect(applied(whole((n) => (n === '--body' ? 'rgb(250, 249, 246)' : '#222222')))['color-scheme']).toBe('light');
  });

  it('applies nothing of a partial livery, one with an extra name or one bad value (the app\'s all-or-nothing rule)', () => {
    const tokens = whole('#223344');
    expect(applied({ '--body': '#101418', '--text': '#eeeeee' })).toEqual({});
    expect(applied({ ...tokens, '--evil': '#ffffff' })).toEqual({});
    expect(applied({ ...tokens, '--text': 'red' })).toEqual({});
    expect(applied({ ...tokens, '--text': 'url(https://x/y)' })).toEqual({});
    expect(applied({ ...tokens, '--text': '#fff;background:url(x)' })).toEqual({});
    const missing = { ...tokens } as Record<string, string>;
    delete missing['--lcd'];
    expect(applied(missing)).toEqual({});
    expect(applied([])).toEqual({});
    expect(applied(whole('#223344'), 'Bad Slug')).toEqual({});
  });

  it('accepts oklch, hsl and rgb in the forms of the app, and refuses what it refuses', () => {
    for (const ok of ['oklch(0.2 0.02 250)', 'oklch(20% 0.02 250deg)', 'hsl(210, 20%, 10%)', 'hsl(210 20% 10%)', 'rgb(16 20 24)', 'rgb(10%, 20%, 30%)', '#abc', ' #AABBCC ']) {
      expect(applied(whole(ok)), ok).not.toEqual({});
    }
    for (const bad of ['oklch(1.2 0 0)', 'oklch(0.2 -1 0)', 'oklch(0.2 0.02)', 'hsl(210, 120%, 10%)', 'rgb(300, 0, 0)', 'rgb(10%, 20, 30)', '#abcd', '#abcdef12', 'red', 'rgb(1,2,3);x', 'oklch(0.2 0.02 250)'.padEnd(70, ' ') + 'x', '']) {
      expect(applied(whole(bad)), bad).toEqual({});
    }
  });

  it('judges every value as isColour does, so the page and the app cannot drift apart', () => {
    const values = ['#fff', '#ffff', 'rgb(0,0,0)', 'rgb(255 255 255)', 'rgb(256,0,0)', 'rgb(50%,50%,50%)', 'rgb(1e2,0,0)', 'hsl(0,0%,0%)', 'hsl(360deg 100% 50%)', 'hsl(0 0 0)', 'hsl(-30, 50%, 50%)', 'oklch(0.5 0.1 120)', 'oklch(0.5 0.1 120deg)', 'oklch(50% 0.1 120)', 'oklch(0.5 0.1 120rad)', 'oklch(0.5, 0.1, 120)', 'RGB(0,0,0)', 'rgb( 0 , 0 , 0 )', 'rgb(0 0, 0)', 'rgba(0,0,0,1)', 'transparent', 'var(--x)', 'oklch(.5 .1 .5)', 'oklch(0.5 +0.1 -5)'];
    for (const value of values) expect(applied(whole(value)) !== undefined && Object.keys(applied(whole(value))).length > 0, value).toBe(isColour(value));
  });

  it('leaves the default livery and an unreadable one alone', () => {
    expect(applied(whole('#000000'), 'instrument')).toEqual({});
    expect(run({ rooms: [], livery: '{not json' }).root.style.props).toEqual({});
  });

  it('says how many need you only when the count changes', async () => {
    const { byId } = run({ token: 'a'.repeat(64), rooms: [room({ needsYou: 2 })] });
    await settle();
    expect(text(byId.live)).toBe('2 agents need you.');
    expect(byId.sum?.attrs.role).toBeUndefined();
  });
});

describe('the version on the rooms page', () => {
  it('sits in the top bar by the logo, as in a room, not in a corner', () => {
    const page = roomsPage(null, '9.9.9');
    const bar = page.slice(page.indexOf('<header class="topbar">'), page.indexOf('</header>'));
    expect(bar).toContain('<span class="topbar-version"><a class="version-mark"');
    expect(bar).toContain('>9.9.9</a>');
    expect(page).not.toContain('version-corner');
    expect(roomsPage(null, null)).not.toContain('topbar-version');
  });
});

describe('where room main keeps its files', () => {
  const text = (n: { all(): Array<{ textContent: string }> } & { textContent: string }): string => n.textContent;
  it('a move that was refused shows its reasons and the keys ABOVE the cards, in a box of its own, not inside main\'s card', async () => {
    const page = run({ rooms: [room()], layout: { main: '.', path: '/h', migration: { state: 'skipped', at: Date.now(), reasons: ['/h/cleanroom still holds rso: run git -C /r worktree remove /h/cleanroom/rso'] } } });
    await settle();
    const box = page.byId.move as Node;
    expect(text(box)).toContain('was not moved into rooms/main');
    expect(text(box)).toContain('git -C /r worktree remove /h/cleanroom/rso');
    for (const key of ['migrate:now', 'migrate:dry', 'migrate:dismiss']) expect(box.querySelector(`[data-f="${key}"]`), key).not.toBeNull();
    // not in the room's own card
    expect(text(page.byId.rooms as Node)).not.toContain('was not moved');
  });

  it('shows nothing for a home that keeps main in rooms/main with no note, and the removed worktrees after a move', async () => {
    const quiet = run({ rooms: [room()], layout: { main: 'rooms/main', path: '/h/rooms/main', migration: null } });
    await settle();
    expect(text(quiet.byId.move as Node)).toBe('');
    const done = run({ rooms: [room()], layout: { main: 'rooms/main', path: '/h/rooms/main', migration: { state: 'done', at: Date.now(), moved: 9, removed: ['/h/cleanroom/rso'] } } });
    await settle();
    expect(text(done.byId.move as Node)).toContain('Leftover worktrees removed first');
    expect(text(done.byId.move as Node)).toContain('/h/cleanroom/rso');
    expect((done.byId.move as Node).querySelector('[data-f="migrate:undo"]')).not.toBeNull();
  });
});

describe('stopping and starting rooms', () => {
  const rooms = [room(), room({ id: 'docs', name: 'Docs', autostart: true }), room({ id: 'old', name: 'Old', state: 'stopped', autostart: true, agents: null }), room({ id: 'idle', name: 'Idle', state: 'stopped', autostart: false, agents: null })];
  const cardOf = (byId: Record<string, Node>, id: string): Node => (byId.rooms?.children ?? []).find((c) => c.querySelector(`[data-f="open:${id}"]`) !== null) as Node;

  it('a running room has STOP, a stopped one START, and a stopped one that starts at boot says it stays down only until then', async () => {
    const { byId } = run({ token: 'a'.repeat(64), rooms });
    await settle();
    expect(cardOf(byId, 'docs').querySelector('[data-f="stop:docs"]')).not.toBeNull();
    expect(cardOf(byId, 'docs').querySelector('[data-f="start:docs"]')).toBeNull();
    expect(cardOf(byId, 'old').querySelector('[data-f="start:old"]')).not.toBeNull();
    expect(cardOf(byId, 'old').querySelector('[data-f="stop:old"]')).toBeNull();
    expect(text(cardOf(byId, 'old'))).toContain('stopped until gonogo starts again');
    expect(text(cardOf(byId, 'idle'))).not.toContain('until gonogo starts again');
  });

  it('STOP asks first and says what stops; KEEP RUNNING puts it away and sends nothing', async () => {
    const { byId, calls } = run({ token: 'a'.repeat(64), rooms });
    await settle();
    cardOf(byId, 'docs').querySelector('[data-f="stop:docs"]')?.fire('click');
    const box = cardOf(byId, 'docs').querySelector('[data-f="keep-running:docs"]');
    expect(text(cardOf(byId, 'docs'))).toContain('Its agents stop with it, and mail waiting for them is kept. It starts again when gonogo starts.');
    box?.fire('click');
    expect(cardOf(byId, 'docs').querySelector('[data-f="stop-go:docs"]')).toBeNull();
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('stopping main says what else goes off with it', async () => {
    const { byId } = run({ token: 'a'.repeat(64), rooms });
    await settle();
    cardOf(byId, 'main').querySelector('[data-f="stop:main"]')?.fire('click');
    expect(text(cardOf(byId, 'main'))).toContain('Telegram poll, phone approvals and webhooks');
  });

  it('the confirmed STOP posts to the room\'s stop route, START to its start route', async () => {
    const { byId, calls } = run({ token: 'a'.repeat(64), rooms, respond: () => ({ status: 200, body: {} }) });
    await settle();
    cardOf(byId, 'docs').querySelector('[data-f="stop:docs"]')?.fire('click');
    cardOf(byId, 'docs').querySelector('[data-f="stop-go:docs"]')?.fire('click');
    await settle();
    cardOf(byId, 'old').querySelector('[data-f="start:old"]')?.fire('click');
    await settle();
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual(['/api/rooms/docs/stop', '/api/rooms/old/start']);
  });

  it('a room that does not answer: the 409 offers STOP ANYWAY, which sends force', async () => {
    const { byId, calls } = run({
      token: 'a'.repeat(64),
      rooms,
      respond: (call) => (call.url === '/api/rooms/docs/stop' && call.body?.force !== true ? { status: 409, body: { error: 'room "docs" did not answer whether it is busy: it may be hung; send {"force":true} to stop it anyway' } } : { status: 200, body: {} }),
    });
    await settle();
    cardOf(byId, 'docs').querySelector('[data-f="stop:docs"]')?.fire('click');
    cardOf(byId, 'docs').querySelector('[data-f="stop-go:docs"]')?.fire('click');
    await settle();
    expect(text(cardOf(byId, 'docs'))).toContain('The room didn\u2019t answer whether it\u2019s busy. Stop it anyway?');
    cardOf(byId, 'docs').querySelector('[data-f="force:docs"]')?.fire('click');
    await settle();
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([{}, { force: true }]);
  });

  it('a refusal that is not "did not answer" is shown, not forced', async () => {
    const { byId } = run({ token: 'a'.repeat(64), rooms, respond: () => ({ status: 409, body: { error: 'room "docs" has an open poll' } }) });
    await settle();
    cardOf(byId, 'docs').querySelector('[data-f="stop:docs"]')?.fire('click');
    cardOf(byId, 'docs').querySelector('[data-f="stop-go:docs"]')?.fire('click');
    await settle();
    expect(text(byId.note)).toContain('has an open poll');
    expect(cardOf(byId, 'docs').querySelector('[data-f="force:docs"]')).toBeNull();
  });

  it('a stop that needs the password asks for it and repeats the stop after it', async () => {
    let asked = 0;
    const { byId, calls } = run({
      token: 'a'.repeat(64),
      rooms,
      respond: (call) => {
        if (call.url === '/api/auth/stepup') return { status: 200, body: {} };
        if (call.url === '/api/rooms/docs/stop') return ++asked === 1 ? { status: 403, body: { error: 'confirm with your password', stepUp: true } } : { status: 200, body: {} };
        return undefined;
      },
    });
    await settle();
    cardOf(byId, 'docs').querySelector('[data-f="stop:docs"]')?.fire('click');
    cardOf(byId, 'docs').querySelector('[data-f="stop-go:docs"]')?.fire('click');
    await settle();
    const step = byId.move?.querySelector('[data-f="step:password"]');
    expect(step).not.toBeNull();
    (step as Node).value = 'pw';
    byId.move?.querySelector('[data-f="step:go"]')?.fire('click');
    await settle();
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual(['/api/rooms/docs/stop', '/api/auth/stepup', '/api/rooms/docs/stop']);
  });

  it('STOP ALL says how many rooms stop, and what comes back as skipped is shown', async () => {
    const { byId, calls } = run({ token: 'a'.repeat(64), rooms, respond: (call) => (call.url === '/api/rooms/stop-all' ? { status: 200, body: { stopped: ['main'], skipped: [{ id: 'docs', why: 'room "docs" did not answer whether it is busy' }] } } : undefined) });
    await settle();
    byId.sum?.querySelector('[data-f="stop-all"]')?.fire('click');
    expect(text(byId.move)).toContain('Stop every room? 2 rooms and their agents stop, main last.');
    expect(text(byId.move)).toContain('skipped, not forced');
    byId.move?.querySelector('[data-f="stop-all-go"]')?.fire('click');
    await settle();
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual(['/api/rooms/stop-all']);
    expect(text(byId.note)).toContain('Not done: docs (room "docs" did not answer whether it is busy)');
  });

  it('START ALL is there only when a room is stopped, and the boot key flips autostart', async () => {
    const { byId, calls } = run({ token: 'a'.repeat(64), rooms, respond: () => ({ status: 200, body: {} }) });
    await settle();
    expect(byId.sum?.querySelector('[data-f="start-all"]')).not.toBeNull();
    cardOf(byId, 'idle').querySelector('[data-f="boot:idle"]')?.fire('click');
    await settle();
    expect(calls.filter((c) => c.method === 'PATCH')).toEqual([{ method: 'PATCH', url: '/api/rooms/idle', body: { autostart: true } }]);
    expect(cardOf(byId, 'main').querySelector('[data-f="boot:main"]')).toBeNull();
    const none = run({ token: 'a'.repeat(64), rooms: [room()] });
    await settle();
    expect(none.byId.sum?.querySelector('[data-f="start-all"]')).toBeNull();
  });
});
