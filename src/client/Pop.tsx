/** A key that opens a small panel under (or over) it: the one primitive of the prototype's menus, popovers and strip chips. Closes on Escape, on a press outside and when asked. */
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

interface Props {
  /** What the key says. */
  label: ReactNode;
  /** The name for a screen reader when the label is a symbol. */
  name?: string;
  kind?: 'quiet' | 'primary';
  /** The panel opens above the key (the bottom bar of a phone). */
  up?: boolean;
  /** The panel's edge: its left edge at the key's left edge, or its right edge at the key's right. */
  align?: 'start' | 'end';
  className?: string;
  children: (close: () => void) => ReactNode;
}

export function Pop({ label, name, kind = 'quiet', up = false, align = 'start', className = '', children }: Props): ReactElement {
  const id = useId();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement | null>(null);
  const key = useRef<HTMLButtonElement | null>(null);
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
        <div id={id} className="lay-pop module" role="dialog" aria-label={name ?? (typeof label === 'string' ? label : undefined)} data-up={up || undefined} data-align={align}>
          {children(() => setOpen(false))}
        </div>
      )}
    </span>
  );
}
