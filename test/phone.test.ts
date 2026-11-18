import { describe, expect, it } from 'vitest';
import type { Logger } from '../src/shared/protocol.js';
import { createPhone, PHONE_PRESS_MAX } from '../src/server/phone.js';
import { callbackData } from '../src/server/phonetag.js';

const SECRET = 'telegram-uplink-secret-0123456789';
const quiet: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined, child: () => quiet };

function setup(over: { nonce?: string; phoneOn?: () => boolean; on?: boolean; secret?: string | null; answer?: (name: string, request: { go: boolean; needSeq?: number }) => unknown; decide?: (id: string, verdict: string) => Promise<unknown> } = {}) {
  const sent: Array<{ text: string; markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } }> = [];
  const called: Array<[string, Record<string, unknown>]> = [];
  const answered: Array<[string, { go: boolean; needSeq?: number }]> = [];
  const decided: Array<[string, string]> = [];
  let clock = 0;
  const phone = createPhone({
    hub: {
      answer: (name, request) => {
        answered.push([name, request]);
        return over.answer?.(name, request) as never;
      },
    },
    relief: {
      decide: async (id, verdict) => {
        decided.push([id, verdict]);
        return (await over.decide?.(id, verdict)) as never;
      },
    },
    relay: {
      phoneTelegram: () => over.on !== false && (over.phoneOn?.() ?? true),
      sendButtons: async (text, markup) => {
        sent.push({ text, markup: markup as never });
        return true;
      },
      telegramCall: async (method, body) => {
        called.push([method, body]);
        return true;
      },
    },
    secret: () => (over.secret === undefined ? SECRET : over.secret),
    nonce: () => over.nonce ?? 'abcd',
    now: () => clock,
    log: quiet,
  });
  const press = (data: string | null, queryId = 'q1') => phone.press(SECRET, { queryId, data: data ?? 'a:x', chat: '555', messageId: '41' });
  const tick = (ms: number): void => void (clock += ms);
  const dataOf = (n: number, verdict: string): string => sent[n]?.markup.inline_keyboard[0]?.find((b) => b.text === verdict)?.callback_data ?? '';
  return { phone, sent, called, answered, decided, press, tick, dataOf };
}

describe('phone approvals: what is sent', () => {
  it('sends a permission with GO and NO-GO, signed, and no more when the path is off or has no secret', () => {
    const t = setup();
    t.phone.approval({ kind: 'permission', agent: 'ana', seq: 3 }, 'ana asks: Bash: ls');
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]?.markup.inline_keyboard[0]?.map((b) => b.text)).toEqual(['GO', 'NO-GO']);
    expect(t.dataOf(0, 'GO')).toMatch(/^a:permission:pabcd1:go:[0-9a-f]{8}$/);
    const off = setup({ on: false });
    off.phone.approval({ kind: 'permission', agent: 'ana', seq: 3 }, 'x');
    const none = setup({ secret: null });
    none.phone.approval({ kind: 'permission', agent: 'ana', seq: 3 }, 'x');
    expect(off.sent).toHaveLength(0);
    expect(none.sent).toHaveLength(0);
  });

  it('offers NO-GO and Open only for a cut dialog, and for a hire request, whose role text is not shown', () => {
    const t = setup();
    t.phone.approval({ kind: 'permission', agent: 'ana', seq: 3 }, 'ana asks: Bash: aaaaaaaa…');
    t.phone.approval({ kind: 'relief', id: 'h4' }, 'flight asks to hire guido-1 as GUIDO: claude, acceptEdits, /work');
    expect(t.sent.map((m) => m.markup.inline_keyboard[0]?.map((b) => b.text))).toEqual([['NO-GO', 'Open'], ['NO-GO', 'Open']]);
    expect(t.sent[0]?.text).toContain('truncated');
    expect(t.sent[1]?.text).toContain('role text: open gonogo to read it');
    expect(t.dataOf(1, 'NO-GO')).toMatch(/^a:relief:rabcdh4:nogo:/);
  });
});

describe('phone approvals: a press', () => {
  it('answers a permission for the dialog it was made for, tells Telegram and takes the buttons off', async () => {
    const t = setup();
    t.phone.approval({ kind: 'permission', agent: 'ana', seq: 3 }, 'ana asks: Bash: ls');
    await t.press(t.dataOf(0, 'GO'));
    expect(t.answered).toEqual([['ana', { go: true, needSeq: 3 }]]);
    expect(t.called.map(([method]) => method)).toEqual(['answerCallbackQuery', 'editMessageReplyMarkup']);
    expect(t.called[0]?.[1]).toMatchObject({ callback_query_id: 'q1', text: 'Sent GO' });
    expect(t.called[1]?.[1]).toMatchObject({ message_id: 41, reply_markup: { inline_keyboard: [] } });
  });

  it('says "too late" when the hub refuses the dialog (answered or replaced), and still clears the buttons', async () => {
    const t = setup({
      answer: () => {
        throw new Error('ana is asking about something else now: that dialog was answered or replaced');
      },
    });
    t.phone.approval({ kind: 'permission', agent: 'ana', seq: 3 }, 'x');
    await t.press(t.dataOf(0, 'NO-GO'));
    expect(t.called[0]?.[1]).toMatchObject({ text: 'Too late: already answered' });
    expect(t.called[1]?.[0]).toBe('editMessageReplyMarkup');
  });

  it('refuses a wrong tag, a button made with another secret, and a handle of before a restart', async () => {
    const t = setup();
    t.phone.approval({ kind: 'permission', agent: 'ana', seq: 3 }, 'x');
    await t.press(t.dataOf(0, 'GO').replace(/.$/, (c) => (c === '0' ? '1' : '0')));
    await t.press(callbackData('another-secret-0123456789', { kind: 'permission', id: 'pabcd1', verdict: 'go' }));
    expect(t.called.map(([, body]) => body.text)).toEqual(['Invalid button', 'Invalid button']);
    const fresh = setup();
    await fresh.press(callbackData(SECRET, { kind: 'permission', id: 'pabcd9', verdict: 'go' }));
    expect(fresh.answered).toEqual([]);
    expect(fresh.called[0]?.[1]).toMatchObject({ text: 'Too late: already answered' });
    expect(t.answered).toEqual([]);
  });

  it('says NO-GO to a hire request, and Open only says to open gonogo', async () => {
    const t = setup();
    t.phone.approval({ kind: 'relief', id: 'h4' }, 'x');
    await t.press(t.dataOf(0, 'Open'));
    expect(t.decided).toEqual([]);
    expect(t.called[0]?.[1]).toMatchObject({ text: expect.stringContaining('Open gonogo') });
    await t.press(t.dataOf(0, 'NO-GO'), 'q2');
    expect(t.decided).toEqual([['h4', 'no-go']]);
  });

  it('never approves a hire request, even with a signed GO made by hand', async () => {
    const t = setup();
    await t.press(callbackData(SECRET, { kind: 'relief', id: 'rabcdh4', verdict: 'go' }));
    expect(t.decided).toEqual([]);
    expect(t.called[0]?.[1]).toMatchObject({ text: 'hire requests are approved in gonogo' });
  });

  it('says a hire request that is gone is too late', async () => {
    const t = setup({
      decide: async () => {
        throw new Error('no such hire request: it may have expired or been answered');
      },
    });
    await t.press(callbackData(SECRET, { kind: 'relief', id: 'rabcdh4', verdict: 'nogo' }));
    expect(t.called[0]?.[1]).toMatchObject({ text: 'Too late: already answered' });
  });

  it('takes at most PHONE_PRESS_MAX presses a minute, and more after it', async () => {
    const t = setup();
    t.phone.approval({ kind: 'relief', id: 'h4' }, 'x');
    for (let n = 0; n < PHONE_PRESS_MAX; n++) await t.press(t.dataOf(0, 'Open'));
    await t.press(t.dataOf(0, 'Open'));
    expect(t.called.at(-1)?.[1]).toMatchObject({ text: 'Too many presses: wait a minute' });
    t.tick(61_000);
    await t.press(t.dataOf(0, 'Open'));
    expect(t.called.at(-1)?.[1]).toMatchObject({ text: expect.stringContaining('Open gonogo') });
  });

  it('two taps of one button type one answer: the second one is the hub\'s conflict', async () => {
    let first = true;
    const t = setup({
      answer: () => {
        if (!first) throw new Error('ana is not asking for a go');
        first = false;
      },
    });
    t.phone.approval({ kind: 'permission', agent: 'ana', seq: 3 }, 'x');
    await t.press(t.dataOf(0, 'GO'));
    await t.press(t.dataOf(0, 'GO'), 'q2');
    expect(t.called.filter(([, body]) => body.text === 'Sent GO')).toHaveLength(1);
    expect(t.called.some(([, body]) => body.text === 'Too late: already answered')).toBe(true);
  });
});

describe('phone approvals: after a restart, and when the path is turned off', () => {
  it('refuses the buttons of an earlier process even though the secret is the same: its p1 is not this process\'s p1', async () => {
    const before = setup({ nonce: '1111' });
    before.phone.approval({ kind: 'permission', agent: 'ana', seq: 3 }, 'ana asks: Bash: ls');
    before.phone.approval({ kind: 'relief', id: 'h1' }, 'flight asks to hire x');
    const oldGo = before.dataOf(0, 'GO');
    const oldNoGo = before.dataOf(1, 'NO-GO');
    // a new process: the counters start again, the secret is the one in uplinks.json
    const after = setup({ nonce: '2222' });
    after.phone.approval({ kind: 'permission', agent: 'bob', seq: 3 }, 'bob asks: Bash: rm -rf x');
    await after.press(oldGo);
    await after.press(oldNoGo, 'q2');
    expect(after.answered).toEqual([]);
    expect(after.decided).toEqual([]);
    expect(after.called.filter(([m]) => m === 'answerCallbackQuery').map(([, b]) => b.text)).toEqual(['Too late: already answered', 'Too late: already answered']);
    // the new button still works
    await after.press(after.dataOf(0, 'GO'), 'q3');
    expect(after.answered).toEqual([['bob', { go: true, needSeq: 3 }]]);
  });

  it('refuses a press once phone approvals are off, and counts presses with a bad tag', async () => {
    let on = true;
    const t = setup({ phoneOn: () => on });
    t.phone.approval({ kind: 'permission', agent: 'ana', seq: 3 }, 'x');
    const go = t.dataOf(0, 'GO');
    on = false;
    await t.press(go);
    expect(t.answered).toEqual([]);
    expect(t.called[0]?.[1]).toMatchObject({ text: 'Phone approvals are off' });
    on = true;
    for (let n = 0; n < PHONE_PRESS_MAX; n++) await t.press('a:permission:pabcd1:go:00000000');
    await t.press(go);
    expect(t.answered).toEqual([]);
    expect(t.called.at(-1)?.[1]).toMatchObject({ text: 'Too many presses: wait a minute' });
  });
});
