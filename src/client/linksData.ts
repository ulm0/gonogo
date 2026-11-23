/** The links of this station, one copy for every card, the board and the rules (a page of one tab). Read on first use, every 30 s, when the tab comes back and after each action. */
import { useEffect, useSyncExternalStore } from 'react';
import type { LinkView } from '../shared/protocol.js';
import * as api from './api.js';

let current: LinkView[] = [];
let loaded = false;
const watchers = new Set<() => void>();

export async function refreshLinks(): Promise<void> {
  try {
    current = await api.links();
    loaded = true;
    for (const w of watchers) w();
  } catch {
    // a list that cannot be read keeps what was shown; the next try asks again
  }
}

/** For a test or a capture that has the list already. */
export function setLinks(list: LinkView[]): void {
  current = list;
  loaded = true;
  for (const w of watchers) w();
}

export function useLinks(): LinkView[] {
  useEffect(() => {
    if (!loaded) void refreshLinks();
    const timer = setInterval(() => void refreshLinks(), 30_000);
    const back = (): void => void refreshLinks();
    window.addEventListener('focus', back);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', back);
    };
  }, []);
  return useSyncExternalStore(
    (w) => {
      watchers.add(w);
      return () => void watchers.delete(w);
    },
    () => current,
  );
}
