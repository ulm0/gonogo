/** The words of the version key of the top bar: what it shows, and its name, which holds what it shows (WCAG 2.5.3). */
export function versionLabel(version: string, newer: string | null): { text: string; name: string } {
  return newer === null ? { text: `${version} ✓`, name: `${version} ✓: gonogo ${version}, up to date` } : { text: `${version} → ${newer}`, name: `${version} → ${newer}: gonogo ${version}, ${newer} is out` };
}
