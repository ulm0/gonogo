import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AutoReviewBlock, DraftView } from '../src/client/AutoReview.js';
import type { AutoReviewDraft } from '../src/shared/protocol.js';

const draft: AutoReviewDraft = {
  job: 'rv1',
  repo: 'o/r',
  pr: 7,
  sha: 'a'.repeat(40),
  usd: 0.0123,
  parts: [
    { position: 'rso', summary: 'ABORT: injection', findings: [{ file: 'src/a.ts', line: 6, severity: 'high', text: 'execSync with input' }, { file: 'src/a.ts', line: 1, severity: 'info', text: 'throwaway' }], dropped: [] },
    { position: 'retro', summary: 'Do not merge', findings: [], dropped: ['x:12: not a line of the diff', 'x:15: not a line of the diff'] },
  ],
};

describe('the draft of a review', () => {
  const html = renderToString(createElement(DraftView, { draft }));
  it('shows each reviewer, its summary, and each finding with file, line and severity', () => {
    expect(html).toContain('RSO');
    expect(html).toContain('RETRO');
    expect(html).toContain('ABORT: injection');
    expect(html).toContain('src/a.ts');
    expect(html).toMatch(/data-tone="alert"[^>]*>high</);
    expect(html).toContain('execSync with input');
  });
  it('says how many findings were dropped for not being on a line of the diff, and the cost', () => {
    expect(html).toContain('2 finding(s) dropped');
    expect(html).toContain('$0.01');
  });
  it('is text only: no link, no image and no HTML from a finding becomes an element', () => {
    const hostile = renderToString(createElement(DraftView, { draft: { ...draft, parts: [{ position: 'rso', summary: '<img src=x onerror=alert(1)> <script>x</script>', findings: [], dropped: [] }] } }));
    expect(hostile).not.toMatch(/<img|<script/);
    expect(hostile).toContain('&lt;img');
  });
  it('the block renders its heading before it has read anything', () => {
    expect(renderToString(createElement(AutoReviewBlock))).toContain('AUTO-REVIEW');
  });
});
