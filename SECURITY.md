# Security policy

## Supported versions

Only the **latest release** gets security fixes: the newest `v*` tag on [GitHub Releases](https://github.com/ulm0/gonogo/releases), published as the npm package `@ulm0/gonogo`, the Docker image `ghcr.io/ulm0/gonogo` and the Homebrew formula. A fix ships as a new release; older releases are not patched. Update to the latest before you report, if you can.

## Reporting a vulnerability

Report it privately through GitHub: **[Security > Report a vulnerability](https://github.com/ulm0/gonogo/security/advisories/new)**.

**Never open a public issue, pull request or discussion for a vulnerability.**

Please include:

- the version (`gonogo --version`, or the image tag) and how it runs (npm, Docker, Homebrew; local only or reachable from a network; behind a proxy);
- what an attacker needs first (a network position, a login, an API key and its scope, an agent, a pull request, a Telegram chat…) and what they gain;
- steps to reproduce, or a proof of concept;
- any idea for a fix.

Do not include real secrets, tokens or other people's data. Test only against an install of your own.

## What to expect

gonogo is maintained by one person, so the times below are **best effort**, not a promise:

- an acknowledgement within a few days;
- a first assessment (accepted, needs more information, or not a vulnerability, with the reason) within about two weeks;
- a fix in a new release as soon as it is ready, prioritized by severity.

We follow **coordinated disclosure**: the report stays private in a draft GitHub Security Advisory while it is fixed, and the advisory is published with the release that fixes it, with a CVE when it warrants one. Please wait for that release before you disclose. You are **credited in the advisory** unless you ask not to be. There is **no bug bounty**.

## Scope

In scope: gonogo itself, meaning the server, the web page, the CLI, the Docker image, the npm package and the Homebrew formula, as published from this repository.

Out of scope:

- the engines gonogo runs and their own CLIs (Claude Code, pi, opencode and the others), the models, and MCP servers or other tools you add, unless gonogo itself makes them unsafe (for example by leaking a secret to them or widening what they may do);
- what an agent can do in a permission mode you chose, outside a Clean Room: it runs as your user (see the threat model);
- your own exposure choices, such as serving gonogo on a public address without a login or behind a proxy you configured; the page's banner warns about these;
- denial of service that needs a login or an API key with the full scope.

The threat model, what gonogo protects and what it does not, is in [docs/reference/security.md](docs/reference/security.md).
