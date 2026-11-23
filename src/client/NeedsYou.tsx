/**
 * COMMS, above the tabs: everything that waits on the Director, each with its answer on the spot: a hire request, a handoff FLIGHT asks to send, and a message that asks something
 * (GO or NO-GO keys for a go/no-go, a reply box for a question). An answered one leaves the list. Nothing is moved: the same requests are still in the room, answered by the same keys.
 */
import { useId, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import type { AgentView, DownlinkMessage } from '../shared/protocol.js';
import { Reply } from './Activity.js';
import * as api from './api.js';
import { HandoffNeed } from './HandoffAsks.js';
import { useHandoffAsks } from './linksData.js';
import { replyRequest, subjectOf, legendOf as nameOf } from './loop.js';
import { asksOf, needsCount, needsTitle, wantsGoNoGo } from './needsYou.js';
import { ReliefNeed, useSeats } from './RoomView.js';
import { useStore } from './store.js';
import { legendOf } from './wall.js';
import { useRun } from './WallView.js';
import './comms.css';

function Ask({ item, agents }: { item: DownlinkMessage; agents: Readonly<Record<string, AgentView>> }): ReactElement {
  const id = useId();
  const { busy, error, run } = useRun();
  const title = subjectOf(item);
  const done = async (): Promise<void> => void (await api.markRead([item.id]));
  const answer = (word: 'GO' | 'NO-GO'): void =>
    run(async () => {
      await api.sendMessage(replyRequest(item, word));
      await done();
    });
  return (
    <section className="flood need needs-ask" data-tone="amber" aria-labelledby={`${id}-t`}>
      <span className="led need-led" data-on="true" data-blink="true" aria-hidden="true" />
      <div className="need-text">
        <h3 className="disp need-title" id={`${id}-t`}>
          {nameOf(item.from, agents)}: {title}
        </h3>
        <p className="loop-body needs-body">
          {item.body}
          {item.truncated ? ' …(cut)' : ''}
        </p>
        {wantsGoNoGo(item) ? (
          <div className="go-buttons">
            <button type="button" className="btn" data-kind="danger" data-size="big" aria-disabled={busy || undefined} aria-label={`NO-GO: ${title}`} onClick={() => answer('NO-GO')}>
              NO-GO
            </button>
            <button type="button" className="btn" data-kind="primary" data-size="big" aria-disabled={busy || undefined} aria-label={`GO: ${title}`} onClick={() => answer('GO')}>
              GO
            </button>
          </div>
        ) : (
          <Reply item={item} agents={agents} onSent={() => void done()} />
        )}
        <button type="button" className="btn" data-kind="quiet" aria-label={`Not a question: ${title}`} aria-disabled={busy || undefined} onClick={() => run(done)}>
          Not a question
        </button>
        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

export function NeedsYou(): ReactElement | null {
  const items = useStore((s) => s.downlink.items);
  const agents = useStore((s) => s.agents);
  const relief = useStore((s) => s.relief);
  const handoffs = useHandoffAsks();
  const { legends } = useSeats();
  const [failed, setFailed] = useState<string | null>(null);
  const asks = useMemo(() => asksOf(items), [items]);
  const n = needsCount(asks.length, relief.length, handoffs.length);
  if (n === 0 && failed === null) return null;
  return (
    <section className="needs-you" aria-label={needsTitle(n)}>
      <h2 className="label needs-you-title">{needsTitle(n)}</h2>
      {failed !== null && (
        <section className="flood need" data-tone="nogo" role="alert">
          <p className="need-text relief-failed">{failed}</p>
          <button type="button" className="btn" data-size="big" onClick={() => setFailed(null)}>
            DISMISS
          </button>
        </section>
      )}
      {relief.map((request) => (
        <ReliefNeed key={request.id} request={request} legend={legendOf(legends, request.by)} onFail={setFailed} />
      ))}
      {handoffs.map((ask) => (
        <HandoffNeed key={ask.id} ask={ask} legend="FLIGHT" />
      ))}
      {asks.map((item) => (
        <Ask key={item.id} item={item} agents={agents} />
      ))}
    </section>
  );
}
