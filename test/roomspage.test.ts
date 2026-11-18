// The list page of the rooms supervisor (src/server/roomspage.ts): its scripts run here against a small stand-in for the DOM (no
// browser exists on this host), so the cards, the keys and the livery are tried as the page builds them. What a real browser draws
// (the look, the focus ring, the phone layout) is not covered here.
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
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

function run(options: { token?: string; rooms: unknown[]; livery?: string; hash?: string }): { byId: Record<string, Node>; saved: Record<string, string>; root: Node & { style: { props: Record<string, string> } } } {
  const html = roomsPage(null, '1.2.3');
  const scripts = [...html.matchAll(/<script>([^]*?)<\/script>/g)].map((m) => m[1] ?? '');
  const byId: Record<string, Node> = {};
  for (const id of ['rooms', 'note', 'add', 'gate', 'sum', 'title', 'loading', 'new', 'cancel']) byId[id] = make(id === 'add' ? 'form' : 'div');
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
    location: { hash: options.hash ?? '', pathname: '/' },
    history: { replaceState() {} },
    URLSearchParams,
    fetch: async () => ({ status: 200, ok: true, json: async () => ({ rooms: options.rooms }) }),
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
  return { byId, saved, root };
}

const room = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({ id: 'main', name: 'Main', state: 'running', agents: 15, running: 15, needsYou: 0, working: 0, lastActivity: null, tabName: null, note: null, ...patch });
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10));
const text = (n: Node | undefined): string => n?.textContent ?? '';

describe('the rooms list page script', () => {
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

  it('without a token it says how to open the page; nothing else is drawn', async () => {
    const { byId } = run({ rooms: [room()] });
    await settle();
    expect(byId.gate?.hidden).toBe(false);
    expect(text(byId.gate?.querySelector('h2') ?? undefined)).toMatch(/address gonogo printed/);
    expect(byId.rooms?.children).toHaveLength(0);
    expect(byId.new?.disabled).toBe(true);
  });

  it('puts the livery of the last visit on the page, names and colours only', () => {
    const livery = JSON.stringify({ slug: 'night', tokens: { '--body': '#101418', '--text': 'rgb(240, 240, 240)', '--evil': 'url(https://x/y)', 'bad name': '#fff', '--ok-name': 'red;background:url(x)' } });
    const { root } = run({ rooms: [], livery });
    expect(root.style.props).toMatchObject({ '--body': '#101418', '--text': 'rgb(240, 240, 240)', 'color-scheme': 'dark' });
    expect(root.style.props['--evil']).toBeUndefined();
    expect(root.style.props['bad name']).toBeUndefined();
    expect(root.style.props['--ok-name']).toBeUndefined();
    expect(root.dataset.scheme).toBe('dark');
    expect(root.dataset.livery).toBe('night');
  });

  it('leaves the default livery and an unreadable one alone', () => {
    expect(run({ rooms: [], livery: JSON.stringify({ slug: 'instrument', tokens: { '--body': '#000000' } }) }).root.style.props).toEqual({});
    expect(run({ rooms: [], livery: '{not json' }).root.style.props).toEqual({});
  });
});
