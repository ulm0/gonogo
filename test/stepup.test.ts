// Which changes ask for the password again (docs/login-spec.md, step-up): an ALLOW-list for an edit, so a field added later is asked about by default.
import { describe, expect, it } from 'vitest';
import { bodyMatters, stepUpReason } from '../src/server/stepup.js';

describe('auto-update (it runs code of the publisher unattended)', () => {
  const put = (body: Record<string, unknown> | null) => stepUpReason('PUT', '/api/autoupdate', body);
  it('asks to turn it on or to move its windows, and when the body cannot be read; never to turn it off or to skip a version', () => {
    expect(bodyMatters('PUT', '/api/autoupdate')).toBe(true);
    expect(put({ enabled: true })).not.toBeNull();
    expect(put({ windows: [{ from: '02:00', to: '05:00' }] })).not.toBeNull();
    expect(put({ enabled: true, windows: [] })).not.toBeNull();
    expect(put(null)).not.toBeNull();
    expect(put({ enabled: false })).toBeNull();
    expect(put({})).toBeNull();
    expect(stepUpReason('POST', '/api/autoupdate/skip', { version: '0.6.3' })).toBeNull();
    expect(stepUpReason('GET', '/api/autoupdate', null)).toBeNull();
  });
});

describe('an edit of an agent', () => {
  const edit = (body: Record<string, unknown> | null) => stepUpReason('PATCH', '/api/agents/ana', body);

  it('asks about every field that is not plainly harmless, including the ones RSO named', () => {
    for (const field of ['mode', 'command', 'role', 'permissions', 'payload', 'dir', 'cleanRoom', 'confirmBypass', 'worktree', 'remoteControl', 'keys', 'image', 'aFieldOfALaterVersion']) {
      expect(edit({ [field]: field === 'cleanRoom' ? false : 'x' }), field).not.toBeNull();
    }
    expect(edit({ cleanRoom: false })).not.toBeNull();
    expect(edit({ dir: '/' })).not.toBeNull();
  });

  it('lets name, position, autostart, coauthor, model and effort through, alone or together', () => {
    for (const field of ['name', 'position', 'autostart', 'coauthor', 'model', 'effort']) expect(edit({ [field]: 'x' }), field).toBeNull();
    expect(edit({ name: 'b', position: 'guido', autostart: false, coauthor: false, model: 'm', effort: 'high' })).toBeNull();
    // one field of the other kind among them is enough
    expect(edit({ model: 'm', dir: '/tmp' })).not.toBeNull();
    // a field that is undefined is no field
    expect(edit({ model: 'm', dir: undefined })).toBeNull();
  });

  it('asks when there is no body to read, and for PUT as for PATCH', () => {
    expect(edit(null)).not.toBeNull();
    expect(stepUpReason('PUT', '/api/agents/ana', { role: 'x' })).not.toBeNull();
    expect(stepUpReason('PUT', '/api/agents/ana', { model: 'x' })).toBeNull();
    expect(stepUpReason('GET', '/api/agents/ana', null)).toBeNull();
  });
});

describe('a hire', () => {
  const hire = (body: Record<string, unknown> | null) => stepUpReason('POST', '/api/agents', body);

  it('asks for a command of its own, an unattended mode, no Clean Room, remote control or keys', () => {
    expect(hire({ name: 'x', command: 'sh' })).not.toBeNull();
    expect(hire({ name: 'x', mode: 'auto' })).not.toBeNull();
    expect(hire({ name: 'x', mode: 'bypassPermissions' })).not.toBeNull();
    expect(hire({ name: 'x', cleanRoom: false })).not.toBeNull();
    expect(hire({ name: 'x', remoteControl: true })).not.toBeNull();
    expect(hire({ name: 'x', remoteControl: { enabled: true } })).not.toBeNull();
    expect(hire({ name: 'x', keys: { ANTHROPIC_API_KEY: 'k' } })).not.toBeNull();
    expect(hire(null)).not.toBeNull();
  });

  it('asks for a payload or permissions that carry something, not for empty ones', () => {
    expect(hire({ name: 'x', payload: { env: { A: 'b' } } })).not.toBeNull();
    expect(hire({ name: 'x', permissions: { allow: ['Bash'] } })).not.toBeNull();
    expect(hire({ name: 'x', permissions: { allow: ['Bash'], deny: [] } })).not.toBeNull();
    for (const empty of [{}, [], null, '']) {
      expect(hire({ name: 'x', payload: empty }), JSON.stringify(empty)).toBeNull();
      expect(hire({ name: 'x', permissions: empty }), JSON.stringify(empty)).toBeNull();
    }
  });

  it('lets a plain hire through', () => {
    expect(hire({ name: 'x', role: 'does a thing', mode: 'default', dir: '/work' })).toBeNull();
    expect(hire({ name: 'x', cleanRoom: true })).toBeNull();
    expect(hire({ name: 'x', remoteControl: false })).toBeNull();
    expect(hire({ name: 'x', command: null, keys: null })).toBeNull();
  });
});

describe('the rest of the list, and what is not on it', () => {
  it('knows which requests have a body that decides', () => {
    expect(bodyMatters('POST', '/api/agents')).toBe(true);
    expect(bodyMatters('PATCH', '/api/agents/ana')).toBe(true);
    expect(bodyMatters('PUT', '/api/agents/ana')).toBe(true);
    expect(bodyMatters('POST', '/api/agents/ana/hold')).toBe(false);
    expect(bodyMatters('GET', '/api/agents')).toBe(false);
  });

  it('shell-equivalent routes are not behind it, and the listed ones are', () => {
    for (const [method, path] of [['POST', '/api/messages'], ['POST', '/api/agents/ana/answer'], ['POST', '/api/agents/ana/hold'], ['POST', '/api/agents/ana/resume'], ['POST', '/api/agents/ana/restart'], ['POST', '/api/agents/ana/start'], ['POST', '/api/relief/r1/go']] as const) expect(stepUpReason(method, path, {}), path).toBeNull();
    for (const [method, path] of [['PUT', '/api/permissions'], ['PUT', '/api/payload-defaults/servers/x'], ['POST', '/api/payload-defaults/skills'], ['DELETE', '/api/payload-defaults/skills/x'], ['PUT', '/api/features/x'], ['POST', '/api/uplinks'], ['PUT', '/api/relay'], ['POST', '/api/docking/pair'], ['PUT', '/api/engines/claude'], ['PUT', '/api/agents/ana/file'], ['POST', '/api/agents/ana/git/commit'], ['POST', '/api/update'], ['POST', '/api/auth/keys'], ['POST', '/api/auth/password'], ['DELETE', '/api/auth/sessions/abcdef12'], ['POST', '/api/auth/logout-all'], ['POST', '/api/auth/mfa/begin']] as const) expect(stepUpReason(method, path, {}), path).not.toBeNull();
  });
});
