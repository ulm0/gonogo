import { afterAll, describe, expect, it } from 'vitest';
import { RELAY_FORWARD_KINDS, RELAY_SERVICES, UPLINK_KINDS } from '../src/shared/protocol.js';
import { FORWARD_LABELS, lastText, parts, SERVICES, TARGET_FIELDS, targetProblems, toggled } from '../src/client/relay.js';
import { needsSecret, secretProblem } from '../src/client/uplink.js';

// What the RELAY section says and checks, without a DOM (src/client/relay.ts).

const savedZone = process.env.TZ;
process.env.TZ = 'America/New_York';
afterAll(() => {
  if (savedZone === undefined) delete process.env.TZ;
  else process.env.TZ = savedZone;
});
const at = (y: number, month: number, d: number, h = 0, min = 0): number => new Date(y, month - 1, d, h, min).getTime();

describe('the services and their steps', () => {
  it('are the four of Relay, each with an uplink kind of the server and, for two, a target of the server', () => {
    expect(SERVICES.map((s) => s.kind)).toEqual(['github', 'linear', 'slack', 'telegram']);
    for (const s of SERVICES) expect(UPLINK_KINDS).toContain(s.kind);
    expect(SERVICES.filter((s) => s.target !== null).map((s) => s.target)).toEqual(['slack', 'telegram']);
    for (const target of RELAY_SERVICES) expect(Object.keys(TARGET_FIELDS)).toContain(target);
  });

  it('have steps that are whole sentences, with code marked in pairs', () => {
    for (const s of SERVICES) {
      expect(s.steps.length, s.label).toBeGreaterThanOrEqual(5);
      for (const step of s.steps) {
        expect((step.match(/`/g) ?? []).length % 2, step).toBe(0);
        expect(step, s.label).toMatch(/[.:)…]$|`$/);
      }
    }
  });

  it('name what each service wants: the events, the scopes, the secret and the address', () => {
    const text = (kind: string): string => SERVICES.find((s) => s.kind === kind)?.steps.join('\n') ?? '';
    expect(text('github')).toMatch(/application\/json/);
    for (const event of ['Pushes', 'Pull requests', 'Issues', 'Issue comments', 'Workflow runs']) expect(text('github')).toContain(event);
    for (const scope of ['chat:write', 'app_mentions:read', 'im:history', 'channels:history', 'app_mention', 'message.im', 'xoxb-', 'Signing Secret', 'Verified']) expect(text('slack')).toContain(scope);
    expect(text('linear')).toMatch(/Signing secret/);
    expect(text('telegram')).toMatch(/setWebhook/);
    expect(text('telegram')).toMatch(/secret_token=<SECRET>/);
    expect(text('telegram')).toMatch(/@BotFather/);
    // only the two that take the secret of the service say where it comes from
    expect(SERVICES.filter((s) => needsSecret(s.kind)).map((s) => s.kind)).toEqual(['linear', 'slack']);
  });

  it('split on backticks into text and code', () => {
    expect(parts('Open `a b` and `c`.')).toEqual([
      { code: false, text: 'Open ' },
      { code: true, text: 'a b' },
      { code: false, text: ' and ' },
      { code: true, text: 'c' },
      { code: false, text: '.' },
    ]);
    expect(parts('plain')).toEqual([{ code: false, text: 'plain' }]);
    expect(parts('`x`')).toEqual([{ code: true, text: 'x' }]);
  });
});

describe('what is forwarded', () => {
  it('has a label for each kind', () => {
    expect(Object.keys(FORWARD_LABELS)).toEqual([...RELAY_FORWARD_KINDS]);
  });

  it('keeps the order of the list when one is switched on or off', () => {
    expect(toggled(['message', 'tminus'], 'redline', true)).toEqual(['message', 'redline', 'tminus']);
    expect(toggled(['message', 'redline'], 'message', false)).toEqual(['redline']);
    expect(toggled([], 'flight-plan', true)).toEqual(['flight-plan']);
    expect(toggled(['message'], 'message', true)).toEqual(['message']);
  });
});

describe('a target', () => {
  it('wants a token the first time and a place always; an empty token keeps the saved one', () => {
    expect(targetProblems({ token: '', to: '' }, false)).toEqual({ token: 'Paste the bot token.', to: 'Say where to post.' });
    expect(targetProblems({ token: '  ', to: 'C1' }, false)).toEqual({ token: 'Paste the bot token.' });
    expect(targetProblems({ token: '', to: 'C1' }, true)).toEqual({});
    expect(targetProblems({ token: 'x', to: '  ' }, true)).toEqual({ to: 'Say where to post.' });
  });

  it('says how the last send went, or that nothing was sent', () => {
    const now = at(2026, 11, 17, 15, 30);
    expect(lastText(null, now)).toBe('Nothing sent yet');
    expect(lastText({ at: at(2026, 11, 17, 9, 5), ok: true, note: 'test sent' }, now)).toBe('Last send 09:05: test sent');
    expect(lastText({ at: at(2026, 11, 16, 23, 59), ok: false, note: 'Slack answered 200: channel_not_found' }, now)).toBe('Last send 16 Nov 23:59: Slack answered 200: channel_not_found');
  });
});

describe('the signing secret of an uplink', () => {
  it('is needed by the kinds that take the secret of the service, and by no other', () => {
    expect(UPLINK_KINDS.filter(needsSecret)).toEqual(['linear', 'slack']);
  });

  it('is required for a new uplink, optional when editing, and 16 to 256 characters without spaces', () => {
    expect(secretProblem('', false)).toBe('Paste the signing secret.');
    expect(secretProblem('', true)).toBeUndefined();
    expect(secretProblem('8f742231b10e8888abcd99yyyzzz85a5', false)).toBeUndefined();
    expect(secretProblem('lin_wh_0123456789abcdef', true)).toBeUndefined();
    for (const bad of ['short', 'has a space in it 1234567', 'x'.repeat(257), 'tab\there1234567890']) expect(secretProblem(bad, false), bad).toBe('A signing secret has 16 to 256 characters and no spaces.');
  });
});
