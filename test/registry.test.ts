import { describe, expect, it } from 'vitest';
import { PAYLOAD_SERVER_NAME_PATTERN } from '../src/server/constants.js';
import { parsePayload } from '../src/server/payload.js';
import { checkedDaysAgo, REGISTRY, REGISTRY_STALE_DAYS, REGISTRY_WARNINGS } from '../src/shared/registry.js';
import type { RegistryServer, RegistrySkill } from '../src/shared/registry.js';

// The registry (src/shared/registry.ts): the rules every entry keeps, offline. Whether an entry is still true of its repository and package is
// `pnpm registry:check`, by hand: it needs the network.

const servers = REGISTRY.filter((e): e is RegistryServer => e.kind === 'mcp');
const skills = REGISTRY.filter((e): e is RegistrySkill => e.kind === 'skill');
const NAME = new RegExp(PAYLOAD_SERVER_NAME_PATTERN);
/** What a token or a key looks like when it was pasted into a file. */
const SECRETISH = /(?:ghp_|github_pat_|gho_|sk-[A-Za-z0-9]|ntn_[A-Za-z0-9]|xox[abp]-|AKIA[0-9A-Z]{8}|-----BEGIN|eyJ[A-Za-z0-9_-]{10,}\.)/;

describe('every entry', () => {
  it('has a unique slug id, a name, a one-sentence summary, a source on GitHub and a day it was checked', () => {
    expect(new Set(REGISTRY.map((e) => `${e.kind}:${e.id}`)).size).toBe(REGISTRY.length);
    for (const e of REGISTRY) {
      expect(e.id, e.id).toMatch(/^[a-z0-9][a-z0-9-]{0,40}$/);
      expect(e.name.trim(), e.id).not.toBe('');
      expect(e.summary.length, e.id).toBeLessThanOrEqual(140);
      expect(e.summary, e.id).toMatch(/[.]$/);
      expect(e.licence.trim(), e.id).not.toBe('');
      expect(e.source, e.id).toMatch(/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+/);
      expect(e.checked, e.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(e.checked)), e.id).toBe(false);
    }
  });

  it('has no token, key or private address in it, and no control character', () => {
    for (const e of REGISTRY) {
      const text = JSON.stringify(e);
      expect(text, e.id).not.toMatch(SECRETISH);
      // eslint-disable-next-line no-control-regex
      expect(text, e.id).not.toMatch(/[\u0000-\u001f\u007f]|\\u00[01]/);
      expect(text, e.id).not.toMatch(/https?:\/\/[^\s"']*@/);
    }
  });
});

describe('an MCP server', () => {
  it('is a Payload server: parsePayload accepts it under its id, and the id is a server name that is not "gonogo"', () => {
    expect(servers.length).toBeGreaterThanOrEqual(10);
    for (const e of servers) {
      expect(e.id, e.id).toMatch(NAME);
      expect(e.id).not.toBe('gonogo');
      const checked = parsePayload({ mcpServers: { [e.id]: e.server } });
      expect(checked.ok, `${e.id}: ${checked.ok ? '' : checked.error}`).toBe(true);
    }
  });

  it('and all of them together fit one payload (16 servers, 32 KiB)', () => {
    const all = Object.fromEntries(servers.map((e) => [e.id, e.server]));
    expect(servers.length).toBeLessThanOrEqual(16);
    expect(parsePayload({ mcpServers: all }).ok).toBe(true);
  });

  it('names what it needs and never holds a value: each name is used as ${NAME} in an env or a header, and only there', () => {
    for (const e of servers) {
      for (const need of e.needs) {
        expect(need, e.id).toMatch(/^[A-Z][A-Z0-9_]{0,63}$/);
        const used = JSON.stringify({ env: e.server.env ?? {}, headers: e.server.headers ?? {} });
        expect(used, `${e.id} uses ${need}`).toContain('${' + need + '}');
      }
      // every value in an env or a header is nothing but a reference to a name it needs
      for (const value of [...Object.values(e.server.env ?? {}), ...Object.values(e.server.headers ?? {})]) {
        const refs = [...value.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)].map((m) => m[1] as string);
        expect(refs.length, `${e.id}: ${value}`).toBeGreaterThan(0);
        for (const r of refs) expect(e.needs, `${e.id} ${r}`).toContain(r);
        expect(value.replace(/\$\{[A-Z][A-Z0-9_]*\}/g, '').replace(/^Bearer $/, ''), `${e.id}: ${value}`).toBe('');
      }
    }
  });

  it('runs a command that is pinned to the version that was checked, or is a remote server over https', () => {
    for (const e of servers) {
      const { command, args = [], url } = e.server;
      if (url !== undefined) {
        expect(e.server.type, e.id).toBe('http');
        expect(url, e.id).toMatch(/^https:\/\/[a-z0-9.-]+\/[\w/.-]*$/);
        expect(command, e.id).toBeUndefined();
        expect(e.runtime, e.id).toBeNull();
      } else if (command === 'npx') {
        const spec = args.find((a) => !a.startsWith('-')) as string;
        expect(spec, e.id).toMatch(/^(?:@[a-z0-9-]+\/)?[a-z0-9._-]+@\d+\.\d+\.\d+$/);
        expect(args[0], e.id).toBe('-y');
        expect(e.runtime, e.id).toBe('node');
      } else if (command === 'uvx') {
        expect(args[0], e.id).toMatch(/^[a-z0-9._-]+==\d[\w.]*$/);
        expect(e.runtime, e.id).toBe('uv');
      } else {
        throw new Error(`${e.id}: the command ${String(command)} is not one the registry uses (npx, uvx, or a remote url)`);
      }
    }
  });

  it('says what the person must edit when the entry holds a placeholder path', () => {
    for (const e of servers) {
      const hasPlaceholder = (e.server.args ?? []).some((a) => a.startsWith('/path/to/'));
      expect(e.edit !== null, e.id).toBe(hasPlaceholder);
    }
  });

  it('is never the deprecated or archived package of the same thing', () => {
    const text = JSON.stringify(servers);
    expect(text).not.toContain('@modelcontextprotocol/server-github');
    expect(text).not.toContain('@stripe/mcp');
    expect(text).not.toContain('servers-archived');
  });
});

describe('a skill', () => {
  it('is a folder to fetch by a line the person runs themselves: gonogo installs nothing and the entry has no command to run', () => {
    expect(skills.length).toBeGreaterThanOrEqual(1);
    for (const e of skills) {
      expect(e.install, e.id).toMatch(/^git clone --depth 1 https:\/\/github\.com\/[^\s/]+\/[^\s/]+\.git <[a-z ]+>$/);
      expect(e.folder, e.id).toMatch(/^[a-z0-9][a-z0-9/_-]*$/);
      expect(e.folder, e.id).not.toContain('..');
      expect(e.source, e.id).toContain(e.folder);
      // the folder's name is the skill's name in a Payload
      expect(e.folder.split('/').pop(), e.id).toBe(e.id);
    }
  });

  it('is open source by its own licence file, said in the entry', () => {
    for (const e of skills) expect(e.licence, e.id).toBe('Apache-2.0');
  });
});

describe('what the card says', () => {
  it('every server names its publisher, how it is reached, what executes and where the data goes, in plain words', () => {
    for (const e of servers) {
      expect(e.publisher.trim(), e.id).not.toBe('');
      expect(e.transport, e.id).toBe(e.server.url === undefined ? 'stdio' : 'http');
      expect(e.runs, e.id).toMatch(e.transport === 'http' ? /^nothing runs here: the agent connects to https:\/\//u : /^(npx|uvx) downloads \S+(?: \S+)? and its dependencies from (npm|PyPI) and runs them on this machine/u);
      // the version in the words is the version in the command
      const spec = (e.server.args ?? []).find((a) => !a.startsWith('-')) ?? '';
      if (e.transport === 'stdio') expect(e.runs, e.id).toContain(spec.replace('==', ' ').replace(/(@[\d.]+)$/, '$1'));
      if (e.transport === 'http') expect(e.sendsTo, e.id).not.toBeNull();
      if (e.sendsTo !== null) expect(e.sendsTo.trim(), e.id).not.toBe('');
    }
    for (const e of skills) expect(e.publisher, e.id).toBe('Anthropic');
  });

  it('has the words that must be on every card, and the staleness rule', () => {
    expect(REGISTRY_WARNINGS.runs).toContain("your agent's rights when the agent starts");
    expect(REGISTRY_WARNINGS.pin).toContain('not what it depends on');
    expect(REGISTRY_WARNINGS.descriptions).toContain('tool descriptions are read by your agent');
    expect(REGISTRY_STALE_DAYS).toBe(90);
    const day = Date.UTC(2026, 10, 21);
    expect(checkedDaysAgo('2026-11-21', day)).toBe(0);
    expect(checkedDaysAgo('2026-11-20', day + 3600_000)).toBe(1);
    expect(checkedDaysAgo('2026-08-23', day)).toBe(90);
    expect(checkedDaysAgo('2027-01-01', day)).toBe(0);
  });

  it('is said in the docs that a change to a command, package, version or address is reviewed by RSO', async () => {
    const { readFile } = await import('node:fs/promises');
    const page = await readFile(new URL('../docs/features/registry.md', import.meta.url), 'utf8');
    expect(page).toMatch(/RSO reviews every change to an entry's command, package, version or address/);
  });
});
