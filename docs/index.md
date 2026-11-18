---
# A placeholder: the landing page replaces this home.
layout: home

hero:
  name: gonogo
  text: Mission control for coding agents, in a browser tab
  tagline: One Node process starts each agent as a real claude (or another CLI) in a terminal, shows the terminals and a room of consoles in the browser (it works on a phone), and lets the agents message each other. Closing the tab stops nothing. One person per installation.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: GitHub
      link: https://github.com/ulm0/gonogo
---

## Quick start

Needs Node 24+, macOS or Linux (glibc), and `claude` on your `PATH`, signed in. With [pnpm](https://pnpm.io/), from the npm registry (the package is `@ulm0/gonogo`; the unscoped `gonogo` there is another project):

```sh
pnpm dlx @ulm0/gonogo
# or install the gonogo command: pnpm add -g @ulm0/gonogo && gonogo
```

Or build from a clone (`corepack enable pnpm` gives you the release `package.json` pins):

```sh
git clone https://github.com/ulm0/gonogo.git && cd gonogo
pnpm install && pnpm build && pnpm start
```

It prints `gonogo ready: http://127.0.0.1:7777/#token=...`. Open that URL. The token after the `#` is your password, and the server runs shells as you. State lives in `~/.gonogo`. Keep the port on `127.0.0.1`; to use it from another device or take webhooks, read [Exposing gonogo safely](./https.md). The long form is in [Getting started](./guide/getting-started.md), and Docker in [Running in Docker](./guide/docker.md).

License: MIT, see [`LICENSE`](https://github.com/ulm0/gonogo/blob/main/LICENSE). The licences of the libraries bundled into the browser client (React, xterm.js and their dependencies) are in `dist/client/THIRD-PARTY-NOTICES.md` of the package.
