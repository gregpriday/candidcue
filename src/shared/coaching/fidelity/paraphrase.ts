/**
 * §25.5. The `material_meaning_change` **question**, not the answer.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE FILE FROM THE COMPARATOR
 * ---------------------------------------------------------------------------
 * `comparator.ts` states, at the top and correctly, that it never produces
 * `material_meaning_change`: deciding a paraphrase changed the meaning is a
 * semantic judgement and §25.5 reserves materiality for Luna. The observer
 * states, also correctly, that it rejects any Luna code the local candidate
 * types do not permit (§23.1). Composed, the candidate type, the
 * `LunaCoachTipCode`, the catalog entry and the `MATERIAL_DIFFERENCE_CONFIRMED`
 * reason code were all unreachable — a deadlock between two rules that are each
 * right on their own.
 *
 * Of the two available resolutions, this is the one that keeps both rules
 * intact. An explicit escalation rule — "let Luna raise this one code without a
 * local candidate" — would have punched a hole in §20.1's "the model may
 * classify local evidence, never introduce an issue of its own", and that
 * boundary is load-bearing for the whole subsystem: it is what makes a
 * hallucinated issue structurally impossible rather than merely unlikely.
 *
 * So the local layer asks a question it can honestly ask. **The claim this
 * module makes is lexical, not semantic**: "the presenter did not deliver this
 * span as written, by a wide margin, and the transcript is final". That is a
 * word-overlap measurement. Whether the difference *matters* is untouched here
 * and is exactly what Luna is asked. The catalog enforces the division —
 * `MATERIAL_MEANING_CHANGE.requiresLunaValidation` means a local proposal can
 * never reach the glass however confident this module were to become.
 *
 * ---------------------------------------------------------------------------
 * WHY IT STAYS QUIET
 * ---------------------------------------------------------------------------
 * A paraphrase question is *cheap* to ask locally and *expensive* to ask Luna,
 * so the gates below exist to keep the call rate sane rather than to protect
 * the presenter (the catalog does that):
 *
 * - short spans are skipped: rewording three words is not evidence of anything;
 * - a *total* mismatch is skipped, because at that point the likeliest
 *   explanation is that alignment put us on the wrong span, and asking Luna to
 *   judge the meaning of a misalignment wastes a call and invites a confident
 *   wrong answer;
 * - provisional text is skipped, per §25.5's "final/highly stable evidence".
 */
import type { CoachCandidate, CoachEvidenceStamp } from '../../contracts/coaching';
import { safeFragment, toWordStream } from './normalize';
import type { FidelitySpanObservation } from './comparator';

/** Authored words below this and a rewording means nothing. */
export const MIN_AUTHORED_WORDS = 8;

/**
 * Fraction of authored content words absent from the spoken stream, above
 * which the span is worth asking about.
 */
export const DIVERGENCE_LOW = 0.35;

/**
 * …and above which it is more likely a misalignment than a paraphrase. §19's
 * whole posture is that a wrong priority-90 claim costs more than a missed one.
 */
export const DIVERGENCE_HIGH = 0.8;

const MAX_FRAGMENT_CHARS = 64;

/**
 * Words carrying no propositional content. Dropping them stops "the" and "of"
 * from diluting the divergence measure in both directions.
 */
const FUNCTION_WORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'so', 'of', 'to', 'in', 'on', 'at', 'by', 'for',
  'with', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its',
  'this', 'that', 'these', 'those', 'we', 'you', 'they', 'i', 'he', 'she', 'our', 'your',
  'their', 'will', 'would', 'can', 'could', 'do', 'does', 'did', 'have', 'has', 'had',
]);

export interface ParaphraseObservationResult {
  candidate: CoachCandidate | null;
  /** Diagnostic only; never rendered. */
  divergence: number | null;
  reason:
    | 'candidate'
    | 'span_too_short'
    | 'below_divergence_floor'
    | 'above_divergence_ceiling'
    | 'provisional_evidence'
    | 'coaching_disabled';
}

/**
 * Ask whether this span is worth a materiality judgement.
 *
 * Returns the reason alongside the candidate for the same purpose the
 * comparator returns verdicts: so a test can prove that "no candidate" came
 * from a *match* rather than from the function never looking.
 */
export function observeParaphrase(
  observation: FidelitySpanObservation,
): ParaphraseObservationResult {
  if (observation.coachingDisabled === true) {
    return { candidate: null, divergence: null, reason: 'coaching_disabled' };
  }

  const authoredWords = contentWords(observation.authored.map((token) => token.surface));
  const spokenWords = contentWords(observation.spoken.map((token) => token.surface));
  if (authoredWords.length < MIN_AUTHORED_WORDS) {
    return { candidate: null, divergence: null, reason: 'span_too_short' };
  }

  const spokenSet = new Set(spokenWords);
  let missing = 0;
  for (const word of authoredWords) if (!spokenSet.has(word)) missing += 1;
  const divergence = missing / authoredWords.length;

  if (divergence < DIVERGENCE_LOW) {
    return { candidate: null, divergence, reason: 'below_divergence_floor' };
  }
  if (divergence > DIVERGENCE_HIGH) {
    return { candidate: null, divergence, reason: 'above_divergence_ceiling' };
  }

  const stamp = finalStampFor(observation);
  if (stamp === null) {
    return { candidate: null, divergence, reason: 'provisional_evidence' };
  }

  return {
    candidate: {
      evidenceId: `paraphrase:${observation.spanId ?? 'span'}:${Math.round(stamp.audioStartMs)}`,
      type: 'material_meaning_change',
      // Scaled across the band this module is willing to speak in, and capped
      // well below the critical codes' usual floor. The number is honestly a
      // measure of lexical distance and nothing more, and the catalog's
      // `requiresLunaValidation` is what stops it being read as more.
      localConfidence: scaleDivergence(divergence),
      stamp,
      scriptSpanId: observation.spanId,
      scriptAnchorTokenId: null,
      // Derived from continuous comparison of a span, not from discrete events.
      contributingEventIds: [],
      detailCode: `divergence_${divergence.toFixed(2)}`,
      spokenFragment: safeFragment(
        observation.spoken.map((token) => token.surface).join(' '),
        MAX_FRAGMENT_CHARS,
      ),
      authoredFragment: safeFragment(
        observation.authored.map((token) => token.surface).join(' '),
        MAX_FRAGMENT_CHARS,
      ),
      // Guaranteed by `finalStampFor`.
      finalEvidence: true,
    },
    divergence,
    reason: 'candidate',
  };
}

/** 0.35 → 0.4, 0.8 → 0.65. Never near the critical codes' usual floor. */
function scaleDivergence(divergence: number): number {
  const position = (divergence - DIVERGENCE_LOW) / (DIVERGENCE_HIGH - DIVERGENCE_LOW);
  return 0.4 + 0.25 * Math.min(1, Math.max(0, position));
}

function contentWords(surfaces: readonly string[]): string[] {
  return toWordStream(surfaces)
    .map((word) => word.word)
    .filter((word) => word.length > 0 && !FUNCTION_WORDS.has(word));
}

/**
 * §25.5. A stamp covering the span, or `null` when any of it is still
 * provisional. A materiality question asked about a tail that is about to be
 * rewritten is a wasted call and a possible wrong alert.
 */
function finalStampFor(observation: FidelitySpanObservation): CoachEvidenceStamp | null {
  let audioStartMs = Number.POSITIVE_INFINITY;
  let audioEndMs = Number.NEGATIVE_INFINITY;
  let commitSequence: number | null = null;
  for (const token of observation.spoken) {
    if (!token.final) return null;
    audioStartMs = Math.min(audioStartMs, token.audioStartMs);
    audioEndMs = Math.max(audioEndMs, token.audioEndMs);
    commitSequence = token.commitSequence;
  }
  if (!Number.isFinite(audioStartMs) || !Number.isFinite(audioEndMs)) return null;
  return {
    audioStartMs,
    audioEndMs: Math.max(audioStartMs, audioEndMs),
    commitSequence,
    trackingEpoch: observation.trackingEpoch,
    takePassId: observation.takePassId,
  };
}
