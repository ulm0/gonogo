// The insecure-setup banner: which findings it shows and in what order, and the calls to the server.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { dismissExposure, exposureFindings } from '../src/client/api.js';
import { BANNER_ROWS, bannerFindings, bannerTitle, bannerTone } from '../src/client/exposureModel.js';
import { ExposureBanner } from '../src/client/ExposureBanner.js';
import type { ExposureFindingView } from '../src/shared/protocol.js';

const f = (id: string, severity: ExposureFindingView['severity'] = 'medium'): ExposureFindingView => ({ id, severity, text: `text of ${id}`, fix: `fix of ${id}` });

afterEach(() => vi.unstubAllGlobals());

describe('what the banner lists', () => {
  it('puts the most severe first, keeps the server order within a severity, and leaves out what another strip says', () => {
    const list = bannerFindings([f('update-checks-off', 'info'), f('no-login', 'high'), f('a', 'medium'), f('version-behind', 'info'), f('b', 'high'), f('c', 'medium')]);
    expect(list.map((x) => x.id)).toEqual(['b', 'a', 'c', 'update-checks-off']);
  });
  it('is red with a high one, else amber, and counts in words', () => {
    expect(bannerTone([f('a', 'high')])).toBe('nogo');
    expect(bannerTone([f('a'), f('b', 'info')])).toBe('amber');
    expect(bannerTitle(1)).toContain('One thing');
    expect(bannerTitle(4)).toContain('4 things');
  });
  it('draws nothing before the list is read (and so nothing without one)', () => {
    expect(renderToString(createElement(ExposureBanner))).toBe('');
    expect(BANNER_ROWS).toBeGreaterThan(0);
  });
});

describe('the calls', () => {
  const answer = (status: number, body: unknown): ReturnType<typeof vi.fn> => {
    const fetchMock = vi.fn(async () => ({ ok: status < 300, status, text: async () => JSON.stringify(body) }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };
  it('reads the list, and shows nothing (null) on 403 and on a failure', async () => {
    const ok = answer(200, { findings: [f('a')] });
    expect(await exposureFindings()).toEqual([f('a')]);
    expect(ok).toHaveBeenCalledWith('/api/exposure/findings', expect.objectContaining({ method: 'GET' }));
    answer(403, { error: 'no' });
    expect(await exposureFindings()).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('down'))));
    expect(await exposureFindings()).toBeNull();
  });
  it('dismisses by id; a 400 (already gone) is not an error, a 403 is', async () => {
    const ok = answer(200, { ok: true });
    await dismissExposure('docker-socket');
    expect(ok).toHaveBeenCalledWith('/api/exposure/dismiss', expect.objectContaining({ method: 'POST', body: JSON.stringify({ id: 'docker-socket' }) }));
    answer(400, { error: 'gone' });
    await expect(dismissExposure('x')).resolves.toBeUndefined();
    answer(403, { error: 'no' });
    await expect(dismissExposure('x')).rejects.toThrow();
  });
});

describe('which writes read the list again', () => {
  it('Flight Rules, settings, keys, Docking and agents do; a message, a vote, a task and any read do not', async () => {
    const { changesExposure } = await import('../src/client/exposureModel.js');
    for (const [m, p] of [['PUT', '/features'], ['PUT', '/settings/maxHops'], ['PUT', '/rules'], ['POST', '/agents'], ['PATCH', '/agents/ana'], ['POST', '/docking/pair'], ['DELETE', '/room-keys/x'], ['PUT', '/room?rev=3']]) expect(changesExposure(m as string, p as string), `${m} ${p}`).toBe(true);
    for (const [m, p] of [['POST', '/messages'], ['POST', '/tasks'], ['PATCH', '/tasks/t1'], ['POST', '/log'], ['POST', '/relief/r1/go'], ['GET', '/features'], ['POST', '/poll/hold']]) expect(changesExposure(m as string, p as string), `${m} ${p}`).toBe(false);
  });
});
