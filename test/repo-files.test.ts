/**
 * What the repository itself must keep true besides its code: the licence that ships in the package, the lock, the
 * list `pnpm check:pack` accepts, and nothing private in what is committed (docs, scripts, README, Dockerfile and the
 * recorded fixtures). No private string is written in this file: the login name and the host name are read from the
 * machine that runs the test, everything else is a class of strings (a home path, a volume path, an id).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IMAGE_OLLAMA_BIN, OLLAMA_SHA256, OLLAMA_VERSION } from '../src/server/ollama.js';
import { listProblems } from '../scripts/check-pack.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (...path: string[]): string => readFileSync(join(root, ...path), 'utf8');

interface PackageJson {
  name: string;
  bin: Record<string, string>;
  publishConfig: Record<string, unknown>;
  license: string;
  os: string[];
  keywords: string[];
  files: string[];
  packageManager: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}
const pkg = JSON.parse(read('package.json')) as PackageJson;

describe('the licence and the package manifest', () => {
  it('has a LICENSE with the MIT text and a copyright line, and package.json names the same licence', () => {
    const text = read('LICENSE');
    expect(text.startsWith('MIT License\n')).toBe(true);
    expect(text).toMatch(/^Copyright \(c\) \d{4} \S.*$/m);
    expect(text).toContain('Permission is hereby granted, free of charge');
    expect(text).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
    expect(pkg.license).toBe('MIT');
  });

  it('restricts the install to the platforms that have a terminal library, and has keywords', () => {
    expect(pkg.os).toStrictEqual(['darwin', 'linux']);
    expect(pkg.keywords).toEqual(expect.arrayContaining(['claude-code', 'agents', 'mcp']));
  });

  it('publishes under a scope, publicly and with provenance, and keeps the command gonogo', () => {
    expect(pkg.name).toMatch(/^@[a-z0-9-]+\/gonogo$/);
    expect(pkg.publishConfig).toStrictEqual({ access: 'public', provenance: true });
    expect(Object.keys(pkg.bin)).toStrictEqual(['gonogo']);
  });

  it('asks the client build for the notices of the libraries it bundles', () => {
    expect(read('vite.config.ts')).toMatch(/license:\s*\{\s*fileName:\s*'THIRD-PARTY-NOTICES\.md'\s*\}/);
  });
});

describe('pnpm-lock.yaml', () => {
  const lock = read('pnpm-lock.yaml');

  it('is made by the pnpm that package.json pins, with its checksum', () => {
    expect(pkg.packageManager).toMatch(/^pnpm@12\.\d+\.\d+\+sha512\.[0-9a-f]{128}$/);
    // pnpm 12 writes two documents: the pinned pnpm itself, then the project's dependencies.
    expect(lock.startsWith("---\nlockfileVersion: '9.0'\n")).toBe(true);
    expect(lock).toContain(`packageManagerDependencies:\n      pnpm:\n        specifier: ${pkg.packageManager.slice(5).split('+')[0]}\n`);
  });

  it('describes the dependencies of package.json exactly, so `pnpm install --frozen-lockfile` agrees with the tests', () => {
    for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      const key = name.startsWith('@') ? `'${name}'` : name;
      expect(lock, name).toContain(`\n      ${key}:\n        specifier: ${version}\n        version: ${version}`);
    }
  });

  it('pins every package with a checksum', () => {
    const resolutions = lock.split('\n').filter((line) => /^\s+resolution:/.test(line));
    expect(resolutions.length).toBeGreaterThan(100);
    for (const line of resolutions) expect(line).toMatch(/^\s+resolution: \{integrity: sha512-[A-Za-z0-9+/=]+\}$/);
  });

  it('is the only lock, and it is committed', () => {
    for (const other of ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock']) expect(existsSync(join(root, other)), other).toBe(false);
    expect(read('.gitignore').split('\n')).not.toContain('pnpm-lock.yaml');
  });
});

describe('Dockerfile', () => {
  // The image has never been built here, so what a build would trip over has to be checked in the text
  const text = read('Dockerfile');

  it('copies the lock that exists, because the build stage runs `pnpm install --frozen-lockfile` from it', () => {
    const lock = /^COPY package\.json (\S+) \.\/$/m.exec(text)?.[1];
    expect(lock).toBe('pnpm-lock.yaml');
    expect(existsSync(join(root, lock ?? 'missing'))).toBe(true);
  });

  it('installs Claude Code with the pnpm release that package.json pins', () => {
    expect(/^ARG PNPM_VERSION=(\S+)$/m.exec(text)?.[1]).toBe(/^pnpm@([^+]+)/.exec(pkg.packageManager)?.[1]);
  });

  it('has a healthcheck on the port of CMD, and scopes git\'s safe.directory to /projects', () => {
    expect(text).toMatch(/^HEALTHCHECK .*\\\n\s+CMD \["node", "-e", "fetch\('http:\/\/127\.0\.0\.1:7777\/rooms\/health'\)/m);
    expect(text).toMatch(/^CMD \["--host", "0\.0\.0\.0", "--port", "7777"\]$/m);
    expect(text).not.toMatch(/safe\.directory\s+'\*'/);
    expect(text).toMatch(/safe\.directory '\/projects\/\*'/);
  });
});

describe('compose.yaml', () => {
  it('defaults GONOGO_DATA to ./gonogo-data but never silently on an empty ${PWD} (a UI runs compose with no shell, so PWD is empty and every path broke silently)', () => {
    const compose = read('compose.yaml');
    const live = compose.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
    // every use is the whole expression: the variable, else the working directory (and an empty one STOPS compose), then /gonogo-data
    expect(live).not.toMatch(/\$\{GONOGO_DATA(?!:-\$\{PWD:\?|:\+yes\})/);
    expect(live).not.toMatch(/\$\{PWD(?!:\?)/);
    expect(live.match(/\$\{GONOGO_DATA:-\$\{PWD:\?[^}]+\}\/gonogo-data\}/g)?.length).toBeGreaterThanOrEqual(6);
    expect(live).not.toContain('DOCKER_GID');
    expect(live).not.toContain('group_add');
    expect(live).toContain('${GONOGO_HOST:-0.0.0.0}');
    expect(compose).toMatch(/docker compose up -d/);
  });
});

describe('the HOME of the container is persisted as a whole', () => {
  it('compose binds <data>/home on /home/node, the image and the compose file point no XDG or git config elsewhere, and nothing reads /state/config', () => {
    const compose = read('compose.yaml');
    const live = compose.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
    expect(live).toMatch(/- \$\{GONOGO_DATA:-\$\{PWD:\?[^}]+\}\/gonogo-data\}\/home:\/home\/node\n/);
    const docker = read('Dockerfile');
    const liveDocker = docker.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
    for (const text of [live, liveDocker]) {
      expect(text).not.toContain('XDG_CONFIG_HOME');
      expect(text).not.toContain('GIT_CONFIG_GLOBAL');
      expect(text).not.toContain('/state/config');
    }
    // a new, empty home gets the skeleton, never over a file that exists
    const entry = read('packaging', 'docker', 'entrypoint.sh');
    expect(liveDocker).toContain('/src/packaging/docker/entrypoint.sh /usr/local/bin/gonogo-entrypoint');
    expect(liveDocker).toContain('ENTRYPOINT ["tini", "-s", "--", "gonogo-entrypoint"]');
    expect(entry).toContain('cp -rn /etc/skel/.');
    expect(entry).toContain('[ ! -e "$HOME/.config/gh" ]');
    expect(entry).toContain('cp -rn /state/config/gh');
    expect(entry).toContain('[ ! -e "$HOME/.gitconfig" ]');
    expect(entry).toMatch(/\[ -w "\$HOME" \] \|\| echo .*chown 1000:1000/);
    expect(entry).toMatch(/exec gonogo "\$@"\n$/);
    expect(statSync(join(root, 'packaging', 'docker', 'entrypoint.sh')).mode & 0o111).not.toBe(0);
    expect(compose).toContain('./gonogo-data');
    expect(read('docs', 'guide', 'docker.md')).toContain('./gonogo-data');
  });
});

describe('the image is attested, and the self-update verifies it', () => {
  const workflow = read('.github', 'workflows', 'image.yml');
  it('image.yml attests the digest of the manifest list the tags point at, with an action pinned by commit, and only the merge job gets the token for it', () => {
    expect(workflow).toMatch(/uses: actions\/attest-build-provenance@[0-9a-f]{40} # v\d/);
    expect(workflow).toContain('subject-digest: ${{ steps.index.outputs.digest }}');
    expect(workflow).toContain('push-to-registry: true');
    const merge = workflow.slice(workflow.indexOf('\n  merge:'));
    expect(merge).toMatch(/id-token: write/);
    expect(merge).toMatch(/attestations: write/);
    const before = workflow.slice(0, workflow.indexOf('\n  merge:'));
    expect(before).not.toMatch(/id-token|attestations/);
    expect(workflow).toMatch(/^permissions: \{\}/m);
  });
  it('the signer the self-update demands is that workflow of this repository', () => {
    const attest = read('src', 'server', 'attest.ts');
    expect(attest).toContain("SIGNER_WORKFLOW = 'ulm0/gonogo/.github/workflows/image.yml'");
    expect(attest).toContain("OFFICIAL_IMAGE = 'ghcr.io/ulm0/gonogo'");
  });
});

describe('the container starts as root only to fix a bind folder, and drops to uid 1000 before anything of gonogo runs', () => {
  const entry = read('packaging', 'docker', 'entrypoint.sh');
  const drop = read('packaging', 'docker', 'drop.sh');
  const wrapper = read('packaging', 'docker', 'gonogo.sh');
  const docker = read('Dockerfile');
  const live = (text: string): string => text.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');

  it('the image ends as root (after the build-time proof as node) and has the three scripts, executable', () => {
    const lines = live(docker).split('\n');
    const asNode = lines.lastIndexOf('USER node');
    const asRoot = lines.lastIndexOf('USER root');
    expect(asNode).toBeGreaterThan(-1);
    expect(asRoot).toBeGreaterThan(asNode);
    expect(lines.slice(asRoot).join('\n')).toContain('ENTRYPOINT');
    for (const [file, name] of [['entrypoint.sh', 'gonogo-entrypoint'], ['drop.sh', 'gonogo-drop'], ['gonogo.sh', 'gonogo']] as const) {
      expect(docker, file).toContain(`/src/packaging/docker/${file} /usr/local/bin/${name}`);
      expect(statSync(join(root, 'packaging', 'docker', file)).mode & 0o111, file).not.toBe(0);
    }
  });

  it('chowns only the top of gonogo\'s own bind targets, never recursively, never through a symlink, never a system folder, only what root owns and Docker made', () => {
    const fix = entry.slice(entry.indexOf('fix() {'), entry.indexOf('exec /usr/local/bin/gonogo-drop'));
    expect(entry).not.toMatch(/chown\s+-[a-zA-Z]*R/);
    // a path is accepted only as its own canonical spelling
    expect(fix).toContain('r=$(realpath -e "$p" 2>/dev/null) && [ "$r" = "$p" ] || return 0');
    expect(fix.indexOf('realpath -e')).toBeLessThan(fix.indexOf('chown'));
    expect(fix).toContain('chown -h 1000:1000 "$p"');
    expect(fix).toContain('[ ! -L "$p" ]');
    expect(fix).toContain('stat -c %u "$p")" = 0');
    expect(fix).toContain('mountpoint -q "$p" || { d=$(dirname "$p"); [ "$d" != / ] && mountpoint -q "$d"; }');
    for (const system of ['/', '/etc', '/home', '/root', '/usr', '/var', '/proc']) expect(fix, system).toMatch(new RegExp(`[ |]${system.replaceAll('/', '\\/')}( \\||\\))`));
    // exactly these five paths are offered to it
    for (const target of ['fix "$HOME"', 'fix "${XDG_CONFIG_HOME:-}"', 'fix "$(dirname "$GONOGO_HOME")"', 'fix "${CLAUDE_CONFIG_DIR:-}"', 'fix "$PWD"']) expect(entry, target).toContain(target);
    expect(entry.match(/\bfix "/g)).toHaveLength(5);
    // as root it only fixes, then drops: nothing of gonogo's runs before the drop
    const rootPart = entry.slice(entry.indexOf('if [ "$(id -u)" = 0 ]; then'), entry.indexOf('# Past here'));
    expect(rootPart).not.toMatch(/exec gonogo/);
    expect(rootPart).toContain('exec /usr/local/bin/gonogo-drop /usr/local/bin/gonogo-entrypoint "$@"');
  });

  it('drops to uid and gid 1000 with the container\'s supplementary groups but root\'s, and the gonogo command does it too (docker exec starts as root)', () => {
    expect(drop).toContain('setpriv --reuid=1000 --regid=1000 "--groups=$groups" --inh-caps=-all --bounding-set=-all "$@"');
    expect(drop).toContain('--clear-groups --inh-caps=-all --bounding-set=-all "$@"');
    expect(drop).not.toMatch(/^[^#\n]*--no-new-privs/m);
    expect(drop).toContain('grep -vx 0');
    expect(drop).toContain('--clear-groups');
    expect(drop).not.toContain('--init-groups');
    expect(wrapper).toContain('[ "$(id -u)" = 0 ]');
    expect(wrapper).toContain('exec /usr/local/bin/gonogo-drop /opt/gonogo/bin/gonogo.js "$@"');
  });

  it('repairs the files `docker exec` as root left in HOME: regular files and folders only, no symlink followed, no mount crossed, chown run in the directory', () => {
    const rootPart = entry.slice(entry.indexOf('if [ "$(id -u)" = 0 ]; then'), entry.indexOf('# Past here'));
    const find = /find "\$1" (.*) -execdir chown -h 1000:1000 \{\} \+/.exec(rootPart);
    expect(find?.[1]).toBeDefined();
    expect(rootPart).toMatch(/realpath -e "\$1"[^\n]*= "\$1" \]/);
    // run for the home, and for XDG_CONFIG_HOME only when it is decided first (another filesystem, top uid 1000's, or root's and empty)
    expect(rootPart).toContain('heal "$HOME"');
    expect(rootPart).toContain('heal "$x"');
    for (const part of ['-xdev', '-mindepth 1', '-user 0', '\\( -type f -links 1 -o -type d \\)', '\\( -type d -exec mountpoint -q {} \\; -prune \\)']) expect(find?.[1], part).toContain(part);
    expect(rootPart).not.toMatch(/find [^\n]*(-L\b|-follow|-H\b)/);
    expect(rootPart).not.toContain('-exec chown');
    expect(rootPart).not.toMatch(/chown\s+-[a-zA-Z]*R/);
  });

  it('the Ollama the image carries is the one src/server/ollama.ts pins, with the same checksums', () => {
    const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
    const arg = (name: string): string | undefined => new RegExp('^ARG ' + name + '=(\\S+)$', 'm').exec(dockerfile)?.[1];
    expect(arg('OLLAMA_VERSION')).toBe(OLLAMA_VERSION);
    expect(arg('OLLAMA_SHA256_AMD64')).toBe(OLLAMA_SHA256.x64);
    expect(arg('OLLAMA_SHA256_ARM64')).toBe(OLLAMA_SHA256.arm64);
    // the file is checked before it is opened, and only the CPU part is kept
    expect(dockerfile).toContain('sha256sum -c');
    expect(dockerfile).toContain('COPY --from=ollama /out /opt/ollama');
    for (const dropped of ['cuda_*', 'vulkan', 'rocm*', 'mlx*']) expect(dockerfile).toContain('--exclude=lib/ollama/' + dropped);
    expect(IMAGE_OLLAMA_BIN).toBe('/opt/ollama/bin/ollama');
  });

  it('a container started with --user (not root) skips the fix and keeps the warning', () => {
    expect(entry.indexOf('# Past here')).toBeGreaterThan(entry.indexOf('exec /usr/local/bin/gonogo-drop'));
    expect(entry).toMatch(/\[ -w "\$HOME" \] \|\| echo "gonogo: \$HOME is not writable by uid \$\(id -u\)/);
  });
});

describe('Homebrew installs from the release asset, not from npm\'s CDN', () => {
  const release = read('.github', 'workflows', 'release.yml');
  const job = (name: string): string => {
    const start = release.indexOf(`\n  ${name}:\n`);
    const next = release.slice(start + 1).search(/\n  [a-z-]+:\n/);
    return release.slice(start, next === -1 ? undefined : start + 1 + next);
  };
  it('the tarball is packed in the publish job, passed by artifact, attached to the release with --clobber, and the homebrew job waits for the release, not for npm', () => {
    expect(job('publish')).toContain('pnpm pack --pack-destination');
    // npm gets the very file that is attached to the release and installed by Homebrew
    expect(job('publish')).toContain('pnpm publish "$1" --access public --provenance --no-git-checks --tag "$dist_tag"');
    expect(job('publish').indexOf('pnpm pack --pack-destination')).toBeLessThan(job('publish').indexOf('pnpm publish "$1"'));
    expect(job('publish')).not.toMatch(/pnpm publish --/);
    expect(job('publish')).toMatch(/actions\/upload-artifact@[0-9a-f]{40} # v\d/);
    expect(job('github-release')).toMatch(/actions\/download-artifact@[0-9a-f]{40} # v\d/);
    expect(job('github-release')).toContain('gh release upload "$TAG" "$1" --repo "$GITHUB_REPOSITORY" --clobber');
    expect(job('homebrew')).toContain('needs: github-release');
    expect(job('homebrew')).toMatch(/actions\/download-artifact@[0-9a-f]{40} # v\d/);
  });
  it('the formula url is the release asset and the sha256 is the uploaded file\'s; nothing in the job asks npm', () => {
    const h = job('homebrew');
    expect(h).toContain('releases/download/${TAG}/');
    expect(h).toContain('sha=$(sha256sum "$file"');
    expect(h).not.toContain('registry.npmjs.org');
    expect(h).not.toMatch(/sleep 30|seq 1 20/);
    // it still checks the release serves the very file, and says so when it does not
    expect(h).toContain('serves another file than the one uploaded');
  });
  it('the template formula carries a release asset url (one line each for url and sha256, which the job rewrites)', () => {
    const rb = read('packaging', 'homebrew', 'gonogo.rb');
    expect(rb).toMatch(/^  url "https:\/\/github\.com\/ulm0\/gonogo\/releases\/download\/v[\d.]+\/ulm0-gonogo-[\d.]+\.tgz"$/m);
    expect(rb).toMatch(/^  sha256 "[0-9a-f]{64}"$/m);
    expect(rb).not.toContain('registry.npmjs.org');
  });
});

describe('the Docker self-update is tried end to end in CI (update-e2e.yml, scripts/update-e2e.sh)', () => {
  const wf = read('.github', 'workflows', 'update-e2e.yml');
  const script = read('scripts', 'update-e2e.sh');
  it('image.yml calls it after a stable tag is pushed and attested; also by hand and for a change of the script; read access only, the job\'s own token, pinned actions, no secret', () => {
    expect(wf).toContain('workflow_call:');
    expect(wf).not.toContain('workflow_run');
    expect(wf).toContain('workflow_dispatch:');
    const image = read('.github', 'workflows', 'image.yml');
    const job = image.slice(image.indexOf('\n  update-e2e:'));
    expect(job).toContain('needs: merge');
    expect(job).toContain("if: ${{ startsWith(github.ref, 'refs/tags/v') && !contains(github.ref_name, '-') }}");
    expect(job).toContain('uses: ./.github/workflows/update-e2e.yml');
    expect(job).toMatch(/permissions:\n\s+contents: read\n\s+packages: read\n\s+attestations: read/);
    expect(wf).toMatch(/^permissions: \{\}/m);
    expect(wf).toMatch(/permissions:\n\s+contents: read\n\s+packages: read\n\s+attestations: read/);
    expect(wf).not.toMatch(/secrets\./);
    expect(wf).not.toMatch(/E2E_UNVERIFIED/);
    expect(wf.match(/GH_TOKEN: \$\{\{ github\.token \}\}/g)).toHaveLength(2);
    for (const use of wf.match(/uses: [^\n]+/g) ?? []) expect(use, use).toMatch(/@[0-9a-f]{40} # v\d/);
  });
  it('TO is the tag image.yml ran for (the release may not be marked latest yet), FROM the newest stable release below it', () => {
    expect(wf).toContain("RUN_TAG: ${{ github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v') && github.ref_name || '' }}");
    expect(wf).toContain('to=${INPUT_TO:-${RUN_TAG#v}}');
    expect(wf).toContain('sort -Vr');
    expect(wf).toContain("[[ \"$to\" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]]");
    // FROM is validated like TO before it reaches GITHUB_OUTPUT
    expect(wf).toContain("[[ \"$from\" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]]");
    expect(wf.indexOf('FROM \'$from\' is not x.y.z')).toBeLessThan(wf.indexOf('echo "from=$from" >> "$GITHUB_OUTPUT"'));
    // the old pick (the second release of the list) is gone
    expect(wf).not.toContain('grep -vx "$to"');
  });
  it('the script pulls only this repository\'s image, updates through the API and then UNDOes, with the token passed by name', () => {
    expect(script).toContain('IMAGE=${E2E_IMAGE:-ghcr.io/ulm0/gonogo}');
    expect(wf).not.toMatch(/E2E_IMAGE/);
    expect(script.match(/docker pull/g)).toHaveLength(2);
    expect(script).not.toMatch(/docker pull [^\n]*(docker\.io|quay|gcr|registry\.npmjs)/);
    expect(script).toContain('-e GH_TOKEN \\');
    expect(script).not.toMatch(/-e GH_TOKEN=/);
    // the Director token of the throwaway instance never reaches a public log: masked by value and by shape, and update.json is read as its owner
    expect(script).toContain('::add-mask::$token');
    expect(script).toContain('docker logs --tail 60 "$NAME" 2>&1 | mask');
    expect(script).toContain('result_file() { $SUDO find');
    expect(script).toContain('<<<"$(result_text)"');
    expect(script).not.toMatch(/result_text \| grep/);
    expect(script).not.toMatch(/cat "\$\(result_file\)"/);
    expect(script).toContain('POST /api/update');
    expect(script).toContain('/api/update/undo');
    expect(script).toContain('E2E_UNVERIFIED');
    // the moving tag is what the update pulls, so the container runs from :latest and TO must be what :latest is
    expect(script).toContain('docker tag "$IMAGE:$FROM" "$IMAGE:latest"');
    expect(script).toContain('not $TO (the update takes the moving tag');
    // the cleanup removes only what the run labelled (and the helpers aimed at those), never by name or by the general helper label
    expect(script).toContain('docker run -d --name "$NAME" --label "gonogo.e2e=$RUN"');
    expect(script).toContain('--filter "label=gonogo.e2e=$RUN"');
    expect(script).toContain('--filter "label=gonogo.helper.target=$id"');
    expect(script).not.toMatch(/--filter "name=/);
    expect(script).not.toContain('--filter "label=gonogo.helper"');
    expect(statSync(join(root, 'scripts', 'update-e2e.sh')).mode & 0o111).not.toBe(0);
  });
});

describe('the Homebrew formula is tried on macOS and Linux (brew.yml)', () => {
  const wf = read('.github', 'workflows', 'brew.yml');
  it('runs for tags, by hand and for a change of the formula, on both platforms, with nothing but read access', () => {
    expect(wf).toMatch(/tags: \['v\*'\]/);
    expect(wf).toContain('workflow_dispatch:');
    expect(wf).toMatch(/paths:\n\s+- packaging\/homebrew\/\*\*/);
    expect(wf).toContain('os: [macos-latest, ubuntu-latest]');
    expect(wf).toMatch(/^permissions: \{\}/m);
    expect(wf).toMatch(/permissions:\n\s+contents: read/);
    expect(wf).not.toMatch(/secrets\./);
    for (const use of wf.match(/uses: [^\n]+/g) ?? []) expect(use, use).toMatch(/@[0-9a-f]{40} # v\d/);
  });
  it('installs from a throwaway tap (a formula by path is refused by Homebrew), from the tarball of this checkout, then tests and audits it', () => {
    expect(wf).toContain('brew tap-new --no-git ulm0/ci');
    expect(wf).toContain('brew install --build-from-source --verbose ulm0/ci/gonogo');
    expect(wf).toContain('brew test --verbose ulm0/ci/gonogo');
    expect(wf).toContain('brew audit --strict --formula ulm0/ci/gonogo');
    expect(wf).not.toMatch(/brew (install|audit|test)[^\n]*\.\/packaging/);
    expect(wf).toContain('pnpm pack --pack-destination');
    expect(wf).toContain('url \\"file://$tarball\\"');
    // the audit copy carries the release-asset url the real tap has
    expect(wf).toContain('releases/download/v${version}/');
  });
  it('checks that the prebuilt node-pty of the platform has its spawn-helper executable (macOS cannot start a terminal without it)', () => {
    expect(wf).toContain("-name 'spawn-helper'");
    expect(wf).toContain('[ -x "$f" ]');
    expect(wf).toMatch(/RUNNER_OS" = macOS/);
    expect(wf).toContain("-name 'pty.node'");
  });
  it('the template formula still has the one-per-line url and sha256 the job rewrites', () => {
    const rb = read('packaging', 'homebrew', 'gonogo.rb');
    expect(rb.match(/^  url "/gm)).toHaveLength(1);
    expect(rb.match(/^  sha256 "/gm)).toHaveLength(1);
    // `brew audit --strict` refuses a line longer than 118 characters (its first run on this formula found five)
    for (const [i, line] of rb.split('\n').entries()) expect(line.length, `gonogo.rb line ${i + 1}`).toBeLessThanOrEqual(118);
  });
});

describe('the image label that the Docker self-update reads is the plain release number', () => {
  it('the publish job names the semver version as its tag, whose version becomes the label (the git ref gave "v0.11.0")', () => {
    const image = read('.github', 'workflows', 'image.yml');
    const publish = image.slice(image.indexOf('\n  publish:'), image.indexOf('\n  merge:'));
    expect(publish).toMatch(/id: meta[\s\S]*?tags: \|\n\s+type=semver,pattern=\{\{version\}\}/);
  });
});

describe('scripts/check-pack.mjs file list', () => {
  const server = ['cli', 'hub'];
  const complete = [
    'package/bin/gonogo.js',
    'package/package.json',
    'package/README.md',
    'package/LICENSE',
    'package/dist/shared/protocol.js',
    'package/dist/shared/positions.js',
    'package/dist/shared/fuel.js',
    'package/dist/shared/cron.js',
    'package/dist/shared/details.js',
    'package/dist/shared/diff.js',
    'package/dist/shared/layout.js',
    'package/dist/shared/livery.js',
    'package/dist/shared/longtext.js',
    'package/dist/shared/prices.js',
    'package/dist/shared/features.js',
    'package/dist/shared/registry.js',
    'package/dist/client/index.html',
    'package/dist/client/THIRD-PARTY-NOTICES.md',
    'package/dist/client/assets/index-abc.js',
    'package/dist/server/cli.js',
    'package/dist/server/hub.js',
  ];

  it('accepts the files of a complete package', () => {
    expect(listProblems(complete, server)).toStrictEqual([]);
  });

  it.each(['package/LICENSE', 'package/dist/client/THIRD-PARTY-NOTICES.md', 'package/dist/shared/positions.js', 'package/dist/shared/fuel.js', 'package/dist/shared/cron.js', 'package/dist/shared/diff.js', 'package/dist/shared/layout.js', 'package/dist/shared/livery.js', 'package/dist/shared/longtext.js', 'package/dist/shared/prices.js', 'package/dist/shared/features.js', 'package/dist/shared/registry.js'])('fails when %s is not packed', (gone) => {
    expect(listProblems(complete.filter((entry) => entry !== gone), server)).toStrictEqual([`missing ${gone}`]);
  });

  it('still fails on a file that does not belong', () => {
    expect(listProblems([...complete, 'package/package-lock.json', 'package/docs/contract.md'], server)).toStrictEqual([
      'unexpected package/package-lock.json',
      'unexpected package/docs/contract.md',
    ]);
  });
});

/* ---- nothing of the owner's machine in what is committed (contract 0.5 item 11) ---- */

const files = (dir: string): string[] =>
  (readdirSync(join(root, dir), { recursive: true }) as string[]).map((name) => join(dir, name)).filter((path) => statSync(join(root, path)).isFile());
const committed = [
  ...files('docs'),
  ...files('scripts'),
  ...files('.github'),
  '.vitepress/config.mts',
  ...files('.vitepress/theme'),
  'README.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'Dockerfile',
  '.dockerignore',
  'compose.yaml',
];

/** The decoded output and input bytes of a recording as ONE string: a name cut in two by a record boundary or a line wrap is still found. */
function recordedBytes(file: string): string {
  const records = read('test', 'fixtures', file)
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { k: string; b?: string });
  return Buffer.concat(records.filter((r) => r.k === 'd' || r.k === 'in').map((r) => Buffer.from(r.b ?? '', 'base64'))).toString('latin1');
}

/** Names of the machine that runs the test; ordinary words are skipped, as in terminal.test.ts. */
function machineNames(): string[] {
  const generic = new Set(['user', 'root', 'node', 'test', 'runner', 'admin', 'ubuntu', 'debian', 'docker', 'build', 'localhost']);
  const login = ((): string => {
    try {
      return userInfo().username;
    } catch {
      return ''; // an arbitrary uid in a container has no passwd entry
    }
  })();
  return [login, hostname(), hostname().split('.')[0] ?? ''].map((name) => name.toLowerCase()).filter((name) => name.length >= 4 && !generic.has(name));
}

describe('committed files hold nothing private', () => {
  it('lists the files it checks (so that an empty list cannot pass)', () => {
    expect(committed).toEqual(expect.arrayContaining(['README.md', 'Dockerfile', join('docs', 'contract.md'), join('docs', 'facts', 'claude-code-terminal.md')]));
  });

  it.each(committed)('%s has no home path, volume path, scratch folder or name of this machine', (path) => {
    // The project's own public coordinates (its GitHub repository, its image, its npm package, its Pages site and its docs domain) name an account, not this machine.
    const text = read(path).replace(/\b(?:ghcr\.io|github\.com)\/[a-z0-9-]+\/gonogo\b|(?<![\w.-])@[a-z0-9-]+\/gonogo\b|\b[a-z0-9-]+\.github\.io\/gonogo\b|\bgonogo\.[a-z0-9-]+\.[a-z]{2,}\b/gi, '');
    expect(text, 'a home directory with a login name in it').not.toMatch(/\/Users\/[A-Za-z0-9_-]/);
    expect(text, 'a volume name').not.toMatch(/\/Volumes\/[^<`\s]/);
    expect(text, 'the scratch folder of a session').not.toMatch(/\.claude-tmp\b/);
    for (const name of machineNames()) expect(text.toLowerCase().includes(name), 'a name of the machine running this test').toBe(false);
  });

  it.each(['real-fs.stream.jsonl', 'real-classic.stream.jsonl'])('%s has no id, path or name of a machine, also when a record boundary or a wrap cuts it', (file) => {
    const all = recordedBytes(file);
    expect(all, 'a piece of an account, organisation or plugin id').not.toMatch(/[0-9a-f]{4,}-[0-9a-f]{3,}/i);
    expect(all).not.toMatch(/\/Users\/|\/Volumes\/|\/home\/|\.claude-tmp/);
    for (const name of machineNames()) expect(all.toLowerCase().includes(name), 'a name of the machine running this test').toBe(false);
  });
});

describe('the first name of this app is gone', () => {
  // Built from pieces so that this file does not match itself. Only "arc" may come before it ("archive"): any other
  // neighbour fails, a letter too (another product's file names held it inside a word).
  const old = ['h', 'ive'].join('');
  const pattern = new RegExp(`(?<!arc)${old}`, 'i');
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter((path) => path !== '' && existsSync(join(root, path)));

  it('checks every committed file (so that an empty list cannot pass)', () => {
    expect(tracked).toEqual(expect.arrayContaining(['package.json', 'Dockerfile', 'test/repo-files.test.ts', 'docs/contract.md']));
  });

  it('appears in no committed file', () => {
    const hits = tracked.filter((path) => pattern.test(readFileSync(join(root, path)).toString('latin1')));
    expect(hits).toStrictEqual([]);
  });

  it('the pattern catches each form the name took, inside a word too, and lets "archive" through', () => {
    for (const form of [`~/.desk${old}`, `mcp__${old}__send_message`, `${old.toUpperCase()}_ROOT`, `main/${old}.ts`, `Shared ${old} state`, `use${old[0].toUpperCase()}${old.slice(1)}.ts`, `shared/${old}Nudge.ts`, `bee${old}`]) expect(pattern.test(form), form).toBe(true);
    for (const word of ['archive', 'ARCHIVED', 'Archive: Build is green']) expect(pattern.test(word), word).toBe(false);
  });
});
