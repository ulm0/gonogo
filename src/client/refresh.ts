import { useEffect, useRef } from 'react';

/** How often an open page asks the server again, in milliseconds. */
export const REFRESH_MS = 5000;

/** Calls `load` now, every REFRESH_MS while the tab is visible, and when it becomes visible again. The Plot Board and the Black Box have no frame: they are asked for. */
export function useRefresh(load: () => void): void {
  const latest = useRef(load);
  latest.current = load;
  useEffect(() => {
    const ask = (): void => {
      if (document.visibilityState !== 'hidden') latest.current();
    };
    ask();
    const timer = setInterval(ask, REFRESH_MS);
    document.addEventListener('visibilitychange', ask);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', ask);
    };
  }, []);
}
