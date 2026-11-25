/**
 * The class lists of the form controls: Tailwind utilities over the Livery tokens (src/client/shadcn.css). One source for the React
 * components (src/client/ui: input, native-select, textarea, checkbox) and the pages the server writes itself (authpage.ts, roomspage.ts),
 * which load the client's built stylesheet. Native elements in the Instrument's sizes: 46 px fields, 22 px boxes, a 44 x 26 switch,
 * checked in --go-ink with the mark in --key (CONTROL_PAIRS).
 */

/** What a text field, a select and a field's text area share. */
const FIELD = 'w-full min-w-0 rounded-sm border border-input bg-secondary px-3.5 font-sans text-[14px] text-foreground placeholder:text-muted-foreground placeholder:opacity-100 aria-invalid:border-2 aria-invalid:border-[var(--nogo)] data-fit:w-auto';

/** A check box, a radio and a switch: a native input drawn by its ::after. */
const BOX = 'relative m-0 flex-none cursor-pointer appearance-none border-2 border-muted-foreground bg-secondary after:absolute after:opacity-0 checked:border-[var(--go-ink)] checked:bg-[var(--go-ink)] checked:after:opacity-100 disabled:cursor-default disabled:opacity-60 forced-colors:checked:border-[Highlight] forced-colors:checked:bg-[Highlight] forced-colors:checked:forced-color-adjust-none';

export const INPUT_CLASS = `${FIELD} h-[46px] read-only:bg-muted read-only:text-muted-foreground`;
/** The chevron is a background in --text-2 (4.5:1 or better on --key), so the select stays one element. */
export const SELECT_CLASS = `${FIELD} h-[46px] cursor-pointer appearance-none bg-[image:linear-gradient(45deg,transparent_50%,var(--text-2)_50%),linear-gradient(135deg,var(--text-2)_50%,transparent_50%)] bg-[size:6px_6px] bg-[position:calc(100%-20px)_50%,calc(100%-14px)_50%] bg-no-repeat pr-10 disabled:cursor-default disabled:opacity-60 forced-colors:bg-[Field] forced-colors:bg-[image:linear-gradient(45deg,transparent_50%,CanvasText_50%),linear-gradient(135deg,CanvasText_50%,transparent_50%)]`;
export const TEXTAREA_FIELD_CLASS = `${FIELD} resize-y py-3 font-mono text-[12.5px] leading-[1.5]`;
export const CHECKBOX_CLASS = `${BOX} size-[22px] rounded-[5px] after:top-[3px] after:left-[3px] after:h-[5px] after:w-[11px] after:-rotate-45 after:border-0 after:border-b-[3px] after:border-l-[3px] after:border-solid after:border-secondary indeterminate:after:top-[7px] indeterminate:after:h-0 indeterminate:after:w-[10px] indeterminate:after:rotate-0 indeterminate:after:border-l-0 indeterminate:after:opacity-100 forced-colors:checked:after:border-[Canvas]`;
export const RADIO_CLASS = `${BOX} size-[22px] rounded-full after:inset-[3px] after:rounded-full after:bg-secondary forced-colors:after:bg-[CanvasText] forced-colors:checked:after:bg-[Canvas]`;
export const SWITCH_CLASS = `${BOX} h-[26px] w-11 rounded-[13px] bg-muted after:top-[3px] after:left-[3px] after:size-4 after:rounded-full after:bg-muted-foreground after:opacity-100 after:transition-transform after:duration-150 checked:after:translate-x-[18px] checked:after:bg-secondary forced-colors:after:bg-[CanvasText] forced-colors:checked:after:bg-[Canvas]`;
