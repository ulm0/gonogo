import { describe, expect, it } from 'vitest';
import type { AuditKind } from '../src/shared/protocol.js';
import { audited, PERMISSIONS_AUDIT, BOARD_AUDIT, DOCKING_AUDIT, HUB_AUDIT, LIVERIES_AUDIT, pollText, PROPELLANT_AUDIT, RELAY_AUDIT, RELIEF_AUDIT, REVIEW_AUDIT, SCHEDULES_AUDIT, TASKS_AUDIT, tripText, UPLINKS_AUDIT } from '../src/server/audited.js';

type Told = Array<[AuditKind, string]>;

/** A store with one method of each kind of answer, and what the Black Box was told of it. */
function wrapped<T extends object>(store: T, table: Parameters<typeof audited>[2]): { store: T; told: Told } {
  const told: Told = [];
  return { store: audited(store, (kind, text) => void told.push([kind, text]), table), told };
}

const SECRET = 'xoxb-1234567890-SECRET';

describe('audited', () => {
  it('tells after a call that worked, whether it answers at once or later, and gives back what the store gave', async () => {
    const store = {
      later: async (name: string) => ({ name, extra: 1 }),
      now: (id: string) => ({ id }),
      other: (x: number) => x + 1,
    };
    const { store: copy, told } = wrapped(store, { later: ['crew', 'did'], now: ['config', 'changed'] });
    expect(await copy.later('ana')).toEqual({ name: 'ana', extra: 1 });
    expect(copy.now('s3')).toEqual({ id: 's3' });
    expect(copy.other(1)).toBe(2);
    expect(told).toEqual([['crew', 'did ana'], ['config', 'changed s3']]);
  });

  it('tells nothing for a call that throws, at once or later, and lets the error through', async () => {
    const store = {
      boom: (): never => {
        throw new Error('no');
      },
      boomLater: async (): Promise<never> => {
        throw new Error('later');
      },
    };
    const { store: copy, told } = wrapped(store, { boom: ['crew', 'x'], boomLater: ['crew', 'y'] });
    expect(() => copy.boom()).toThrow('no');
    await expect(copy.boomLater()).rejects.toThrow('later');
    expect(told).toEqual([]);
  });

  it('does not let a table that fails stop the call', () => {
    const { store, told } = wrapped({ go: () => 'done' }, { go: ['crew', () => { throw new Error('bad table'); }] });
    expect(store.go()).toBe('done');
    expect(told).toEqual([]);
  });

  it('refuses a table that names a method the store does not have, when it is made', () => {
    expect(() => audited({ a: () => 1 }, () => undefined, { b: ['crew', 'x'] })).toThrow('audited: no method b');
  });

  it('uses the first argument that is a plain name or id, else the id or name of the answer, and no word that is not plain', () => {
    const { store, told } = wrapped(
      {
        a: (_actor: unknown, id: string) => id,
        b: () => ({ id: 'u2', secret: SECRET }),
        c: (text: string) => text,
        d: () => ({ name: 'My uplink' }),
        e: () => ({ name: 'ana' }),
      },
      { a: ['plan', 'a'], b: ['plan', 'b'], c: ['plan', 'c'], d: ['plan', 'd'], e: ['plan', 'e'] },
    );
    store.a({ kind: 'user' }, 't9');
    store.b();
    store.c('has a space');
    store.c('x'.repeat(65));
    store.c('-leading-dash');
    store.d();
    store.e();
    expect(told.map(([, text]) => text)).toEqual(['a t9', 'b u2', 'c', 'c', 'c', 'd', 'e ana']);
    expect(JSON.stringify(told)).not.toContain(SECRET);
  });
});

describe('what the Director does through the hub', () => {
  const view = (name: string) => ({ name, role: 'a role', command: 'sh -c "echo $TOKEN"', payload: { env: { TOKEN: SECRET } } });
  const hub = {
    hire: async (request: { name: string }) => view(request.name),
    restart: async (name: string) => view(name),
    startAgent: async (name: string, _by: string) => view(name),
    holdAll: () => ({ held: ['ana', 'ben'], skipped: ['cy'] }),
    resumeAll: () => ({ resumed: ['ana'] }),
    stop: async (name: string) => view(name),
    remove: async (name: string): Promise<void> => void name,
    edit: async (name: string, _request: unknown) => view(name),
    hold: (name: string) => view(name),
    resume: (name: string) => view(name),
    answer: (name: string, _request: unknown) => view(name),
    startPoll: (_request: unknown) => ({ id: 3, status: 'open' }),
    holdPoll: () => ({ id: 3, status: 'hold' }),
    abortPoll: () => ({ id: 3, status: 'aborted' }),
    clearPoll: (): void => undefined,
    setGovernor: (request: { limit: number | null }) => ({ limit: request.limit, working: 0, holding: 0 }),
    views: () => [],
  };

  it('says who was hired, stopped, started and removed, and nothing of the request', async () => {
    const { store, told } = wrapped(hub, HUB_AUDIT);
    await store.hire({ name: 'ana', role: 'secret role', command: 'x', payload: { env: { TOKEN: SECRET } } } as never);
    await store.stop('ana');
    await store.restart('ana');
    await store.remove('ana');
    await store.startAgent('ana', 'flight');
    expect(told).toEqual([
      ['crew', 'Director hired ana'],
      ['crew', 'Director stopped ana'],
      ['crew', 'Director restarted ana'],
      ['crew', 'Director removed ana'],
      ['crew', 'flight started ana'],
    ]);
    expect(JSON.stringify(told)).not.toContain(SECRET);
    expect(JSON.stringify(told)).not.toContain('secret role');
  });

  it('names the fields of an edit and never their values', async () => {
    const { store, told } = wrapped(hub, HUB_AUDIT);
    await store.edit('ana', { role: 'new role text', mode: 'bypassPermissions', confirmBypass: true, payload: { env: { TOKEN: SECRET } }, command: undefined });
    await store.edit('ana', { name: 'bea' });
    await store.edit('ana', {});
    expect(told).toEqual([
      ['config', 'Director edited ana: role, mode, payload'],
      ['config', 'Director edited ana: name'],
      ['config', 'Director edited ana: nothing'],
    ]);
    expect(JSON.stringify(told)).not.toContain(SECRET);
  });

  it('records a go or a no-go answer, a resume, the polls and Max Q', () => {
    const { store, told } = wrapped(hub, HUB_AUDIT);
    store.answer('ana', { go: true });
    store.answer('ana', { go: false });
    store.resume('ana');
    store.startPoll({});
    store.holdPoll();
    store.abortPoll();
    store.clearPoll();
    store.setGovernor({ limit: 4 });
    store.setGovernor({ limit: null });
    expect(told).toEqual([
      ['answer', 'Director answered ana: go'],
      ['answer', 'Director answered ana: no-go'],
      ['redline', 'Director resumed ana'],
      ['poll', 'Director started a T-minus poll'],
      ['poll', 'Director held the poll'],
      ['poll', 'Director aborted the poll'],
      ['poll', 'Director cleared the poll'],
      ['config', 'Director set Max Q to 4 working'],
      ['config', 'Director set Max Q to no limit'],
    ]);
  });

  it('records a Hold of an agent, and a Hold that was refused is not recorded', () => {
    const { store, told } = wrapped({ ...hub, hold: (name: string) => (name === 'bad' ? (() => { throw new Error('no hooks'); })() : view(name)) }, HUB_AUDIT);
    store.hold('ana');
    expect(() => store.hold('bad')).toThrow();
    expect(told).toEqual([['redline', 'Director put ana on hold']]);
  });

  it('records ALL STOP and ALL RESUME with the number only, never a name', () => {
    const { store, told } = wrapped(hub, HUB_AUDIT);
    store.holdAll();
    store.resumeAll();
    expect(told).toEqual([
      ['redline', 'Director pressed ALL STOP: 2 held'],
      ['redline', 'Director pressed ALL RESUME: 1 resumed'],
    ]);
  });

  it('leaves the other methods of the hub as they are', () => {
    const { store, told } = wrapped(hub, HUB_AUDIT);
    expect(store.views()).toEqual([]);
    expect(told).toEqual([]);
  });
});

describe('Flight Plan and Plot Board', () => {
  const tasks = {
    create: async (_actor: unknown, _input: unknown) => ({ id: 't7', title: 'a title', detail: SECRET }),
    update: async (_actor: unknown, id: string, _input: unknown) => ({ id }),
    remove: async (_id: string): Promise<void> => undefined,
    handOff: async (id: string, _station: string, _assignee: string | null) => ({ id }),
  };

  it('says what happened in a review, by names, ids and counts, never a body, a path or a line', async () => {
    const review = {
      addNote: async (_actor: unknown, name: string, input: unknown) => ({ name, input }),
      addNotes: async (_actor: unknown, _name: string, _inputs: unknown) => [{ id: 'rn1' }, { id: 'rn2' }],
      update: async (_name: string, id: string, _input: unknown) => ({ id }),
      remove: async (_name: string, _id: string) => undefined,
      verdict: async (_name: string, input: { verdict: string; summary?: string }) => ({ message: 'm1', notes: 3, verdict: { verdict: input.verdict } }),
      ask: async (_name: string, _input: unknown) => ({ message: 'm2', notes: 0 }),
    };
    const { store, told } = wrapped(review, REVIEW_AUDIT);
    await store.addNote({ kind: 'user' }, 'ana', { path: 'secret/path.ts', line: 3, body: SECRET });
    await store.addNotes({ kind: 'agent', name: 'ben' }, 'ana', [{ body: SECRET }]);
    await store.update('ana', 'rn1', { status: 'resolved' });
    await store.update('ana', 'rn2', { body: SECRET });
    await store.remove('ana', 'rn1');
    await store.verdict('ana', { verdict: 'changes', summary: SECRET } as never);
    await store.verdict('ana', { verdict: 'approved' });
    await store.ask('ana', { kind: 'walkthrough' });
    await store.ask('ana', { kind: 'peer', reviewer: 'ben' });
    expect(told).toEqual([
      ['plan', 'Director added a review note on ana'],
      ['plan', 'ben added 2 review notes on ana'],
      ['plan', 'Director changed review note rn1 of ana to resolved'],
      ['plan', 'Director changed review note rn2 of ana (edited)'],
      ['plan', 'Director deleted review note rn1 of ana'],
      ['plan', 'Director gave a verdict on ana: changes requested'],
      ['plan', 'Director gave a verdict on ana: approved'],
      ['plan', 'Director asked ana for a walkthrough of its diff'],
      ['plan', 'Director asked ben to review the diff of ana'],
    ]);
    expect(JSON.stringify(told)).not.toContain(SECRET);
    expect(JSON.stringify(told)).not.toContain('secret/path');
  });

  it('says who made or changed a task and how, never its title, detail or note', async () => {
    const { store, told } = wrapped(tasks, TASKS_AUDIT);
    const ana = { kind: 'agent', name: 'ana', generation: 1 };
    await store.create(ana, { title: 'Ship', detail: SECRET });
    await store.create({ kind: 'user' }, { title: 'Ship' });
    await store.create({ kind: 'dock', station: 'lab' }, { title: 'Ship' });
    await store.update(ana, 't7', { status: 'doing' });
    await store.update(ana, 't7', { status: 'review', assignee: 'ben', note: SECRET });
    await store.update({ kind: 'user' }, 't7', { assignee: null });
    await store.update({ kind: 'user' }, 't7', { note: SECRET });
    await store.update(ana, 't7', { status: 'not a status', assignee: 'a name with spaces' });
    await store.remove('t7');
    await store.handOff('t7', 'lab', null);
    expect(told).toEqual([
      ['plan', 'ana created task t7'],
      ['plan', 'Director created task t7'],
      ['plan', 'Director of lab created task t7'],
      ['plan', 'ana updated task t7: status doing'],
      ['plan', 'ana updated task t7: status review assignee ben note'],
      ['plan', 'Director updated task t7: unassigned'],
      ['plan', 'Director updated task t7: note'],
      ['plan', 'ana updated task t7:'],
      ['plan', 'Director removed task t7'],
      ['plan', 'Director handed off task t7 to lab'],
    ]);
    expect(JSON.stringify(told)).not.toContain(SECRET);
    expect(JSON.stringify(told)).not.toContain('Ship');
  });

  const board = {
    write: async (by: string, input: { text: string; revision: number }) => ({ text: input.text, revision: input.text === 'same' ? input.revision : input.revision + 1, author: by, updatedAt: 1 }),
  };

  it('says who wrote the Plot Board, which revision and how long, and not the text; the same text again says nothing', async () => {
    const { store, told } = wrapped(board, BOARD_AUDIT);
    await store.write('flight', { text: `plan ${SECRET}`, revision: 3 });
    await store.write('user', { text: 'x'.repeat(10), revision: 4 });
    await store.write('flight', { text: 'same', revision: 5 });
    expect(told).toEqual([
      ['plan', `flight wrote the Plot Board: revision 4, ${`plan ${SECRET}`.length} characters`],
      ['plan', 'Director wrote the Plot Board: revision 5, 10 characters'],
    ]);
    expect(JSON.stringify(told)).not.toContain('plan xoxb');
  });
});

describe('Uplink, and what the Director configures', () => {
  it('records a delivery that made a message and not a ping, and never a body or a secret', async () => {
    const uplinks = {
      deliver: (id: string, _raw: Buffer, _headers: object) => (id === 'u9' ? { ok: true as const, answer: { pong: true } } : { ok: true as const, id: 'm41', status: 'queued' }),
      create: async (_input: unknown) => ({ id: 'u3', name: 'My hook', secret: SECRET }),
      update: async (_id: string, _input: unknown) => ({}),
      remove: async (_id: string): Promise<void> => undefined,
      rotate: async (_id: string) => ({ id: 'u3', secret: SECRET }),
    };
    const { store, told } = wrapped(uplinks, UPLINKS_AUDIT);
    store.deliver('u3', Buffer.from(`body ${SECRET}`), { authorization: `Bearer ${SECRET}` });
    store.deliver('u9', Buffer.from('ping'), {});
    await store.create({ name: 'My hook', secret: SECRET });
    await store.update('u3', { enabled: false });
    await store.remove('u3');
    await store.rotate('u3');
    expect(told).toEqual([
      ['uplink', 'Uplink u3 delivered message m41'],
      ['config', 'Director made an uplink u3'],
      ['config', 'Director changed uplink u3'],
      ['config', 'Director removed uplink u3'],
      ['config', 'Director rotated the secret of uplink u3'],
    ]);
    expect(JSON.stringify(told)).not.toContain(SECRET);
  });

  it('records the rest of the configuration by its name or id, never by the body', async () => {
    const all = {
      schedules: { create: async (_b: unknown) => ({ id: 's3', name: 'Nightly', body: SECRET }), update: async (id: string, _b: unknown) => ({ id }), remove: async (_id: string): Promise<void> => undefined, run: async (id: string) => ({ id }) },
      propellant: { setLimits: async (_r: unknown) => ({ room: {} }), setBudget: async (_b: unknown) => ({ room: {} }) },
      relay: { set: async (name: string, _b: unknown) => ({ name }), remove: async (name: string) => ({ name }), forward: async (_b: unknown) => ({}) },
      liveries: { select: async (_b: unknown) => ({}), remove: async (slug: string) => ({ slug }) },
      docking: { createCode: (_b: unknown) => ({ code: SECRET }), pair: async (_b: unknown) => ({ id: 'd1' }), undock: async (id: string) => ({ id }) },
    };
    const told: Told = [];
    const record = (kind: AuditKind, text: string): void => void told.push([kind, text]);
    const schedules = audited(all.schedules, record, SCHEDULES_AUDIT);
    const propellant = audited(all.propellant, record, PROPELLANT_AUDIT);
    const relay = audited(all.relay, record, RELAY_AUDIT);
    const liveries = audited(all.liveries, record, LIVERIES_AUDIT);
    const docking = audited(all.docking, record, DOCKING_AUDIT);
    await schedules.create({ name: 'Nightly', body: SECRET });
    await schedules.update('s3', { body: SECRET });
    await schedules.remove('s3');
    await schedules.run('s3');
    await propellant.setLimits({ room: { day: 1000 } });
    await relay.set('slack', { token: SECRET, to: 'C0123456789' });
    await relay.remove('slack');
    await relay.forward({ kinds: ['message'] });
    await liveries.select({ current: 'dusk' });
    await liveries.remove('dusk');
    docking.createCode({ url: SECRET });
    await docking.pair({ code: SECRET });
    await docking.undock('d1');
    expect(told.map(([, text]) => text)).toEqual([
      'Director made a schedule s3',
      'Director changed schedule s3',
      'Director removed schedule s3',
      'Director ran schedule s3',
      'Director changed the Propellant limits',
      'Director set up Relay target slack',
      'Director removed Relay target slack',
      'Director changed what Relay forwards',
      'Director chose a livery',
      'Director removed livery dusk',
      'Director made a docking code',
      'Director paired a station d1',
      'Director undocked d1',
    ]);
    expect(JSON.stringify(told)).not.toContain(SECRET);
  });
});

describe('what a Redline trip and a poll say', () => {
  it('keeps the name and the rule of a trip, never the command line that is in its reason', () => {
    expect(tripText('ana: loop: Bash: curl -H "Authorization: Bearer xoxb-SECRET" 5 times in a row')).toBe('ana tripped the Redline: loop');
    expect(tripText('ana: error storm: 8 failed tool calls in 2 min')).toBe('ana tripped the Redline: error storm');
    expect(tripText('ben: ping-pong: 16 messages to ana in 10 min')).toBe('ben tripped the Redline: ping-pong');
    expect(tripText('cy: out of propellant: 2M of 2M tokens in day')).toBe('cy tripped the Redline: out of propellant');
    expect(tripText('cy: room out of propellant: 5M of 5M tokens in week')).toBe('cy tripped the Redline: room out of propellant');
    // a reason that is not one of ours, a name that is not a name, a text with no colon
    expect(tripText('ana: something else with a secret xoxb-SECRET')).toBe('ana tripped the Redline: another rule');
    expect(tripText('a b: loop: x')).toBe('An agent tripped the Redline: loop');
    expect(tripText('xoxb-SECRET')).toBe('An agent tripped the Redline: another rule');
    expect(tripText('loopy: loopback')).toBe('loopy tripped the Redline: another rule');
  });

  it('puts the result of a poll after its name', () => {
    expect(pollText('HOLD: no-go: ana')).toBe('T-minus poll HOLD: no-go: ana');
  });
});

describe('what the Director answers to Relief', () => {
  const relief = { request: async (_by: unknown, input: { name: string; role: string }) => (input.name === 'rule' ? { id: 'hired:rule', status: 'hired', name: 'rule' } : { id: 'h3', status: 'pending', note: `needs the Director's GO: ${SECRET}` }), setRules: async (_body: unknown) => ({ requests: [] }), stopCrew: async () => ({ stopped: ['a', 'b'], view: { requests: [] } }), decide: async (id: string, verdict: string, _by: unknown) => ({ id, verdict, requests: [{ name: 'secret-name', role: SECRET }] }), view: () => ({ requests: [] }) };

  it('records a go and a no-go by the id of the request, and nothing of the request', async () => {
    const { store, told } = wrapped(relief, RELIEF_AUDIT);
    await store.decide('h1', 'go', { kind: 'user' });
    await store.decide('h2', 'no-go', { kind: 'user' });
    expect(told).toEqual([
      ['answer', 'Director answered hire request h1: go'],
      ['answer', 'Director answered hire request h2: no-go'],
    ]);
    expect(JSON.stringify(told)).not.toContain(SECRET);
    expect(store.view()).toEqual({ requests: [] });
  });

  it('records the boss\'s hire by rule, the rules changed and STOP CREW: names and counts, never the role text or the note', async () => {
    const { store, told } = wrapped(relief, RELIEF_AUDIT);
    await store.request({}, { name: 'rule', role: SECRET });
    await store.request({}, { name: 'wait', role: SECRET });
    await store.setRules({ role: SECRET });
    await store.stopCrew();
    expect(told).toEqual([
      ['crew', 'boss hired rule by rule'],
      ['crew', 'boss asked to hire an agent: waits for the Director (h3)'],
      ['config', 'Director changed the Relief rules'],
      ['crew', 'STOP CREW: 2 agents stopped, automatic hires off'],
    ]);
    expect(JSON.stringify(told)).not.toContain(SECRET);
  });

  it('records nothing when the answer is refused or the id is not a plain id', async () => {
    const refusing = { request: async () => ({}), setRules: async () => ({}), stopCrew: async () => ({}), decide: async (_id: string, _verdict: string, _by: unknown): Promise<never> => { throw new Error('forbidden'); } };
    const refused = wrapped(refusing, RELIEF_AUDIT);
    await expect(refused.store.decide('h1', 'go', { kind: 'agent' })).rejects.toThrow();
    expect(refused.told).toEqual([]);
    const { store, told } = wrapped(relief, RELIEF_AUDIT);
    await store.decide(`x ${SECRET}`, 'go', { kind: 'user' });
    expect(told).toEqual([['answer', 'Director answered hire request ?: go']]);
  });
});

describe('what the Director does to the room\'s tool rules', () => {
  it('records that they changed, never a rule', () => {
    const { store, told } = wrapped({ set: async (_rules: unknown) => ({ permissions: {} }) }, PERMISSIONS_AUDIT);
    void store.set({ allow: [`Bash(curl -H "Authorization: ${SECRET}")`] });
    return Promise.resolve().then(() => {
      expect(told).toEqual([['config', "Director changed the room's tool rules"]]);
      expect(JSON.stringify(told)).not.toContain(SECRET);
    });
  });
});
