/**
 * Model lists (docs/engine-bay-spec.md): the models an engine offers, read from the program itself. The parsers read the real output of
 * pi 1.6.0 and opencode 2.4.1 (test/fixtures/engine-models, captured in this room); the lists, the cache and the time limit run stand-in
 * programs (shell scripts) on a PATH of their own.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROVIDER_INFO } from '../src/shared/protocol.js';
import { AWS_LIST_PLACEHOLDER, createEngineModelLists, listEnv, MODEL_LIST_RETRY_MS, parseOpencodeModels, parsePiModels, runListing } from '../src/server/enginemodels.js';

const fixture = (name: string): Promise<string> => readFile(join(import.meta.dirname, 'fixtures', 'engine-models', name), 'utf8');
const SECRET = 'sk-test-secret-value-1234';

let tmp: string;
let bin: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'gonogo-engine-models-'));
  bin = join(tmp, 'bin');
  await mkdir(bin);
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** A stand-in program: `--version` prints `version`; anything else counts the call in <name>.calls and runs `body`. */
async function program(name: string, version: string, body: string): Promise<void> {
  const file = join(bin, name);
  await writeFile(file, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\necho x >> "${join(tmp, `${name}.calls`)}"\n${body}\n`);
  await chmod(file, 0o755);
}
const calls = async (name: string): Promise<number> => (await readFile(join(tmp, `${name}.calls`), 'utf8').catch(() => '')).split('\n').filter((l) => l !== '').length;

describe('parsers, on the real output', () => {
  it('pi 1.6.0: `provider/model` for each row of the table, nothing from the header', async () => {
    const names = parsePiModels(await fixture('pi-1.6.0.txt'));
    expect(names).toHaveLength(18);
    expect(names).toContain('anthropic/claude-opus-5-5');
    expect(names).toContain('anthropic/claude-haiku-4-5-20251001');
    expect(names.every((n) => n.startsWith('anthropic/'))).toBe(true);
  });

  it('pi signed out of every provider: its warning is not a model', async () => {
    expect(parsePiModels(await fixture('pi-1.6.0-signed-out.txt'))).toEqual([]);
  });

  it('opencode 2.4.1: one `provider/model` per line', async () => {
    const names = parseOpencodeModels(await fixture('opencode-2.4.1.txt'));
    expect(names).toHaveLength(28);
    expect(names).toContain('anthropic/claude-opus-5-5');
    expect(names).toContain('opencode/big-pickle');
    expect(parseOpencodeModels('Error: no\n\nanthropic/x\n  spaced out/y\n')).toEqual(['anthropic/x']);
  });
});

describe('createEngineModelLists', () => {
  it('reads pi and opencode from the program, with the command and the version, and keeps only names the model field takes', async () => {
    await program('pi', '1.6.0', `cat <<'EOF'\nprovider   model    context\nanthropic  claude-opus-5-5  1M\n-bad        x    1M\nok  a$b  1M\nEOF`);
    await program('opencode', 'opencode v2.4.1', `[ "$1 $2" = "models --standalone" ] || exit 3\necho anthropic/claude-opus-5-5\necho openai/gpt-x`);
    const lists = createEngineModelLists({ env: { PATH: `${bin}:/usr/bin:/bin`, HOME: tmp } });
    expect(await lists.get('pi')).toMatchObject({ provider: 'pi', source: 'cli', models: ['anthropic/claude-opus-5-5'], command: 'pi --list-models', version: '1.6.0' });
    expect(await lists.get('opencode')).toMatchObject({ source: 'cli', models: ['anthropic/claude-opus-5-5', 'openai/gpt-x'], command: 'opencode models --standalone', version: 'opencode v2.4.1' });
  });

  it('an engine without a listing command gives the names it suggests; one not installed says so', async () => {
    await program('claude', '2.1.325 (Claude Code)', 'exit 1');
    const lists = createEngineModelLists({ env: { PATH: `${bin}:/usr/bin:/bin`, HOME: tmp } });
    expect(await lists.get('claude')).toMatchObject({ source: 'static', models: [...(PROVIDER_INFO.claude.model ?? [])], command: null, version: '2.1.325 (Claude Code)' });
    expect(await calls('claude')).toBe(0);
    expect(await lists.get('opencode')).toMatchObject({ source: 'missing', models: [], version: null });
  });

  it('remembers a list until a refresh or a new version of the program; asks once for two readers at the same time', async () => {
    await program('pi', '1.6.0', `printf 'provider model\\nanthropic a\\n'`);
    const lists = createEngineModelLists({ env: { PATH: `${bin}:/usr/bin:/bin`, HOME: tmp } });
    const [a, b] = await Promise.all([lists.get('pi'), lists.get('pi')]);
    expect(a).toBe(b);
    await lists.get('pi');
    expect(await calls('pi')).toBe(1);
    await lists.get('pi', true);
    expect(await calls('pi')).toBe(2);
    await program('pi', '1.7.0', `printf 'provider model\\nanthropic b\\n'`);
    expect(await lists.get('pi')).toMatchObject({ models: ['anthropic/b'], version: '1.7.0' });
    expect(await calls('pi')).toBe(3);
  });

  it('a program that fails gives its suggested names and why, and is asked again only after a while or on a refresh', async () => {
    await program('pi', '1.6.0', 'echo "PlatformError: PermissionDenied" >&2\nexit 1');
    let clock = 1_000;
    const lists = createEngineModelLists({ env: { PATH: `${bin}:/usr/bin:/bin`, HOME: tmp }, now: () => clock });
    expect(await lists.get('pi')).toMatchObject({ source: 'error', models: [...(PROVIDER_INFO.pi.model ?? [])], error: 'PlatformError: PermissionDenied', command: 'pi --list-models' });
    await lists.get('pi');
    expect(await calls('pi')).toBe(1);
    clock += MODEL_LIST_RETRY_MS + 1;
    await lists.get('pi');
    expect(await calls('pi')).toBe(2);
    await lists.get('pi', true);
    expect(await calls('pi')).toBe(3);
  });
});

describe('runListing', () => {
  it('gets PATH, HOME, LANG and the XDG folders, and no key of gonogo', async () => {
    expect(listEnv({ PATH: '/b', HOME: '/h', XDG_CONFIG_HOME: '/c', ANTHROPIC_API_KEY: SECRET, GONOGO_TOKEN: SECRET })).toEqual({ PATH: '/b', HOME: '/h', XDG_CONFIG_HOME: '/c', NO_COLOR: '1' });
    await program('pi', '1', 'env');
    const out = await runListing(join(bin, 'pi'), ['--list-models'], listEnv({ PATH: `${bin}:/usr/bin:/bin`, HOME: tmp, ANTHROPIC_API_KEY: SECRET }));
    expect(out).toContain(`HOME=${tmp}`);
    expect(out).not.toContain(SECRET);
  });

  it('a program that does not answer in time is stopped with what it started', async () => {
    const marker = join(tmp, 'child-alive');
    await program('opencode', '1', `(sleep 2; touch "${marker}") &\nsleep 30`);
    const started = Date.now();
    await expect(runListing(join(bin, 'opencode'), ['models'], { PATH: '/usr/bin:/bin', HOME: tmp }, 300)).rejects.toThrow('no answer in 0.3 s');
    expect(Date.now() - started).toBeLessThan(5_000);
    await new Promise((r) => setTimeout(r, 2_500));
    // the background child was in the killed process group: it never touched its marker
    await expect(readFile(marker)).rejects.toThrow();
  }, 10_000);
});

describe('Amazon Bedrock in the lists (t144)', () => {
  it('the listing gets the AWS settings of gonogo and of the room (the room wins): profile, region and files as they are, a secret only as a placeholder', () => {
    const env = listEnv({ PATH: '/b', HOME: '/h', AWS_REGION: 'eu-west-1', AWS_ACCESS_KEY_ID: 'AKIAREALKEY', OTHER: 'x' }, { AWS_PROFILE: 'work', AWS_REGION: 'us-west-2', AWS_BEARER_TOKEN_BEDROCK: SECRET });
    expect(env).toEqual({ PATH: '/b', HOME: '/h', NO_COLOR: '1', AWS_PROFILE: 'work', AWS_REGION: 'us-west-2', AWS_ACCESS_KEY_ID: AWS_LIST_PLACEHOLDER, AWS_BEARER_TOKEN_BEDROCK: AWS_LIST_PLACEHOLDER });
    expect(JSON.stringify(env)).not.toContain(SECRET);
    expect(JSON.stringify(env)).not.toContain('AKIAREALKEY');
  });

  it('pi lists its amazon-bedrock models once the room has an AWS setting, and lists again when the room keys change', async () => {
    await program('pi', '1.6.0', `printf 'provider model\\nanthropic claude-opus-5-5\\n'\n[ -n "$AWS_PROFILE$AWS_BEARER_TOKEN_BEDROCK" ] && printf 'amazon-bedrock anthropic.claude-fable-5\\n'\nexit 0`);
    let room: Record<string, string> = {};
    const lists = createEngineModelLists({ env: { PATH: `${bin}:/usr/bin:/bin`, HOME: tmp }, room: () => room });
    expect((await lists.get('pi')).models).toEqual(['anthropic/claude-opus-5-5']);
    room = { AWS_PROFILE: 'work', AWS_REGION: 'us-west-2' };
    expect((await lists.get('pi')).models).toEqual(['anthropic/claude-opus-5-5', 'amazon-bedrock/anthropic.claude-fable-5']);
    expect(await calls('pi')).toBe(2);
    // the same keys: remembered
    await lists.get('pi');
    expect(await calls('pi')).toBe(2);
  });

  it('the real output of pi 1.6.0 with AWS_PROFILE set: amazon-bedrock/<id> names the model field takes', async () => {
    const names = parsePiModels(await fixture('pi-1.6.0-aws-profile.txt'));
    expect(names.length).toBeGreaterThan(100);
    expect(names).toContain('amazon-bedrock/anthropic.claude-fable-5');
    expect(names.every((n) => n.startsWith('amazon-bedrock/'))).toBe(true);
  });
});

describe('opencode with AWS_PROFILE set (real output of 2.4.1)', () => {
  it('lists amazon-bedrock/<id> names', async () => {
    const names = parseOpencodeModels(await fixture('opencode-2.4.1-aws-profile.txt'));
    expect(names.filter((n) => n.startsWith('amazon-bedrock/')).length).toBeGreaterThan(100);
  });
});
