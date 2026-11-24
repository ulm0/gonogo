// From https://nexus-ui.dev/r/message.json (Nexus UI, MIT). Only Message, MessageStack and MessageContent are taken: the markdown
// renderer (streamdown, mermaid, math, cjk), the code block and the avatar are not. Agent text is untrusted and shows as plain text.
import { createContext, useContext } from 'react';
import type { HTMLAttributes, ReactElement } from 'react';
import { cn } from '@/lib/utils.js';

type MessageFrom = 'user' | 'assistant';

const MessageContext = createContext<{ from: MessageFrom } | null>(null);

function Message({ className, from, children, ...props }: HTMLAttributes<HTMLDivElement> & { from: MessageFrom }): ReactElement {
  return (
    <MessageContext.Provider value={{ from }}>
      <div
        data-slot="message"
        role="article"
        className={cn('group/message flex w-full max-w-[90%] items-start gap-2', from === 'user' ? 'ms-auto' : 'me-auto', className)}
        {...props}
      >
        {children}
      </div>
    </MessageContext.Provider>
  );
}

function MessageStack({ className, ...props }: HTMLAttributes<HTMLDivElement>): ReactElement {
  const from = useContext(MessageContext)?.from ?? 'assistant';
  return <div data-slot="message-stack" className={cn('flex w-full flex-col gap-2', from === 'user' ? 'items-end' : 'items-start', className)} {...props} />;
}

function MessageContent({ className, ...props }: HTMLAttributes<HTMLDivElement>): ReactElement {
  const from = useContext(MessageContext)?.from ?? 'assistant';
  return (
    <div
      data-slot="message-content"
      className={cn('rounded-2xl text-sm leading-6.5 text-primary', from === 'user' ? 'w-fit bg-secondary px-4 py-2' : 'mb-1 w-full bg-transparent px-2', className)}
      {...props}
    />
  );
}

export { Message, MessageStack, MessageContent };
