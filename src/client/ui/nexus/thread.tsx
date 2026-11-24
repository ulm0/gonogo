// From https://nexus-ui.dev/r/thread.json (Nexus UI, MIT). Slot from radix-ui, the package the shadcn files already use.
import type { ComponentProps, ReactElement } from 'react';
import { ArrowDown02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Slot } from 'radix-ui';
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom';
import { cn } from '@/lib/utils.js';

function Thread({ className, resize = 'smooth', initial = 'smooth', ...props }: ComponentProps<typeof StickToBottom>): ReactElement {
  return <StickToBottom data-slot="thread" className={cn('relative h-full w-full', className)} resize={resize} initial={initial} {...props} />;
}

function ThreadContent({ className, ...props }: ComponentProps<typeof StickToBottom.Content>): ReactElement {
  return <StickToBottom.Content data-slot="thread-content" className={cn('flex w-full flex-col gap-6 p-6', className)} {...props} />;
}

function ThreadScrollToBottom({ asChild = false, className, children, onClick, ...props }: ComponentProps<'button'> & { asChild?: boolean }): ReactElement | null {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  if (isAtBottom) return null;
  const Comp = asChild ? Slot.Root : 'button';
  return (
    <Comp
      data-slot="thread-scroll-to-bottom"
      type={asChild ? undefined : 'button'}
      className={cn(
        !asChild &&
          'absolute bottom-6 left-[50%] flex size-8 translate-x-[-50%] cursor-pointer items-center justify-center rounded-full border border-border bg-secondary text-muted-foreground shadow-sm transition-all hover:bg-border active:scale-95',
        className,
      )}
      onClick={(event) => {
        void scrollToBottom();
        onClick?.(event);
      }}
      {...props}
    >
      {children ?? <HugeiconsIcon icon={ArrowDown02Icon} strokeWidth={2} className="size-4.5" />}
    </Comp>
  );
}

export { Thread, ThreadContent, ThreadScrollToBottom };
