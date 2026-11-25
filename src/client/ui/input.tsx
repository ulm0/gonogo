// From https://ui.shadcn.com/r/styles/new-york-v4/input.json (shadcn/ui, MIT), drawn in the Instrument's size (46 px, a touch target) instead of shadcn's 36 px; the focus ring is the page's own (:focus-visible in base.css). The classes live in src/shared/controls.ts, which the server's own pages use too.
import type { ComponentProps, ReactElement } from 'react';
import { cn } from '@/lib/utils.js';
import { INPUT_CLASS } from '../../shared/controls.js';

function Input({ className, type, ...props }: ComponentProps<'input'>): ReactElement {
  return <input type={type} data-slot="input" className={cn(INPUT_CLASS, className)} {...props} />;
}

export { Input };
