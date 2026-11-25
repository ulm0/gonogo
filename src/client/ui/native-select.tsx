// From https://ui.shadcn.com/r/styles/new-york-v4/native-select.json (shadcn/ui, MIT): a native <select>, so the menu, the keyboard and a phone's picker stay the browser's. No wrapper and icon: the chevron is drawn in the background (src/shared/controls.ts), so the select stays one element in the layouts it sits in.
import type { ComponentProps, ReactElement } from 'react';
import { cn } from '@/lib/utils.js';
import { SELECT_CLASS } from '../../shared/controls.js';

function NativeSelect({ className, ...props }: ComponentProps<'select'>): ReactElement {
  return <select data-slot="native-select" className={cn(SELECT_CLASS, className)} {...props} />;
}

export { NativeSelect };
