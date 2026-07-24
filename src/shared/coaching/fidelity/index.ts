/**
 * Local critical-term comparator (§19, §25.5).
 *
 * Produces `CoachCandidate`s in the `fidelity_critical` band from a comparison
 * of authored script text against the aligned transcript. See
 * `comparator.ts` for the design rules; the short version is that every path
 * through this subsystem is biased toward silence, and `material_meaning_change`
 * is deliberately never produced locally because §25.5 reserves materiality for
 * Luna.
 */
export { alignmentLinksFromMatchedPairs, toCriticalChecks } from './assist-bridge';
export {
  compareSpanFidelity,
  type AlignmentLink,
  type FidelityComparison,
  type FidelitySpanObservation,
  type SpokenTokenObservation,
  type TermVerdict,
} from './comparator';
export {
  extractCriticalTerms,
  type AuthoredToken,
  type CriticalTerm,
  type CriticalTermKind,
  type ExtractedTerms,
} from './terms';
export { normalizeWords, safeFragment, type NormalWord } from './normalize';
export { findNameRendering, nameIsPresent, NAME_MATCH_THRESHOLD, NAME_MISMATCH_THRESHOLD } from './names';
export { countNegations, findNegations, negates } from './negation';
export { findNumberRuns, numberVariants, parseNumberAt } from './numbers';
export { findUnits, unitBySurface, unitVariants, type UnitDefinition, type UnitDimension } from './units';
