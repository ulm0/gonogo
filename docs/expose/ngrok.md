# ngrok: public, the last choice

<ExposeMock provider="ngrok" class="doc-mock" />

**Who can open it:** anyone who has the address. **What ngrok sees:** it ends the TLS, so it can see every password, cookie, TOTP code and terminal byte that passes. Use it only when nothing above is possible.


Give gonogo the address, the name and the header the proxy sets, and start it (the login with its second factor must already be set up, or gonogo refuses to start on this name):

```
gonogo --allow-host gonogo.example.ngrok.app --public-url https://gonogo.example.ngrok.app --trusted-proxy 127.0.0.1 --client-ip-header x-forwarded-for
```

`gonogo expose ngrok --public-url https://gonogo.example.ngrok.app` prints exactly this and the steps below. It runs nothing and holds none of your provider logins.

Then, in order:

```
ngrok http --url=gonogo.example.ngrok.app http://127.0.0.1:7777
gonogo expose check
```

- Check `ngrok http --help` for your version: the flag for a fixed name has changed over time.
- Free-plan features, WebSocket support and any interstitial page were not read: `gonogo expose check` is the proof.

**Tried:** not run against the real service. The commands follow the provider's documentation as read on 2026-11-18; `gonogo expose check` is the proof for your setup.
