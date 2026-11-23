/** The words of the version key of the top bar: what it shows, and its name, which holds what it shows (WCAG 2.5.3). */
export function versionLabel(version: string, newer: string | null, phone = false): { text: string; name: string } {
  if (newer === null) return { text: `${version} ✓`, name: `${version} ✓: gonogo ${version}, up to date` };
  // a phone has no room for both versions beside the logo and Jump: the one that is out, with an arrow up
  const text = phone ? `↑ ${newer}` : `${version} → ${newer}`;
  return { text, name: `${text}: gonogo ${version}, ${newer} is out` };
}
