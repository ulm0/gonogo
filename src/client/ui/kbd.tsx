// From https://ui.shadcn.com/r/styles/new-york-v4/kbd.json (shadcn/ui, MIT).
import type { ComponentProps, ReactElement } from 'react';
import { cn } from '@/lib/utils.js';

function Kbd({ className, ...props }: ComponentProps<'kbd'>): ReactElement {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        'pointer-events-none inline-flex h-5 w-fit min-w-5 items-center justify-center gap-1 rounded-sm bg-muted px-1 font-sans text-xs font-medium text-muted-foreground select-none',
        '[[data-slot=tooltip-content]_&]:bg-background/20 [[data-slot=tooltip-content]_&]:text-background',
        className,
      )}
      {...props}
    />
  );
}

export { Kbd };
