import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { checkEndpoint, classifyAddress, embed, EMBED_DIM_MAX, endpointText, parseEndpoint, resolveHost, vectorsOf } from '../src/server/embedder.js';
import type { EmbedOptions, Resolver } from '../src/server/embedder.js';

let server: Server | null = null;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;
async function ollama(handler: Handler): Promise<{ endpoint: string; hits: Array<{ url: string; body: string }> }> {
  const hits: Array<{ url: string; body: string }> = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      hits.push({ url: req.url ?? '', body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
  return { endpoint: `http://127.0.0.1:${(server?.address() as AddressInfo).port}`, hits };
}
const reply = (res: ServerResponse, json: unknown, status = 200): void => void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json));
const opts = (endpoint: string, over: Partial<EmbedOptions> = {}): EmbedOptions => ({ endpoint, model: 'nomic-embed-text', confirmed: null, ...over });
const message = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('it did not fail');
};

describe('what an address is', () => {
  it('loopback, private, public by range; link-local, unspecified and what is not an address are refused', () => {
    const cases: Array<[string, string]> = [
      ['127.0.0.1', 'loopback'], ['127.9.9.9', 'loopback'], ['::1', 'loopback'], ['[::1]', 'loopback'],
      ['10.1.2.3', 'private'], ['172.16.0.1', 'private'], ['172.31.255.255', 'private'], ['192.168.1.5', 'private'], ['100.64.0.1', 'private'], ['fd12::1', 'private'], ['fc00::1', 'private'],
      ['8.8.8.8', 'public'], ['172.32.0.1', 'public'], ['2606:4700::1111', 'public'], ['100.128.0.1', 'public'],
      ['0.0.0.0', 'refused'], ['0.1.2.3', 'refused'], ['::', 'refused'], ['169.254.169.254', 'refused'], ['169.254.0.1', 'refused'], ['fe80::1', 'refused'], ['febf::1', 'refused'],
      ['::ffff:169.254.169.254', 'refused'], ['::ffff:a9fe:a9fe', 'refused'], ['::ffff:0.0.0.0', 'refused'], ['::FFFF:7F00:1', 'loopback'], ['::ffff:127.0.0.1', 'loopback'], ['0:0:0:0:0:ffff:7f00:1', 'loopback'], ['::ffff:10.0.0.1', 'private'], ['::ffff:8.8.8.8', 'public'],
      ['100.100.100.200', 'refused'], ['100.100.100.201', 'private'], ['fd00:ec2::254', 'refused'], ['fd00:ec2::255', 'private'], ['FD00:EC2:0:0:0:0:0:254', 'refused'], ['::ffff:100.100.100.200', 'refused'],
      ['::169.254.169.254', 'refused'], ['::a9fe:a9fe', 'refused'], ['::0.0.0.0', 'refused'], ['::127.0.0.1', 'loopback'], ['::7f00:1', 'loopback'], ['::10.0.0.1', 'private'], ['::8.8.8.8', 'public'], ['::100.100.100.200', 'refused'],
      ['64:ff9b::169.254.169.254', 'refused'], ['64:ff9b::a9fe:a9fe', 'refused'], ['64:ff9b::7f00:1', 'loopback'], ['64:ff9b::127.0.0.1', 'loopback'], ['64:ff9b::10.0.0.1', 'private'], ['64:ff9b::808:808', 'public'], ['64:ff9b::0.0.0.0', 'refused'], ['64:ff9b::6464:64c8', 'refused'],
      ['localhost', 'refused'], ['', 'refused'], ['300.1.1.1', 'refused'], ['1.2.3', 'refused'],
    ];
    for (const [address, want] of cases) expect(classifyAddress(address), address).toBe(want);
  });
});

describe('the endpoint text', () => {
  it('is a scheme, a host and a port: no user name, password, path, query or fragment', () => {
    expect(parseEndpoint('http://127.0.0.1:11434')).toEqual({ scheme: 'http', host: '127.0.0.1', port: 11434 });
    expect(parseEndpoint('http://127.0.0.1:11434/')).toEqual({ scheme: 'http', host: '127.0.0.1', port: 11434 });
    expect(parseEndpoint('HTTPS://Ollama.Lan')).toEqual({ scheme: 'https', host: 'ollama.lan', port: 443 });
    expect(parseEndpoint('http://[::1]:11434')).toEqual({ scheme: 'http', host: '::1', port: 11434 });
    expect(endpointText({ scheme: 'http', host: '::1', port: 11434 })).toBe('http://[::1]:11434');
    for (const bad of ['http://user@127.0.0.1:11434', 'http://u:p@127.0.0.1', 'http://127.0.0.1/api/embed', 'http://127.0.0.1/?x=1', 'http://127.0.0.1/#x', 'ftp://127.0.0.1', 'file:///etc/passwd', 'javascript:alert(1)', '127.0.0.1:11434', '', '   ', 'x'.repeat(301), 5, null, undefined]) {
      expect(typeof parseEndpoint(bad), String(bad)).toBe('string');
    }
  });
});

describe('who is allowed', () => {
  const to = (map: Record<string, string[]>): Resolver => async (host) => (map[host] ?? []).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

  it('loopback by its address, never by what the name says: localhost.attacker.example that resolves elsewhere is not loopback', async () => {
    const r = to({ 'localhost.attacker.example': ['169.254.169.254'], 'looks-local.example': ['8.8.8.8'], 'really-local.example': ['127.0.0.1'], localhost: ['::1', '127.0.0.1'] });
    expect(await checkEndpoint('http://localhost.attacker.example:11434', null, r)).toMatch(/never used/);
    expect(await checkEndpoint('http://localhost.attacker.example:11434', 'localhost.attacker.example', r)).toMatch(/never used/);
    expect(await checkEndpoint('http://looks-local.example', null, r)).toMatch(/not this machine/);
    expect(await checkEndpoint('http://really-local.example', null, r)).toMatchObject({ resolved: { class: 'loopback', address: '127.0.0.1' } });
    expect(await checkEndpoint('http://localhost:11434', null, r)).toMatchObject({ resolved: { class: 'loopback' } });
  });

  it('one bad address among several decides: a name that resolves to a loopback and a link-local address is refused', async () => {
    const r = to({ 'two.example': ['127.0.0.1', '169.254.169.254'] });
    expect(await checkEndpoint('http://two.example', null, r)).toMatch(/never used/);
    expect((await resolveHost('two.example', r)).class).toBe('refused');
  });

  it('refuses 0.0.0.0, link-local, and their IPv4-mapped forms, even with a confirmation', async () => {
    for (const host of ['0.0.0.0', '169.254.169.254', '[fe80::1]', '[::ffff:169.254.169.254]', '[::ffff:a9fe:a9fe]', '[::]', '100.100.100.200', '[fd00:ec2::254]', '[::169.254.169.254]', '[64:ff9b::169.254.169.254]', '[64:ff9b::a9fe:a9fe]']) {
      const bare = host.replace(/^\[|\]$/g, '');
      expect(await checkEndpoint(`http://${host}:11434`, bare), host).toMatch(/never used/);
    }
  });

  it('a private or public host needs the confirmation of that host, and a public one https too', async () => {
    const r = to({ 'ollama.lan': ['192.168.1.10'], 'embed.example.com': ['93.184.216.34'], 'other.example.com': ['93.184.216.35'] });
    expect(await checkEndpoint('http://ollama.lan:11434', null, r)).toMatch(/confirm that your notes may be sent there/);
    expect(await checkEndpoint('http://ollama.lan:11434', 'other.lan', r)).toMatch(/confirm/);
    expect(await checkEndpoint('http://ollama.lan:11434', 'ollama.lan', r)).toMatchObject({ resolved: { class: 'private' } });
    expect(await checkEndpoint('http://embed.example.com', 'embed.example.com', r)).toMatch(/needs https/);
    expect(await checkEndpoint('https://embed.example.com', 'embed.example.com', r)).toMatchObject({ resolved: { class: 'public' } });
    expect(await checkEndpoint('https://embed.example.com', 'other.example.com', r)).toMatch(/confirm/);
  });

  it('a name that does not resolve is refused', async () => {
    expect(await checkEndpoint('http://nothing.example', null, to({}))).toMatch(/did not resolve/);
  });
});

describe('the request', () => {
  it('posts the model and the texts to /api/embed only, and returns the vectors', async () => {
    const { endpoint, hits } = await ollama((_req, res) => reply(res, { embeddings: [[1, 0, 0], [0, 1, 0]] }));
    expect(await embed(opts(endpoint), ['one', 'two'])).toEqual([[1, 0, 0], [0, 1, 0]]);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.url).toBe('/api/embed');
    expect(JSON.parse(hits[0]?.body ?? '{}')).toEqual({ model: 'nomic-embed-text', input: ['one', 'two'], truncate: true });
  });

  it('refuses no text, too many, and cuts a long one', async () => {
    const { endpoint, hits } = await ollama((_req, res) => reply(res, { embeddings: [[1, 2]] }));
    expect(await message(() => embed(opts(endpoint), []))).toMatch(/1 to 8/);
    expect(await message(() => embed(opts(endpoint), Array.from({ length: 9 }, () => 'x')))).toMatch(/1 to 8/);
    await embed(opts(endpoint), ['y'.repeat(10_000)]);
    expect((JSON.parse(hits[0]?.body ?? '{}') as { input: string[] }).input[0]).toHaveLength(4000);
  });

  it('does not follow a redirect, and says so', async () => {
    let followed = 0;
    const target = await ollama((_r, res) => {
      followed += 1;
      reply(res, { embeddings: [[1]] });
    });
    const second = await ollama((_r, res) => void res.writeHead(307, { location: `${target.endpoint}/api/embed` }).end());
    expect(await message(() => embed(opts(second.endpoint), ['x']))).toMatch(/redirect, which is not followed/);
    expect(followed).toBe(0);
  });

  it('never shows the body of an error: the status and fixed words only', async () => {
    const { endpoint } = await ollama((_r, res) => void res.writeHead(500).end('SECRET-ECHO: the text of your note'));
    const text = await message(() => embed(opts(endpoint), ['my note']));
    expect(text).toBe('the endpoint answered 500');
    expect(text).not.toMatch(/SECRET|note/);
  });

  it('ends an answer that is too large while it streams, and refuses a Content-Length over the cap before reading', async () => {
    let sent = 0;
    const big = await ollama((_r, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      const push = (): void => {
        sent += 1000;
        if (!res.write('x'.repeat(1000)) || sent > 200_000) return;
        setImmediate(push);
      };
      push();
    });
    expect(await message(() => embed(opts(big.endpoint, { maxBytes: 5000 }), ['x']))).toMatch(/too large/);
    expect(sent).toBeLessThan(200_000);
    await new Promise<void>((r) => server?.close(() => r()));
    const declared = await ollama((_r, res) => void res.writeHead(200, { 'content-length': '999999999' }).end('{}'));
    expect(await message(() => embed(opts(declared.endpoint), ['x']))).toMatch(/too large/);
  });

  it('times out on an endpoint that does not answer', async () => {
    const { endpoint } = await ollama(() => undefined);
    expect(await message(() => embed(opts(endpoint, { timeoutMs: 200 }), ['x']))).toMatch(/did not answer in time/);
  });

  it('says it could not be reached, in fixed words, when nothing listens', async () => {
    const { endpoint } = await ollama((_r, res) => reply(res, {}));
    await new Promise<void>((r) => server?.close(() => r()));
    server = null;
    expect(await message(() => embed(opts(endpoint), ['x']))).toBe('the endpoint could not be reached');
  });

  it('the connection goes to the address that was classified, not to what the name resolves to a moment later', async () => {
    const real = await ollama((_r, res) => reply(res, { embeddings: [[1, 2, 3]] }));
    const port = new URL(real.endpoint).port;
    let calls = 0;
    // the first (and only) resolution is the loopback; a second one, if the code made it, would answer an address nobody listens on
    const resolver: Resolver = async () => (calls++ === 0 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '203.0.113.9', family: 4 }]);
    expect(await embed(opts(`http://pinned.example:${port}`, { resolver }), ['x'])).toEqual([[1, 2, 3]]);
    expect(calls).toBe(1);
  });

  it('is refused before any connection for an endpoint that is not allowed', async () => {
    const { endpoint, hits } = await ollama((_r, res) => reply(res, { embeddings: [[1]] }));
    const resolver: Resolver = async () => [{ address: '169.254.169.254', family: 4 }];
    expect(await message(() => embed(opts(`http://meta.example:${new URL(endpoint).port}`, { resolver }), ['x']))).toMatch(/never used/);
    expect(hits).toEqual([]);
  });
});

describe('the vectors of an answer', () => {
  it('are one for each text, one size, finite numbers, at most 4096', () => {
    expect(vectorsOf({ embeddings: [[1, 2], [3, 4]] }, 2)).toEqual([[1, 2], [3, 4]]);
    const bad: unknown[] = [
      null, {}, { embeddings: 'x' }, { embeddings: [[1, 2]] }, { embeddings: [[1, 2], [3]] }, { embeddings: [[], []] },
      { embeddings: [[1, Number.NaN], [1, 2]] }, { embeddings: [[1, 'x'], [1, 2]] }, { embeddings: [[1, Number.POSITIVE_INFINITY], [1, 2]] }, { embeddings: [[1, null], [1, 2]] },
      { embeddings: [Array.from({ length: EMBED_DIM_MAX + 1 }, () => 0), Array.from({ length: EMBED_DIM_MAX + 1 }, () => 0)] },
    ];
    for (const json of bad) expect(() => vectorsOf(json, 2), JSON.stringify(json)?.slice(0, 40)).toThrow();
    expect(vectorsOf({ embeddings: [Array.from({ length: EMBED_DIM_MAX }, () => 0.5)] }, 1)[0]).toHaveLength(EMBED_DIM_MAX);
  });
});
