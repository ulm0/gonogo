# Amazon Bedrock facts (checked 2026-11-18)

Verdict: **read from the vendors' docs and checked against gonogo's code; no engine was run against Bedrock, no AWS call was
made, and no AWS profile or credential of this host was read** (owner rule: never the profile `pi`). Tests: `test/bedrock.test.ts`.

## What each engine's docs say

| Engine | Bedrock | How (from its docs) | Source |
|---|---|---|---|
| Claude Code | yes | `CLAUDE_CODE_USE_BEDROCK=1`; region `AWS_REGION` (then `AWS_DEFAULT_REGION`, the profile's region, `us-east-1`); credentials by the AWS SDK chain: `AWS_PROFILE`, `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (+ `AWS_SESSION_TOKEN`), or `AWS_BEARER_TOKEN_BEDROCK` (a Bedrock API key; when set, the chain is not used). Model: `ANTHROPIC_MODEL` or `--model` with a Bedrock id or an inference-profile ARN; pin the aliases with `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`; `ANTHROPIC_BEDROCK_REGION_PREFIX` picks `us`/`eu`/`apac`/`global`. No `/login` needed; WebSearch is not available on Bedrock. Mantle endpoint: `CLAUDE_CODE_USE_MANTLE=1`. | code.claude.com/docs/en/amazon-bedrock |
| opencode | yes | A provider `amazon-bedrock`; it appears when `AWS_PROFILE`, `AWS_ACCESS_KEY_ID`, a web-identity token file or a container credential URI is set (a region alone does not). `AWS_BEARER_TOKEN_BEDROCK` for an API key; region `AWS_REGION`, then `AWS_DEFAULT_REGION`, then `us-east-1`. Model is picked in opencode itself. | opencode.ai/docs/providers |
| Codex | yes | Built-in provider: `model_provider = "amazon-bedrock"` in `config.toml`, optional `[model_providers.amazon-bedrock.aws]` with `profile` and `region` (the only overrides); else `AWS_PROFILE` and the SDK chain. Do not set `OPENAI_API_KEY` for it. Minimum version: 0.124.0 or 0.128.0, the sources disagree. | help.openai.com article 20001253; developers.openai.com/codex/config-advanced |
| pi | yes | Provider `amazon-bedrock`: `AWS_PROFILE`, or the key pair (+ `AWS_SESSION_TOKEN`), or `AWS_BEARER_TOKEN_BEDROCK`; `AWS_REGION`. How to pick the provider on the command line is not in its Bedrock section (the docs show `--model azure/gpt-5.4` for another provider, so `--model amazon-bedrock/<id>` is likely, **not verified**). | docs.pi.dev/latest/providers |
| Crush | yes | `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, `AWS_BEARER_TOKEN_BEDROCK`, `AWS_PROFILE`, `AWS_REGION`; a key typed in Crush wins, then the bearer variable, then the SDK chain. From mirrors of its README and a commit, not the repository. | README mirrors, crush commit eaa9a4a |
| Gemini CLI, Antigravity CLI | no | Google's models only (Gemini API, Vertex AI). Nothing about Bedrock was found; not searched beyond that. | — |
| Qwen Code, Grok CLI, Kimi CLI, Copilot CLI, Cursor Agent | not found | No Bedrock provider was found; not checked in depth. | — |
| Custom command | whatever it is | gonogo passes the environment and nothing else. | — |

## What gonogo does with it (code checked)

- **Environment.** `buildChildEnv` removes only the session identity of a `claude` that started gonogo and `GONOGO_TOKEN`/`GONOGO_API_KEY`. `AWS_*`, `CLAUDE_CODE_USE_BEDROCK` and `ANTHROPIC_*` pass through (the test fixture of `launcher.test.ts` already had `CLAUDE_CODE_USE_BEDROCK`). `GONOGO_SCRUB_ENV` can remove any of them for all agents; an agent's own key still comes back.
- **Clearance.** None of the Bedrock names is reserved: they are valid key names, and the longest value (a session token) fits the 4096 limit. A key works for every engine. The hire form now suggests the Bedrock names.
- **Seed mode** (`IS_DEMO=1`) only moves `ANTHROPIC_API_KEY`; it does not touch Bedrock. Whether the startup of a real `claude` with `IS_DEMO=1` and Bedrock shows no dialog is **not verified**.
- **Clean Room.** The container gets `HOME` of its own, the worktree and the agent's folder, and the variables **named** for it: gonogo's few, `CLAUDE_CODE_OAUTH_TOKEN`, and the agent's Clearance keys. So Bedrock works there with keys (`CLAUDE_CODE_USE_BEDROCK`, `AWS_REGION`, `AWS_BEARER_TOKEN_BEDROCK` or the key pair, `ANTHROPIC_MODEL`), and **not** with the owner's shell variables or `~/.aws` / an SSO profile. `~/.aws` is deliberately not mounted: a sandboxed agent that can read it could use every profile on the host. Prefer a short-term Bedrock API key (up to 12 hours) in a Clean Room. The container needs network access to `bedrock-runtime.<region>.amazonaws.com`.
- **Model field.** A Bedrock id (`us.anthropic.claude-sonnet-4-6`, `anthropic.claude-sonnet-4-5-20250929-v1:0`) and an application-inference-profile ARN pass `MODEL_PATTERN` (letters, digits, `. _ : / @ + -`, 100 characters). A system inference-profile ARN is about 105 characters and does not fit: use `ANTHROPIC_MODEL` as a key. With no agent model and no room default gonogo passes no `--model`, so `ANTHROPIC_MODEL` and the pins apply.
- **Cost.** Tokens are counted as for any Claude (the transcript's usage lines). Dollars: the built-in rows match only first-party ids, so a Bedrock id is **unpriced** until you add a row (prefixes, longest wins) in the price table, for example `us.anthropic.claude-sonnet-4-6`. gonogo does not guess: Bedrock's own prices can differ from the first-party list (regional endpoints and service tiers). What string a Bedrock transcript holds in `message.model` is **not verified**; a row works with whatever it is.
- **Engine start.** No engine's argv or env mentions Bedrock; opencode's `OPENCODE_CONFIG` file holds only the gonogo MCP server, so the owner's provider config still applies. Codex gets `-c` overrides for MCP only, so `model_provider` from the owner's `config.toml` stays.

## What a real check needs (from the Director)

1. An AWS account with Bedrock model access for one Anthropic model (the one-time use-case form) in a region, and an IAM identity that may `bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream`, `bedrock:ListInferenceProfiles`, `bedrock:GetInferenceProfile`.
2. One of: a **short-term Bedrock API key** (simplest, no profile on the host), or an access key pair with a session token. Not a profile found on this host.
3. The region and one model id or profile (for example `us.anthropic.claude-haiku-4-5-20251001-v1:0`, cheapest).
4. Then, with a recent `claude`: hire an agent with keys `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_REGION`, `AWS_BEARER_TOKEN_BEDROCK`, `ANTHROPIC_MODEL`; expect a reply, a `fuel.jsonl` line with the Bedrock model string, and `unpriced` in dollars. Repeat in a Clean Room (docker). opencode/Codex/pi need their own install and the settings above.
