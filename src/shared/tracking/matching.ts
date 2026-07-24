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

/** The best score this transcript token could possibly contribute. */
export function idealTokenScore(token: LedgerToken, profile: TrackingProfile): number {
  if (token.filler) return 0;
  const weight = token.content ? profile.normalWeight : profile.stopwordWeight;
  return (token.content ? profile.exactScore : profile.weakScore) * weight;
}
