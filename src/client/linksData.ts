/** The links of this station, one copy for every card, the board and the rules (a page of one tab). Read on first use, every 30 s, when the tab comes back and after each action. */
import { useEffect, useSyncExternalStore } from 'react';
import type { HandoffAsk } from '../shared/protocol.js';
import * as api from './api.js';
import type { LinkItem } from './links.js';
import { store, useStore } from './store.js';

let loaded = false;

/** The list is in the store (the `links` frame keeps it); it is read once with GET /api/links, since the snapshot has none, and again when the tab comes back. */
export async function refreshLinks(): Promise<void> {
  try {
    const list = await api.links();
    loaded = true;
    store.setState((s) => ({ ...s, links: list }));
  } catch {
    // a list that cannot be read keeps what was shown; the next try asks again
  }
}

/** For a test or a capture that has the list already. */
export function setLinks(list: LinkItem[]): void {
  loaded = true;
  store.setState((s) => ({ ...s, links: list }));
}

export function useLinks(): LinkItem[] {
  useEffect(() => {
    if (!loaded) void refreshLinks();
    const back = (): void => void refreshLinks();
    window.addEventListener('focus', back);
    return () => window.removeEventListener('focus', back);
  }, []);
  return useStore((s) => s.links) as LinkItem[];
}

let asks: HandoffAsk[] = [];
let asksLoaded = false;
const askWatchers = new Set<() => void>();

export async function refreshAsks(): Promise<void> {
  try {
    asks = await api.handoffAsks();
    asksLoaded = true;
    for (const w of askWatchers) w();
  } catch {
    // kept as it was; the next try asks again
  }
}

/** The handoffs waiting for the Director's GO, read every 10 s (they have no frame of their own yet) and when the tab comes back. */
export function useHandoffAsks(): HandoffAsk[] {
  useEffect(() => {
    if (!asksLoaded) void refreshAsks();
    const timer = setInterval(() => void refreshAsks(), 10_000);
    const back = (): void => void refreshAsks();
    window.addEventListener('focus', back);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', back);
    };
  }, []);
  return useSyncExternalStore(
    (w) => {
      askWatchers.add(w);
      return () => void askWatchers.delete(w);
    },
    () => asks,
    () => asks,
  );
}
