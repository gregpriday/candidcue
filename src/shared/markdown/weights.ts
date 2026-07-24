/**
 * Token weights (spec §25.7). Indicative defaults plus a mild within-script
 * inverse-frequency bump, clamped so one unusual token can never force a
 * global jump.
 */
import { TOKEN_FLAGS } from '../contracts';
import { isStopword } from './stopwords';

export const WEIGHT_STOPWORD = 0.35;
export const WEIGHT_COMMON = 1.0;
export const WEIGHT_LESS_COMMON = 1.2;
export const WEIGHT_PROPER_NOUN = 1.5;
export const WEIGHT_OVERRIDE_ANCHOR = 1.65;
export const WEIGHT_MIN = 0.2;
export const WEIGHT_MAX = 1.65;

export function computeTokenWeight(
  normalized: string,
  flags: number,
  frequency: number,
  totalTokens: number,
): number {
  let weight: number;
  if ((flags & TOKEN_FLAGS.DIRECTIVE_ALIAS) !== 0) {
    weight = WEIGHT_OVERRIDE_ANCHOR;
  } else if ((flags & TOKEN_FLAGS.PUNCTUATION) !== 0) {
    return 0;
  } else if (isStopword(normalized) || normalized.length <= 1) {
    weight = WEIGHT_STOPWORD;
  } else if ((flags & TOKEN_FLAGS.PROPER_NOUN) !== 0) {
    weight = WEIGHT_PROPER_NOUN;
  } else if ((flags & TOKEN_FLAGS.NUMBER) !== 0) {
    weight = WEIGHT_LESS_COMMON;
  } else {
    weight = WEIGHT_COMMON;
    // Within-script IDF: rare content words anchor better.
    if (totalTokens >= 50 && frequency <= 2 && normalized.length >= 4) {
      weight = WEIGHT_LESS_COMMON;
    }
  }
  return Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, weight));
}
