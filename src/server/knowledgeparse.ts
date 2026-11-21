/**
 * The grammar of anchors (docs/knowledge-spec.md 0b.3), as the store and the proposals use it: `parseLegs` turns the anchor lines of a
 * claim into legs and says, with the line, what is wrong. It is the ported multivac parser of anchorgrammar.ts.
 */
import { parseLegLines } from './anchorgrammar.js';
import type { ParseLegs } from './claimsfile.js';

export type { ParseLegs };
export const parseLegs: ParseLegs = parseLegLines;
