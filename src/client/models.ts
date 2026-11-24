/**
 * Default models (docs/engine-bay-spec.md): what the page knows about the room's model per engine. No React here but the hook.
 * A console's own model wins; the room's applies when it has none, at the next start.
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { CleanRoomFlavor, EngineModels, ModelDefaults, Provider } from '../shared/protocol.js';
import { PROVIDERS, providerInfo } from '../shared/protocol.js';
import { effectiveModel as startModel } from '../shared/details.js';
import * as api from './api.js';

/** The engines with a model field, in the order the page lists them. */
export const MODEL_PROVIDERS: readonly Provider[] = PROVIDERS.filter((p) => providerInfo(p).model !== null);

/** The model a console runs with: its own, else the room's, else null (the CLI's own default). */
export function effectiveModel(own: string | null | undefined, defaults: ModelDefaults | null, provider: Provider): { model: string; from: 'console' | 'room' } | null {
  const mine = own?.trim();
  if (mine) return { model: mine, from: 'console' };
  const room = defaults?.models[provider];
  return room ? { model: room, from: 'room' } : null;
}

/** What the model field says under it: where the value comes from, and that a `/model` typed in the console is not kept. */
export function modelNote(own: string | null | undefined, defaults: ModelDefaults | null, provider: Provider, label: string, position: string | null = null): string {
  // the position's default (Claude Code) comes before the room's, as at the start (shared/details.ts)
  const eff = startModel({ model: own?.trim() || null, provider, position }, defaults);
  const where = eff === null ? `Empty: ${label} uses its own default.` : eff.from === 'console' ? `This console runs ${eff.name}.` : `Empty: the ${eff.from === 'position' ? "position's" : "room's"} default ${eff.name} applies.`;
  return `${where} A /model typed inside the console only changes that session: set it here to keep it.`;
}

/* The room's defaults are asked once for the whole page and shared: the hire form and every chip on the page read the same copy, and the
   settings block publishes a change so that they follow it. They are not in a frame, so another browser's change shows at the next load. */
let shared: ModelDefaults | null = null;
let asked = false;
const listeners = new Set<() => void>();

/** The settings block saved a change: every reader gets it. */
export function publishModelDefaults(next: ModelDefaults): void {
  shared = next;
  listeners.forEach((l) => l());
}

/** Forgets the copy (a test, or a new connection to another server). */
export function resetModelDefaults(): void {
  shared = null;
  asked = false;
  listeners.forEach((l) => l());
}

/** The room's defaults; null until they come (or if the server cannot say). */
export function useModelDefaults(): ModelDefaults | null {
  useEffect(() => {
    if (asked) return;
    asked = true;
    api.modelDefaults().then(publishModelDefaults, () => {
      asked = false;
    });
  }, []);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => shared,
    () => shared,
  );
}

/** The Clean Room flavors as a person reads them, with the runtime each needs. */
export const FLAVOR_TEXT: Readonly<Record<CleanRoomFlavor, string>> = { docker: 'Docker (runc)', gvisor: 'gVisor (runsc)', microvm: 'microVM (Kata)' };

/* Model lists (docs/engine-bay-spec.md): what each engine offers, asked of the server once per engine for the whole page and shared,
   like the defaults above. The hire form, the Edit form and the DEFAULTS block read the same copy; REFRESH asks the program again. */
export type EngineModelsState = { state: 'loading' } | { state: 'ready'; list: EngineModels } | { state: 'failed'; error: string };
const modelLists = new Map<Provider, EngineModelsState>();
const modelListeners = new Set<() => void>();
const LOADING: EngineModelsState = { state: 'loading' };

/** Asks the server for one engine's models (again with `refresh`); every reader follows. */
export function loadEngineModels(provider: Provider, refresh = false): Promise<void> {
  const before = modelLists.get(provider);
  if (!refresh && before !== undefined) return Promise.resolve();
  modelLists.set(provider, LOADING);
  modelListeners.forEach((l) => l());
  return api.engineModels(provider, refresh).then(
    (list) => {
      modelLists.set(provider, { state: 'ready', list });
      modelListeners.forEach((l) => l());
    },
    (e: unknown) => {
      modelLists.set(provider, { state: 'failed', error: e instanceof Error ? e.message : String(e) });
      modelListeners.forEach((l) => l());
    },
  );
}

/** Forgets every list (a test, or a new connection to another server). */
export function resetEngineModels(): void {
  modelLists.clear();
  modelListeners.forEach((l) => l());
}

/** The names a model field offers: the engine's real list when it came, else the names PROVIDER_INFO suggests. */
export function modelNames(provider: Provider, state: EngineModelsState): readonly string[] {
  return state.state === 'ready' ? state.list.models : (providerInfo(provider).model ?? []);
}

/** One engine's models; asks for them the first time any reader wants them. null provider: none asked. */
export function useEngineModels(provider: Provider | null): EngineModelsState {
  useEffect(() => {
    if (provider !== null && providerInfo(provider).model !== null) void loadEngineModels(provider);
  }, [provider]);
  return useSyncExternalStore(
    (l) => {
      modelListeners.add(l);
      return () => modelListeners.delete(l);
    },
    () => (provider === null ? LOADING : (modelLists.get(provider) ?? LOADING)),
    () => (provider === null ? LOADING : (modelLists.get(provider) ?? LOADING)),
  );
}

/** What the line under a model field says about the list: where the names come from, or why there are none. */
export function modelListText(provider: Provider, state: EngineModelsState): string {
  const label = providerInfo(provider).label;
  if (state.state === 'loading') return `Loading the models of ${label}…`;
  if (state.state === 'failed') return `Could not ask the server for the models of ${label}: ${state.error}. Type a name.`;
  const list = state.list;
  const n = list.models.length;
  const count = `${n} ${n === 1 ? 'model' : 'models'}`;
  switch (list.source) {
    case 'cli':
      return `${n === 0 ? `${list.command ?? label} listed no models: is a provider signed in? Type a name.` : `${count} from ${list.command ?? label}${list.version ? ` (${list.version})` : ''}. Pick one or type any name it accepts.`}${provider === 'opencode' && n > 0 ? ` ${OPENCODE_KEY_NOTE}` : ''}`;
    case 'static':
      return n === 0 ? `${label} has no command that lists its models: type a name.` : `${label} has no command that lists its models; names it knows: ${list.models.join(', ')}. Any name it accepts works.`;
    case 'missing':
      return `${label} is not installed here (${providerInfo(provider).bin} is not on the PATH): type a name.`;
    case 'error':
      return `Could not read the list (${list.command ?? label}: ${list.error ?? 'no answer'}). Type a name.`;
  }
}

/** Puts a list in the page's copy as if the server had sent it (a test, or a page that already has one). */
export function publishEngineModels(provider: Provider, list: EngineModels): void {
  modelLists.set(provider, { state: 'ready', list });
  modelListeners.forEach((l) => l());
}

/**
 * opencode: the key names a provider's models need (models.dev, opencode 2.4.1's catalog, read 2026-11-24). An opencode agent keeps its own
 * opencode data in its folder, so the owner's opencode sign-in does not reach it: without one of these keys (or a Clean Room's egress for
 * Anthropic) the agent has no model and asks the Director (its free models stay off unless picked: opencodeFreeModels). opencode's own models (`opencode/...`) need none.
 */
export const OPENCODE_PROVIDER_KEYS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  google: ['GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  groq: ['GROQ_API_KEY'],
  xai: ['XAI_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  'amazon-bedrock': ['AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_PROFILE'],
  'github-copilot': ['GITHUB_TOKEN'],
};

/** The line under the opencode model list: which models need a key for the agent. */
export const OPENCODE_KEY_NOTE =
  "An opencode agent keeps its own opencode data, so your own opencode sign-in does not reach it: a model of another provider than opencode's own (anthropic/..., openai/...) needs that provider's key for the agent (Keys below or the room's keys, such as ANTHROPIC_API_KEY), or for Anthropic a Clean Room with egress. Without it the agent stops and asks you: gonogo keeps opencode's free models off unless you pick one (opencode/...).";

/**
 * A warning for an opencode agent about to start with `model`: its provider needs a key the agent will not have. `keys` are the key names it
 * will get (its own and the room's that reach it); `egress` is a Clean Room whose Anthropic key is held by gonogo's proxy. null: no warning
 * (no model, opencode's own, a key is there). A key in gonogo's own environment is not seen here, so the text says it may still be there.
 */
export function opencodeKeyWarning(model: string, keys: readonly string[], egress: boolean): string | null {
  const slash = model.indexOf('/');
  if (slash <= 0) return null;
  const provider = model.slice(0, slash);
  if (provider === 'opencode') return null;
  if (provider === 'anthropic' && egress) return null;
  const wanted = OPENCODE_PROVIDER_KEYS[provider];
  if (wanted !== undefined && wanted.some((name) => keys.includes(name))) return null;
  const which = wanted === undefined ? `the API key of ${provider}` : wanted.length === 1 ? (wanted[0] ?? '') : `one of ${wanted.join(', ')}`;
  return `${model} needs ${which} for this agent, and it has none among its keys or the room's${provider === 'anthropic' ? ' (a Clean Room with egress also works)' : ''}. Without it the agent stops at its first turn and asks you (unless gonogo's own environment has the key): opencode's free models stay off unless one is picked.`;
}

/** The AWS settings that give pi's and opencode's `amazon-bedrock` provider a credential (pi 1.6.0 `--help`, opencode's provider docs). */
const AWS_CREDENTIAL_KEYS = ['AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_BEARER_TOKEN_BEDROCK'] as const;
/** A credential that works without the host's `~/.aws` (a Clean Room has none): a key pair or a Bedrock API key. */
const AWS_SELF_CONTAINED_KEYS = ['AWS_ACCESS_KEY_ID', 'AWS_BEARER_TOKEN_BEDROCK'] as const;

/**
 * Amazon Bedrock with pi or opencode (t144): both read the AWS settings only for their `amazon-bedrock` provider, so a room set up for Bedrock
 * (AWS_PROFILE and AWS_REGION as room keys) with an `anthropic/...` model fails with "No API key found for anthropic" (pi 1.6.0, seen by the
 * Director). A warning for the model an agent starts with, or null: `keys` are the key names it gets (its own and the room's that reach it);
 * gonogo's own environment is not seen here. opencode's other cases (no key at all) are opencodeKeyWarning's.
 */
export function bedrockModelWarning(provider: Provider, model: string, keys: readonly string[], cleanRoom: boolean): string | null {
  if (provider !== 'pi' && provider !== 'opencode') return null;
  const label = providerInfo(provider).label;
  const slash = model.indexOf('/');
  const vendor = slash > 0 ? model.slice(0, slash) : '';
  const aws = AWS_CREDENTIAL_KEYS.filter((name) => keys.includes(name));
  if (model === '' && aws.length > 0 && !keys.includes('ANTHROPIC_API_KEY')) return `The keys set up Amazon Bedrock (${aws.join(', ')}), and with no model ${label} picks its own default, which may not be one of Bedrock's: pick an amazon-bedrock/... model from the list.`;
  if (vendor === 'anthropic' && aws.length > 0 && !keys.includes('ANTHROPIC_API_KEY') && !keys.includes('ANTHROPIC_OAUTH_TOKEN')) {
    return `The keys set up Amazon Bedrock (${aws.join(', ')}), but ${model} is Anthropic's own API: ${label} reads the AWS settings only for its amazon-bedrock provider. Pick an amazon-bedrock/... model from the list (for example amazon-bedrock/anthropic.claude-...); with ${model} the agent needs its own Anthropic sign-in or ANTHROPIC_API_KEY, or it stops with "No API key found for anthropic".`;
  }
  if (vendor !== 'amazon-bedrock') return null;
  if (cleanRoom && aws.length > 0 && !AWS_SELF_CONTAINED_KEYS.some((name) => keys.includes(name))) {
    return 'In a Clean Room AWS_PROFILE does not work: the container has no ~/.aws (on purpose). Give this agent AWS_BEARER_TOKEN_BEDROCK (a short-term Bedrock API key) or AWS_ACCESS_KEY_ID with AWS_SECRET_ACCESS_KEY (and AWS_SESSION_TOKEN).';
  }
  if (provider === 'pi' && aws.length === 0) {
    return `${model} needs an AWS credential for this agent: AWS_PROFILE, AWS_ACCESS_KEY_ID with AWS_SECRET_ACCESS_KEY, or AWS_BEARER_TOKEN_BEDROCK, with AWS_REGION, among its keys or the room's (unless gonogo's own environment has them).`;
  }
  return null;
}
