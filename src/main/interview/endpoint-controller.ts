import type { EndpointMode, EndpointDecision } from '@shared/domain';
import {
  ENDPOINT_THRESHOLDS,
  RUNTIME_DEFAULTS,
  CONTINUATION_WORDS,
  CONTINUATION_PHRASES,
  type EndpointThresholds,
} from '@shared/constants/runtime-defaults';

/**
 * Endpoint detection logic (spec §14). Deterministic, side-effect free guards
 * that decide whether a user's turn should be committed. The lightweight LLM
 * classifier ({@link EndpointDecision}) is advisory: timing thresholds and the
 * hard-silence ceiling are what ultimately gate a commit.
 */

/** Reason a {@link decideEndpoint} call resolved the way it did. */
export type EndpointDecisionReason =
  | 'manual'
  | 'classifier'
  | 'hard_silence'
  | 'wait'
  | 'too_short'
  | 'empty';

export interface EndpointDecisionResult {
  commit: boolean;
  reason: EndpointDecisionReason;
}

/** Below this much speech a low-confidence answer is treated as a stray blip. */
const MIN_MEANINGFUL_SPEECH_MS = 1200;

/** Minimum speech before the classifier is worth invoking (spec §14.2). */
const MIN_SPEECH_FOR_CLASSIFICATION_MS = 1500;

/**
 * Resolve the timing thresholds for an automatic endpoint mode. Manual mode has
 * no thresholds because it never auto-commits.
 */
function thresholdsFor(mode: Exclude<EndpointMode, 'manual'>): EndpointThresholds {
  return ENDPOINT_THRESHOLDS[mode];
}

/**
 * True when the mode is permitted to commit a turn on its own. Manual mode
 * relies entirely on the operator pressing commit, so it never auto-commits.
 */
export function autoCommitAllowed(mode: EndpointMode): boolean {
  return mode !== 'manual';
}

/**
 * Weak continuation signal (spec §14.3): the transcript ends on a word or
 * phrase that strongly implies the speaker intends to keep going. This is a
 * hint only — it never decides an endpoint by itself, but it can hold back an
 * otherwise-borderline commit.
 */
export function endsWithContinuation(transcript: string): boolean {
  const lower = transcript.toLowerCase().trim();
  if (lower.length === 0) return false;

  // Phrase match: transcript ends with a known trailing phrase.
  for (const phrase of CONTINUATION_PHRASES) {
    if (lower.endsWith(phrase)) return true;
  }

  // Word match: the final word (stripped of trailing punctuation) is a known
  // continuation conjunction/article.
  const words = lower.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 0);
  const lastWord = words[words.length - 1];
  if (lastWord !== undefined && CONTINUATION_WORDS.includes(lastWord)) return true;

  return false;
}

/**
 * Whether the (relatively expensive) endpoint classifier should be run for the
 * current state. We gate on mode, silence, accumulated speech, a non-empty
 * transcript, and the absence of an in-flight commit so we never double-fire.
 */
export function shouldRunClassifier(input: {
  mode: EndpointMode;
  silenceMs: number;
  speechMs: number;
  transcript: string;
  commitInFlight: boolean;
}): boolean {
  if (!autoCommitAllowed(input.mode)) return false;
  if (input.commitInFlight) return false;
  if (input.transcript.trim().length === 0) return false;
  if (input.speechMs < MIN_SPEECH_FOR_CLASSIFICATION_MS) return false;

  // `mode` is non-manual here (autoCommitAllowed guard above).
  const thresholds = thresholdsFor(input.mode as Exclude<EndpointMode, 'manual'>);
  return input.silenceMs >= thresholds.minSilenceBeforeClassificationMs;
}

/** A classifier result that confidently signals a complete answer for `mode`. */
function isHighConfidenceCompletion(
  classifier: EndpointDecision | null,
  thresholds: EndpointThresholds,
): boolean {
  return (
    classifier !== null &&
    classifier.shouldCommit &&
    classifier.completeProbability >= thresholds.commitProbability
  );
}

/** A classifier result that explicitly judged the answer incomplete. */
function isExplicitlyIncomplete(classifier: EndpointDecision | null): boolean {
  return classifier !== null && !classifier.shouldCommit;
}

/**
 * Decide whether the current user turn should be committed (spec §14).
 *
 * Resolution order:
 *  1. Manual mode never auto-commits.
 *  2. An empty transcript never commits.
 *  3. A high-confidence classifier completion past the per-mode silence floor
 *     commits ('classifier').
 *  4. The hard-silence ceiling forces a balanced commit on any non-empty
 *     transcript (unless the classifier explicitly said incomplete); a
 *     conservative session only force-commits on hard silence if a prior
 *     high-confidence completion exists ('hard_silence').
 *  5. Very short speech with no confident completion is treated as a stray blip
 *     ('too_short').
 *  6. Otherwise keep listening ('wait').
 */
export function decideEndpoint(input: {
  mode: EndpointMode;
  silenceMs: number;
  speechMs: number;
  transcript: string;
  classifier: EndpointDecision | null;
}): EndpointDecisionResult {
  if (!autoCommitAllowed(input.mode)) {
    return { commit: false, reason: 'manual' };
  }

  if (input.transcript.trim().length === 0) {
    return { commit: false, reason: 'empty' };
  }

  // `mode` is now narrowed to an automatic mode.
  const mode = input.mode as Exclude<EndpointMode, 'manual'>;
  const thresholds = thresholdsFor(mode);
  const highConfidence = isHighConfidenceCompletion(input.classifier, thresholds);

  // 3. Classifier-driven commit: confident completion past the total-silence floor.
  if (highConfidence && input.silenceMs >= thresholds.minTotalSilenceMs) {
    return { commit: true, reason: 'classifier' };
  }

  // 4. Hard-silence ceiling.
  if (input.silenceMs >= RUNTIME_DEFAULTS.endpointHardSilenceMs) {
    if (mode === 'balanced') {
      // Balanced commits anything non-empty unless the classifier explicitly
      // judged the answer incomplete.
      if (!isExplicitlyIncomplete(input.classifier)) {
        return { commit: true, reason: 'hard_silence' };
      }
    } else if (highConfidence) {
      // Conservative only force-commits on hard silence with prior confidence.
      return { commit: true, reason: 'hard_silence' };
    }
    // Conservative without confidence (or balanced with an incomplete
    // classifier) keeps waiting for more speech.
    return { commit: false, reason: 'wait' };
  }

  // 5. Too short and not confidently complete → stray blip.
  if (input.speechMs < MIN_MEANINGFUL_SPEECH_MS && !highConfidence) {
    return { commit: false, reason: 'too_short' };
  }

  // 6. Default: keep listening.
  return { commit: false, reason: 'wait' };
}
