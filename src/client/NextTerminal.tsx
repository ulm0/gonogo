/** The toolbar over the terminal in the prototype layout (docs/ui-semantic.md, "The console panel and its terminal"): size, Copy (four ways), Find, Latest, Full screen, Expand, and Select for a phone. */
import { useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { NextPop } from './NextPop.js';
import { setNext, useNext } from './nextState.js';
import { panes } from './TerminalPane.js';
import { copyText } from './uplink.js';

const COPIES: ReadonlyArray<{ mode: 'selection' | 'last' | 'screen' | 'all'; label: string }> = [
  { mode: 'selection', label: 'Selection' },
  { mode: 'last', label: 'Last answer' },
  { mode: 'screen', label: 'The screen' },
  { mode: 'all', label: 'All scrollback' },
];

export function TerminalBar({ phone = false }: { phone?: boolean }): ReactElement {
  const expanded = useNext((s) => s.expanded);
  const [said, setSaid] = useState('');
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState('');
  const [selectText, setSelectText] = useState<string | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const tools = (): NonNullable<typeof panes.current> | null => panes.current;
  const copy = (mode: 'selection' | 'last' | 'screen' | 'all'): void => {
    const text = tools()?.text(mode) ?? '';
    if (text === '') {
      setSaid(mode === 'selection' ? 'Nothing is selected.' : 'Nothing to copy.');
      return;
    }
    void copyText(text).then((ok) => setSaid(ok ? `Copied ${text.split('\n').length} lines.` : 'The browser refused the copy: use Select.'));
  };
  const find = (backwards: boolean): void => setSaid(tools()?.find(query, backwards) === true ? '' : 'Not found.');
  return (
    <div className="next-termbar" role="toolbar" aria-label="Terminal" ref={box}>
      <span className="hint">Terminal</span>
      <span className="topbar-grow" />
      <button type="button" className="btn" data-kind="quiet" aria-label="Smaller letters" onClick={() => tools()?.fontSize(-1)}>
        A−
      </button>
      <button type="button" className="btn" data-kind="quiet" aria-label="Larger letters" onClick={() => tools()?.fontSize(1)}>
        A+
      </button>
      <NextPop label="Copy ▾" name="Copy" align="end">
        {(close) => (
          <div className="next-menu" role="group" aria-label="Copy">
            {COPIES.map((c) => (
              <button
                key={c.mode}
                type="button"
                className="btn next-item"
                data-kind="quiet"
                onClick={() => {
                  copy(c.mode);
                  close();
                }}
              >
                {c.label}
              </button>
            ))}
          </div>
        )}
      </NextPop>
      <button type="button" className="btn" data-kind="quiet" aria-pressed={finding} onClick={() => setFinding(!finding)}>
        Find
      </button>
      <button type="button" className="btn" data-kind="quiet" aria-label="Scroll to the latest line" onClick={() => tools()?.latest()}>
        ↓ Latest
      </button>
      {phone ? (
        <button type="button" className="btn" data-kind="quiet" onClick={() => setSelectText(tools()?.text('tail') ?? '')}>
          Select
        </button>
      ) : (
        <>
          <button type="button" className="btn" data-kind="quiet" onClick={() => void (document.fullscreenElement !== null ? document.exitFullscreen() : document.querySelector('.pane')?.requestFullscreen())}>
            Full screen
          </button>
          <button
            type="button"
            className="btn"
            data-kind="quiet"
            aria-pressed={expanded}
            onClick={() => {
              setNext((s) => ({ ...s, expanded: !s.expanded }));
              // the terminal changes width: fit it after the layout has moved, not before
              setTimeout(() => tools()?.refit(), 200);
            }}
          >
            {expanded ? 'Back to the room' : 'Expand'}
          </button>
        </>
      )}
      {finding && (
        <form
          className="next-find"
          onSubmit={(e) => {
            e.preventDefault();
            find(false);
          }}
        >
          <input className="input" aria-label="Find in the terminal" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find…" />
          <button type="button" className="btn" data-kind="quiet" aria-label="Previous match" onClick={() => find(true)}>
            ↑
          </button>
          <button type="submit" className="btn" data-kind="quiet" aria-label="Next match">
            ↓
          </button>
        </form>
      )}
      {said !== '' && (
        <span className="hint" role="status">
          {said}
        </span>
      )}
      {selectText !== null && (
        <div className="next-select module" role="dialog" aria-label="Select text">
          <div className="next-pop-head">
            <b>Last 300 lines</b>
            <button type="button" className="btn" data-kind="quiet" onClick={() => setSelectText(null)}>
              Close
            </button>
          </div>
          <pre tabIndex={0}>{selectText}</pre>
        </div>
      )}
    </div>
  );
}
