/**
 * Weighted speech units (companion §6).
 *
 * Raw token counts are a poor pace coordinate: "a" and "internationalization"
 * are both one token but do not take the same time to deliver, and punctuation
 * changes timing. This module turns the compiled spoken tokens into the
 * cumulative, continuous `speechUnit` coordinate the semantic filter and the
 * stage motion path both use:
 *
 *   speechUnit[0]     = 0
 *   speechUnit[i + 1] = speechUnit[i] + speechWeight[i]
 *
 * Pure and deterministic; every weight comes from `TrackingProfile`.
 */
import type { TrackingProfile } from './profile';
import type { PauseAnchor, SpokenToken, TrackingDocument } from './types';
import { TOKEN_FLAG } from './types';
import { STOPWORDS } from './normalize';

export class SpeechUnitScale {
  /** `boundaries[i]` is the unit coordinate at the *start* of token `i`. */
  private readonly boundaries: Float64Array;
  private readonly weights: Float64Array;
  readonly tokenCount: number;
  readonly totalUnits: number;

  constructor(document: TrackingDocument, profile: TrackingProfile) {
    const tokens = document.spokenTokens;
    this.tokenCount = tokens.length;
    this.weights = new Float64Array(this.tokenCount);
    this.boundaries = new Float64Array(this.tokenCount + 1);

    // Sentence and block ends carry the virtual pause weight (§6.2): the
    // predicted trajectory may slow at a boundary without the aligner having
    // to interpret silence as loss of position.
    const sentenceEnds = new Set<number>();
    for (const sentence of document.sentences) sentenceEnds.add(sentence.endTokenIndex);
    const blockEnds = new Set<number>();
    let previousBlockId: string | undefined;
    for (let i = tokens.length - 1; i >= 0; i--) {
      const token = tokens[i];
      if (token === undefined) continue;
      if (previousBlockId !== undefined && token.blockId !== previousBlockId) blockEnds.add(i);
      previousBlockId = token.blockId;
    }
    if (tokens.length > 0) blockEnds.add(tokens.length - 1);

    // §6.1 clause boundaries and authored pause directives. Both are derived
    // once, at projection time (`buildTrackingDocument`), because neither
    // survives into `SpokenToken`: the compiler emits no punctuation token at
    // all, and a `[Pause]` is a `CueEvent`, not a token.
    const clauseEnds = new Set(document.clauseEndTokenIndexes ?? []);
    const authoredPause = new Map<number, number>();
    for (const anchor of document.pauseAnchors ?? []) {
      const at = anchor.tokenIndex;
      if (!Number.isInteger(at) || at < 0 || at >= tokens.length) continue;
      authoredPause.set(at, (authoredPause.get(at) ?? 0) + authoredPauseWeight(anchor, profile));
    }

    let running = 0;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      this.boundaries[i] = running;
      const weight = token === undefined ? 0 : speechWeightOf(token, profile);
      let total = weight;
      // Structural pauses are exclusive — a paragraph end is not additionally a
      // sentence end and a comma before a full stop is not an extra breath.
      if (blockEnds.has(i)) total += profile.unitBlockEndPause;
      else if (sentenceEnds.has(i)) total += profile.unitSentenceEndPause;
      else if (clauseEnds.has(i)) total += profile.unitClausePause;
      // An authored pause is not structural: the writer asked for silence on
      // top of whatever the punctuation already implies, so it adds.
      total += authoredPause.get(i) ?? 0;
      this.weights[i] = total;
      running += total;
    }
    this.boundaries[tokens.length] = running;
    this.totalUnits = running;
  }

  weightAt(tokenIndex: number): number {
    return this.weights[clampIndex(tokenIndex, this.tokenCount - 1)] ?? 0;
  }

  /**
   * Unit coordinate of a (possibly fractional) token position. `125.4` means
   * "40 % of the way through token 125" (companion §5.2).
   */
  unitAt(tokenPosition: number): number {
    if (this.tokenCount === 0) return 0;
    if (!Number.isFinite(tokenPosition)) return 0;
    if (tokenPosition <= 0) return 0;
    if (tokenPosition >= this.tokenCount) return this.totalUnits;
    const whole = Math.floor(tokenPosition);
    const fraction = tokenPosition - whole;
    const start = this.boundaries[whole] ?? 0;
    return start + fraction * (this.weights[whole] ?? 0);
  }

  /** Inverse of {@link unitAt}: the fractional token position at `unit`. */
  tokenAt(unit: number): number {
    if (this.tokenCount === 0) return 0;
    if (!Number.isFinite(unit) || unit <= 0) return 0;
    if (unit >= this.totalUnits) return this.tokenCount - 1;
    // Binary search over the monotone boundary array.
    let low = 0;
    let high = this.tokenCount - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((this.boundaries[mid] ?? 0) <= unit) low = mid;
      else high = mid - 1;
    }
    const start = this.boundaries[low] ?? 0;
    const weight = this.weights[low] ?? 0;
    const fraction = weight > 0 ? Math.min(1, (unit - start) / weight) : 0;
    return low + fraction;
  }

  /** Integer token index at `unit`, clamped into the document. */
  tokenIndexAt(unit: number): number {
    return clampIndex(Math.floor(this.tokenAt(unit)), this.tokenCount - 1);
  }

  /** Signed unit distance between two token positions. */
  distanceUnits(fromTokenPosition: number, toTokenPosition: number): number {
    return this.unitAt(toTokenPosition) - this.unitAt(fromTokenPosition);
  }
}

/** Companion §6.1 "explicit pause directive: authored duration or weight". */
function authoredPauseWeight(anchor: PauseAnchor, profile: TrackingProfile): number {
  switch (anchor.kind) {
    case 'beat':
      return profile.unitBeatPause;
    case 'breathe':
      return profile.unitBreathePause;
    default:
      return profile.unitAuthoredPause;
  }
}

/** Companion §6.1 initial token weighting. */
export function speechWeightOf(token: SpokenToken, profile: TrackingProfile): number {
  // Non-spoken content contributes no delivery time.
  if ((token.flags & TOKEN_FLAG.nonNavigation) !== 0 && token.normalized.length === 0) return 0;
  // Kept for producers that mark punctuation as a token; the CandidCue compiler
  // is not one of them (`markdown/tokenize.ts` never emits one), which is why
  // §6.1's comma weight arrives through `TrackingDocument.clauseEndTokenIndexes`
  // instead of through a flag on a token that does not exist.
  if ((token.flags & TOKEN_FLAG.punctuation) !== 0) return 0;

  const length = token.normalized.length;
  const stopword = (token.flags & TOKEN_FLAG.stopword) !== 0 || STOPWORDS.has(token.normalized);
  if (stopword && length <= profile.unitShortTokenChars) return profile.unitStopwordWeight;
  if (length >= profile.unitLongTokenChars) return profile.unitLongWeight;
  return profile.unitNormalWeight;
}

function clampIndex(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  if (max < 0) return 0;
  return Math.max(0, Math.min(max, Math.floor(value)));
}
