/**
 * Cleaning for auto-review (docs/auto-review-spec.md step 6 and RSO R3): everything a reviewer writes passes here before it can leave for GitHub.
 * A reviewer read an attacker's text, so what it wrote is treated as hostile: secrets redacted, control and bidi characters removed, `@mentions` and
 * `#123` references neutralized (no pings, no backlinks), a line that starts with `/` quoted (no slash-command bots), images and raw HTML removed,
 * links shown as text. A finding must name a file and a line that are in the diff, or it is dropped.
 */
import { parseDiff } from '../shared/diff.js';
import type { ReviewFileDiff } from '../shared/protocol.js';
import { redactSecrets } from './triggers.js';

/** The characters of a text field that must never reach GitHub: C0 (but not the newline), DEL, C1, and bidi/zero-width controls. */
const UNSAFE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;
/** A zero-width space after the `@` or `#` keeps the text readable and stops GitHub from linking it. */
const ZWSP = '​';

export const FINDINGS_MAX = 20;
export const FINDING_CHARS = 2000;
export const SUMMARY_CHARS = 4000;
export const SEVERITIES = ['info', 'low', 'medium', 'high'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** One piece of text, cleaned; `max` characters at most. */
export function cleanText(input: string, max: number): string {
  let text = String(input).replace(UNSAFE, ' ').replace(/\r\n?/g, '\n');
  // images: an image URL is a way out for data. Raw HTML is not stripped (a pattern that removes tags can be fooled by `<scr<script>ipt>`): every < and > is escaped below, so a tag is only text
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '[image removed]');
  // a link shows as its text, then its address as plain text without the scheme (a bare URL autolinks; this does not)
  text = text.replace(/\[([^\]]*)\]\(\s*<?([^)>\s]*)>?[^)]*\)/g, (_m, label: string, url: string) => `${label} (${url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\./g, `.${ZWSP}`)})`);
  text = text.replace(/\bhttps?:\/\/\S+/gi, (url) => url.replace(/^https?:\/\//i, '').replace(/\./g, `.${ZWSP}`));
  // secrets last of the markup steps: its patterns eat a closing bracket, so it must not run before the links are made plain
  text = redactSecrets(text);
  // mentions and references: `@user` `@org/team`, `#12`, `owner/repo#12`, and a commit sha is left alone
  text = text.replace(/(^|[^A-Za-z0-9_`])@([A-Za-z0-9_-])/g, `$1@${ZWSP}$2`).replace(/\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)/g, `$1#${ZWSP}$2`).replace(/(^|[^A-Za-z0-9_&])#(\d+)/g, `$1#${ZWSP}$2`);
  // no markup at all: < and > become entities, so there is no tag to hide in, whatever the nesting
  text = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // a line that starts with a slash is a command to a bot (/lgtm, /approve, /merge, /retest): quote it
  text = text
    .split('\n')
    .map((line) => (/^\s*\//.test(line) ? `> ${line.trim()}` : line))
    .join('\n');
  return text.slice(0, max).trim();
}

export interface Finding {
  file: string;
  line: number;
  severity: Severity;
  text: string;
}

/** The lines of the new side that a review comment can sit on: added and context lines, by file. */
export function commentableLines(files: readonly ReviewFileDiff[]): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const f of files) {
    const lines = new Set<number>();
    for (const h of f.hunks) for (const l of h.lines) if (l.new !== null) lines.add(l.new);
    out.set(f.path, lines);
  }
  return out;
}

/** What `pr_review_submit` gave, as untrusted JSON: a summary and findings. Returns the cleaned summary, the kept findings and how many were dropped (with why). */
export function cleanSubmission(input: unknown, diff: string): { ok: true; summary: string; findings: Finding[]; dropped: string[] } | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, error: 'the review must be an object with summary and findings' };
  const { summary, findings } = input as { summary?: unknown; findings?: unknown };
  if (typeof summary !== 'string' || summary.trim() === '') return { ok: false, error: 'summary must be text' };
  if (!Array.isArray(findings)) return { ok: false, error: 'findings must be a list' };
  if (findings.length > FINDINGS_MAX) return { ok: false, error: `at most ${FINDINGS_MAX} findings` };
  const where = commentableLines(parseDiff(diff));
  const kept: Finding[] = [];
  const dropped: string[] = [];
  for (const f of findings) {
    const item = typeof f === 'object' && f !== null ? (f as Record<string, unknown>) : {};
    const file = typeof item.file === 'string' ? item.file : '';
    const line = typeof item.line === 'number' && Number.isInteger(item.line) ? item.line : -1;
    const severity = (SEVERITIES as readonly unknown[]).includes(item.severity) ? (item.severity as Severity) : null;
    const text = typeof item.text === 'string' ? cleanText(item.text, FINDING_CHARS) : '';
    if (severity === null || text === '') dropped.push(`${file}:${line}: not a valid finding`);
    else if (where.get(file)?.has(line) !== true) dropped.push(`${file}:${line}: not a line of the diff`);
    else kept.push({ file, line, severity, text });
  }
  return { ok: true, summary: cleanText(summary, SUMMARY_CHARS), findings: kept, dropped };
}
