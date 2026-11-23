/** The name of the Docking row of Flight Rules and its group: the row names the key that opens it. */
export const DOCKING_ROW = { group: 'auto', row: 'Docking: other stations' } as const;

/** A key elsewhere in the room that leads to one row of Flight Rules: the group to open and the row to open in it. Taken once by Flight Rules when it draws. */
let target: { group: string; row: string } | null = null;

export function openRules(group: string, row: string): void {
  target = { group, row };
}

export function takeRulesTarget(): { group: string; row: string } | null {
  const found = target;
  target = null;
  return found;
}
