/** Whether a newer gonogo is out, as the page of any room knows it. Main checks; every other room asks the supervisor what main saw. */
import { useEffect, useState, useSyncExternalStore } from 'react';
import * as api from './api.js';
import { BASE } from './base.js';
import { readStored, useStore, writeStored } from './store.js';

/** The version by the logo says a newer one is out and asks the strip to show itself, even one dismissed for that version. */
export const ROLLOUT_SHOW = 'gonogo:rollout-show';

/** Where this browser remembers which version the Director dismissed on the update strip. */
export const ROLLOUT_DISMISSED_KEY = 'gonogo.rollout.dismissed';

// One copy for the strip and the version key (a page of the same tab): kept here as well as in the browser, so a browser that refuses the write still agrees with itself
let dismissed = readStored(ROLLOUT_DISMISSED_KEY);
const watchers = new Set<() => void>();
export const setRolloutDismissed = (version: string): void => {
  dismissed = version;
  writeStored(ROLLOUT_DISMISSED_KEY, version);
  for (const w of watchers) w();
};
export const useRolloutDismissed = (): string | null =>
  useSyncExternalStore(
    (w) => {
      watchers.add(w);
      return () => void watchers.delete(w);
    },
    () => dismissed,
  );

export const CHANGELOG_URL = 'https://github.com/ulm0/gonogo/blob/main/CHANGELOG.md';

/** The main room is the one that checks for a newer gonogo and updates it (a room under /r/<other>/ links there). */
export const inMain = BASE === '' || BASE === '/r/main';

/** The newer version the check saw, or null. Main has it in its own rollout; any other room runs no check, so the supervisor says what main saw. */
export function useNewer(): string | null {
  const rollout = useStore((s) => s.rollout);
  const [other, setOther] = useState<string | null>(null);
  useEffect(() => {
    if (inMain) return undefined;
    let alive = true;
    const ask = (): void => void api.roomsUpdate().then((v) => alive && setOther(v));
    ask();
    const timer = setInterval(ask, 30 * 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  return inMain ? (rollout?.newer === true ? rollout.latest : null) : other;
}
