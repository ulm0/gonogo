/**
 * Model lists (docs/engine-bay-spec.md): the models an installed engine offers, read from the program itself where it has a command
 * for it, so that the hire form, the Edit form and the room's defaults can offer real names instead of guesses.
 *
 * - pi: `pi --list-models` prints a table (provider, model, ...); the names are `provider/model`, which pi's `--model` takes.
 * - opencode: `opencode models --standalone` prints one `provider/model` per line. `--standalone` runs a private server that ends with
 *   it: without it opencode starts (or joins) its background service, which outlives the call and writes into its config folder.
 * - every other engine has no listing command that was checked: the names PROVIDER_INFO suggests (`static`).
 *
 * No shell, a time limit, the process group killed at the end, and an environment of PATH, HOME, LANG, NO_COLOR and the XDG folders only
 * (where both programs keep their sign-in), so no key of gonogo's environment reaches a program that is merely asked for a list.
 * Shortcut: a provider an engine knows only through an API key in the environment is therefore not listed; its model is typed.
 * A list is remembered per engine until the program changes (path, modification time, version) or the page asks for a refresh.
 */
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { MODEL_PATTERN, PROVIDER_INFO } from '../shared/protocol.js';
import type { EngineModels, Provider } from '../shared/protocol.js';
import { findOnPath, versionOf } from './providers.js';

/** How long one listing may take. opencode answered in 1.6 s and pi in under 1 s here (2.4.1 and 1.6.0); a first opencode run fetches its catalog. */
export const MODEL_LIST_MS = 20_000;
/** Most output read from a listing, and most names kept. */
export const MODEL_LIST_BYTES = 2 * 1024 * 1024;
export const MODEL_LIST_MAX = 1000;
/** A failed listing is asked again after this, or at once on a refresh. */
export const MODEL_LIST_RETRY_MS = 30_000;

const MODEL_RE = new RegExp(MODEL_PATTERN);

interface Lister {
  args: readonly string[];
  parse(stdout: string): string[];
}

/** pi 1.6.0: a header `provider model context ...`, then one row per model; anything before the header (a warning) is not a row. */
export function parsePiModels(stdout: string): string[] {
  const lines = stdout.split('\n');
  const header = lines.findIndex((l) => /^\s*provider\s+model\b/.test(l));
  if (header < 0) return [];
  return lines.slice(header + 1).flatMap((line) => {
    const [provider, model] = line.trim().split(/\s+/);
    return provider && model ? [`${provider}/${model}`] : [];
  });
}

/** opencode 2.4.1: one `provider/model` per line. */
export function parseOpencodeModels(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[^\s/]+\/\S+$/.test(l));
}

export const MODEL_LISTERS: Partial<Record<Provider, Lister>> = {
  pi: { args: ['--list-models'], parse: parsePiModels },
  opencode: { args: ['models', '--standalone'], parse: parseOpencodeModels },
};

/** Names that pass the model field's own check, once each, in their order, at most MODEL_LIST_MAX. */
const clean = (names: readonly string[]): string[] => [...new Set(names.filter((n) => MODEL_RE.test(n)))].slice(0, MODEL_LIST_MAX);

/** The environment a listing gets: no keys, the folders where the engines keep their sign-in. */
export function listEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = { NO_COLOR: '1' };
  for (const name of ['PATH', 'HOME', 'LANG', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) {
    const value = env[name];
    if (value !== undefined && value !== '') out[name] = value;
  }
  return out;
}

/** Runs `file args` in its own process group and gives its standard output; the group is killed when it ends or runs out of time. */
export function runListing(file: string, args: readonly string[], env: Record<string, string>, timeoutMs = MODEL_LIST_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], { env, cwd: env.HOME ?? tmpdir(), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const out: Buffer[] = [];
    let size = 0;
    let err = '';
    let settled = false;
    const killGroup = (): void => {
      try {
        if (child.pid !== undefined && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // already gone
      }
    };
    const finish = (fail: Error | null, text = ''): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup();
      if (fail) reject(fail);
      else resolve(text);
    };
    const timer = setTimeout(() => finish(new Error(`no answer in ${timeoutMs / 1000} s`)), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MODEL_LIST_BYTES) return finish(new Error('the list is too long'));
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (err.length < 4096) err += chunk.toString('utf8');
    });
    child.on('error', (e) => finish(e));
    child.on('close', (code) => {
      const text = Buffer.concat(out).toString('utf8');
      if (code === 0) return finish(null, text);
      const line = err.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? `exit code ${String(code)}`;
      finish(new Error(line.slice(0, 200)));
    });
  });
}

export interface EngineModelLists {
  /** The models of one engine; `refresh` asks the program again even when a list is remembered. */
  get(provider: Provider, refresh?: boolean): Promise<EngineModels>;
}

export function createEngineModelLists(options: { env: Record<string, string | undefined>; now?: () => number; run?: typeof runListing }): EngineModelLists {
  const now = options.now ?? Date.now;
  const run = options.run ?? runListing;
  const cache = new Map<Provider, { key: string; value: EngineModels }>();
  const pending = new Map<Provider, Promise<EngineModels>>();

  const read = async (provider: Provider, refresh: boolean): Promise<EngineModels> => {
    const info = PROVIDER_INFO[provider];
    const hints = [...(info.model ?? [])];
    const lister = MODEL_LISTERS[provider];
    const path = findOnPath(info.bin, options.env.PATH);
    if (path === null) {
      cache.delete(provider);
      return { provider, source: 'missing', models: hints, command: null, version: null, at: now() };
    }
    const version = await versionOf(path, options.env).catch(() => null);
    let mtime = 0;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      // gone between the two looks: asked anyway
    }
    const key = `${path}\0${mtime}\0${version ?? ''}`;
    const known = cache.get(provider);
    if (!refresh && known && known.key === key && (known.value.source !== 'error' || now() - known.value.at < MODEL_LIST_RETRY_MS)) return known.value;
    let value: EngineModels;
    if (!lister) {
      value = { provider, source: 'static', models: hints, command: null, version, at: now() };
    } else {
      const command = `${info.bin} ${lister.args.join(' ')}`;
      try {
        value = { provider, source: 'cli', models: clean(lister.parse(await run(path, lister.args, listEnv(options.env)))), command, version, at: now() };
      } catch (error) {
        value = { provider, source: 'error', models: hints, command, version, error: error instanceof Error ? error.message : String(error), at: now() };
      }
    }
    cache.set(provider, { key, value });
    return value;
  };

  return {
    get(provider, refresh = false) {
      const busy = pending.get(provider);
      if (busy) return busy;
      const job = read(provider, refresh).finally(() => pending.delete(provider));
      pending.set(provider, job);
      return job;
    },
  };
}
