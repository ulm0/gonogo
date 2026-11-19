// Auto-update (docs/features/update.md): when it may run, what it never takes, the record it keeps and the breaker. The clock, the rollout, the busy
// check and the manual update are all stand-ins; nothing here starts a container.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AUTO_COOL_MS, AUTO_LEAD_MS, AUTOUPDATE_FILE, autoEligible, createAutoUpdateStore, createAutoUpdater, inWindow, parseWindow } from '../src/server/autoupdate.js';
import type { UpdateResult } from '../src/server/dockerupdate.js';

const dirs: string[] = [];
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'gonogo-auto-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const at = (h: number, m = 0): Date => new Date(2026, 10, 19, h, m);

describe('windows and versions', () => {
  it('parses HH:MM-HH:MM and refuses the rest', () => {
    expect(parseWindow('02:00-05:00')).toEqual({ from: '02:00', to: '05:00' });
    expect(parseWindow(' 23:30 - 00:15 ')).toEqual({ from: '23:30', to: '00:15' });
    for (const bad of ['', '2:00-5:00', '24:00-05:00', '02:60-05:00', '02:00-02:00', '02:00', '02:00-05:00-06:00', 'aa:bb-cc:dd']) expect(parseWindow(bad), bad).toBeNull();
  });

  it('is inside from <= now < to, and over midnight when the end is before the start', () => {
    const day = [{ from: '02:00', to: '05:00' }];
    expect(inWindow(at(1, 59), day)).toBe(false);
    expect(inWindow(at(2, 0), day)).toBe(true);
    expect(inWindow(at(4, 59), day)).toBe(true);
    expect(inWindow(at(5, 0), day)).toBe(false);
    const night = [{ from: '23:00', to: '01:00' }];
    expect([at(22, 59), at(23, 0), at(23, 59), at(0, 0), at(0, 59), at(1, 0)].map((d) => inWindow(d, night))).toEqual([false, true, true, true, true, false]);
    expect(inWindow(at(13, 30), [...day, { from: '13:00', to: '14:00' }])).toBe(true);
  });

  it('takes the next patch of the running version and nothing else (a 0.x minor counts as a major)', () => {
    expect(autoEligible('0.6.1', '0.6.2')).toBe(true);
    expect(autoEligible('0.6.1', '0.6.9')).toBe(true);
    expect(autoEligible('1.2.3', '1.2.4')).toBe(true);
    for (const [now, next] of [['0.6.1', '0.7.0'], ['0.6.1', '0.7.2'], ['0.6.1', '1.0.0'], ['1.2.3', '1.3.0'], ['1.2.3', '2.0.0'], ['0.6.2', '0.6.2'], ['0.6.2', '0.6.1'], ['0.6.1', '0.6.2-rc.1'], ['0.6.1', 'latest'], ['0.6.1', '0.6']]) {
      expect(autoEligible(now, next), `${now} -> ${next}`).toBe(false);
    }
    // a pre-release that runs now (0.6.1-rc.1) takes the patch of the same major and minor
    expect(autoEligible('0.6.1-rc.1', '0.6.2')).toBe(true);
  });
});

describe('the store', () => {
  it('is off by default, with the night window, and keeps what it is told', async () => {
    const dir = tmp();
    const store = createAutoUpdateStore({ dir, env: {} });
    await store.load();
    expect(store.state()).toMatchObject({ enabled: false, source: 'file', windows: [{ from: '02:00', to: '05:00' }], skipped: [], tried: [], pending: null, note: null });
    await store.set({ enabled: true, windows: [{ from: '03:00', to: '04:00' }] });
    await store.skip('0.6.3');
    const again = createAutoUpdateStore({ dir, env: {} });
    await again.load();
    expect(again.state()).toMatchObject({ enabled: true, windows: [{ from: '03:00', to: '04:00' }], skipped: ['0.6.3'] });
    expect(readFileSync(join(dir, AUTOUPDATE_FILE), 'utf8')).toContain('"version": 1');
  });

  it('refuses a bad body with the field named, and unknown fields', async () => {
    const store = createAutoUpdateStore({ dir: tmp(), env: {} });
    await store.load();
    for (const [body, field] of [
      [{ enabled: 'yes' }, 'enabled'],
      [{ windows: [] }, 'windows'],
      [{ windows: [{ from: '2:00', to: '5:00' }] }, 'windows'],
      [{ windows: [1, 2] }, 'windows'],
      [{ windows: Array.from({ length: 5 }, () => ({ from: '01:00', to: '02:00' })) }, 'windows'],
      [{ other: 1 }, 'other'],
    ] as const) await expect(store.set(body), JSON.stringify(body)).rejects.toMatchObject({ field });
    await expect(store.set('x')).rejects.toThrow(/JSON object/);
    await expect(store.skip('next')).rejects.toMatchObject({ field: 'version' });
  });

  it('a damaged file means off, and is left where it is', async () => {
    const dir = tmp();
    writeFileSync(join(dir, AUTOUPDATE_FILE), '{ "version": 1, "enabled": tru');
    const store = createAutoUpdateStore({ dir, env: {} });
    await store.load();
    expect(store.state().enabled).toBe(false);
    expect(readFileSync(join(dir, AUTOUPDATE_FILE), 'utf8')).toContain('tru');
    writeFileSync(join(dir, AUTOUPDATE_FILE), JSON.stringify({ version: 2, enabled: true }));
    const other = createAutoUpdateStore({ dir, env: {} });
    await other.load();
    expect(other.state().enabled).toBe(false);
  });

  it('GONOGO_AUTO_UPDATE sets the switch (and the page cannot change it); GONOGO_AUTO_UPDATE_WINDOW sets the windows', async () => {
    const on = createAutoUpdateStore({ dir: tmp(), env: { GONOGO_AUTO_UPDATE: '1', GONOGO_AUTO_UPDATE_WINDOW: '01:00-02:00,23:00-23:30' } });
    await on.load();
    expect(on.state()).toMatchObject({ enabled: true, source: 'env', windows: [{ from: '01:00', to: '02:00' }, { from: '23:00', to: '23:30' }] });
    await expect(on.set({ enabled: false })).rejects.toMatchObject({ field: 'enabled' });
    const off = createAutoUpdateStore({ dir: tmp(), env: { GONOGO_AUTO_UPDATE: 'off' } });
    await off.load();
    await off.set({ windows: [{ from: '06:00', to: '07:00' }] });
    expect(off.state()).toMatchObject({ enabled: false, source: 'env' });
    // a bad window text is ignored (the file's windows apply) and nothing else about it matters
    const bad = createAutoUpdateStore({ dir: tmp(), env: { GONOGO_AUTO_UPDATE_WINDOW: '25:00-26:00' } });
    await bad.load();
    expect(bad.state().windows).toEqual([{ from: '02:00', to: '05:00' }]);
  });

  it('records an attempt before it starts, settles it, and the breaker turns the switch off with the reason (unless the environment forces it)', async () => {
    const store = createAutoUpdateStore({ dir: tmp(), env: {} });
    await store.load();
    await store.set({ enabled: true });
    await store.attempt('0.6.2', '0.6.1', 5);
    expect(store.state()).toMatchObject({ tried: ['0.6.2'], pending: { version: '0.6.2', from: '0.6.1', at: 5 } });
    await store.trip('0.6.2', 'the new container reported unhealthy');
    expect(store.state()).toMatchObject({ enabled: false, pending: null, tried: ['0.6.2'] });
    expect(store.state().note).toMatch(/0\.6\.2 was rolled back \(the new container reported unhealthy\).*auto-update is off/);
    await store.set({ enabled: true });
    expect(store.state().note).toBeNull();
    const forced = createAutoUpdateStore({ dir: tmp(), env: { GONOGO_AUTO_UPDATE: '1' } });
    await forced.load();
    await forced.trip('0.6.2', 'x');
    expect(forced.state().enabled).toBe(true);
    expect(forced.state().tried).toContain('0.6.2');
  });
});

describe('the controller', () => {
  const MIN = 60_000;
  /** 03:00 local on the day of the clock below, a day and an hour after 0.6.2 was first seen. */
  const START = new Date(2026, 10, 19, 3, 0).getTime();
  async function rig(over: { env?: NodeJS.ProcessEnv; current?: string; latest?: string | null; seen?: number | null; busy?: () => string | null; unavailable?: () => string | null; updating?: () => boolean; start?: (v: string) => unknown; result?: UpdateResult | null; enable?: boolean } = {}) {
    let clock = START;
    const store = createAutoUpdateStore({ dir: tmp(), env: over.env ?? {} });
    await store.load();
    if (over.enable !== false && over.env?.GONOGO_AUTO_UPDATE === undefined) await store.set({ enabled: true });
    const started: string[] = [];
    const notes: string[] = [];
    const view = { enabled: true, current: over.current ?? '0.6.1', latest: over.latest === undefined ? '0.6.2' : over.latest, checkedAt: 1, newer: (over.latest === undefined ? '0.6.2' : over.latest) !== null, command: '' };
    const auto = createAutoUpdater({
      store,
      rollout: { view: () => view as never, seenAt: () => (over.seen === undefined ? START - AUTO_COOL_MS - 60 * MIN : over.seen) },
      current: over.current ?? '0.6.1',
      unavailable: over.unavailable ?? (() => null),
      busy: async () => over.busy?.() ?? null,
      start: (v) => {
        started.push(v);
        return over.start?.(v);
      },
      updating: over.updating ?? (() => false),
      readResult: async () => over.result ?? null,
      notify: (text) => notes.push(text),
      now: () => clock,
    });
    return { auto, store, started, notes, advance: (ms: number) => (clock += ms), view };
  }

  it('announces once, waits out the lead with nothing changing, starts the manual update once, and never tries that version again', async () => {
    const r = await rig();
    await r.auto.tick();
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toMatch(/Auto-update to 0\.6\.2 starts at about 03:10.*SKIP THIS VERSION/);
    expect(r.auto.view().plan).toEqual({ version: '0.6.2', startsAt: START + AUTO_LEAD_MS });
    r.advance(9 * MIN);
    await r.auto.tick();
    expect(r.started).toEqual([]);
    r.advance(MIN);
    await r.auto.tick();
    expect(r.started).toEqual(['0.6.2']);
    expect(r.store.state()).toMatchObject({ tried: ['0.6.2'], pending: { version: '0.6.2', from: '0.6.1' } });
    r.advance(30 * MIN);
    await r.auto.tick();
    await r.auto.tick();
    expect(r.started).toEqual(['0.6.2']);
    expect(r.auto.view().waiting).toMatch(/tried once already/);
  });

  it('anything busy, in this room or another, in the lead starts the lead again; the notice is not repeated', async () => {
    let busy: string | null = null;
    const r = await rig({ busy: () => busy });
    await r.auto.tick();
    r.advance(8 * MIN);
    busy = 'ana is working';
    await r.auto.tick();
    expect(r.auto.view()).toMatchObject({ plan: null, waiting: 'ana is working' });
    busy = null;
    r.advance(MIN);
    await r.auto.tick();
    expect(r.auto.view().plan?.startsAt).toBe(START + 9 * MIN + AUTO_LEAD_MS);
    r.advance(9 * MIN);
    await r.auto.tick();
    expect(r.started).toEqual([]);
    r.advance(MIN);
    await r.auto.tick();
    expect(r.started).toEqual(['0.6.2']);
    expect(r.notes).toHaveLength(1);
  });

  it.each([
    ['it is off', { enable: false }, /off/],
    ['this install cannot update itself', { unavailable: () => 'needs the Docker socket' }, /Docker socket/],
    ['a new minor', { latest: '0.7.0' }, /not the next patch/],
    ['a new major', { latest: '1.0.0' }, /not the next patch/],
    ['no newer version', { latest: null }, /no newer/],
    ['the version is not a day old', { seen: START - 23 * 3_600_000 }, /not a day old/],
    ['the time of the first sight is unknown', { seen: null }, /not a day old/],
    ['it is outside the window', { env: { GONOGO_AUTO_UPDATE: '1', GONOGO_AUTO_UPDATE_WINDOW: '04:00-05:00' } }, /outside the window/],
    ['an update is already running', { updating: () => true }, /running/],
  ] as const)('does nothing when %s', async (_what, over, why) => {
    const r = await rig(over as never);
    for (let i = 0; i < 3; i += 1) {
      await r.auto.tick();
      r.advance(10 * MIN);
    }
    expect(r.started).toEqual([]);
    expect(r.notes).toEqual([]);
    expect(r.auto.view().waiting).toMatch(why);
  });

  it('a skipped version is not taken, and a newer patch is', async () => {
    const r = await rig();
    await r.store.skip('0.6.2');
    await r.auto.tick();
    expect(r.auto.view().waiting).toMatch(/skipped/);
    r.view.latest = '0.6.3';
    await r.auto.tick();
    expect(r.auto.view().plan?.version).toBe('0.6.3');
  });

  it('a manual update that refuses to start (nothing was touched) is no attempt: the version stays open, the Director is told once, the switch stays on', async () => {
    let refuse = true;
    const r = await rig({
      start: () => {
        if (refuse) throw new Error('a T-minus poll or Static fire is running');
      },
    });
    await r.auto.tick();
    r.advance(AUTO_LEAD_MS);
    await r.auto.tick();
    expect(r.store.state()).toMatchObject({ enabled: true, tried: [], pending: null });
    expect(r.notes.at(-1)).toMatch(/did not start: a T-minus poll or Static fire is running\. Nothing was changed; it will try again/);
    await r.auto.tick();
    r.advance(AUTO_LEAD_MS);
    await r.auto.tick();
    expect(r.started).toEqual(['0.6.2', '0.6.2']);
    expect(r.notes.filter((n) => /did not start/.test(n))).toHaveLength(1);
    refuse = false;
    await r.auto.tick();
    r.advance(AUTO_LEAD_MS);
    await r.auto.tick();
    expect(r.store.state().tried).toEqual(['0.6.2']);
  });

  it('an update that fails before the helper takes over (a refused pull) is an attempt that failed: reported, the breaker trips', async () => {
    const r = await rig();
    await r.auto.tick();
    r.advance(AUTO_LEAD_MS);
    await r.auto.tick();
    expect(r.started).toEqual(['0.6.2']);
    (r.view as Record<string, unknown>).update = { state: 'failed', version: '0.6.2', note: 'the pull of 0.6.2 was refused (500). Nothing was changed.', tail: [], rollback: null };
    await r.auto.tick();
    expect(r.store.state()).toMatchObject({ enabled: false, pending: null, tried: ['0.6.2'] });
    expect(r.notes.at(-1)).toMatch(/failed: the pull of 0\.6\.2 was refused.*not tried again and auto-update is off/);
  });

  describe('how the last one ended (read by the next process)', () => {
    const result = (state: UpdateResult['state'], note = ''): UpdateResult => ({ version: 1, at: START, state, from: '0.6.1', to: '0.6.2', previousImage: '', note, tail: [] });

    it('reports a good one and clears the record', async () => {
      const r = await rig({ current: '0.6.2', latest: null, result: result('ok') });
      await r.store.attempt('0.6.2', '0.6.1', START);
      await r.auto.start();
      r.auto.close();
      expect(r.notes).toHaveLength(1);
      expect(r.notes[0]).toMatch(/updated 0\.6\.1 to 0\.6\.2/);
      expect(r.store.state().pending).toBeNull();
      expect(r.store.state().enabled).toBe(true);
    });

    it('reports a rollback, turns the switch off with the reason, and never retries that version', async () => {
      const r = await rig({ current: '0.6.1', latest: '0.6.2', result: result('rolled-back', 'the new container reported unhealthy') });
      await r.store.attempt('0.6.2', '0.6.1', START);
      await r.auto.start();
      r.auto.close();
      expect(r.notes[0]).toMatch(/was rolled back: the new container reported unhealthy.*not tried again and auto-update is off/);
      expect(r.store.state()).toMatchObject({ enabled: false, pending: null, tried: ['0.6.2'] });
      expect(r.store.state().note).toMatch(/rolled back/);
    });

    it('the NEW container is not told "updated" until the helper says ok: it runs a moment before its health check, and a failed one is removed', async () => {
      const r = await rig({ current: '0.6.2', latest: null, result: result('started') });
      await r.store.attempt('0.6.2', '0.6.1', START);
      expect(await r.auto.settle()).toBe(false);
      expect(r.notes).toEqual([]);
      expect(r.store.state().pending).not.toBeNull();
    });

    it('the NEW container whose update was rolled back (it is about to be removed) says nothing and trips nothing; the old one that comes back does', async () => {
      const rolled = result('rolled-back', 'the new container reported unhealthy');
      const gone = await rig({ current: '0.6.2', latest: null, result: rolled });
      await gone.store.attempt('0.6.2', '0.6.1', START);
      expect(await gone.auto.settle()).toBe(true);
      expect(gone.notes).toEqual([]);
      expect(gone.store.state().pending).not.toBeNull();
      const back = await rig({ current: '0.6.1', result: rolled });
      await back.store.attempt('0.6.2', '0.6.1', START);
      expect(await back.auto.settle()).toBe(true);
      expect(back.notes[0]).toMatch(/was rolled back: the new container reported unhealthy/);
      expect(back.store.state()).toMatchObject({ enabled: false, pending: null, tried: ['0.6.2'] });
    });

    it('with no record of the update at all there is nothing to learn, and the pending note is dropped', async () => {
      const r = await rig({ current: '0.6.1', result: null });
      await r.store.attempt('0.6.2', '0.6.1', START);
      expect(await r.auto.settle()).toBe(true);
      expect(r.store.state().pending).toBeNull();
      expect(r.notes).toEqual([]);
    });

    it('a helper that is still working leaves the record for the next start, and one that was killed is a failure', async () => {
      const waiting = await rig({ current: '0.6.1', result: result('started') });
      await waiting.store.attempt('0.6.2', '0.6.1', START);
      await waiting.auto.start();
      waiting.auto.close();
      expect(waiting.notes).toEqual([]);
      expect(waiting.store.state().pending).not.toBeNull();
      const killed = await rig({ current: '0.6.1', result: result('interrupted') });
      await killed.store.attempt('0.6.2', '0.6.1', START);
      await killed.auto.start();
      killed.auto.close();
      expect(killed.notes[0]).toMatch(/failed: the helper stopped half way/);
      expect(killed.store.state().enabled).toBe(false);
    });
  });
});
