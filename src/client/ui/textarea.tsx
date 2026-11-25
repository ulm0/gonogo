// From https://ui.shadcn.com/r/styles/new-york-v4/textarea.json (shadcn/ui, MIT). The `field` variant is the Instrument's form field (the look of Input, in mono, grows by hand); the default is shadcn's, for the Nexus PromptInput.
import type { ComponentProps, ReactElement } from 'react';
import { cn } from '@/lib/utils.js';
import { TEXTAREA_FIELD_CLASS } from '../../shared/controls.js';

const VARIANTS = {
  default:
    'flex field-sizing-content min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
  field: TEXTAREA_FIELD_CLASS,
};

function Textarea({ className, variant = 'default', ...props }: ComponentProps<'textarea'> & { variant?: keyof typeof VARIANTS }): ReactElement {
  return <textarea data-slot="textarea" className={cn(VARIANTS[variant], className)} {...props} />;
}

export { Textarea };
