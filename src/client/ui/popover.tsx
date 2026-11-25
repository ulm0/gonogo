// From https://ui.shadcn.com/r/styles/new-york-v4/popover.json (shadcn/ui, MIT). The enter/exit animation classes (tw-animate-css) are dropped, and the Portal is left to the caller: Pop.tsx keeps its panel next to its key, so the callers' CSS still reaches it.
import type { ComponentProps, ReactElement } from 'react';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils.js';

function Popover(props: ComponentProps<typeof PopoverPrimitive.Root>): ReactElement {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger(props: ComponentProps<typeof PopoverPrimitive.Trigger>): ReactElement {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverContent({ className, align = 'center', sideOffset = 4, ...props }: ComponentProps<typeof PopoverPrimitive.Content>): ReactElement {
  return (
    <PopoverPrimitive.Content
      data-slot="popover-content"
      align={align}
      sideOffset={sideOffset}
      className={cn('z-50 w-72 origin-(--radix-popover-content-transform-origin) rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-hidden', className)}
      {...props}
    />
  );
}

function PopoverAnchor(props: ComponentProps<typeof PopoverPrimitive.Anchor>): ReactElement {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor };
