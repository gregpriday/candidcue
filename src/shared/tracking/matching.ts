/**
 * Token matching features (spec §31.4): exact, alias, deterministic
 * equivalents (numbers/contractions), light edit similarity, phonetic
 * similarity, and weak/common-word matches, weighted by script-token weight.
 */
import {
  contractionEquivalent,
  lexicallySimilar,
  numberEquivalent,
  phoneticallySimilar,
  STOPWORDS,
} from './normalize';
import type { TrackingProfile } from './profile';
import type { LedgerToken, MatchedPair, SpokenToken } from './types';
import { TOKEN_FLAG } from './types';

export type MatchKind = MatchedPair['kind'];

export interface TokenMatch {
  kind: MatchKind;
  /** Weighted positive score contribution. */
  score: number;
}

export function isStopwordToken(token: SpokenToken): boolean {
  return (token.flags & TOKEN_FLAG.stopword) !== 0 || STOPWORDS.has(token.normalized);
}

/**
 * Score one transcript token against one script token, or undefined for no
 * usable match. Weak matches on common words score low so that stopword runs
 * cannot fake a lock (spec §31.4).
 */
export function matchTokens(
  transcript: LedgerToken,
  script: SpokenToken,
  profile: TrackingProfile,
): TokenMatch | undefined {
  const t = transcript.normalized;
  const s = script.normalized;
  const weight = script.weight;
  const stopword = isStopwordToken(script);

  if (t === s) {
    if (stopword) {
      return { kind: 'weak', score: profile.weakScore * Math.max(weight, profile.stopwordWeight) };
    }
    return { kind: 'exact', score: profile.exactScore * weight };
  }
  if (script.aliases.includes(t)) {
    return { kind: 'alias', score: profile.explicitAliasScore * weight };
  }
  if (numberEquivalent(t, s) || contractionEquivalent(t, s)) {
    return { kind: 'equivalent', score: profile.equivalentScore * weight };
  }
  if (stopword) return undefined; // fuzzy matches on stopwords are noise
  if (lexicallySimilar(t, s)) {
    return { kind: 'fuzzy', score: profile.fuzzyScore * weight };
  }
  if (phoneticallySimilar(t, s)) {
    return { kind: 'phonetic', score: profile.phoneticScore * weight };
  }
  return undefined;
}

/**
 * The best score this transcript token could contribute when nothing in the
 * script matched it — an estimate made from the transcript side alone, because
 * there is no script token to ask.
 */
export function idealTokenScore(token: LedgerToken, profile: TrackingProfile): number {
  if (token.filler) return 0;
  const weight = token.content ? profile.normalWeight : profile.stopwordWeight;
  return (token.content ? profile.exactScore : profile.weakScore) * weight;
}

/**
 * The best score this PAIRING could have produced — what `matchTokens` returns
 * when the two tokens are identical.
 *
 * Normalizing a match against `idealTokenScore` instead of this made the score
 * asymmetric, and a word-perfect read unable to reach 1.0. The two functions
 * judge "is this word worth anything" from opposite sides: `matchTokens` uses
 * the SCRIPT token's weight and stopword flag, `idealTokenScore` uses the
 * TRANSCRIPT token's `content` flag. They come from different lists — the
 * compiler marked `say`, `way` and `them` as low-weight, the ledger called
 * them content — so each such word scored 0.175 against a demanded 3.0.
 *
 * On the app's own starter script that capped a perfect read at 0.55, which
 * the confidence model turned into 0.60 against a `lockedThreshold` of 0.78.
 * The aligner could not commit a single token of a word-perfect read, of any
 * script, ever.
 */
export function idealPairScore(script: SpokenToken, profile: TrackingProfile): number {
  return isStopwordToken(script)
    ? profile.weakScore * Math.max(script.weight, profile.stopwordWeight)
    : profile.exactScore * script.weight;
}
