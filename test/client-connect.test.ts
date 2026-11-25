// connect() in src/client/api.ts: a server that does not answer is LOSS OF SIGNAL; the page's own exception while it takes in the state is a client error, with its message.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const failApply = { on: false };
vi.mock('../src/client/store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/client/store.js')>();
  return {
    ...real,
    applyServerFrame: (...args: Parameters<typeof real.applyServerFrame>) => {
      if (failApply.on && args[1].t === 'state') throw new TypeError('boom in apply');
      return real.applyServerFrame(...args);
    },
  };
});

const SNAPSHOT = { agents: [], activity: [], info: { version: '9.9.9' }, governor: {}, poll: null };

beforeEach(() => {
  vi.resetModules();
  failApply.on = false;
  // the retry timer of one test must not fire in the next one: useRealTimers drops it
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.stubGlobal('location', { hash: '', pathname: '/', search: '', protocol: 'http:', host: '127.0.0.1:7777', reload: () => undefined });
  vi.stubGlobal('window', { addEventListener: () => undefined });
  vi.stubGlobal('document', { addEventListener: () => undefined, visibilityState: 'visible' });
  vi.stubGlobal('history', { replaceState: () => undefined });
  vi.stubGlobal('WebSocket', class {
    static OPEN = 1;
    readyState = 0;
    close(): void {}
    send(): void {}
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function started(): Promise<{ store: typeof import('../src/client/store.js').store; errors: unknown[][] }> {
  const errors: unknown[][] = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args));
  const api = await import('../src/client/api.js');
  const { emptyState, store } = await import('../src/client/store.js');
  // a mocked module stays cached across resetModules: the store starts empty here
  store.setState(emptyState());
  api.start();
  await vi.waitFor(() => expect(store.getState().connection === 'reconnecting' || store.getState().clientError !== null).toBe(true));
  return { store, errors };
}

describe('connect', () => {
  it('a server that does not answer is LOSS OF SIGNAL, not a client error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    const { store } = await started();
    expect(store.getState().connection).toBe('reconnecting');
    expect(store.getState().failedAttempts).toBe(1);
    expect(store.getState().clientError).toBeNull();
  });

  it('an exception while the page takes in the state is a client error with its message, the version and the stack, and goes to the console', async () => {
    failApply.on = true;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => SNAPSHOT })));
    const { store, errors } = await started();
    const error = store.getState().clientError;
    expect(error?.message).toBe('TypeError: boom in apply');
    expect(error?.details).toContain('9.9.9');
    expect(error?.details).toContain('boom in apply');
    expect(error?.details).toMatch(/\n\s*at /); // the stack
    expect(store.getState().failedAttempts).toBe(0);
    expect(errors.some((args) => args.some((a) => a instanceof TypeError))).toBe(true);
  });
});
