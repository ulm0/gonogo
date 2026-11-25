// After https://ui.shadcn.com/r/styles/new-york-v4/checkbox.json, radio-group.json and switch.json (shadcn/ui, MIT), but native inputs, not Radix buttons: the keyboard, a screen reader, `required` and form submission stay the browser's (docs/ui-library-assessment.md, PR 5). The classes live in src/shared/controls.ts.
import type { ComponentProps, ReactElement } from 'react';
import { cn } from '@/lib/utils.js';
import { CHECKBOX_CLASS, RADIO_CLASS, SWITCH_CLASS } from '../../shared/controls.js';

type Native = Omit<ComponentProps<'input'>, 'type'>;

function Checkbox({ className, ...props }: Native): ReactElement {
  return <input type="checkbox" data-slot="checkbox" className={cn(CHECKBOX_CLASS, className)} {...props} />;
}

function Radio({ className, ...props }: Native): ReactElement {
  return <input type="radio" data-slot="radio" className={cn(RADIO_CLASS, className)} {...props} />;
}

/** A checkbox drawn as a switch; the caller gives role="switch" where a screen reader should say on and off. */
function Switch({ className, ...props }: Native): ReactElement {
  return <input type="checkbox" data-slot="switch" className={cn(SWITCH_CLASS, className)} {...props} />;
}

export { Checkbox, Radio, Switch };
