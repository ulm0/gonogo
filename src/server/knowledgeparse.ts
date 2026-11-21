/**
 * The grammar of anchors (docs/knowledge-spec.md 0b.3), as the store and the proposals use it: `parseLegs` turns the anchor lines of a
 * claim into legs and says, with the line, what is wrong. K2 (the ported multivac parser, the regex gate, the glob matcher) replaces
 * the body of this file; until then every anchor line is kept as text and means no leg, so nothing here refuses a line the engine
 * would. The names below are the contract between K1 (the store) and K2 (the engine).
 */
import { noLegs } from './claimsfile.js';
import type { ParseLegs } from './claimsfile.js';

export type { ParseLegs };
export const parseLegs: ParseLegs = noLegs;
