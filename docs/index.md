---
layout: home

hero:
  name: gonogo
  text: Mission control for coding agents, in a browser tab
  tagline: One Node process starts each agent as a real claude (or another CLI) in a terminal, shows the terminals and a room of consoles in the browser (it works on a phone), and lets the agents message each other. Closing the tab stops nothing. One person per installation.
  image:
    light: /lockup.svg
    dark: /lockup-dark.svg
    alt: gonogo
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: GitHub
      link: https://github.com/ulm0/gonogo

features:
  - title: Room
    details: Consoles, a wall, a Brief box, go/no-go polls, FLIGHT the boss.
    link: /guide/the-room
  - title: Guard rails
    details: Redline (stops loops and error storms), Propellant (token budgets), Clean Room (a container per agent).
    link: /features/redline
  - title: Work in
    details: Launch Window (schedules), Uplink (webhooks), Relay (Slack, GitHub, Linear, Telegram), Flight Plan (tasks), Downlink (inbox).
    link: /features/launch-window
  - title: Shared
    details: Mission Log (memory with search), Payload (MCP servers and skills), Engine Bay (Gemini, Codex and other CLIs, not yet tried against a model).
    link: /features/mission-log
  - title: Look and links
    details: Livery (themes), Docking (two installations message each other and hand off tasks).
    link: /features/livery
---

## Quick start

Needs Node 24+, macOS or Linux (glibc), and `claude` on your `PATH`, signed in. Not published to the npm registry or as an image yet, so build from a clone with [pnpm](https://pnpm.io/) (`corepack enable pnpm` gives you the release `package.json` pins):

```sh
git clone https://github.com/ulm0/gonogo.git && cd gonogo
pnpm install && pnpm build && pnpm start
```

It prints `gonogo ready: http://127.0.0.1:7777/#token=...`. Open that URL. The token after the `#` is your password, and the server runs shells as you. State lives in `~/.gonogo`. Keep the port on `127.0.0.1`; to use it from another device or take webhooks, read [Exposing gonogo safely](./https.md). The long form is in [Getting started](./guide/getting-started.md), and Docker in [Running in Docker](./guide/docker.md).

License: MIT, see [`LICENSE`](https://github.com/ulm0/gonogo/blob/main/LICENSE). The licences of the libraries bundled into the browser client (React, xterm.js and their dependencies) are in `dist/client/THIRD-PARTY-NOTICES.md` of the package.
