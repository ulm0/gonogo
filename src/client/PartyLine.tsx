/**
 * Party Line: the messages of the room as conversations, the one with the newest message first. A conversation is a reply
 * chain, or the same two parties with the same subject (src/client/threads.ts). Opening one shows its messages in order and a
 * box to answer as the Director, through the same route as the comm loop's reply box.
 *
 * The shadcn pilot (docs/ui-library-assessment.md §3): the open thread is a Nexus UI Thread of Messages, the answer box a Nexus
 * PromptInput with a shadcn Button and Tooltip, the icons Hugeicons (free) and "Sending" a motion-primitives TextShimmer. Styles
 * are Tailwind utilities over the Livery tokens (shadcn.css); the chips and the page head stay the Instrument's. Comms loads this
 * file lazily, so its libraries are not in the first screen's bundle.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactElement } from 'react';
import { ArrowDown01Icon, ArrowRight01Icon, BubbleChatIcon, SentIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { ActivityItem, AgentView } from '../shared/protocol.js';
import * as api from './api.js';
import { enterSends } from './Brief.js';
import { whenText } from './inbox.js';
import { chipOf, legendOf, noteOf, replyRequest, routeText } from './loop.js';
import { showRoom, useStore } from './store.js';
import { linkLine } from './links.js';
import type { LinkItem } from './links.js';
import { useLinks } from './linksData.js';
import { groupThreads, repliers, replyTarget } from './threads.js';
import type { Thread as ThreadData } from './threads.js';
import { briefSentText } from './wording.js';
import { Button } from '@/ui/button.js';
import { Kbd } from '@/ui/kbd.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip.js';
import { Message, MessageContent, MessageStack } from '@/ui/nexus/message.js';
import { PromptInput, PromptInputActions, PromptInputTextarea } from '@/ui/nexus/prompt-input.js';
import { Thread, ThreadContent, ThreadScrollToBottom } from '@/ui/nexus/thread.js';
import { TextShimmer } from '@/ui/motion/text-shimmer.js';
import './loop.css';

/** The page draws at most this many threads; the store keeps the newest 200 messages, so it is rarely reached. */
const MAX_ROWS = 100;

const countText = (n: number): string => `${n} ${n === 1 ? 'message' : 'messages'}`;

function Said({ item, agents, now }: { item: ActivityItem; agents: Readonly<Record<string, AgentView>>; now: number }): ReactElement {
  const chip = chipOf(item);
  const note = noteOf(item);
  const you = item.from === 'user';
  return (
    <Message from={you ? 'user' : 'assistant'} aria-label={`${routeText(item, agents)}, ${whenText(item.at, now)}`}>
      <MessageStack>
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-2 text-xs text-muted-foreground">
          <span className="loop-route">{routeText(item, agents)}</span>
          <span className="loop-time">{whenText(item.at, now)}</span>
          {chip.tone !== 'quiet' && (
            <span className="chip" data-tone={chip.tone}>
              {chip.text}
            </span>
          )}
        </p>
        {note !== '' && chip.tone !== 'quiet' && <p className="px-2 text-xs text-muted-foreground">{note}</p>}
        <MessageContent className={you ? 'bg-accent text-accent-foreground' : 'border border-border bg-secondary px-4 py-2'}>
          {/* plain text: an agent's words never become links or markup here */}
          <span className="break-words whitespace-pre-wrap">
            {item.body}
            {item.truncated ? ' …(cut)' : ''}
          </span>
        </MessageContent>
      </MessageStack>
    </Message>
  );
}

/** The Director's answer: the comm loop's reply (Activity.tsx, Reply) in a Nexus PromptInput. */
function Answer({ item, agents }: { item: Pick<ActivityItem, 'id' | 'from' | 'subject'>; agents: Readonly<Record<string, AgentView>> }): ReactElement {
  const id = useId();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; failed: boolean } | null>(null);
  const to = legendOf(item.from, agents);
  const empty = text.trim() === '';

  async function send(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    const body = text.trim();
    if (busy || body === '') return;
    setBusy(true);
    setResult(null);
    try {
      const sent = await api.sendMessage(replyRequest(item, body));
      if (!sent.ok || sent.status === 'undelivered') {
        setResult({ text: sent.note ?? 'The message could not be delivered.', failed: true });
      } else {
        setText('');
        setResult({ text: briefSentText(sent.note, sent.to, to), failed: false });
      }
    } catch (e) {
      setResult({ text: e instanceof Error ? e.message : String(e), failed: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-1.5" onSubmit={(event) => void send(event)}>
      <label className="legend" htmlFor={`${id}-reply`}>
        Reply to {to}
      </label>
      <PromptInput>
        <PromptInputTextarea
          id={`${id}-reply`}
          rows={1}
          value={text}
          autoComplete="off"
          placeholder={`Write to ${to}`}
          aria-describedby={`${id}-result`}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
            if (enterSends(event)) void send(event);
          }}
        />
        <PromptInputActions>
          <span className="px-2 text-xs" aria-hidden={!busy}>
            {busy ? <TextShimmer as="span">Sending…</TextShimmer> : null}
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="submit" size="sm" className="rounded-full" aria-disabled={busy || empty}>
                <HugeiconsIcon icon={SentIcon} strokeWidth={1.8} aria-hidden="true" />
                Send
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              Send <Kbd>Enter</Kbd>
            </TooltipContent>
          </Tooltip>
        </PromptInputActions>
      </PromptInput>
      <p id={`${id}-result`} className={result?.failed === true ? 'error' : 'hint'} role="status">
        {result?.text}
      </p>
    </form>
  );
}

/** The open thread: its messages oldest first, then the box to answer. */
function Open({ thread, agents, now }: { thread: ThreadData; agents: Readonly<Record<string, AgentView>>; now: number }): ReactElement {
  const id = useId();
  const who = useMemo(() => repliers(thread), [thread]);
  const [chosen, setChosen] = useState<string | null>(null);
  // the choice is dropped when that agent leaves the thread
  const to = chosen !== null && who.includes(chosen) ? chosen : (who[0] ?? null);
  return (
    <div className="flex flex-col gap-3 border-t border-border bg-muted/40 px-3 pt-1 pb-4 sm:px-4">
      <Thread className="max-h-[min(60vh,560px)] overflow-y-auto">
        <ThreadContent className="gap-4 px-0 py-3">
          {thread.items.map((item) => (
            <Said key={item.id} item={item} agents={agents} now={now} />
          ))}
        </ThreadContent>
        <ThreadScrollToBottom aria-label="Go to the newest message" />
      </Thread>
      {to === null ? (
        <p className="hint">This thread is with another station. You cannot write to it from here.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {who.length > 1 && (
            <div className="flex items-center gap-2">
              <label className="legend" htmlFor={`${id}-to`}>
                Send to
              </label>
              <select id={`${id}-to`} className="input" value={to} onChange={(event) => setChosen(event.target.value)}>
                {who.map((name) => (
                  <option key={name} value={name}>
                    {legendOf(name, agents)}
                  </option>
                ))}
              </select>
            </div>
          )}
          {/* a new box for each agent, so that text typed for one is not sent to another */}
          <Answer key={to} item={replyTarget(thread, to)} agents={agents} />
        </div>
      )}
    </div>
  );
}

/** The THREADS tab of COMMS. */
export function PartyLine(): ReactElement {
  const titleId = useId();
  const items = useStore((s) => s.activity);
  const agents = useStore((s) => s.agents);
  const [openId, setOpenId] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const links = useLinks();
  const threads = useMemo(() => groupThreads(items, new Set(links.map((l) => l.id))), [items, links]);
  const rows = threads.slice(0, MAX_ROWS);
  const now = useMemo(() => Date.now(), [items]);
  // The page replaces the room: the keyboard starts at its title, not on a button that is gone.
  useEffect(() => heading.current?.focus(), []);

  return (
    <section className="flex flex-[1_0_auto] flex-col gap-3 px-4 pt-4 pb-5 sm:px-6" aria-labelledby={titleId}>
      <header className="loop-head">
        <h1 id={titleId} ref={heading} tabIndex={-1} className="disp loop-title focus-visible:outline-none">
          PARTY LINE
        </h1>
        <span className="chip" data-tone="quiet">
          {threads.length} {threads.length === 1 ? 'thread' : 'threads'}
        </span>
        <button type="button" className="btn loop-room" data-kind="quiet" onClick={showRoom}>
          Room
        </button>
      </header>
      <div className="module overflow-hidden">
        {rows.length === 0 ? (
          <p className="flex items-center gap-2 p-6 text-muted-foreground">
            <HugeiconsIcon icon={BubbleChatIcon} className="size-5 shrink-0" aria-hidden="true" />
            No messages yet. Conversations between agents, and with you, appear here.
          </p>
        ) : (
          <ol className="m-0 list-none divide-y divide-border p-0">
            {rows.map((thread) => {
              const open = openId === thread.id;
              const chip = chipOf(thread.last);
              const link = thread.link === undefined ? undefined : links.find((l) => l.id === thread.link);
              return (
                <li key={thread.id}>
                  <button
                    type="button"
                    data-slot="thread-row"
                    aria-expanded={open}
                    onClick={() => setOpenId(open ? null : thread.id)}
                    className="grid min-h-11 w-full grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 px-3 py-3 text-left transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:grid-cols-[auto_96px_200px_minmax(0,1fr)_auto] sm:gap-x-4 sm:px-4"
                  >
                    <HugeiconsIcon icon={open ? ArrowDown01Icon : ArrowRight01Icon} className="mt-0.5 size-4 text-muted-foreground" aria-hidden="true" />
                    <span className="loop-time sm:pt-0.5">{whenText(thread.last.at, now)}</span>
                    <span className="loop-route col-start-2 truncate sm:col-start-auto sm:pt-0.5">
                      {thread.who.map((name) => legendOf(name, agents)).join(' · ')}
                    </span>
                    <span className="col-start-2 flex min-w-0 flex-col gap-1 sm:col-start-auto">
                      <span className="loop-subject break-words">{thread.title}</span>
                      {link !== undefined && (
                        <span className="chip self-start" data-tone="quiet">
                          LINK · {linkLine(link as LinkItem)}
                        </span>
                      )}
                      <span className="loop-note">{countText(thread.items.length)}</span>
                    </span>
                    {chip.tone !== 'quiet' && (
                      <span className="chip col-start-3 row-start-1 sm:col-start-auto sm:row-start-auto" data-tone={chip.tone}>
                        {chip.text}
                      </span>
                    )}
                  </button>
                  {open && <Open thread={thread} agents={agents} now={now} />}
                </li>
              );
            })}
          </ol>
        )}
        {threads.length > rows.length && (
          <p className="hint border-t border-border px-4 py-3">
            The {MAX_ROWS} threads with the newest messages are shown, of {threads.length}.
          </p>
        )}
      </div>
    </section>
  );
}
