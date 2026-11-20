/**
 * Image provenance (docs/features/update.md, "Verifying the image"): before a Docker self-update runs a pulled image, `gh attestation verify` checks that
 * GitHub's build of this repository's workflow made it (a signed SLSA provenance attestation, `actions/attest-build-provenance` in image.yml). Without it the
 * only check was a version label, which anyone who can push the tag can write; with auto-update that was the publisher's registry account and nothing else.
 *
 * Three answers. `verified`: the attestation is there and the signer is `ulm0/gonogo`'s image workflow. `unattested`: nothing to verify against (an image from
 * before the attestations, or one that is not `ghcr.io/ulm0/gonogo` at all, such as your own build): the Director may confirm it by hand; auto-update never does.
 * `failed`: an attestation that does not verify, or `gh` could not run or reach GitHub: refused, and no confirm helps.
 *
 * gh gets a small environment and no token (the repository is public; a token of yours would only widen what a bad `gh` could read), a private config folder,
 * no shell and a time limit. The digest is checked to be sha256:<64 hex> before it is put on a command line.
 */
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

export const OFFICIAL_IMAGE = 'ghcr.io/ulm0/gonogo';
export const SOURCE_REPO = 'ulm0/gonogo';
export const SIGNER_WORKFLOW = 'ulm0/gonogo/.github/workflows/image.yml';
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const VERIFY_MS = 120_000;

export type Attestation = { kind: 'verified'; digest: string } | { kind: 'unattested'; why: string } | { kind: 'failed'; why: string };

export interface RunResult {
  code: number | null;
  out: string;
  /** gh could not be started (not installed). */
  missing?: boolean;
}
export type Run = (file: string, args: string[], env: Record<string, string>) => Promise<RunResult>;

const defaultRun: Run = (file, args, env) =>
  new Promise((resolve) => {
    execFile(file, args, { env, timeout: VERIFY_MS, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null;
      resolve({ code, out: `${stdout}\n${stderr}${error !== null && code === null ? `\n${error.message}` : ''}`, ...((error as { code?: unknown } | null)?.code === 'ENOENT' ? { missing: true } : {}) });
    });
  });

/** One short line of gh's own words, control characters out. */
const oneLine = (out: string): string =>
  out
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);

/** The environment gh gets: where to find itself and a proxy, never a token. */
export function ghEnv(from: NodeJS.ProcessEnv, configDir: string): Record<string, string> {
  const out: Record<string, string> = { GH_CONFIG_DIR: configDir, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', HOME: configDir };
  for (const key of ['PATH', 'LANG', 'TMPDIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    const value = from[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** `digests` are the registry digests the pulled image carries for `repo` (RepoDigests). One that verifies is enough. */
export async function verifyImage(repo: string, digests: readonly string[], options: { configDir: string; run?: Run; env?: NodeJS.ProcessEnv }): Promise<Attestation> {
  if (repo !== OFFICIAL_IMAGE) return { kind: 'unattested', why: `only ${OFFICIAL_IMAGE} can be checked; this container runs ${repo}` };
  const valid = digests.filter((d) => DIGEST.test(d));
  if (valid.length === 0) return { kind: 'failed', why: 'the pulled image has no registry digest to check' };
  const run = options.run ?? defaultRun;
  await mkdir(options.configDir, { recursive: true, mode: 0o700 }).catch(() => undefined);
  const env = ghEnv(options.env ?? process.env, options.configDir);
  let unattested: string | null = null;
  let failed: string | null = null;
  for (const digest of valid) {
    const result = await run('gh', ['attestation', 'verify', `oci://${OFFICIAL_IMAGE}@${digest}`, '--repo', SOURCE_REPO, '--signer-workflow', SIGNER_WORKFLOW], env);
    if (result.code === 0) return { kind: 'verified', digest };
    if (result.missing === true) return { kind: 'failed', why: 'gh is not installed in this image, so the image cannot be checked' };
    // gh answers HTTP 404 for a digest that has no attestation at all (an image from before they were made): the one case a Director may confirm
    if (/HTTP 404|no attestations? found/i.test(result.out) && !/verification failed/i.test(result.out)) unattested = `${digest.slice(0, 19)} has no attestation: it was published before they were made`;
    else failed = oneLine(result.out) === '' ? `gh attestation verify exited ${result.code ?? 'with no code'}` : oneLine(result.out);
  }
  if (failed !== null) return { kind: 'failed', why: failed };
  return { kind: 'unattested', why: unattested ?? 'no attestation was found' };
}
