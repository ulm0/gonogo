// Image provenance (attest.ts): what is asked of gh, what is answered for each of its outcomes, and what gh is never given. gh is a stand-in.
import { describe, expect, it } from 'vitest';
import { FIRST_ATTESTED, ghEnv, OFFICIAL_IMAGE, SIGNER_WORKFLOW, SOURCE_REPO, verifyImage } from '../src/server/attest.js';
import type { Run } from '../src/server/attest.js';

const D1 = 'sha256:' + '1'.repeat(64);
const D2 = 'sha256:' + '2'.repeat(64);

describe('verifyImage', () => {
  it('asks gh for the official repository and workflow, by digest, with no shell, with the login the container has and nothing else of gonogo, and answers verified on exit 0', async () => {
    const calls: Array<{ file: string; args: string[]; env: Record<string, string> }> = [];
    const run: Run = async (file, args, env) => (calls.push({ file, args, env }), { code: 0, out: 'ok' });
    const answer = await verifyImage(OFFICIAL_IMAGE, [D1], { run, env: { PATH: '/usr/bin', GH_TOKEN: 'secret', GITHUB_TOKEN: 'secret2', HTTPS_PROXY: 'http://p:1', HOME: '/root', ANTHROPIC_API_KEY: 'k' } });
    expect(answer).toEqual({ kind: 'verified', digest: D1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe('gh');
    expect(calls[0]?.args).toEqual(['attestation', 'verify', `oci://ghcr.io/ulm0/gonogo@${D1}`, '--repo', SOURCE_REPO, '--signer-workflow', SIGNER_WORKFLOW]);
    expect(SIGNER_WORKFLOW).toBe('ulm0/gonogo/.github/workflows/image.yml');
    const env = calls[0]?.env ?? {};
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HTTPS_PROXY).toBe('http://p:1');
    // gh refuses to verify without a login: the token variables and the home (its saved login) go through; no other secret of gonogo's does
    expect(env.GH_TOKEN).toBe('secret');
    expect(env.GITHUB_TOKEN).toBe('secret2');
    expect(env.HOME).toBe('/root');
    expect(JSON.stringify(env)).not.toMatch(/ANTHROPIC|"k"/);
  });

  it('a digest with no attestation (HTTP 404) is unattested: the one answer a Director may confirm; an image that is not the official one is too', async () => {
    const notFound: Run = async () => ({ code: 1, out: 'Error: HTTP 404: Not Found (https://api.github.com/repos/ulm0/gonogo/attestations/sha256:1)' });
    expect(await verifyImage(OFFICIAL_IMAGE, [D1], { run: notFound })).toMatchObject({ kind: 'unattested', why: expect.stringMatching(/no attestation/) as string });
    const none: Run = async () => ({ code: 1, out: 'no attestations found for the subject' });
    expect((await verifyImage(OFFICIAL_IMAGE, [D1], { run: none })).kind).toBe('unattested');
    const never: Run = async () => {
      throw new Error('must not run');
    };
    expect(await verifyImage('localhost:5000/gonogo', [D1], { run: never })).toMatchObject({ kind: 'unattested', why: expect.stringContaining('localhost:5000/gonogo') as string });
  });

  it('anything else that goes wrong is failed, and there is no confirm for it: a bad signature or signer, no network, a missing gh, no digest', async () => {
    const bad: Run = async () => ({ code: 1, out: 'verification failed: the certificate\'s SAN does not match the signer workflow' });
    expect(await verifyImage(OFFICIAL_IMAGE, [D1], { run: bad })).toMatchObject({ kind: 'failed', why: expect.stringContaining('verification failed') as string });
    // even when a 404 for one digest is mixed in, a real failure for another wins
    let n = 0;
    const mixed: Run = async () => (n++ === 0 ? { code: 1, out: 'HTTP 404' } : { code: 1, out: 'verification failed: bad signature' });
    expect((await verifyImage(OFFICIAL_IMAGE, [D1, D2], { run: mixed })).kind).toBe('failed');
    const offline: Run = async () => ({ code: null, out: 'dial tcp: lookup api.github.com: no such host' });
    expect((await verifyImage(OFFICIAL_IMAGE, [D1], { run: offline })).kind).toBe('failed');
    const missing: Run = async () => ({ code: null, out: 'spawn gh ENOENT', missing: true });
    expect(await verifyImage(OFFICIAL_IMAGE, [D1], { run: missing })).toMatchObject({ kind: 'failed', why: expect.stringMatching(/gh is not installed/) as string });
    expect(await verifyImage(OFFICIAL_IMAGE, [], {})).toMatchObject({ kind: 'failed', why: expect.stringMatching(/no registry digest/) as string });
    // a 404 text that also says the verification failed is a failure
    const both: Run = async () => ({ code: 1, out: 'HTTP 404 ... verification failed' });
    expect((await verifyImage(OFFICIAL_IMAGE, [D1], { run: both })).kind).toBe('failed');
  });

  it('one digest that verifies is enough, and a digest that is not sha256:<64 hex> never reaches a command line', async () => {
    const seen: string[] = [];
    const run: Run = async (_f, args) => {
      seen.push(args[2] ?? '');
      return args[2]?.endsWith(D2) ? { code: 0, out: '' } : { code: 1, out: 'HTTP 404' };
    };
    expect(await verifyImage(OFFICIAL_IMAGE, ['--repo', 'sha256:abc', D1, D2], { run })).toEqual({ kind: 'verified', digest: D2 });
    expect(seen).toEqual([`oci://ghcr.io/ulm0/gonogo@${D1}`, `oci://ghcr.io/ulm0/gonogo@${D2}`]);
  });

  it('cuts what gh says to one short line without control characters', async () => {
    const noisy: Run = async () => ({ code: 1, out: `verification failed\n\u001b[31m${'x'.repeat(500)}\u0000` });
    const answer = await verifyImage(OFFICIAL_IMAGE, [D1], { run: noisy });
    expect(answer.kind).toBe('failed');
    const why = 'why' in answer ? answer.why : '';
    expect(why.length).toBeLessThanOrEqual(200);
    // eslint-disable-next-line no-control-regex
    expect(why).not.toMatch(/[\u0000-\u001f]/);
  });

  it('the tag of the release is demanded of the attestation (--source-ref), so a run of the workflow from a branch makes no image that verifies', async () => {
    const seen: string[][] = [];
    const run: Run = async (_f, args) => (seen.push(args), { code: 0, out: '' });
    await verifyImage(OFFICIAL_IMAGE, [D1], { run, version: '0.8.1' });
    expect(seen[0]?.slice(-2)).toEqual(['--source-ref', 'refs/tags/v0.8.1']);
    seen.length = 0;
    // no version asks for no tag; one that is given and is not x.y.z FAILS (it is not silently dropped), and none of it reaches a command line
    await verifyImage(OFFICIAL_IMAGE, [D1], { run });
    expect(seen[0]).not.toContain('--source-ref');
    seen.length = 0;
    for (const version of ['0.8.1; rm -rf /', 'latest', '--repo', '', '0.8', '0.8.1-', 'v0.8.1', '0.8.1 -rc', '0.8.1-rc 1', '0.8.1-rc/1', '0.8.1+build']) expect(await verifyImage(OFFICIAL_IMAGE, [D1], { run, version }), version).toMatchObject({ kind: 'failed', why: expect.stringMatching(/not a release number/) as string });
    expect(seen).toEqual([]);
    // and the order does not matter: not even for an image that is not the official one
    expect((await verifyImage('localhost:5000/gonogo', [D1], { run, version: 'latest' })).kind).toBe('failed');
  });

  it('a release candidate is checked like its base version: its own tag, and owed from 0.8.0 on', async () => {
    const seen: string[][] = [];
    const run: Run = async (_f, args) => (seen.push(args), { code: 1, out: 'HTTP 404' });
    expect((await verifyImage(OFFICIAL_IMAGE, [D1], { run, version: '0.8.1-rc.1' })).kind).toBe('failed');
    expect((await verifyImage(OFFICIAL_IMAGE, [D1], { run, version: '0.8.0-rc.2' })).kind).toBe('failed');
    expect((await verifyImage(OFFICIAL_IMAGE, [D1], { run, version: '0.7.9-rc.1' })).kind).toBe('unattested');
    expect(seen.map((a) => a.slice(-1)[0])).toEqual(['refs/tags/v0.8.1-rc.1', 'refs/tags/v0.8.0-rc.2', 'refs/tags/v0.7.9-rc.1']);
  });

  it('from the first attested release on, no attestation is a failure with no override; for an older one, or an image that is not the official one, it is only unattested', async () => {
    const notFound: Run = async () => ({ code: 1, out: 'Error: HTTP 404: Not Found' });
    for (const version of [FIRST_ATTESTED, '0.8.1', '0.9.0', '1.0.0', '10.0.0']) expect((await verifyImage(OFFICIAL_IMAGE, [D1], { run: notFound, version })).kind, version).toBe('failed');
    for (const version of ['0.7.9', '0.7.0', '0.1.0']) expect((await verifyImage(OFFICIAL_IMAGE, [D1], { run: notFound, version })).kind, version).toBe('unattested');
    // a mirror or your own build: nothing was owed
    expect((await verifyImage('localhost:5000/gonogo', [D1], { run: notFound, version: '0.9.0' })).kind).toBe('unattested');
    // and a verified one is verified whatever its version
    expect((await verifyImage(OFFICIAL_IMAGE, [D1], { run: async () => ({ code: 0, out: '' }), version: '0.9.0' })).kind).toBe('verified');
    expect(FIRST_ATTESTED).toBe('0.8.0');
  });

  it('ghEnv passes only what gh needs', () => {
    expect(ghEnv({ PATH: 'p', LANG: 'C', GH_TOKEN: 't', HOME: '/h', SSL_CERT_FILE: '/c', CLAUDE_CODE_OAUTH_TOKEN: 'o', GONOGO_TOKEN: 'g' })).toEqual({ GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', PATH: 'p', LANG: 'C', GH_TOKEN: 't', HOME: '/h', SSL_CERT_FILE: '/c' });
  });

  it('uses the gh login kept in room main\'s folder when it is told where it is', () => {
    expect(ghEnv({ PATH: 'p' }, '/state/gh').GH_CONFIG_DIR).toBe('/state/gh');
    expect(ghEnv({ PATH: 'p' }).GH_CONFIG_DIR).toBeUndefined();
    // one the environment sets (a shared login) wins over the room's folder
    expect(ghEnv({ PATH: 'p', GH_CONFIG_DIR: '/shared/gh' }, '/state/gh').GH_CONFIG_DIR).toBe('/shared/gh');
  });

  it('gh with no login (it refuses before it asks GitHub) is not a bad image: unchecked (apart from "no attestation"), with what to do; a rejected token is a failure', async () => {
    const none: Run = async () => ({ code: 4, out: 'To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.' });
    expect(await verifyImage(OFFICIAL_IMAGE, [D1], { run: none })).toMatchObject({ kind: 'unchecked', why: expect.stringMatching(/gh auth login.*GH_TOKEN/) as string });
    const rejected: Run = async () => ({ code: 1, out: 'Error: HTTP 401: Bad credentials' });
    expect((await verifyImage(OFFICIAL_IMAGE, [D1], { run: rejected })).kind).toBe('failed');
  });
});
