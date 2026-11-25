/** A key that opens a small panel under (or over) it: the one primitive of the prototype's menus, popovers and strip chips. Closes on Escape, on a press outside and when asked. */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

interface Props {
  /** What the key says. */
  label: ReactNode;
  /** The name of the key for a screen reader. It must contain the words the key shows (WCAG 2.5.3, label in name). */
  name?: string;
  /** The name of the panel it opens, when that is not the key's name. */
  dialog?: string;
  kind?: 'quiet' | 'primary';
  /** The panel opens above the key (the bottom bar of a phone). */
  up?: boolean;
  /** The panel's edge: its left edge at the key's left edge, or its right edge at the key's right. */
  align?: 'start' | 'end';
  className?: string;
  children: (close: () => void) => ReactNode;
}

export function Pop({ label, name, dialog, kind = 'quiet', up = false, align = 'start', className = '', children }: Props): ReactElement {
  const id = useId();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement | null>(null);
  const key = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  // The panel fits the screen: it is as tall as the room below the key (above it when it opens up) and moves in from an edge it would cross.
  // shortcut: measured when it opens, not on a scroll or resize while open; follow the key with a ResizeObserver if that is ever needed.
  useLayoutEffect(() => {
    const p = panel.current;
    const k = key.current;
    if (!open || p === null || k === null) return;
    const margin = 16;
    const kr = k.getBoundingClientRect();
    const below = window.innerHeight - kr.bottom - 6 - margin;
    const above = kr.top - 6 - margin;
    // a key near the bottom of the screen opens its panel upward when the panel would not fit below and there is more room above
    const flip = !up && below < Math.min(p.scrollHeight, 240) && above > below;
    if (flip) p.dataset.up = '';
    else if (!up) delete p.dataset.up;
    const room = up || flip ? above : below;
    p.style.setProperty('--pop-room', `${Math.max(120, Math.floor(room))}px`);
    p.style.setProperty('--pop-shift', '0px');
    const r = p.getBoundingClientRect();
    const shift = r.right > window.innerWidth - margin ? window.innerWidth - margin - r.right : r.left < margin ? margin - r.left : 0;
    p.style.setProperty('--pop-shift', `${Math.round(shift)}px`);
  }, [open, up]);
  useEffect(() => {
    if (!open) return undefined;
    const outside = (event: PointerEvent): void => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
        key.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  return (
    <span className={`lay-anchor ${className}`.trim()} ref={root}>
      <button ref={key} type="button" className="btn" data-kind={kind} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} aria-label={name} onClick={() => setOpen(!open)}>
        {label}
      </button>
      {open && <div className="lay-scrim" aria-hidden="true" onClick={() => setOpen(false)} />}
      {open && (
        <div ref={panel} id={id} className="lay-pop module" role="dialog" aria-label={dialog ?? name ?? (typeof label === 'string' ? label : undefined)} data-up={up || undefined} data-align={align}>
          {children(() => setOpen(false))}
        </div>
      )}
    </span>
  );
}
