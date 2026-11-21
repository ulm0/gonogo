/**
 * The next layout (docs/ui-semantic.md): a PROTOTYPE of the room view, the console terminal, the top bar and the update entry, built from the app's own components and
 * styles, behind a switch that is OFF by default. It is turned on by `?layout=next` in the address (kept for the tab in sessionStorage; `?layout=old` turns it off).
 * Nothing in the default page changes: every use of the switch is `NEXT && ...`. It exists so that the layout can be looked at in a real browser, with the real components,
 * before it is built for good.
 */
const KEY = 'gonogo.layout';

function read(): boolean {
  if (typeof location === 'undefined') return false;
  const query = new URLSearchParams(location.search).get('layout');
  try {
    if (query === 'next') sessionStorage.setItem(KEY, 'next');
    else if (query === 'old') sessionStorage.removeItem(KEY);
    return sessionStorage.getItem(KEY) === 'next';
  } catch {
    // storage may be blocked: the address alone then decides
    return query === 'next';
  }
}

/** Whether the prototype layout is on for this tab. Read once, at load. */
export const NEXT: boolean = read();
