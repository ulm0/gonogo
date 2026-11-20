// CHECK NOW (src/client/CheckNow.tsx): the words of "when was it checked" and the call to the server.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkedAgo } from '../src/client/CheckNow.js';
import { checkUpdateNow } from '../src/client/api.js';

afterEach(() => vi.unstubAllGlobals());

describe('when the last check was', () => {
  const now = 1_000_000_000;
  it('says it in the unit that fits', () => {
    expect(checkedAgo(now - 5_000, now)).toBe('just now');
    expect(checkedAgo(now - 12 * 60_000, now)).toBe('12 min ago');
    expect(checkedAgo(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(checkedAgo(now - 2 * 86_400_000, now)).toBe('2 d ago');
    expect(checkedAgo(now + 60_000, now)).toBe('just now'); // a clock that is ahead
  });
});

describe('the call', () => {
  const answer = (body: unknown, status = 200): void =>
    void vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => ({ ok: status < 300, status, text: async () => JSON.stringify(body), json: async () => body, headers: new Headers({ 'content-type': 'application/json' }), url, init })));

  it('POSTs to /api/rollout/check and gives back the seconds to wait when the server says so', async () => {
    answer({ rollout: { latest: '0.9.2' }, waitS: 40 });
    expect(await checkUpdateNow()).toEqual({ waitS: 40 });
    const [url, init] = (fetch as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0] as [string, RequestInit];
    expect(String(url)).toMatch(/\/api\/rollout\/check$/);
    expect(init.method).toBe('POST');
    answer({ rollout: { latest: '0.9.2' } });
    expect(await checkUpdateNow()).toEqual({});
  });

  it('turns a refusal into an error with the server\'s words', async () => {
    answer({ error: 'the update check is off here', code: 'conflict' }, 409);
    await expect(checkUpdateNow()).rejects.toThrow(/the update check is off here/);
  });
});
