/**
 * Amazon Bedrock (docs/facts/bedrock.md): nothing in gonogo blocks it. These tests pin what makes it work: the AWS variables
 * of the owner's shell and of an agent's keys reach the engine, a Clean Room gets the keys by name and no host AWS folder,
 * a Bedrock model id passes the model field, and the cost table prices it only from a row of the owner's own.
 * No AWS call is made and no credential of this host is read.
 */
import { describe, expect, it } from 'vitest';
import { buildDockerArgs } from '../src/server/cleanroom.js';
import { keyNameProblem } from '../src/server/clearance.js';
import { buildChildEnv } from '../src/server/launcher.js';
import { buildProviderStart } from '../src/server/providers.js';
import { costOf, mergePrices, priceFor } from '../src/shared/prices.js';
import { KEY_SUGGESTIONS, KEY_VALUE_PATTERN, MODEL_PATTERN, PROVIDERS } from '../src/shared/protocol.js';

/** Fake values, in the shape of the real ones. */
const BEDROCK_KEYS = {
  CLAUDE_CODE_USE_BEDROCK: '1',
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE0000000',
  AWS_SECRET_ACCESS_KEY: 'secret/example+0000000000000000000000000000',
  AWS_SESSION_TOKEN: 'IQoJb3JpZ2luX2VjEXAMPLE' + 'x'.repeat(1500),
  AWS_BEARER_TOKEN_BEDROCK: 'bedrock-api-key-EXAMPLE',
  AWS_PROFILE: 'work',
  ANTHROPIC_MODEL: 'us.anthropic.claude-sonnet-4-6',
};
const MODELS = [
  'us.anthropic.claude-sonnet-4-6',
  'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  'global.anthropic.claude-opus-5-5',
  'anthropic.claude-sonnet-4-5-20250929-v1:0',
  'arn:aws:bedrock:us-east-2:123456789012:application-inference-profile/abcd1234efgh',
];

describe('Bedrock: the environment', () => {
  it('every Bedrock variable is a valid key name and value, and is suggested by the hire form', () => {
    const value = new RegExp(KEY_VALUE_PATTERN);
    for (const [name, text] of Object.entries(BEDROCK_KEYS)) {
      expect(keyNameProblem(name), name).toBeNull();
      expect(value.test(text), name).toBe(true);
      expect(KEY_SUGGESTIONS as readonly string[], name).toContain(name);
    }
  });

  it('the owner\'s shell passes AWS variables on to an agent untouched, and an agent\'s key wins over the same name', () => {
    const base = { PATH: '/usr/bin', HOME: '/home/o', AWS_PROFILE: 'owner', AWS_REGION: 'eu-west-1', CLAUDE_CODE_USE_BEDROCK: '1', AWS_BEARER_TOKEN_BEDROCK: 'host-token' };
    const env = buildChildEnv({ base, token: null, seed: false, keys: { AWS_REGION: 'us-east-1' } });
    expect(env).toMatchObject({ AWS_PROFILE: 'owner', AWS_REGION: 'us-east-1', CLAUDE_CODE_USE_BEDROCK: '1', AWS_BEARER_TOKEN_BEDROCK: 'host-token' });
  });

  it('seed mode keeps Bedrock as it is: it moves only ANTHROPIC_API_KEY', () => {
    const env = buildChildEnv({ base: { PATH: '/usr/bin' }, token: 't', seed: true, keys: BEDROCK_KEYS });
    expect(env.IS_DEMO).toBe('1');
    expect(env).toMatchObject(BEDROCK_KEYS);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GONOGO_API_KEY).toBeUndefined();
  });

  it('GONOGO_SCRUB_ENV can take an AWS variable away from every agent, and the agent\'s own key still comes back', () => {
    const base = { PATH: '/usr/bin', AWS_ACCESS_KEY_ID: 'host', AWS_SECRET_ACCESS_KEY: 'host', GONOGO_SCRUB_ENV: 'AWS_ACCESS_KEY_ID,AWS_SECRET_ACCESS_KEY' };
    expect(buildChildEnv({ base, token: null, seed: false })).not.toHaveProperty('AWS_ACCESS_KEY_ID');
    expect(buildChildEnv({ base, token: null, seed: false, keys: { AWS_ACCESS_KEY_ID: 'mine' } }).AWS_ACCESS_KEY_ID).toBe('mine');
  });

  it('no engine\'s start adds or removes a Bedrock variable: the engine env holds only its own config path', () => {
    const ctx = { name: 'ana', agentDir: '/h/agents/ana', hubUrl: 'http://127.0.0.1:7777', tokenFile: '/h/t', token: 'tok', role: 'r', roleText: 'rt', mode: 'default' as const, seed: false };
    for (const provider of PROVIDERS.filter((p) => p !== 'claude' && p !== 'custom')) {
      const { env, args } = buildProviderStart(provider, ctx);
      expect(Object.keys(env).filter((name) => /^(AWS_|CLAUDE_CODE_USE_|ANTHROPIC_)/.test(name)), provider).toEqual([]);
      expect(args.join(' '), provider).not.toMatch(/bedrock/i);
    }
  });
});

describe('Bedrock: a Clean Room', () => {
  const place = { worktree: '/h/cleanroom/ana', cwd: '/h/cleanroom/ana', home: '/h/agents/ana/cleanroom-home', container: 'gonogo-ana-0123456789ab', network: null };

  it('gets the agent\'s keys by name, never a value, and mounts no AWS folder: HOME is the container\'s own', () => {
    const names = ['GONOGO_TOKEN', ...Object.keys(BEDROCK_KEYS)];
    const args = buildDockerArgs({ image: 'gonogo', uid: 1000, gid: 1000, place, agentDir: '/h/agents/ana', names, command: ['claude'] });
    for (const name of Object.keys(BEDROCK_KEYS)) expect(args).toContain(name);
    expect(args.join('\n')).not.toMatch(/\.aws/);
    for (const text of Object.values(BEDROCK_KEYS)) expect(args).not.toContain(text);
    expect(args).toContain('HOME=/h/agents/ana/cleanroom-home');
    expect(args.filter((a) => a === '-v')).toHaveLength(3);
  });
});

describe('Bedrock: the model', () => {
  it('a Bedrock model id or an inference profile ARN passes the model field', () => {
    const pattern = new RegExp(MODEL_PATTERN);
    for (const model of MODELS) expect(pattern.test(model), model).toBe(true);
  });

  it('claude takes the id as `--model`, other engines that have the field the same way', () => {
    const ctx = { name: 'ana', agentDir: '/h/agents/ana', hubUrl: 'http://127.0.0.1:7777', tokenFile: '/h/t', token: 'tok', role: 'r', roleText: 'rt', mode: 'default' as const, seed: false, model: MODELS[0] };
    expect(buildProviderStart('codex', ctx).args).toContain('--model');
    expect(buildProviderStart('pi', ctx).args.slice(-2)).toEqual(['--model', MODELS[0]]);
  });

  it('a Bedrock id is unpriced until the owner adds a row for it; then the usual arithmetic applies', () => {
    const split = { i: 1_000_000, cw: 0, o: 1_000_000, cr: 0 };
    const defaults = mergePrices();
    for (const model of MODELS) expect(priceFor(defaults, model), model).toBeNull();
    const table = mergePrices({ 'us.anthropic.claude-sonnet-4-6': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 } });
    const price = priceFor(table, 'us.anthropic.claude-sonnet-4-6');
    expect(price).not.toBeNull();
    expect(costOf(split, price!)).toBeCloseTo(18, 6);
  });
});
