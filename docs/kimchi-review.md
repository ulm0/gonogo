# Review: Kimchi (getkimchi/kimchi)

By FIDO, 2026-11-18, task t33c. Read only: a shallow clone read as text, nothing run or installed. I read the README, LICENSE, NOTICE, CLA and
the titles and first lines of its `docs/` (teleport, pr-watch, pr-cost-reporting, work-attribution, bash-tool-guard, ferment-v2, model-routing). I did
**not** read its source code, so what is below is what its documents say, not what the code does.

## What it is

A **coding agent CLI** for CAST AI's inference service, built on the pi-mono agent SDK. Not a room of agents: one agent per terminal that can
call subagents. Its own models (kimi, minimax, nemotron) and any `provider/model`. Install script, brew, a console at kimchi.dev.

**License: Apache-2.0** (CAST AI Group), with a NOTICE and a **CLA** (contributions are licensed to CAST AI). Apache would allow reuse with
notice, but a CLA project means we should not copy code in, and we do not. Ideas and behaviour only.

## Features and a verdict for gonogo

| Kimchi feature | Take? | Why |
|---|---|---|
| **Model roles** (orchestrator, planner, builder, reviewer, explorer, researcher; a pool per role with tier and description) | **Yes, small** | gonogo has 15 positions and, since PR E, a default model per engine. A **default model per position** (a reviewer on a cheaper or stronger model than a builder) is a tiny extension: one more lookup in the launcher. The "orchestrator picks from a pool by tier" part: no, FLIGHT already staffs by hand and Relief asks the Director. |
| **Phase and tag attribution** (every request tagged `phase`, `model`, user tags, for cost) | **Yes, small** | The cost ledger (PR C) is per agent and model. Adding the **mission and task** of the agent at the time (`missionId`, from Flight Plan `doing`) turns "$12 spent" into "$12 on Mission ms3". Read at the meter, no new file. |
| **Objective with a token budget and an independent evaluator** (Ferment V2: `--tokens 50k`, a tool-free judge says met / impossible / continue; pauses after N unchanged turns or errors) | **Partly** | The budget per mission is a good fit for Missions plus the dollar budget (a budget on a mission, enforced through Redline's existing trip). The automatic **judge** is not: gonogo's judge is the independent reviewer and the Director's GO; a model grading its own room's work is another spend and another thing to trust. Loop and error pauses are what Redline already does. |
| **Cross-session project plan** (Ferment: goal, phases, steps in JSON) | No | Flight Plan, Plot Board and Missions are that. |
| **PR watch** (poll CI of a PR every 30 s and fix failures) | Later, maybe | Relay already turns a GitHub `workflow_run` into a message to an agent. Polling the API needs a token gonogo does not hold. |
| **Teleport** (cloud sandboxes, rsync, tabbed sessions) | No | Their cloud service. Clean Room is our sandbox, on the owner's machine. |
| **PR cost reporting / work attribution** (uploads work and cost per PR to the Kimchi console; the installer adds plugins to Claude Code and Codex to report their work) | **No** | Telemetry to a vendor, and modifying other tools' config. Against gonogo's rules: nothing leaves the machine unasked, gonogo writes nothing into other CLIs' settings. Only the idea of local per-PR cost is of interest (the mission attribution above). |
| **PII redaction, project trust, bash-tool guard** (steer the model off `nohup`/`&`) | No | The guard is a prompt tweak to their own tool loop; gonogo's agents run the vendor CLI with its own guards. Project trust: Clearance and permission modes cover it. |
| **Hooks, MCP adapter, skills autoload, ACP, memory extension, auto-update** | No | gonogo already has hooks and MCP in the launcher, the Mission Log as memory, Rollout for updates. ACP (a protocol for editors) could matter for a future engine adapter; not now. |
| **Tabbed TUI with a status line and `ctrl+p` model cycling** | Idea only | Feeds the `gonogo tui` spec (`docs/tui-spec.md`): one-key model/state glyphs in the roster. |

## What to build from this (all small, none in a PR yet)

1. Default model per position (extends `models.json`: `{ positions: { reviewer: 'sonnet' } }`; the agent's own model still wins).
2. Cost attribution to the agent's current mission and task (a field on the ledger line, shown in the Missions view).
3. A budget on a mission (dollars or tokens) that trips through Redline.

Left out on purpose: any upload or telemetry, a router that chooses models by itself, an automatic judge, cloud sandboxes.
