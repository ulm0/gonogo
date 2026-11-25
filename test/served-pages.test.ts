/** The pages the server writes itself carry no template text left unfilled: a `${` in a plain string ships as it is (RSO on #342: the TOTP field of the device page). */
import { describe, expect, it } from 'vitest';
import { authPage } from '../src/server/authpage.js';
import type { AuthPageKind } from '../src/server/authpage.js';
import { roomsPage } from '../src/server/roomspage.js';
import { INPUT_CLASS } from '../src/shared/controls.js';

const KINDS: AuthPageKind[] = ['login', 'setup', 'unset', 'damaged', 'locked', 'second', 'device', 'deviceDetails', 'deviceDone'];
const device = { code: 'ABCD-EFGH', label: 'laptop', address: '10.0.0.2', agent: 'curl', asked: 'now', far: true, again: true };

describe('the served pages', () => {
  it.each(KINDS)('%s, with every option on, has no unfilled ${', (kind) => {
    const html = authPage({ kind, stylesheet: 'index-x.css', message: 'm', user: 'director', stepUp: { code: true }, device, done: 'done', passkey: true, pending: 'p', plain: true });
    expect(html).not.toContain('${');
  });

  it('the device page draws its password and code fields as inputs', () => {
    const html = authPage({ kind: 'device', stylesheet: null, stepUp: { code: true }, device });
    expect(html).toContain(`class="${INPUT_CLASS}" data-slot="input" name="totp"`);
  });

  it('the rooms list has no unfilled ${', () => {
    expect(roomsPage('index-x.css', '1.0.0')).not.toContain('${');
  });
});
