/**
 * Update from the page (docs/features/update.md): the Director's click installs one exact newer version, then hands over with a
 * live reload. Never on its own: there is no timer here, and the check that finds a newer version (Rollout) only shows a note.
 *
 * What it will run is fixed: `npm install -g @ulm0/gonogo@<x.y.z>` or `pnpm add -g @ulm0/gonogo@<x.y.z>`, where x.y.z is the
 * version the registry check named and the click repeated (anything else is refused), with a small environment and no shell.
 * A container cannot replace its own image: it only calls an update hook the owner configured (a Watchtower-style URL in
 * GONOGO_UPDATE_HOOK, optional bearer token GONOGO_UPDATE_HOOK_TOKEN); with none, the page shows the commands.
 */
import { execFile } from 'node:child_process';
import type { InstallKind, Logger, UpdateView } from '../shared/protocol.js';
import { nullLogger } from './constants.js';
import { checkPrevious, DockerUpdateError, pullAndCheck, readResult, startHelper, STABLE_VERSION } from './dockerupdate.js';
import type { DockerCall } from './dockerupdate.js';
import { installCommand } from './rollout.js';
import type { Rollout } from './rollout.js';

const STABLE = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const HOOK_TIMEOUT_MS = 15_000;
const HANDOFF_MS = 5 * 60_000;
const TAIL_LINES = 8;
const TAIL_LINE_CHARS = 200;

export class UpdateError extends Error {
  constructor(
    readonly code: 'bad_request' | 'conflict',
    message: string,
  ) {
    super(message);
    this.name = 'UpdateError';
  }
}

export interface RunResult {
  code: number | null;
  out: string;
}

export interface UpdaterOptions {
  kind: InstallKind;
  /** Where the installer runs: a private folder (<home>/run), never a shared one, so a planted .npmrc in /tmp is not read. */
  cwd: string;
  /** The version that runs now: the rollback goes back to it. */
  current: string;
  rollout: Pick<Rollout, 'view' | 'setUpdate'>;
  /** Runs one command without a shell; resolves with the exit code and the output, never rejects. */
  run?(file: string, args: string[]): Promise<RunResult>;
  /** Hands over to the installed gonogo; false when this process cannot (a test, an embedder). */
  reload(): boolean;
  /** The agents survive a reload (--pty-host): then the update reloads by itself; otherwise it stops after the install. */
  keepsAgents: boolean;
  hook: { url: string; token: string | null } | null;
  /** How long a handed-off update may wait for the helper before the page says it did not answer. Default 5 minutes. */
  handoffMs?: number;
  /** Docker self-update (docs/self-update-spec.md): the socket, the container's own hostname (its id) and gonogo's home; absent without the socket. */
  docker?: { call: DockerCall; hostname: string; home: string; ready: boolean; busy(): string | null | Promise<string | null> };
  fetch: typeof fetch;
  log?: Logger;
}

export interface Updater {
  /** Starts the update to `version` and returns at once with the state; the page follows through the rollout frames. */
  /** Starts the update; with Docker it first asks whether another room is busy, so the answer may take a moment. */
  start(version: unknown): UpdateView | Promise<UpdateView>;
  /** An update hook is set (a container). */
  hasHook(): boolean;
  /** Docker self-update: puts the previous image back, through the same helper. */
  undo(): Promise<UpdateView>;
}

/** The small environment the installer gets: where to find node and npm, and their own settings; none of gonogo's. */
export function installerEnv(from: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(from)) {
    if (value === undefined) continue;
    if (['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'SHELL'].includes(key) || /^(npm_config_|NPM_CONFIG_|PNPM_|COREPACK_)/.test(key)) out[key] = value;
  }
  return out;
}

const defaultRun = (cwd: string, file: string, args: string[]): Promise<RunResult> =>
  new Promise((resolve) => {
    execFile(file, args, { cwd, env: installerEnv(process.env), timeout: INSTALL_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : null;
      resolve({ code, out: `${stdout}\n${stderr}${error !== null && code === null ? `\n${error.message}` : ''}` });
    });
  });

/** The last lines of the installer's output, each cut, with control characters out. */
export function tailOf(out: string): string[] {
  return out
    .split('\n')
    // eslint-disable-next-line no-control-regex
    .map((line) => line.replace(/[\u0000-\u001f\u007f]/g, ' ').trim())
    .filter((line) => line !== '')
    .slice(-TAIL_LINES)
    .map((line) => (line.length > TAIL_LINE_CHARS ? `${line.slice(0, TAIL_LINE_CHARS - 1)}…` : line));
}

export function createUpdater(options: UpdaterOptions): Updater {
  const log = options.log ?? nullLogger;
  const run = options.run ?? ((file: string, args: string[]) => defaultRun(options.cwd, file, args));
  let handoff: NodeJS.Timeout | undefined;
  let asking = false;
  let state: UpdateView = { state: 'idle', version: null, note: '', tail: [], rollback: null };

  const set = (next: Partial<UpdateView>): UpdateView => {
    state = { ...state, ...next };
    options.rollout.setUpdate(state);
    return state;
  };

  async function install(version: string): Promise<void> {
    const command = installCommand(options.kind, version);
    const back = installCommand(options.kind, options.current);
    const rollback = back === null ? null : `${back.file} ${back.args.join(' ')}`;
    if (command === null) return;
    log.info(`updating to ${version}: ${command.file} ${command.args.join(' ')}`);
    const result = await run(command.file, command.args);
    const tail = tailOf(result.out);
    if (result.code !== 0) {
      const why = /EACCES|permission denied/i.test(result.out) ? ' The install folder is not writable by gonogo: run the command yourself, or change the npm prefix.' : '';
      log.warn(`the update to ${version} failed (${result.code ?? 'no exit code'})`);
      set({ state: 'failed', note: `The install of ${version} failed (exit ${result.code ?? 'none'}); the running version is unchanged.${why}`, tail, rollback: null });
      return;
    }
    if (options.keepsAgents && options.reload()) {
      set({ state: 'reloading', note: `Installed ${version}. Reloading: the agents keep running and the page reconnects in a moment.`, tail, rollback });
      return;
    }
    set({
      state: 'installed',
      note: options.keepsAgents ? `Installed ${version}, but this process cannot reload itself: run gonogo reload.` : `Installed ${version}. gonogo is not running with --pty-host, so a reload stops the agents and they resume: reload when you are ready (Flight Rules, or gonogo reload).`,
      tail,
      rollback,
    });
  }

  /** Pull, check the version label, start the helper; the helper then replaces this container, so what follows is the next process's. */
  async function dockerUpdate(version: string, image: 'pull' | { previous: string }): Promise<void> {
    const docker = options.docker;
    if (docker === undefined) return;
    try {
      let target: string;
      let inspect;
      if (image === 'pull') {
        const prepared = await pullAndCheck(docker.call, docker.hostname, version);
        target = prepared.image;
        inspect = prepared.inspect;
      } else {
        target = image.previous;
        const found = await docker.call('GET', `/containers/${encodeURIComponent(docker.hostname)}/json`);
        if (found.status !== 200) throw new DockerUpdateError('this container could not be found through the Docker socket');
        inspect = JSON.parse(found.text) as Record<string, unknown>;
      }
      log.info(`handing the update to ${version} to a helper container`);
      // UNDO runs the helper from the RUNNING image: the previous one may be too old to have `self-update`
      await startHelper(docker.call, { inspect, image: target, helperImage: image === 'pull' ? target : String(inspect.Image ?? ''), expect: version, home: docker.home });
      handoff = setTimeout(() => {
        if (state.state !== 'handed-off') return;
        set({ state: 'failed', version, note: `The update helper did not answer within ${Math.round((options.handoffMs ?? HANDOFF_MS) / 60000)} minutes: it may have died half way. Look at \`docker ps -a\` (a gonogo.helper container, and containers named like this one with -prev or -next) and \`docker logs\` of the helper; to bring gonogo back run \`docker compose up -d\` (or start the old container).`, tail: [], rollback: null });
      }, options.handoffMs ?? HANDOFF_MS);
      handoff.unref();
      set({ state: 'handed-off', version, note: `Started the update helper for ${version}. This container stops, the new one starts and must report healthy; the page reconnects when it does, and the result shows here.`, tail: [], rollback: null });
    } catch (error) {
      const note = error instanceof DockerUpdateError ? error.message : `the update could not start (${error instanceof Error ? error.message : 'error'})`;
      log.warn(`the Docker update to ${version} did not start: ${note}`);
      set({ state: 'failed', note: `${note}. Nothing was changed.`, tail: [], rollback: null });
    }
  }

  async function callHook(version: string): Promise<void> {
    const hook = options.hook;
    if (hook === null) return;
    try {
      const res = await options.fetch(hook.url, {
        method: 'POST',
        redirect: 'error',
        headers: hook.token === null ? {} : { authorization: `Bearer ${hook.token}` },
        signal: AbortSignal.timeout(HOOK_TIMEOUT_MS),
      });
      await res.body?.cancel().catch(() => undefined);
      if (res.ok) set({ state: 'hook-sent', note: `Asked the update hook to pull ${version}. If it updates this container, the page reconnects when the new one is up.`, tail: [], rollback: null });
      else set({ state: 'failed', note: `The update hook answered ${res.status}; nothing was updated.`, tail: [], rollback: null });
    } catch (error) {
      set({ state: 'failed', note: `The update hook could not be reached (${error instanceof Error ? error.name : 'error'}); nothing was updated.`, tail: [], rollback: null });
    }
  }

  return {
    hasHook: () => options.hook !== null,
    async undo() {
      const docker = options.docker;
      if (docker === undefined || !docker.ready) throw new UpdateError('conflict', 'UNDO needs the Docker socket');
      if (state.state === 'running' || state.state === 'handed-off') throw new UpdateError('conflict', 'an update is already in progress');
      const busy = await docker.busy();
      if (busy !== null) throw new UpdateError('conflict', busy);
      const last = await readResult(docker.home);
      if (last === null || last.state !== 'ok' || last.previousImage === '' || !STABLE_VERSION.test(last.from)) throw new UpdateError('conflict', 'there is no update to undo');
      try {
        await checkPrevious(docker.call, docker.hostname, last);
      } catch (error) {
        throw new UpdateError('conflict', error instanceof Error ? error.message : 'the previous image could not be checked');
      }
      const started = set({ state: 'running', version: last.from, note: `Putting ${last.from} back…`, tail: [], rollback: null });
      void dockerUpdate(last.from, { previous: last.previousImage });
      return started;
    },
    start(version) {
      const seen = options.rollout.view();
      if (!seen.enabled) throw new UpdateError('conflict', 'the update check is off (GONOGO_UPDATE_CHECK): gonogo does not update itself');
      if (typeof version !== 'string' || !STABLE.test(version)) throw new UpdateError('bad_request', 'version must be a release number like 1.2.3');
      if (!seen.newer || seen.latest !== version) throw new UpdateError('conflict', `${version} is not the newer version the check found${seen.latest === null ? '' : ` (${seen.latest})`}`);
      if (state.state === 'running' || state.state === 'reloading' || state.state === 'handed-off') throw new UpdateError('conflict', 'an update is already in progress');
      if (options.kind === 'docker' && options.docker?.ready === true) {
        const docker = options.docker;
        // the question to the supervisor takes a moment: nothing else may start while it is out
        if (asking) throw new UpdateError('conflict', 'an update is already in progress');
        asking = true;
        return (async () => {
          try {
            const busy = await docker.busy();
            if (busy !== null) throw new UpdateError('conflict', busy);
            const started = set({ state: 'running', version, note: `Pulling ${version}…`, tail: [], rollback: null });
            void dockerUpdate(version, 'pull');
            return started;
          } finally {
            asking = false;
          }
        })();
      }
      if (options.kind === 'docker') {
        if (options.hook === null) throw new UpdateError('conflict', `a container cannot replace its own image: run ${seen.command} on the host (set GONOGO_UPDATE_HOOK to let this button do it)`);
        const started = set({ state: 'running', version, note: `Asking the update hook to pull ${version}…`, tail: [], rollback: null });
        void callHook(version);
        return started;
      }
      if (installCommand(options.kind, version) === null) throw new UpdateError('conflict', `this install cannot be updated from the page: run ${seen.command}`);
      const started = set({ state: 'running', version, note: `Installing ${version}…`, tail: [], rollback: null });
      void install(version).catch((error: unknown) => {
        log.error('the update failed', error);
        set({ state: 'failed', note: 'The update failed unexpectedly; the running version is unchanged.', tail: [], rollback: null });
      });
      return started;
    },
  };
}
