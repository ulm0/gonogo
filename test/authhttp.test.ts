// The class of a request (docs/login-spec.md): local means the Host AND the address are local; a Host header is whatever the sender wrote.
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createAuthHttp } from '../src/server/authhttp.js';

const http = (trustedProxies: string[] = []) => createAuthHttp({ auth: {} as never, legacyToken: () => null, hostOk: () => true, stylesheet: null, local: new WeakSet<IncomingMessage>(), trustedProxies });
const req = (host: string, address: string, headers: Record<string, string> = {}): IncomingMessage => ({ headers: { host, ...headers }, socket: { remoteAddress: address } }) as unknown as IncomingMessage;

describe('B2: a spoofed Host does not make a request local', () => {
  it('Host 127.0.0.1 from an address that is not local is public, from the LAN it is private', () => {
    const h = http();
    expect(h.whoOf(req('127.0.0.1:7357', '8.8.8.8')).cls).toBe('public');
    expect(h.whoOf(req('localhost', '203.0.113.9')).cls).toBe('public');
    expect(h.whoOf(req('127.0.0.1:7357', '::ffff:192.168.1.5')).cls).toBe('private');
    expect(h.whoOf(req('127.0.0.1:7357', '127.0.0.1')).cls).toBe('loopback');
    expect(h.whoOf(req('127.0.0.1:7357', '::1')).cls).toBe('loopback');
  });

  it('the wider of the two wins: a public name from this machine is public, a private name from this machine is private', () => {
    const h = http();
    expect(h.whoOf(req('gonogo.example.com', '127.0.0.1')).cls).toBe('public');
    expect(h.whoOf(req('nas.local', '127.0.0.1')).cls).toBe('private');
    expect(h.whoOf(req('192.168.1.5:7357', '192.168.1.9')).cls).toBe('private');
  });

  it('a forwarding header from a peer that is not a trusted proxy means something passed it on: public, whatever the Host says', () => {
    const h = http();
    for (const name of ['x-forwarded-for', 'x-real-ip', 'forwarded', 'x-forwarded-host', 'cf-connecting-ip', 'via']) expect(h.whoOf(req('127.0.0.1:7357', '127.0.0.1', { [name]: '8.8.8.8' })).cls, name).toBe('public');
  });

  it('behind a trusted proxy the forwarded client address decides, and the proxy\'s own address does not', () => {
    const h = http(['127.0.0.1']);
    expect(h.whoOf(req('127.0.0.1:7357', '127.0.0.1', { 'x-forwarded-for': '8.8.8.8' })).cls).toBe('public');
    expect(h.whoOf(req('nas.local', '127.0.0.1', { 'x-forwarded-for': '192.168.1.9' })).cls).toBe('private');
    expect(h.whoOf(req('nas.local', '127.0.0.1', { 'x-forwarded-for': '192.168.1.9' })).address).toBe('192.168.1.9');
    // nothing forwarded by the trusted proxy: it is a request from the proxy's own machine
    expect(h.whoOf(req('127.0.0.1:7357', '127.0.0.1')).cls).toBe('loopback');
  });

  it('an address that is not an address is public', () => {
    expect(http().whoOf(req('127.0.0.1', 'unknown')).cls).toBe('public');
  });
});

describe('N2: the user agent is shown and put in alerts, so it holds no control character or markup', () => {
  it('replaces them and cuts it at 200', () => {
    const who = http().whoOf(req('127.0.0.1', '127.0.0.1', { 'user-agent': `<img src=x onerror=alert(1)>\u0007\n"quoted" ${'a'.repeat(300)}` }));
    expect(who.agent).not.toMatch(/[<>&"'`\u0000-\u001f]/);
    expect(who.agent.length).toBe(200);
  });
});
