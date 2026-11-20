/**
 * Image provenance (docs/features/update.md, "Verifying the image"): before a Docker self-update runs a pulled image, `gh attestation verify` checks that
 * GitHub's build of this repository's workflow made it (a signed SLSA provenance attestation, `actions/attest-build-provenance` in image.yml). Without it the
 * only check was a version label, which anyone who can push the tag can write; with auto-update that was the publisher's registry account and nothing else.
 *
 * Three answers. `verified`: the attestation is there and the signer is `ulm0/gonogo`'s image workflow. `unattested`: nothing to verify against (an image from
 * before the attestations, or one that is not `ghcr.io/ulm0/gonogo` at all, such as your own build): the Director may confirm it by hand; auto-update never does.
 * `failed`: an attestation that does not verify, or `gh` could not run or reach GitHub: refused, and no confirm helps.
 *
 * `gh attestation verify` REFUSES to run without a GitHub login (found in a dind run: "To get started with GitHub CLI, please run: gh auth login"), even for a
 * public repository. So it runs with the login the container has: `GH_TOKEN` or `GITHUB_TOKEN` of the environment (any token; it needs no scope for a
 * public repository), or the `gh auth login` kept in the home (docs/guide/docker.md). Without either the answer is `unattested` with that reason: a Director may
 * confirm by hand, auto-update never. gh gets a small environment, no shell and a time limit. The digest is checked to be sha256:<64 hex> before it is put on
 * a command line.
 */
import { execFile } from 'node:child_process';

export const OFFICIAL_IMAGE = 'ghcr.io/ulm0/gonogo';
export const SOURCE_REPO = 'ulm0/gonogo';
export const SIGNER_WORKFLOW = 'ulm0/gonogo/.github/workflows/image.yml';
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const VERIFY_MS = 120_000;

/** The release from which every image of ghcr.io/ulm0/gonogo is attested: for it and later ones "no attestation" is a failure, never a thing to confirm. */
export const FIRST_ATTESTED = '0.8.0';

export type Attestation =
  | { kind: 'verified'; digest: string }
  /** No attestation to find, and none was owed: an image of before FIRST_ATTESTED, or one that is not ghcr.io/ulm0/gonogo (your own build, a mirror). */
  | { kind: 'unattested'; why: string }
  /** Gonogo cannot check (no GitHub login for gh): nothing is known about the image either way. */
  | { kind: 'unchecked'; why: string }
  | { kind: 'failed'; why: string };

/** a >= b for two x.y.z strings. */
const atLeast = (a: string, b: string): boolean => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i += 1) if ((x?.[i] ?? 0) !== (y?.[i] ?? 0)) return (x?.[i] ?? 0) > (y?.[i] ?? 0);
  return true;
};

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

/** The environment gh gets: where to find itself, its login (the token variables and the config it keeps in the home) and a proxy; nothing else of gonogo's. */
export function ghEnv(from: NodeJS.ProcessEnv, configDir?: string): Record<string, string> {
  const out: Record<string, string> = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' };
  for (const key of ['PATH', 'HOME', 'LANG', 'TMPDIR', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_CONFIG_DIR', 'XDG_CONFIG_HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    const value = from[key];
    if (value !== undefined) out[key] = value;
  }
  // the gh login of room main's consoles lives in the room's own folder (`<home>/gh`, where an agent's `gh auth login` goes), not in ~/.config
  // (a GH_CONFIG_DIR the environment already sets wins: the same precedence as a console's)
  if (configDir !== undefined && out.GH_CONFIG_DIR === undefined) out.GH_CONFIG_DIR = configDir;
  return out;
}

/** `digests` are the registry digests the pulled image carries for `repo` (RepoDigests). One that verifies is enough. */
export async function verifyImage(repo: string, digests: readonly string[], options: { run?: Run; env?: NodeJS.ProcessEnv; configDir?: string; /** The version being installed (x.y.z): its release tag is demanded of the attestation, and from FIRST_ATTESTED on a missing attestation is a failure. */ version?: string } = {}): Promise<Attestation> {
  // a version that is given and is not x.y.z is a failure, never a reason to check less (no tag to demand, nothing "owed")
  if (options.version !== undefined && !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(options.version)) return { kind: 'failed', why: 'the version to verify is not a release number' };
  if (repo !== OFFICIAL_IMAGE) return { kind: 'unattested', why: `only ${OFFICIAL_IMAGE} can be checked; this container runs ${repo}` };
  const valid = digests.filter((d) => DIGEST.test(d));
  if (valid.length === 0) return { kind: 'failed', why: 'the pulled image has no registry digest to check' };
  const run = options.run ?? defaultRun;
  const env = ghEnv(options.env ?? process.env, options.configDir);
  const version = options.version ?? null;
  const owed = version !== null && atLeast(version, FIRST_ATTESTED);
  // the build must come from the tag of THIS release: a run of the workflow from a branch (workflow_dispatch) makes no image that verifies
  const ref = version === null ? [] : ['--source-ref', `refs/tags/v${version}`];
  let unattested: string | null = null;
  let failed: string | null = null;
  for (const digest of valid) {
    const result = await run('gh', ['attestation', 'verify', `oci://${OFFICIAL_IMAGE}@${digest}`, '--repo', SOURCE_REPO, '--signer-workflow', SIGNER_WORKFLOW, ...ref], env);
    if (result.code === 0) return { kind: 'verified', digest };
    if (result.missing === true) return { kind: 'failed', why: 'gh is not installed in this image, so the image cannot be checked' };
    // no login at all: not a bad image, a gonogo that cannot check (gh itself says so before it asks GitHub anything)
    if (/gh auth login|GH_TOKEN environment variable/i.test(result.out)) return { kind: 'unchecked', why: 'gh has no GitHub login in this container, so attestations cannot be fetched: log in from a console of room main (`gh auth login`; the login stays in that room folder) or set GH_TOKEN in the container (a token with no permissions is enough)' };
    // gh answers HTTP 404 for a digest that has no attestation at all (an image from before they were made): the one case a Director may confirm
    if (/HTTP 404|no attestations? found/i.test(result.out) && !/verification failed/i.test(result.out)) {
      if (owed) failed = `${digest.slice(0, 19)} has no attestation, and every image since ${FIRST_ATTESTED} has one`;
      else unattested = `${digest.slice(0, 19)} has no attestation: it was published before they were made`;
    }
    else failed = oneLine(result.out) === '' ? `gh attestation verify exited ${result.code ?? 'with no code'}` : oneLine(result.out);
  }
  if (failed !== null) return { kind: 'failed', why: failed };
  return { kind: 'unattested', why: unattested ?? 'no attestation was found' };
}
