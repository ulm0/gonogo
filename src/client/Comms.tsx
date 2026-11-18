/**
 * COMMS: one door for what is said in the room (docs/comms-analysis.md). Three tabs over the three views that were separate, each as it was:
 * INBOX is the Downlink (what needs the Director, read and archived kept on the server, the badge), TRAFFIC is the Loop (every message, with
 * an agent filter) and THREADS is Party Line. Nothing is merged underneath. The tab is remembered in this browser.
 */
import { useId } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';
import { Loop } from './Activity.js';
import { Downlink } from './Downlink.js';
import { PartyLine } from './PartyLine.js';
import { useAgentList } from './RoomView.js';
import { chooseCommsTab, COMMS_TABS, openConsole, setCommsAgent, showRoom, useStore } from './store.js';
import type { CommsTab } from './store.js';
import './comms.css';

export const COMMS_TAB_TEXT: Record<CommsTab, { label: string; hint: string }> = {
  inbox: { label: 'INBOX', hint: 'Messages to you and what the server noticed.' },
  traffic: { label: 'TRAFFIC', hint: 'Everything the agents send each other and you.' },
  threads: { label: 'THREADS', hint: 'The same messages as conversations.' },
};

export function Comms(): ReactElement {
  const id = useId();
  const tab = useStore((s) => s.commsTab);
  const agent = useStore((s) => s.commsAgent);
  const unread = useStore((s) => s.downlink.unread);
  const activity = useStore((s) => s.activity);
  const agents = useStore((s) => s.agents);
  const list = useAgentList();
  const move = (event: KeyboardEvent): void => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = COMMS_TABS[(COMMS_TABS.indexOf(tab) + step + COMMS_TABS.length) % COMMS_TABS.length] as CommsTab;
    chooseCommsTab(next);
    requestAnimationFrame(() => document.getElementById(`${id}-${next}`)?.focus());
  };
  return (
    <div className="comms">
      <div className="comms-bar">
        <div className="comms-tabs" role="tablist" aria-label="Comms" onKeyDown={move}>
          {COMMS_TABS.map((t) => (
            <button
              key={t}
              id={`${id}-${t}`}
              type="button"
              role="tab"
              className="btn comms-tab"
              data-kind={tab === t ? 'primary' : 'quiet'}
              aria-selected={tab === t}
              aria-controls={`${id}-panel`}
              tabIndex={tab === t ? 0 : -1}
              onClick={() => chooseCommsTab(t)}
            >
              {COMMS_TAB_TEXT[t].label}
              {t === 'inbox' && unread > 0 && (
                <span className="chip" data-tone="amber" aria-hidden="true">
                  {unread}
                </span>
              )}
            </button>
          ))}
        </div>
        <span className="hint comms-hint">{COMMS_TAB_TEXT[tab].hint}</span>
      </div>
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${tab}`} className="comms-panel">
        {tab === 'inbox' && <Downlink />}
        {tab === 'traffic' && <Loop items={activity} agents={agents} boss={list.find((a) => a.boss) ?? null} onSelect={openConsole} onClose={showRoom} agent={agent} onAgent={setCommsAgent} />}
        {tab === 'threads' && <PartyLine />}
      </div>
    </div>
  );
}
