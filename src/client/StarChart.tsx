/**
 * Star Chart: the Mission Log drawn as a graph of entries, tags and authors, and the same graph as lists. Both are views of the
 * chart the server worked out (GET /api/log/chart); the page only places the nodes (chart.ts). Plain SVG and CSS, no library.
 * Choosing an entry opens it in the reader of the Mission Log; choosing a tag or an author lights what it is joined to.
 * The drawing has one tab stop and the arrow keys walk its nodes; the lists are the way for a screen reader and for a phone.
 */
import { useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';
import type { AgentView, ChartNode, LogChart } from '../shared/protocol.js';
import { CHART_HEIGHT, CHART_WIDTH, chartText, layout, links, neighbours, nodeText } from './chart.js';
import { legendOf } from './loop.js';
import { useStore } from './store.js';
import './chart.css';

interface Props {
  chart: LogChart;
  /** The entry that is open in the reader, if any. */
  openId: string | null;
  onOpen(id: string): void;
}

/** Up to this many nodes every entry shows its id; with more, an id shows under the pointer or the keyboard. */
const LABEL_ALL = 40;
const radius = (node: ChartNode): number => 5 + Math.min(node.weight - 1, 4);
/** An author reads as the call sign of its position, as everywhere else; a tag and an entry as written. */
const whoOf = (node: ChartNode, agents: Readonly<Record<string, AgentView>>): string => (node.kind === 'author' ? legendOf(node.ref, agents) : node.label);

function Shape({ node }: { node: ChartNode }): ReactElement {
  // the shape says what a node is, as well as its colour: a circle, a diamond, a square
  if (node.kind === 'entry') return <circle className="chart-shape" r={radius(node)} />;
  if (node.kind === 'tag') return <rect className="chart-shape" x={-6.5} y={-6.5} width={13} height={13} transform="rotate(45)" />;
  return <rect className="chart-shape" x={-8} y={-8} width={16} height={16} rx={3} />;
}

export function Chart({ chart, openId, onOpen }: Props): ReactElement {
  const agents = useStore((s) => s.agents);
  const spots = useMemo(() => layout(chart), [chart]);
  const [picked, setPicked] = useState<string | null>(null);
  const [tab, setTab] = useState<string | null>(null);
  const refs = useRef(new Map<string, SVGGElement>());
  const ids = chart.nodes.map((n) => n.id);
  const active = picked !== null && spots.has(picked) ? picked : null;
  const near = useMemo(() => (active === null ? null : neighbours(chart, active)), [chart, active]);
  const stop = tab !== null && spots.has(tab) ? tab : (ids[0] ?? null);
  const who = (node: ChartNode): string => whoOf(node, agents);
  const current = active === null ? undefined : chart.nodes.find((n) => n.id === active);

  const choose = (node: ChartNode): void => {
    if (node.kind === 'entry') onOpen(node.ref);
    else setPicked(active === node.id ? null : node.id);
  };
  const walk = (event: KeyboardEvent): void => {
    const at = Math.max(ids.indexOf(stop ?? ''), 0);
    const to = event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1 : event.key === 'ArrowRight' || event.key === 'ArrowDown' ? at + 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? at - 1 : null;
    if (to === null || ids.length === 0) return;
    event.preventDefault();
    refs.current.get(ids[Math.min(ids.length - 1, Math.max(0, to))] ?? '')?.focus();
  };

  return (
    <div className="chart module">
      <svg className="chart-svg" viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} role="group" aria-label="Star chart of the Mission Log: entries, tags and authors" onKeyDown={walk}>
        <defs>
          <marker id="chart-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path className="chart-arrow" d="M0 0 L8 4 L0 8 z" />
          </marker>
        </defs>
        <g aria-hidden="true">
          {chart.edges.map((edge) => {
            const a = spots.get(edge.from);
            const b = spots.get(edge.to);
            if (!a || !b) return null;
            const lit = active === null || edge.from === active || edge.to === active;
            return (
              <line
                key={`${edge.kind}:${edge.from}:${edge.to}`}
                className="chart-edge"
                data-kind={edge.kind}
                data-dim={lit ? undefined : ''}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                markerEnd={edge.kind === 'mention' ? 'url(#chart-arrow)' : undefined}
              />
            );
          })}
        </g>
        {chart.nodes.map((node) => {
          const spot = spots.get(node.id);
          if (!spot) return null;
          const open = node.kind === 'entry' && node.ref === openId;
          return (
            <g
              key={node.id}
              ref={(el) => {
                if (el) refs.current.set(node.id, el);
                else refs.current.delete(node.id);
              }}
              className="chart-node"
              data-kind={node.kind}
              data-dim={near === null || near.has(node.id) ? undefined : ''}
              transform={`translate(${spot.x} ${spot.y})`}
              role="button"
              tabIndex={node.id === stop ? 0 : -1}
              aria-pressed={node.kind === 'entry' ? open : active === node.id}
              aria-label={node.kind === 'entry' ? `Entry ${node.ref}: ${node.label}` : `${node.kind === 'tag' ? 'Tag' : 'Author'} ${nodeText(node, who(node))}`}
              onFocus={() => setTab(node.id)}
              onClick={() => choose(node)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                choose(node);
              }}
            >
              <title>{nodeText(node, who(node))}</title>
              <circle className="chart-hit" r={15} />
              <Shape node={node} />
              <text
                className="chart-label"
                data-show={node.kind !== 'entry' || chart.nodes.length <= LABEL_ALL ? '' : undefined}
                // a name near the right edge is written to the left of its node, so that the page does not cut it
                textAnchor={spot.x > CHART_WIDTH - 120 ? 'end' : 'start'}
                x={(node.kind === 'entry' ? 11 : 12) * (spot.x > CHART_WIDTH - 120 ? -1 : 1)}
                y={4}
              >
                {node.kind === 'entry' ? node.ref : who(node)}
              </text>
            </g>
          );
        })}
      </svg>
      <p className="hint chart-status" role="status">
        {current === undefined ? chartText(chart) : `${nodeText(current, who(current))}. The nodes joined to it are lit; choose it again to clear.`}
      </p>
      <p className="hint chart-key">
        Circle: entry. Diamond: tag. Square: author. Arrow: the entry names the other. Dashed: two tags that share entries. Arrow keys walk the nodes, Enter opens an entry. Links lists the same chart.
      </p>
    </div>
  );
}

/** The chart as lists: every entry with what it is joined to, then the tags and the authors with their entries. */
export function Links({ chart, openId, onOpen }: Props): ReactElement {
  const id = useId();
  const agents = useStore((s) => s.agents);
  const found = useMemo(() => links(chart), [chart]);
  const titles = new Map(found.entries.map((e) => [e.node.ref, e.node.label]));
  const ref = (entry: string): ReactElement => (
    <button key={entry} type="button" className="btn chart-ref" data-kind="quiet" aria-label={`Open ${entry}: ${titles.get(entry) ?? ''}`} aria-current={entry === openId ? 'true' : undefined} onClick={() => onOpen(entry)}>
      {entry}
    </button>
  );
  return (
    <div className="chart-links">
      <p className="hint">{chartText(chart)}</p>
      <section aria-labelledby={`${id}-entries`}>
        <h3 className="label" id={`${id}-entries`}>
          ENTRIES
        </h3>
        <ul className="chart-list">
          {found.entries.map((e) => (
            <li key={e.node.ref}>
              <button type="button" className="log-row" aria-current={e.node.ref === openId ? 'true' : undefined} onClick={() => onOpen(e.node.ref)}>
                <span className="log-row-top">
                  <span className="log-id">{e.node.ref}</span>
                  <span className="log-who">{legendOf(e.author, agents)}</span>
                </span>
                <span className="log-row-title">{e.node.label}</span>
                {e.tags.length > 0 && <span className="chart-rel">{`Tags: ${e.tags.join(', ')}`}</span>}
              </button>
              {e.mentions.length + e.mentionedBy.length > 0 && (
                <p className="chart-rel">
                  {e.mentions.length > 0 && <>Names {e.mentions.map(ref)}</>}
                  {e.mentionedBy.length > 0 && <>Named by {e.mentionedBy.map(ref)}</>}
                </p>
              )}
            </li>
          ))}
        </ul>
      </section>
      {[
        { key: 'tags', title: 'TAGS', rows: found.tags },
        { key: 'authors', title: 'AUTHORS', rows: found.authors },
      ].map(({ key, title, rows }) => (
        <section key={key} aria-labelledby={`${id}-${key}`}>
          <h3 className="label" id={`${id}-${key}`}>
            {title}
          </h3>
          <ul className="chart-list">
            {rows.map((group) => (
              <li key={group.node.id} className="chart-group">
                <p className="chart-name">{nodeText(group.node, whoOf(group.node, agents))}</p>
                {group.with.length > 0 && <p className="chart-rel">{`Shares entries with ${group.with.map((w) => `${w.tag} (${w.weight})`).join(', ')}`}</p>}
                <p className="chart-ids">{group.entries.map(ref)}</p>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
