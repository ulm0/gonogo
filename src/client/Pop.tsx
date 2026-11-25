/** A key that opens a small panel under (or over) it: the one primitive of the prototype's menus, popovers and strip chips. Closes on Escape, on a press outside and when asked. Radix Popover places it: it flips to the side with room, moves in from an edge and is as tall as the room it has. */
import { useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover.js';

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
  const [open, setOpen] = useState(false);
  return (
    <span className={`lay-anchor ${className}`.trim()}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger className="btn" data-kind={kind} aria-label={name}>
          {label}
        </PopoverTrigger>
        {open && <div className="lay-scrim" aria-hidden="true" onClick={() => setOpen(false)} />}
        <PopoverContent
          className="lay-pop module z-30 flex max-h-(--radix-popover-content-available-height) min-h-[120px] w-auto max-w-[min(380px,calc(100vw-32px))] min-w-[220px] flex-col gap-2 overflow-y-auto p-3 shadow-[0_8px_24px_rgb(0_0_0/0.25)]"
          aria-label={dialog ?? name ?? (typeof label === 'string' ? label : undefined)}
          side={up ? 'top' : 'bottom'}
          align={align}
          sideOffset={6}
          collisionPadding={16}
          // the key keeps the focus when the panel opens, as before: Tab goes on into the panel
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          {children(() => setOpen(false))}
        </PopoverContent>
      </Popover>
    </span>
  );
}
