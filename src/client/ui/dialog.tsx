// From https://ui.shadcn.com/r/styles/new-york-v4/dialog.json (shadcn/ui, MIT). The animation classes (tw-animate-css), the header and footer and the corner close key are dropped (each dialog of ours has its own Close key), and the overlay is the livery's page colour (--body) at 75%: it washes the page behind toward the background in every livery, dark keys too, where black at 35% left them at full contrast.
import type { ComponentProps, ReactElement } from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils.js';

function Dialog(props: ComponentProps<typeof DialogPrimitive.Root>): ReactElement {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogClose(props: ComponentProps<typeof DialogPrimitive.Close>): ReactElement {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({ className, ...props }: ComponentProps<typeof DialogPrimitive.Overlay>): ReactElement {
  return <DialogPrimitive.Overlay data-slot="dialog-overlay" className={cn('fixed inset-0 z-50 bg-background/75', className)} {...props} />;
}

function DialogContent({ className, children, ...props }: ComponentProps<typeof DialogPrimitive.Content>): ReactElement {
  return (
    <DialogPrimitive.Portal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn('fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border bg-background p-6 shadow-lg sm:max-w-lg', className)}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>): ReactElement {
  return <DialogPrimitive.Title data-slot="dialog-title" className={cn('text-lg leading-none font-semibold', className)} {...props} />;
}

function DialogDescription({ className, ...props }: ComponentProps<typeof DialogPrimitive.Description>): ReactElement {
  return <DialogPrimitive.Description data-slot="dialog-description" className={cn('text-sm text-muted-foreground', className)} {...props} />;
}

export { Dialog, DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogTitle };
