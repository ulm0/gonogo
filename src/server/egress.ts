/**
 * Egress (docs/features/egress.md, docs/cleanroom-egress-decision.md): a reverse proxy for ONE upstream, api.anthropic.com, so that the Anthropic API key of
 * a Clean Room agent never enters its container. The container is given a base URL that points here (`ANTHROPIC_BASE_URL=<hub>/egress/<token>/anthropic`) and
 * a placeholder in place of the key. This module removes whatever credential the client sent, puts the real key on the request, and forwards it over https.
 *
 * No MITM: the container's TLS is its own, to this process, over the address it already uses for its hooks. What is held here:
 *   - one TOKEN per agent start, in the path (`/egress/<token>/anthropic/...`), made at the start and revoked at the stop, kept as a hash;
 *   - the key itself is asked for at every request (`key()`), so a change of the key applies at once and none is kept here;
 *   - the destination is the one constant host: a redirect from it is NOT followed (it goes back to the client, with the host rewritten to this proxy or dropped),
 *     the address it resolves to is checked (not loopback, private, link-local or this machine's own) and the connection is pinned to that answer, and only
 *     `/v1/` is forwarded, with GET, HEAD, POST or DELETE.
 * Nothing about a request is logged but its method, status and size: no header, no body, no path of the client, no key, no token.
 *
 * shortcut: the proxy sees the API traffic in plaintext (it ends the container's http and starts the https to Anthropic), as gonogo's process already holds the key.
 * shortcut: API-key mode only: a subscription (OAuth) token is not swapped, see docs/features/egress.md.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { lookup } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { BlockList, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import https from 'node:https';
import type { Logger } from '../shared/protocol.js';
import { KEY_VALUE_PATTERN } from '../shared/protocol.js';

export const EGRESS_PATH = 'egress';
/** The service names after the token. Only one in S1. */
export const EGRESS_SERVICE_ANTHROPIC = 'anthropic';
export const ANTHROPIC_HOST = 'api.anthropic.com';
export const EGRESS_BODY_MAX_BYTES = 64 * 1024 * 1024;
export const EGRESS_IDLE_MS = 10 * 60_000;
export const EGRESS_CONCURRENT_MAX = 16;
const KEY_RE = new RegExp(KEY_VALUE_PATTERN);
const METHODS = new Set(['GET', 'HEAD', 'POST', 'DELETE']);
/** Headers that are not forwarded either way: hop by hop, and the client's own credentials and identity (the proxy sets its own). */
const DROP = new Set([
  'host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'expect',
  'authorization', 'x-api-key', 'cookie', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip',
]);
const DROP_BACK = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'transfer-encoding', 'upgrade', 'set-cookie', 'set-cookie2', 'trailer', 'te']);

/** Addresses a request to the API must never be sent to: this machine, private networks, link-local (cloud metadata), carrier-grade NAT, and the machine's own addresses. */
const blocked = new BlockList();
for (const [net, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blocked.addSubnet(net, prefix, 'ipv4');
// NAT64 (64:ff9b::/96), 6to4 (2002::/16) and the IPv4-compatible block (::/96, which holds ::1) carry an IPv4 address that must not be reached, so none of them is allowed
for (const [net, prefix] of [['::', 96], ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) blocked.addSubnet(net, prefix, 'ipv6');

/** Whether the proxy may connect to this address. An IPv4-mapped IPv6 address is judged as the IPv4 it holds. */
export function publicAddress(address: string, own: ReadonlySet<string> = ownAddresses()): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const ip = mapped === null ? address : (mapped[1] as string);
  const family = isIP(ip);
  if (family === 0 || own.has(ip.toLowerCase())) return false;
  return !blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}
const ownAddresses = (): Set<string> => new Set(Object.values(networkInterfaces()).flatMap((list) => (list ?? []).map((i) => i.address.toLowerCase())));

const hashOf = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const sameHash = (a: string, b: string): boolean => timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

export interface EgressOptions {
  /** For tests: where the upstream is. Default api.anthropic.com over https. */
  upstream?: { protocol: 'http:' | 'https:'; hostname: string; port: number };
  /**
   * Where the token hashes are kept, 0600, so that a live reload (a new server taking over agents that keep running) does not end their tokens; null: not kept.
   * Only hashes and agent names are written, never a token or a key. A token whose agent is not live is revoked by the launcher's `keepTokens` at the start.
   */
  file?: string | null;
  /** The real key of an agent, by name, for a token that came back from the file (there is no closure of the start that made it). */
  keyOf?(agent: string): string | undefined;
  /** For tests: which addresses may be connected to. Default `publicAddress`. */
  allowAddress?(address: string): boolean;
  log: Logger;
}

export interface Egress {
  /** A token for this agent's start (the earlier one is revoked). `key` is asked at every request and gives the real key, or undefined. Returns the token. */
  issue(agent: string, key: () => string | undefined): string;
  /** The agent stopped (or is gone): its token stops working. */
  revoke(agent: string): void;
  /** Whether this agent has a live token. */
  has(agent: string): boolean;
  /** The path a client uses as its base URL: `/egress/<token>/anthropic`. */
  basePath(token: string): string;
  /** One request of `/egress/...`. Always answers. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

interface Entry {
  agent: string;
  hash: string;
  key: (() => string | undefined) | null;
  active: number;
}

const send = (res: ServerResponse, status: number, message: string): void => {
  if (res.headersSent) return void res.destroy();
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'gonogo_egress', message } }));
};

export function createEgress(options: EgressOptions): Egress {
  const { log } = options;
  const upstream = options.upstream ?? { protocol: 'https:' as const, hostname: ANTHROPIC_HOST, port: 443 };
  const allow = options.allowAddress ?? ((address: string) => publicAddress(address));
  const byHash = new Map<string, Entry>();
  const byAgent = new Map<string, Entry>();
  const file = options.file ?? null;
  const persist = (): void => {
    if (file === null) return;
    try {
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify({ version: 1, tokens: [...byAgent.values()].map((e) => ({ agent: e.agent, hash: e.hash })) }), { mode: 0o600 });
      renameSync(temp, file);
    } catch (error) {
      log.warn(`egress: could not save the tokens (${(error as NodeJS.ErrnoException).code ?? 'error'}): a live reload will end them`);
    }
  };
  if (file !== null) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as { tokens?: Array<{ agent?: unknown; hash?: unknown }> };
      for (const t of Array.isArray(saved.tokens) ? saved.tokens : []) {
        if (typeof t.agent !== 'string' || typeof t.hash !== 'string' || !/^[0-9a-f]{64}$/.test(t.hash)) continue;
        const entry: Entry = { agent: t.agent, hash: t.hash, key: null, active: 0 };
        byHash.set(entry.hash, entry);
        byAgent.set(entry.agent, entry);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('egress: the saved tokens could not be read');
    }
  }

  /** The connection goes to the address that was checked: the lookup that http(s) asks for is the one that answers, and a bad address in it ends the request. */
  const guarded: LookupFunction = (hostname, lookupOptions, callback) => {
    lookup(hostname, { ...lookupOptions, all: true, verbatim: true }, (error, addresses) => {
      if (error) return (callback as (e: Error) => void)(error);
      const list = addresses as Array<{ address: string; family: number }>;
      if (list.length === 0 || list.some((a) => !allow(a.address))) return (callback as (e: Error) => void)(Object.assign(new Error('refused address'), { code: 'EGRESS_REFUSED' }));
      if (lookupOptions.all === true) return (callback as unknown as (e: null, a: unknown) => void)(null, list);
      return callback(null, (list[0] as { address: string }).address, (list[0] as { family: number }).family);
    });
  };

  function entryOf(token: string): Entry | undefined {
    const found = byHash.get(hashOf(token));
    // the map is keyed by the hash; the compare makes the answer take the same time whatever the token
    return found !== undefined && sameHash(found.hash, hashOf(token)) ? found : undefined;
  }

  /** `/egress/<token>/anthropic/<rest>`: the token and the rest of the path (with the query), or null. */
  function parse(url: string | undefined): { token: string; rest: string } | null {
    const raw = url ?? '';
    const m = /^\/egress\/([0-9a-f]{64})\/anthropic(\/[^?#]*)?(\?[^#]*)?$/.exec(raw);
    if (m === null) return null;
    const path = m[2] ?? '';
    // nothing that leaves the API's folder: no dot segment, backslash, NUL or encoded slash, however it is spelled
    for (const segment of path.split('/')) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        return null;
      }
      if (decoded === '.' || decoded === '..' || /[\\\0/]/.test(decoded)) return null;
    }
    if (!path.startsWith('/v1/')) return null;
    return { token: m[1] as string, rest: `${path}${m[3] ?? ''}` };
  }

  function forwardHeaders(req: IncomingMessage, key: string): http.OutgoingHttpHeaders {
    const out: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || DROP.has(name.toLowerCase())) continue;
      out[name] = value;
    }
    out['x-api-key'] = key;
    out.host = upstream.port === 443 || upstream.port === 80 ? upstream.hostname : `${upstream.hostname}:${upstream.port}`;
    return out;
  }

  const revoke = (agent: string): void => {
    const old = byAgent.get(agent);
    if (old === undefined) return;
    byHash.delete(old.hash);
    byAgent.delete(agent);
    persist();
  };
  const basePath = (token: string): string => `/${EGRESS_PATH}/${token}/${EGRESS_SERVICE_ANTHROPIC}`;

  return {
    issue(agent, key) {
      revoke(agent);
      const token = randomBytes(32).toString('hex');
      const entry: Entry = { agent, hash: hashOf(token), key, active: 0 };
      byHash.set(entry.hash, entry);
      byAgent.set(agent, entry);
      persist();
      return token;
    },
    revoke,
    has: (agent) => byAgent.has(agent),
    basePath,

    async handle(req, res) {
      const parsed = parse(req.url);
      const entry = parsed === null ? undefined : entryOf(parsed.token);
      // one answer for a wrong token and for a token that was revoked: nothing says which
      if (parsed === null) return send(res, 404, 'not found');
      if (entry === undefined) return send(res, 403, 'forbidden: this address is no longer valid (restart the agent to get a new one)');
      const method = req.method ?? 'GET';
      if (!METHODS.has(method)) return send(res, 405, 'method not allowed');
      const key = entry.key === null ? options.keyOf?.(entry.agent) : entry.key();
      if (key === undefined || !KEY_RE.test(key)) return send(res, 503, 'no usable API key is set for this agent');
      if (entry.active >= EGRESS_CONCURRENT_MAX) return send(res, 429, 'too many requests at once');
      let bytes = 0;
      let done = false;
      const finish = (note: string, status: number): void => {
        if (done) return;
        done = true;
        entry.active -= 1;
        log.debug(`egress: ${entry.agent} ${method} ${status} ${bytes} bytes${note === '' ? '' : ` (${note})`}`);
      };
      // a literal address skips the lookup that guards a name, so it is judged here (the real upstream is a name)
      if (isIP(upstream.hostname) !== 0 && !allow(upstream.hostname)) {
        log.debug(`egress: ${entry.agent} refused address`);
        return send(res, 502, 'the upstream address is not allowed');
      }
      entry.active += 1;
      const body = method === 'GET' || method === 'HEAD' || method === 'DELETE' ? null : req;
      const opts: http.RequestOptions = { protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port, method, path: parsed.rest, headers: forwardHeaders(req, key), lookup: guarded, timeout: EGRESS_IDLE_MS };
      const out = (upstream.protocol === 'https:' ? https : http).request(opts, (back) => {
        const headers: http.OutgoingHttpHeaders = {};
        for (const [name, value] of Object.entries(back.headers)) {
          if (value === undefined || DROP_BACK.has(name.toLowerCase())) continue;
          // a redirect is not followed here: it goes back to the client, and only a Location to this very host stays, pointed at this proxy
          if (name.toLowerCase() === 'location') {
            const to = String(Array.isArray(value) ? value[0] : value);
            const m = new RegExp(`^(?:https?://${upstream.hostname.replace(/\./g, '\\.')}(?::\\d+)?)?(/v1/[^\\s]*)$`).exec(to);
            if (m !== null) headers.location = `${basePath(parsed.token)}${m[1]}`;
            continue;
          }
          headers[name] = value;
        }
        res.writeHead(back.statusCode ?? 502, headers);
        back.on('data', (chunk: Buffer) => (bytes += chunk.length));
        back.pipe(res);
        back.on('end', () => finish('', back.statusCode ?? 0));
        back.on('error', () => (finish('upstream error', 502), res.destroy()));
      });
      out.on('timeout', () => out.destroy(Object.assign(new Error('idle'), { code: 'EGRESS_IDLE' })));
      out.on('error', (error: NodeJS.ErrnoException) => {
        // what failed, by code only: a message can quote the address, and nothing here is for the client to read
        const refused = error.code === 'EGRESS_REFUSED';
        finish(refused ? 'refused address' : (error.code ?? 'error'), 502);
        send(res, 502, refused ? 'the upstream address is not allowed' : 'the upstream did not answer');
      });
      res.on('close', () => {
        if (!done) out.destroy();
        finish('client closed', 499);
      });
      if (body === null) return void out.end();
      let received = 0;
      body.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > EGRESS_BODY_MAX_BYTES) {
          out.destroy();
          finish('too large', 413);
          send(res, 413, 'request too large');
        }
      });
      body.on('error', () => out.destroy());
      body.pipe(out);
    },
  };
}
