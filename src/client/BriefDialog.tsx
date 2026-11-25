/**
 * The Brief dialog: the Brief FLIGHT box over any screen, opened by Cmd/Ctrl+B or the Patch Panel's Brief FLIGHT line. It sends to
 * the boss of this room without changing the page. After a send it stays open and shows the sent note, so the Director sees it went;
 * Esc or Close shuts it and the keyboard goes back to where it was. A text not sent is kept for the next open.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { ReactElement } from 'react';
import { Brief } from './Brief.js';
import { useAgentList } from './RoomView.js';
import { Dialog, DialogContent, DialogTitle } from '@/ui/dialog.js';
import './patch.css';

export function BriefDialog({ open, onClose }: { open: boolean; onClose(): void }): ReactElement {
  const back = useRef<HTMLElement | null>(null);
  const left = useRef(false);
  // the draft lives here, not in the box: Radix drops the box on close, and Esc must not lose what was typed (a send clears it)
  const draft = useState('');
  const boss = useAgentList().find((a) => a.boss) ?? null;

  // a layout effect: it runs before the dialog takes the focus, so it still sees the opener
  useLayoutEffect(() => {
    if (!open) return;
    // reopened at once, Radix has not yet given the keyboard back (it does so a tick after close): the focus is on body, keep the last opener
    const at = document.activeElement;
    if (at instanceof HTMLElement && at !== document.body) back.current = at;
    left.current = false;
  }, [open]);

  // Make this a mission: closed and the keyboard given back before the page changes, as a Patch Panel line does
  const leave = (): void => {
    left.current = true;
    flushSync(onClose);
    back.current?.focus();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        className="patch brief-dialog module top-[10vh] flex w-[min(560px,calc(100vw-24px))] max-w-none translate-y-0 flex-col gap-2.5 p-3.5 text-foreground sm:max-w-none max-[699px]:top-3"
        aria-describedby={undefined}
        // the field, not the first key (Close); a disabled field (no FLIGHT, or stopped) leaves Radix to focus Close
        onOpenAutoFocus={(e) => {
          const field = (e.currentTarget as HTMLElement).querySelector<HTMLTextAreaElement>('.brief-input');
          if (field === null || field.disabled) return;
          e.preventDefault();
          field.focus();
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          if (!left.current) back.current?.focus();
        }}
      >
        <div className="patch-head">
          <DialogTitle className="label patch-title leading-normal">BRIEF FLIGHT</DialogTitle>
          {/* a touch screen has no Esc */}
          <button type="button" className="btn" data-kind="quiet" onClick={onClose}>
            Close
          </button>
        </div>
        <Brief boss={boss} onLeave={leave} draft={draft} />
      </DialogContent>
    </Dialog>
  );
}
