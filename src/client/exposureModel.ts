/** The insecure-setup banner (docs: GET /api/exposure/findings), with no React: which findings it shows, in which order, and its words. */
import type { ExposureFindingView } from '../shared/protocol.js';

/** (An id is the kind alone, or the kind and a 12-hex subject: `no-login-<hash>`.) Said elsewhere already: no login has its own strip at the top (SetupStrip), and a newer version has the update strip and the version key. Nothing is said twice. */
const ELSEWHERE = new Set(['no-login', 'version-behind']);

const RANK = { high: 0, medium: 1, info: 2 } as const;

/** The findings the banner lists: the most severe first (the server's order within a severity), without what another strip says. */
export function bannerFindings(list: readonly ExposureFindingView[]): ExposureFindingView[] {
  return list.filter((f) => ![...ELSEWHERE].some((kind) => f.id === kind || f.id.startsWith(`${kind}-`))).map((f, i) => ({ f, i })).sort((a, b) => RANK[a.f.severity] - RANK[b.f.severity] || a.i - b.i).map(({ f }) => f);
}

/** At most this many rows are drawn at once; the rest are one key away (a phone shows little more than this; sixteen agents without a hold would fill the screen). */
export const BANNER_ROWS = 2;

export const SEVERITY_WORDS = { high: 'High', medium: 'Medium', info: 'Note' } as const;

/** The banner's tone: red when anything is high, else amber. */
export const bannerTone = (list: readonly ExposureFindingView[]): 'nogo' | 'amber' => (list.some((f) => f.severity === 'high') ? 'nogo' : 'amber');

export const bannerTitle = (count: number): string => (count === 1 ? 'One thing to look at in this setup' : `${count} things to look at in this setup`);

/** Any write of this page may change what is open in the setup: the banner reads its list again. */
export const EXPOSURE_REFRESH = 'gonogo:exposure-refresh';

/** The writes that can open or close a finding: Flight Rules and the settings, keys and the login, Docking, hiring and editing an agent. A message or a vote cannot, and the list asks every room. */
export const changesExposure = (method: string, path: string): boolean =>
  method !== 'GET' && /^\/(features|settings|rules|permissions|room|room-keys|project-folder|startup|governor|autoupdate|relay|uplinks|coauthor|egress|global-mcp|models|subagents|payload-defaults|semantic|docking|agents|auth)(\/|\?|$)/.test(path);
