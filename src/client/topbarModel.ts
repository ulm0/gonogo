/** The words of the version key of the top bar. */
export function versionLabel(version: string, newer: string | null): { text: string; name: string } {
  return newer === null ? { text: `${version} ✓`, name: `gonogo ${version}, up to date` } : { text: `${version} → ${newer}`, name: `gonogo ${version}, ${newer} is out` };
}
