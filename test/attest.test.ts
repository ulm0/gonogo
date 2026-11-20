// Image provenance (attest.ts): what is asked of gh, what is answered for each of its outcomes, and what gh is never given. gh is a stand-in.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ghEnv, OFFICIAL_IMAGE, SIGNER_WORKFLOW, SOURCE_REPO, verifyImage } from '../src/server/attest.js';
import type { Run } from '../src/server/attest.js';

const dirs: string[] = [];
const configDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'gonogo-attest-'));
  dirs.push(dir);
  return join(dir, 'gh');
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const D1 = 'sha256:' + '1'.repeat(64);
const D2 = 'sha256:' + '2'.repeat(64);

describe('verifyImage', () => {
  it('asks gh for the official repository and workflow, by digest, with no shell and no token, and answers verified on exit 0', async () => {
    const calls: Array<{ file: string; args: string[]; env: Record<string, string> }> = [];
    const run: Run = async (file, args, env) => (calls.push({ file, args, env }), { code: 0, out: 'ok' });
    const answer = await verifyImage(OFFICIAL_IMAGE, [D1], { configDir: configDir(), run, env: { PATH: '/usr/bin', GH_TOKEN: 'secret', GITHUB_TOKEN: 'secret2', HTTPS_PROXY: 'http://p:1', HOME: '/root', ANTHROPIC_API_KEY: 'k' } });
    expect(answer).toEqual({ kind: 'verified', digest: D1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe('gh');
    expect(calls[0]?.args).toEqual(['attestation', 'verify', `oci://ghcr.io/ulm0/gonogo@${D1}`, '--repo', SOURCE_REPO, '--signer-workflow', SIGNER_WORKFLOW]);
    expect(SIGNER_WORKFLOW).toBe('ulm0/gonogo/.github/workflows/image.yml');
    const env = calls[0]?.env ?? {};
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HTTPS_PROXY).toBe('http://p:1');
    expect(JSON.stringify(env)).not.toMatch(/secret|ANTHROPIC|GH_TOKEN|GITHUB_TOKEN/);
    expect(env.HOME).toBe(env.GH_CONFIG_DIR);
  });

  it('a digest with no attestation (HTTP 404) is unattested: the one answer a Director may confirm; an image that is not the official one is too', async () => {
    const notFound: Run = async () => ({ code: 1, out: 'Error: HTTP 404: Not Found (https://api.github.com/repos/ulm0/gonogo/attestations/sha256:1)' });
    expect(await verifyImage(OFFICIAL_IMAGE, [D1], { configDir: configDir(), run: notFound })).toMatchObject({ kind: 'unattested', why: expect.stringMatching(/no attestation/) as string });
    const none: Run = async () => ({ code: 1, out: 'no attestations found for the subject' });
    expect((await verifyImage(OFFICIAL_IMAGE, [D1], { configDir: configDir(), run: none })).kind).toBe('unattested');
    const never: Run = async () => {
      throw new Error('must not run');
    };
    expect(await verifyImage('localhost:5000/gonogo', [D1], { configDir: configDir(), run: never })).toMatchObject({ kind: 'unattested', why: expect.stringContaining('localhost:5000/gonogo') as string });
  });

  it('anything else that goes wrong is failed, and there is no confirm for it: a bad signature or signer, no network, a missing gh, no digest', async () => {
    const bad: Run = async () => ({ code: 1, out: 'verification failed: the certificate\'s SAN does not match the signer workflow' });
    expect(await verifyImage(OFFICIAL_IMAGE, [D1], { configDir: configDir(), run: bad })).toMatchObject({ kind: 'failed', why: expect.stringContaining('verification failed') as string });
    // even when a 404 for one digest is mixed in, a real failure for another wins
    let n = 0;
    const mixed: Run = async () => (n++ === 0 ? { code: 1, out: 'HTTP 404' } : { code: 1, out: 'verification failed: bad signature' });
    expect((await verifyImage(OFFICIAL_IMAGE, [D1, D2], { configDir: configDir(), run: mixed })).kind).toBe('failed');
    const offline: Run = async () => ({ code: null, out: 'dial tcp: lookup api.github.com: no such host' });
    expect((await verifyImage(OFFICIAL_IMAGE, [D1], { configDir: configDir(), run: offline })).kind).toBe('failed');
    const missing: Run = async () => ({ code: null, out: 'spawn gh ENOENT', missing: true });
    expect(await verifyImage(OFFICIAL_IMAGE, [D1], { configDir: configDir(), run: missing })).toMatchObject({ kind: 'failed', why: expect.stringMatching(/gh is not installed/) as string });
    expect(await verifyImage(OFFICIAL_IMAGE, [], { configDir: configDir() })).toMatchObject({ kind: 'failed', why: expect.stringMatching(/no registry digest/) as string });
    // a 404 text that also says the verification failed is a failure
    const both: Run = async () => ({ code: 1, out: 'HTTP 404 ... verification failed' });
    expect((await verifyImage(OFFICIAL_IMAGE, [D1], { configDir: configDir(), run: both })).kind).toBe('failed');
  });

  it('one digest that verifies is enough, and a digest that is not sha256:<64 hex> never reaches a command line', async () => {
    const seen: string[] = [];
    const run: Run = async (_f, args) => {
      seen.push(args[2] ?? '');
      return args[2]?.endsWith(D2) ? { code: 0, out: '' } : { code: 1, out: 'HTTP 404' };
    };
    expect(await verifyImage(OFFICIAL_IMAGE, ['--repo', 'sha256:abc', D1, D2], { configDir: configDir(), run })).toEqual({ kind: 'verified', digest: D2 });
    expect(seen).toEqual([`oci://ghcr.io/ulm0/gonogo@${D1}`, `oci://ghcr.io/ulm0/gonogo@${D2}`]);
  });

  it('cuts what gh says to one short line without control characters', async () => {
    const noisy: Run = async () => ({ code: 1, out: `verification failed\n\u001b[31m${'x'.repeat(500)}\u0000` });
    const answer = await verifyImage(OFFICIAL_IMAGE, [D1], { configDir: configDir(), run: noisy });
    expect(answer.kind).toBe('failed');
    const why = 'why' in answer ? answer.why : '';
    expect(why.length).toBeLessThanOrEqual(200);
    // eslint-disable-next-line no-control-regex
    expect(why).not.toMatch(/[\u0000-\u001f]/);
  });

  it('ghEnv passes only what gh needs', () => {
    expect(ghEnv({ PATH: 'p', LANG: 'C', GH_TOKEN: 't', HOME: '/h', SSL_CERT_FILE: '/c' }, '/cfg')).toEqual({ GH_CONFIG_DIR: '/cfg', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', HOME: '/cfg', PATH: 'p', LANG: 'C', SSL_CERT_FILE: '/c' });
  });
});
