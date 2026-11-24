/**
 * The embedding endpoint (docs/semantic-search-spec.md section 5, E1 and E6): an Ollama server that turns text into vectors. gonogo
 * sends the notes of the Mission Log to it, so it is a place the Director chose and nothing else can name:
 *
 * - the URL is a scheme and a host, no user name or password, no path, query or fragment (the path is fixed: `/api/embed`);
 * - "loopback" is decided on the ADDRESS the name resolves to, never on the text of the URL: the name is resolved for each request, the
 *   address is classified, and the connection is pinned to that address (a `lookup` that answers only it), so a name that resolves
 *   somewhere else a moment later cannot be used. `0.0.0.0` and `::`, link-local (`169.254.0.0/16`, `fe80::/10`, where cloud metadata
 *   lives) and the IPv4-mapped forms of them are refused whatever the Director confirms;
 * - an address that is not loopback needs the Director's confirmation of that host (saved with the endpoint), and a public one needs
 *   https too;
 * - redirects are not followed; the answer is read while it streams and ended past 4 MiB (a `Content-Length` over it is refused before
 *   a byte is read); 20 s in all; the vectors are checked (finite numbers, one dimension, at most 4096 floats);
 * - the body of an error answer is never read, shown or logged: a status number and fixed words are all there is to say;
 * - an API key (an Ollama behind a proxy) goes in `Authorization: Bearer` to this endpoint only (redirects are not followed), and only over https or to this machine.
 */
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { LookupAddress } from 'node:dns';

export const EMBED_PATH = '/api/embed';
export const EMBED_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
export const EMBED_TIMEOUT_MS = 20_000;
export const EMBED_DIM_MAX = 4096;
export const EMBED_BATCH_MAX = 8;
export const EMBED_TEXT_MAX_CHARS = 4000;
export const DEFAULT_ENDPOINT = 'http://127.0.0.1:11434';
export const DEFAULT_MODEL = 'nomic-embed-text';

export type AddressClass = 'loopback' | 'private' | 'public' | 'refused';

const range = (v4: Array<[string, number]>, v6: Array<[string, number]>): BlockList => {
  const list = new BlockList();
  for (const [net, bits] of v4) list.addSubnet(net, bits, 'ipv4');
  for (const [net, bits] of v6) list.addSubnet(net, bits, 'ipv6');
  return list;
};
// the metadata services of the clouds (AWS over IPv6, Alibaba) beside link-local
const REFUSED = range([['0.0.0.0', 8], ['169.254.0.0', 16], ['100.100.100.200', 32]], [['::', 128], ['fe80::', 10], ['fd00:ec2::254', 128]]);
const LOOPBACK = range([['127.0.0.0', 8]], [['::1', 128]]);
const PRIVATE = range([['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10]], [['fc00::', 7]]);

/** What an address is, by its range: IPv4-mapped IPv6 (`::ffff:127.0.0.1`), IPv4-compatible (`::127.0.0.1`) and NAT64 (`64:ff9b::127.0.0.1`) are the IPv4 address inside them. Not an address: refused. */
export function classifyAddress(address: string): AddressClass {
  let a = address.trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  let family = isIP(a);
  if (family === 6) {
    // the URL parser writes every form of an address the same way, so the mapped forms are one pattern
    const written = new URL(`http://[${a}]/`).hostname;
    // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) all carry an IPv4 address: it is the one classified. ::1 is the IPv6 loopback, not 0.0.0.1.
    const mapped = written === '[::1]' ? null : /^\[(?:::ffff:|::|64:ff9b::)(?:(?:([0-9a-f]{1,4}):)?([0-9a-f]{1,4}))?\]$/.exec(written);
    if (mapped !== null) {
      const [hi, lo] = [Number.parseInt(mapped[1] ?? '0', 16), Number.parseInt(mapped[2] ?? '0', 16)];
      a = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
      family = 4;
    }
  }
  if (family === 0) return 'refused';
  const type = family === 6 ? 'ipv6' : 'ipv4';
  if (REFUSED.check(a, type)) return 'refused';
  if (LOOPBACK.check(a, type)) return 'loopback';
  return PRIVATE.check(a, type) ? 'private' : 'public';
}

export interface ParsedEndpoint {
  /** `http` or `https`. */
  scheme: 'http' | 'https';
  /** The host as written, lower case, without brackets. */
  host: string;
  port: number;
}

/** The scheme, host and port of an endpoint, or a sentence saying what is wrong with it. */
export function parseEndpoint(text: unknown): ParsedEndpoint | string {
  if (typeof text !== 'string' || text.trim() === '' || text.length > 300) return 'the endpoint must be an address like http://127.0.0.1:11434';
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return 'the endpoint is not an address';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'the endpoint must start with http:// or https://';
  if (url.username !== '' || url.password !== '') return 'the endpoint must not carry a user name or a password';
  if ((url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') return `the endpoint is a host and a port only: the path is always ${EMBED_PATH}`;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '') return 'the endpoint has no host';
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  return { scheme: url.protocol === 'https:' ? 'https' : 'http', host, port };
}

/** The endpoint as it is saved and shown: no trailing slash. */
export const endpointText = (e: ParsedEndpoint): string => `${e.scheme}://${isIP(e.host) === 6 ? `[${e.host}]` : e.host}:${e.port}`;

export interface Resolved {
  address: string;
  family: 4 | 6;
  class: AddressClass;
}

export type Resolver = (host: string) => Promise<Array<{ address: string; family: number }>>;
const systemResolver: Resolver = (host) => lookup(host, { all: true, verbatim: true });

/**
 * Resolves the host ONCE and classifies the address that will be used. When a name has several addresses the worst class decides (one
 * refused address refuses the name, a public one makes it public), and the first address is the one the connection is pinned to.
 */
export async function resolveHost(host: string, resolver: Resolver = systemResolver): Promise<Resolved> {
  const found = isIP(host) !== 0 ? [{ address: host, family: isIP(host) }] : await resolver(host);
  if (found.length === 0) throw new EmbedError('the host did not resolve');
  const rank: Record<AddressClass, number> = { loopback: 0, private: 1, public: 2, refused: 3 };
  let worst: AddressClass = 'loopback';
  for (const f of found) {
    const c = classifyAddress(f.address);
    if (rank[c] > rank[worst]) worst = c;
  }
  const first = found[0] as { address: string; family: number };
  return { address: first.address, family: first.family === 6 ? 6 : 4, class: worst };
}

/** A failure with words that are fixed: nothing a server sent is in it. */
export class EmbedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbedError';
  }
}

export interface EndpointCheck {
  endpoint: ParsedEndpoint;
  resolved: Resolved;
}

/**
 * What a saved or tested endpoint must be, on the address it resolves to now: loopback always; private or public only with `confirmed`
 * (the host the Director confirmed, which must be this one); public also needs https; refused never. A sentence on failure.
 */
export async function checkEndpoint(text: unknown, confirmed: string | null, resolver?: Resolver): Promise<EndpointCheck | string> {
  const endpoint = parseEndpoint(text);
  if (typeof endpoint === 'string') return endpoint;
  let resolved: Resolved;
  try {
    resolved = await resolveHost(endpoint.host, resolver);
  } catch (e) {
    return e instanceof EmbedError ? e.message : 'the host did not resolve';
  }
  if (resolved.class === 'refused') return 'that address is never used: 0.0.0.0, link-local (169.254.x.x, fe80::) and the like are refused';
  if (resolved.class !== 'loopback' && confirmed !== endpoint.host) return `${endpoint.host} is not this machine: confirm that your notes may be sent there`;
  if (resolved.class === 'public' && endpoint.scheme !== 'https') return 'a public host needs https';
  return { endpoint, resolved };
}

export interface EmbedOptions {
  /** The endpoint as saved, the model and the host the Director confirmed (null: none). */
  endpoint: string;
  model: string;
  confirmed: string | null;
  resolver?: Resolver;
  timeoutMs?: number;
  /** An API key for an Ollama behind a proxy: sent as `Authorization: Bearer` to this endpoint only, and only over https or to this machine. */
  apiKey?: string;
  /** Managed mode: how long Ollama keeps the model, and the CPU threads of the request. */
  keepAlive?: string;
  numThread?: number;
  /** For tests: the largest answer read. */
  maxBytes?: number;
}

/** One request to the endpoint: the vectors of `texts`, in order, checked. Throws an EmbedError with fixed words. */
export async function embed(options: EmbedOptions, texts: readonly string[]): Promise<number[][]> {
  if (texts.length === 0 || texts.length > EMBED_BATCH_MAX) throw new EmbedError(`1 to ${EMBED_BATCH_MAX} texts at a time`);
  const checked = await checkEndpoint(options.endpoint, options.confirmed, options.resolver);
  if (typeof checked === 'string') throw new EmbedError(checked);
  const { endpoint, resolved } = checked;
  // a key travels in the clear on http: only to this machine, never to another host
  if (options.apiKey !== undefined && options.apiKey !== '' && endpoint.scheme !== 'https' && resolved.class !== 'loopback') throw new EmbedError('an API key is sent only over https, or to this machine');
  const body = JSON.stringify({
    model: options.model,
    input: texts.map((t) => t.slice(0, EMBED_TEXT_MAX_CHARS)),
    truncate: true,
    ...(options.keepAlive === undefined ? {} : { keep_alive: options.keepAlive }),
    ...(options.numThread === undefined || options.numThread <= 0 ? {} : { options: { num_thread: options.numThread } }),
  });
  const maxBytes = options.maxBytes ?? EMBED_RESPONSE_MAX_BYTES;
  const answer = await new Promise<Buffer>((resolve, reject) => {
    const send = endpoint.scheme === 'https' ? httpsRequest : httpRequest;
    const req = send(
      {
        host: endpoint.host,
        port: endpoint.port,
        path: EMBED_PATH,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), accept: 'application/json', ...(options.apiKey === undefined || options.apiKey === '' ? {} : { authorization: `Bearer ${options.apiKey}` }) },
        // the connection goes to the address that was classified, whatever the name says now
        lookup: ((_host: string, o: { all?: boolean }, cb: (e: Error | null, address: string | Array<{ address: string; family: number }>, family?: number) => void) =>
          // (Node asks for every address when it tries more than one family: the answer is the same one address)
          o?.all === true ? cb(null, [{ address: resolved.address, family: resolved.family }]) : cb(null, resolved.address, resolved.family)) as never,
        agent: false,
        timeout: options.timeoutMs ?? EMBED_TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        // no redirect is followed, and no error body is read
        if (status !== 200) {
          res.destroy();
          reject(new EmbedError(status >= 300 && status < 400 ? 'the endpoint answered with a redirect, which is not followed' : `the endpoint answered ${status}`));
          return;
        }
        const length = Number(res.headers['content-length']);
        if (Number.isFinite(length) && length > maxBytes) {
          res.destroy();
          reject(new EmbedError('the answer is too large'));
          return;
        }
        const chunks: Buffer[] = [];
        let seen = 0;
        res.on('data', (chunk: Buffer) => {
          seen += chunk.length;
          if (seen > maxBytes) {
            res.destroy();
            reject(new EmbedError('the answer is too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', () => reject(new EmbedError('the connection broke')));
      },
    );
    const deadline = setTimeout(() => req.destroy(new EmbedError('the endpoint did not answer in time')), options.timeoutMs ?? EMBED_TIMEOUT_MS);
    req.on('timeout', () => req.destroy(new EmbedError('the endpoint did not answer in time')));
    req.on('error', (e) => reject(e instanceof EmbedError ? e : new EmbedError('the endpoint could not be reached')));
    req.on('close', () => clearTimeout(deadline));
    req.end(body);
  });
  let json: unknown;
  try {
    json = JSON.parse(answer.toString('utf8'));
  } catch {
    throw new EmbedError('the answer is not JSON');
  }
  return vectorsOf(json, texts.length);
}

/** The vectors of an Ollama answer `{ embeddings: number[][] }`, or an EmbedError: one per text, one dimension, finite numbers, at most EMBED_DIM_MAX. */
export function vectorsOf(json: unknown, count: number): number[][] {
  const list = (json as { embeddings?: unknown } | null)?.embeddings;
  if (!Array.isArray(list) || list.length !== count) throw new EmbedError('the answer has not one vector for each text');
  let dim = -1;
  for (const v of list) {
    if (!Array.isArray(v) || v.length === 0 || v.length > EMBED_DIM_MAX) throw new EmbedError('a vector has a size that is not allowed');
    if (dim === -1) dim = v.length;
    if (v.length !== dim) throw new EmbedError('the vectors differ in size');
    for (const x of v) if (typeof x !== 'number' || !Number.isFinite(x)) throw new EmbedError('a vector holds something that is not a number');
  }
  return list as number[][];
}
