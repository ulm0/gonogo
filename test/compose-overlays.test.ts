/**
 * The compose overlays for tunnels (compose.<provider>.yaml, docs/expose/<provider>.md) say the same as `gonogo expose` prints: the same client
 * address header, a trusted proxy that is the sidecar's address and not 127.0.0.1, the allowed host and public URL from the .env, the hooks-only
 * variant, pinned images, and no secret in the files. They are read as text: no compose is run here, and no tunnel.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { exposePlan } from '../src/server/exposecli.js';
import type { ExposeProvider } from '../src/server/exposecli.js';

const read = (name: string): string => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const OVERLAYS: Array<{ provider: ExposeProvider; file: string; sidecar: string }> = [
  { provider: 'tailscale', file: 'compose.tailscale.yaml', sidecar: 'tailscale' },
  { provider: 'cloudflare', file: 'compose.cloudflared.yaml', sidecar: 'cloudflared' },
  { provider: 'ngrok', file: 'compose.ngrok.yaml', sidecar: 'ngrok' },
  { provider: 'caddy', file: 'compose.caddy.yaml', sidecar: 'caddy' },
];
/** The value of `KEY: value` in the gonogo service's environment. */
const envOf = (text: string, key: string): string | undefined => new RegExp(`^ {6}${key}: (.+)$`, 'm').exec(text)?.[1]?.trim();

describe('the overlays', () => {
  for (const { provider, file, sidecar } of OVERLAYS) {
    describe(file, () => {
      const text = read(file);

      it('sets what gonogo expose prints: the allowed host, the public URL, the trusted proxy and the client address header', () => {
        const plan = exposePlan(provider, { publicUrl: 'https://gonogo.example.com', host: 'gonogo.example.com', port: 7777 });
        const header = /--client-ip-header (\S+)/.exec(plan.gonogo.join(' '))?.[1];
        expect(envOf(text, 'GONOGO_CLIENT_IP_HEADER')).toBe(header);
        expect(plan.gonogo.join(' ')).toContain('--trusted-proxy');
        // the public name (name:hooks with GONOGO_HOOKS_ONLY), then the LAN names the Director also uses, so the zimaos / 192.168.x.x setup keeps working
        expect(envOf(text, 'GONOGO_ALLOWED_HOSTS')).toMatch(/^\$\{GONOGO_PUBLIC_NAME:\?[^}]+\}\$\{GONOGO_HOOKS_ONLY:\+:hooks\},\$\{GONOGO_LAN_HOSTS:-\}$/);
        expect(envOf(text, 'GONOGO_PUBLIC_URL')).toMatch(/^https:\/\/\$\{GONOGO_PUBLIC_NAME:\?[^}]+\}$/);
      });

      it('trusts the sidecar\'s address on the private edge network, never 127.0.0.1, and gives the sidecar that very address', () => {
        const trusted = envOf(text, 'GONOGO_TRUSTED_PROXY') ?? '';
        expect(trusted).toBe('${GONOGO_EDGE_PROXY_IP:-172.29.80.2}');
        expect(trusted).not.toContain('127.0.0.1');
        expect(text).toContain('ipv4_address: ${GONOGO_EDGE_PROXY_IP:-172.29.80.2}');
        expect(text).toContain('subnet: ${GONOGO_EDGE_SUBNET:-172.29.80.0/24}');
        // the sidecar and gonogo are both on the edge network
        expect(text).toMatch(new RegExp(`^ {2}${sidecar}:\\n(?: {4}.*\\n)*? {4}networks:\\n {6}edge:`, 'm'));
        expect(text).toMatch(/^ {2}gonogo:\n(?: {4}.*\n)*? {4}networks:\n {6}- default\n {6}- edge/m);
      });

      it('pins its image: a version tag, with an optional override of the same tag; never latest or an untagged name', () => {
        const images = [...text.matchAll(/^ {4}image: (.+)$/gm)].map((m) => m[1] as string);
        expect(images).toHaveLength(1);
        const image = images[0] as string;
        expect(image).not.toMatch(/:latest$|^[^:]+$/);
        // a literal tag Renovate can bump, or ${X_VERSION:-<literal tag>}
        expect(image).toMatch(/:(v?\d[\w.-]*|\$\{[A-Z_]+_VERSION:-v?\d[\w.-]*\})$/);
        expect(image).not.toMatch(/\$\{[A-Z_]+_VERSION:\?/);
      });

      it('holds no secret: every token, key and password comes from the .env', () => {
        for (const line of text.split('\n')) {
          if (line.trimStart().startsWith('#')) continue;
          const m = /^\s+([A-Z_]*(?:TOKEN|AUTHKEY|SECRET|PASSWORD|KEY)[A-Z_]*): (.+)$/.exec(line);
          if (m !== null) expect(m[2], line).toMatch(/^\$\{[A-Z_]+:\?[^}]*\}$/);
        }
        const code = text.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
        expect(code).not.toMatch(/tskey-[A-Za-z0-9]|eyJ[A-Za-z0-9_-]{10,}|[0-9a-f]{32,}/);
      });

      it('needs Compose 2.23 and says so, inlines its config (no file to bind) and says how to change a clashing subnet', () => {
        expect(text).toMatch(/Docker Compose v2\.23/);
        expect(text).not.toMatch(/\.\/packaging|\.\/[A-Za-z]+:\//);
        expect(text).toContain('Pool overlaps');
        expect(text).toContain('GONOGO_LAN_HOSTS');
      });

      it('says to set the login up first, and names the docs page', () => {
        expect(text).toMatch(/FIRST set the login up/);
        expect(text).toContain(`docs/expose/${provider}.md`);
        expect(text).toContain(`-f compose.yaml -f ${file} up -d`);
      });
    });
  }

  it('Tailscale serves its tailnet name to gonogo:7777 from an inline config, and Funnel is one variable', () => {
    const text = read('compose.tailscale.yaml');
    expect(text).toMatch(/^configs:\n  tailscale_serve:\n(?: {4}.*\n)*? {4}content: \|/m);
    expect(text).toContain('"Proxy": "http://gonogo:7777"');
    // Tailscale fills TS_CERT_DOMAIN in, so Compose must not: $$
    expect(text).toContain('"Web": { "$${TS_CERT_DOMAIN}:443"');
    expect(text).toContain('"AllowFunnel": { "$${TS_CERT_DOMAIN}:443": ${TAILSCALE_FUNNEL:-false} }');
    expect(text).toContain('TS_SERVE_CONFIG: /config/serve.json');
  });

  it('the Tailscale node key is in a named volume, not in the data folder the agents can read', () => {
    const text = read('compose.tailscale.yaml');
    expect(text).toContain('- tailscale_state:/var/lib/tailscale');
    expect(text).toMatch(/^volumes:\n  tailscale_state:$/m);
    expect(text).not.toMatch(/GONOGO_DATA[^\n]*:\/var\/lib\/tailscale/);
  });

  it('Caddy keeps the public Host and sets the client address, in a Caddyfile that is inline and names the domain by Compose, not by a Caddy variable', () => {
    const text = read('compose.caddy.yaml');
    expect(text).toMatch(/^configs:\n  caddyfile:\n(?: {4}.*\n)*? {4}content: \|/m);
    expect(text).toContain('${GONOGO_PUBLIC_NAME:?set GONOGO_PUBLIC_NAME} {');
    expect(text).toContain('reverse_proxy gonogo:7777 {');
    expect(text).toContain('header_up X-Forwarded-For {remote_host}');
    expect(text).not.toMatch(/header_up Host/);
    expect(text).toContain('target: /etc/caddy/Caddyfile');
    expect(text).not.toMatch(/\t/);
    expect(exposePlan('caddy', { publicUrl: 'https://g.example.com', host: 'g.example.com', port: 7777 }).files.Caddyfile).toContain('header_up X-Forwarded-For {remote_host}');
  });

  it('cloudflared and ngrok forward to gonogo:7777 on the compose network, and cloudflared uses the token from the .env', () => {
    expect(read('compose.cloudflared.yaml')).toContain('command: tunnel --no-autoupdate run');
    expect(read('compose.cloudflared.yaml')).toContain('TUNNEL_TOKEN: ${TUNNEL_TOKEN:?');
    expect(read('compose.ngrok.yaml')).toContain('command: http --url=${GONOGO_PUBLIC_NAME:?set GONOGO_PUBLIC_NAME} gonogo:7777');
    expect(read('compose.ngrok.yaml')).toContain('NGROK_AUTHTOKEN: ${NGROK_AUTHTOKEN:?');
  });

  it('every provider page has a Docker Compose section that names its overlay', () => {
    for (const { provider, file } of OVERLAYS) {
      const page = read(`docs/expose/${provider}.md`);
      expect(page, provider).toContain('## With Docker Compose');
      expect(page, provider).toContain(file);
    }
  });
});

describe('gonogo expose points at the overlay of its provider', () => {
  it('every provider names a compose file that exists', () => {
    for (const provider of ['tailscale', 'funnel', 'cloudflare', 'caddy', 'ngrok'] as const) {
      const note = exposePlan(provider, { publicUrl: 'https://g.example.com', host: 'g.example.com', port: 7777 }).notes.join('\n');
      const file = /-f (compose\.[a-z]+\.yaml) up -d/.exec(note)?.[1];
      expect(file, provider).toBeDefined();
      expect(read(file as string), provider).toContain('GONOGO_TRUSTED_PROXY');
    }
  });
});
