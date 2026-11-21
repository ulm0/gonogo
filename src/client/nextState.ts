/** The few settings of the prototype layout that the page remembers (docs/ui-semantic.md, "Layout"): how each panel of the wall is shown, which seats, the expanded console. */
import { useSyncExternalStore } from 'react';

export type PanelId = 'mission' | 'sequence' | 'tminus' | 'maxq' | 'propellant';
/** A panel is a chip of the strip, a box of its own under the strip, or hidden. */
export type PanelMode = 'strip' | 'panel' | 'hidden';
export type Density = 'focus' | 'standard' | 'full';

export const PANELS: ReadonlyArray<{ id: PanelId; label: string }> = [
  { id: 'mission', label: 'Mission clock' },
  { id: 'sequence', label: 'Activity' },
  { id: 'tminus', label: 'Poll' },
  { id: 'maxq', label: 'Max Q' },
  { id: 'propellant', label: 'Fuel' },
];

export interface NextState {
  panels: Record<PanelId, PanelMode>;
  /** Open seats: one row, or a tile each. */
  seats: 'row' | 'tiles';
  /** The console takes the main area. */
  expanded: boolean;
}

const KEY = 'gonogo.next';
const standard = (): Record<PanelId, PanelMode> => ({ mission: 'strip', sequence: 'strip', tminus: 'strip', maxq: 'strip', propellant: 'strip' });
const DEFAULT: NextState = { panels: standard(), seats: 'row', expanded: false };

/** The presets of the Layout popover: they write the same per-panel modes the three-way choice does. */
export const DENSITIES: Readonly<Record<Density, Record<PanelId, PanelMode>>> = {
  focus: { mission: 'strip', sequence: 'hidden', tminus: 'hidden', maxq: 'hidden', propellant: 'hidden' },
  standard: standard(),
  full: { mission: 'panel', sequence: 'panel', tminus: 'panel', maxq: 'panel', propellant: 'panel' },
};

/** The preset the panels equal, or null for a mix. */
export function densityOf(panels: Record<PanelId, PanelMode>): Density | null {
  for (const [name, modes] of Object.entries(DENSITIES)) if (PANELS.every((p) => panels[p.id] === modes[p.id])) return name as Density;
  return null;
}

function load(): NextState {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (typeof raw !== 'object' || raw === null) return DEFAULT;
    const r = raw as Partial<NextState>;
    const panels = standard();
    for (const p of PANELS) {
      const mode = r.panels?.[p.id];
      if (mode === 'strip' || mode === 'panel' || mode === 'hidden') panels[p.id] = mode;
    }
    return { panels, seats: r.seats === 'tiles' ? 'tiles' : 'row', expanded: false };
  } catch {
    return DEFAULT;
  }
}

let state: NextState = load();
const listeners = new Set<() => void>();

export function setNext(change: (s: NextState) => NextState): void {
  state = change(state);
  try {
    localStorage.setItem(KEY, JSON.stringify({ panels: state.panels, seats: state.seats }));
  } catch {
    // not remembered; the page still follows
  }
  listeners.forEach((l) => l());
}

export function useNext<T>(select: (s: NextState) => T): T {
  const read = (): T => select(state);
  return useSyncExternalStore((l) => (listeners.add(l), () => void listeners.delete(l)), read, read);
}

/** For tests: back to the default. */
export function resetNext(): void {
  state = { ...DEFAULT, panels: standard() };
  listeners.forEach((l) => l());
}
