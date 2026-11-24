// From https://nexus-ui.dev/r/prompt-input.json (Nexus UI, MIT). The textarea scrolls itself instead of sitting in a ScrollArea, and
// Enter is left to the caller, which follows the Director's own Enter setting (enterSends).
import { createContext, forwardRef, useCallback, useContext, useRef } from 'react';
import type { ComponentProps, HTMLAttributes, MouseEvent, ReactElement } from 'react';
import { Textarea } from '@/ui/textarea.js';
import { TooltipProvider } from '@/ui/tooltip.js';
import { cn } from '@/lib/utils.js';

const PromptInputContext = createContext<{ setTextarea(node: HTMLTextAreaElement | null): void } | null>(null);

function PromptInput({ className, onClick, ...props }: HTMLAttributes<HTMLDivElement>): ReactElement {
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const handleClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      // a click on the frame, not on a control, puts the cursor in the box
      if (!(e.target as HTMLElement).closest('button, a, input, textarea, select, [role="button"]')) textarea.current?.focus();
      onClick?.(e);
    },
    [onClick],
  );
  return (
    <TooltipProvider delayDuration={100}>
      <PromptInputContext.Provider value={{ setTextarea: (node) => (textarea.current = node) }}>
        <div
          data-slot="prompt-input"
          className={cn('relative flex h-auto w-full cursor-text flex-col gap-0 overflow-hidden rounded-3xl border border-border bg-secondary', className)}
          onClick={handleClick}
          {...props}
        />
      </PromptInputContext.Provider>
    </TooltipProvider>
  );
}

const PromptInputTextarea = forwardRef<HTMLTextAreaElement, ComponentProps<typeof Textarea>>(function PromptInputTextarea({ className, ...props }, ref) {
  const context = useContext(PromptInputContext);
  const setRef = useCallback(
    (node: HTMLTextAreaElement | null) => {
      context?.setTextarea(node);
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    },
    [context, ref],
  );
  return (
    <Textarea
      ref={setRef}
      className={cn(
        'max-h-40 min-h-14 w-full resize-none overflow-y-auto rounded-none border-0 bg-transparent px-4 py-4 text-sm leading-6 text-primary shadow-none focus-visible:ring-0',
        className,
      )}
      {...props}
    />
  );
});

function PromptInputActions({ className, ...props }: HTMLAttributes<HTMLDivElement>): ReactElement {
  return <div data-slot="prompt-input-actions" className={cn('flex w-full shrink-0 items-center justify-between gap-2 px-2 py-2', className)} {...props} />;
}

export { PromptInput, PromptInputTextarea, PromptInputActions };
