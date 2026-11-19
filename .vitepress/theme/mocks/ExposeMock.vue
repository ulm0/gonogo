<script setup lang="ts">
// The top of each docs/expose/<provider>.md: what `gonogo expose <provider>` prints (the flags, who can open it, what the provider sees) and what
// `gonogo expose check` says afterwards. Static: the same words the command prints (test/expose.test.ts keeps the pages and the command together).
import '../landing/landing.css';
const props = defineProps<{ provider: 'tailscale' | 'funnel' | 'cloudflare' | 'caddy' | 'ngrok' }>();
const data = {
  tailscale: { who: 'only devices on your tailnet', sees: 'Tailscale does not decrypt the traffic', header: 'x-forwarded-for', name: 'gonogo.tailnet-name.ts.net' },
  funnel: { who: 'anyone who has the address', sees: 'Tailscale relay servers do not decrypt the traffic', header: 'x-forwarded-for', name: 'gonogo.tailnet-name.ts.net' },
  cloudflare: { who: 'anyone who has the address', sees: 'Cloudflare ends the TLS and sees every password, cookie, TOTP code and terminal byte', header: 'cf-connecting-ip', name: 'gonogo.example.com' },
  caddy: { who: 'anyone who has the address', sees: 'Caddy ends the TLS on your own machine: nobody else sees the traffic', header: 'x-forwarded-for', name: 'gonogo.example.com' },
  ngrok: { who: 'anyone who has the address', sees: 'ngrok ends the TLS and sees every password, cookie, TOTP code and terminal byte', header: 'x-forwarded-for', name: 'gonogo.example.ngrok.app' },
} as const;
const d = data[props.provider];
</script>

<template>
  <div class="module lp-visual ex" role="img" :aria-label="`gonogo expose ${provider}: ${d.who} can open it; ${d.sees}. Then gonogo expose check: seven lines pass.`">
    <span class="label">gonogo expose {{ provider }}</span>
    <span class="lcd ex-lcd">Who can open it: {{ d.who }}
What the provider sees: {{ d.sees }}.
Start gonogo with:
  gonogo --allow-host {{ d.name }} --public-url https://{{ d.name }} --trusted-proxy 127.0.0.1 --client-ip-header {{ d.header }}</span>
    <span class="label">gonogo expose check</span>
    <span class="lcd ex-lcd">pass  TLS: the address is https and answered
pass  reached gonogo (login: account)
pass  the Host gonogo sees is the public name
pass  /api/state answers 401 with no credential
pass  the old local token gets 401 through the public address
pass  /hook is 404 off this machine
pass  a WebSocket upgrade with no credential answers 401</span>
  </div>
</template>

<style scoped>
.ex { display: grid; gap: 8px; }
.ex-lcd { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
</style>
