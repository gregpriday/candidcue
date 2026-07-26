/**
 * Plain-language copy for the smooth-following UI (companion §48, §49, §58–§62;
 * primary Appendix F.11–F.13 voice).
 *
 * Everything here is a pure function so the wording is unit-testable and the
 * store stays free of presentation strings. Two rules govern every phrase:
 *
 *  1. §3 experience contract — never imply certainty the tracker does not have.
 *     Confidence is reported as a coarse band, never a percentage, and pace is
 *     always approximate.
 *  2. Appendix F.13 — where a concrete failure is known, name it. Avoid
 *     "something went wrong" language.
 */
import type { AlignmentDecision, StageMotionState } from '../../shared/contracts';

/* ---------------------------------------------------------------------------
 * Tracking state (§48 "tracking state in plain language")
 * ------------------------------------------------------------------------- */

/**
 * One short status line per state. Wording reuses the primary F.11 vocabulary
 * ("Holding your place", "Looking for your place", "Reconnecting — position
 * held") so Live never speaks two dialects.
 */
export const FOLLOW_STATE_LABELS: Record<StageMotionState, string> = {
  searching: 'Looking for your place',
  following: 'Following',
  holding: 'Holding your place',
  ambiguous: 'Holding your place',
  paused: 'Paused — still listening',
};

/**
 * A one-sentence explanation shown under the status line when it helps.
 *
 * `ambiguous` gets its own wording despite sharing a label with `holding`: the
 * presenter is reading a passage that appears more than once, and "the same
 * words appear twice" is a fact they can act on — by reading a distinctive
 * phrase, or by tapping where they are. "Evidence is thin" would send them
 * looking for a microphone problem that does not exist.
 */
export const FOLLOW_STATE_DETAIL: Record<StageMotionState, string | null> = {
  searching: 'Start speaking and the stage picks up your place.',
  following: null,
  holding: 'The text stays put until the words match the script again.',
  ambiguous: 'These words appear in more than one place, so the text is waiting rather than guessing.',
  paused: 'Automatic movement is stopped. Transcription is still connected.',
};

/** Tone used for the state indicator — calm by default, never alarming. */
export type FollowStateTone = 'neutral' | 'accent' | 'success' | 'warning';

export function followStateTone(state: StageMotionState): FollowStateTone {
  switch (state) {
    case 'following':
      return 'success';
    case 'searching':
      return 'accent';
    // Deliberately NOT 'warning'. Holding is the engine working correctly —
    // refusing to guess — and the research brief is explicit that this moment
    // must read as calm. A warning colour here trains presenters to panic at
    // the exact point the system is being careful on their behalf.
    case 'holding':
    case 'ambiguous':
    default:
      return 'neutral';
  }
}

/* ---------------------------------------------------------------------------
 * Behavior (§52) — why the tracker thinks you moved
 * ------------------------------------------------------------------------- */

/**
 * Diagnostics vocabulary for the engine's decision codes.
 *
 * **These are for the developer diagnostics panel only.** The integration
 * contract is explicit that decision codes must not become user-facing copy —
 * `FOLLOW_STATE_LABELS` is what the presenter reads. The distinction matters
 * because these names describe the engine's internal reasoning, which changes
 * as the engine is tuned; the four states are a promise about behaviour, which
 * does not.
 */
export const FOLLOW_DECISION_LABELS: Record<AlignmentDecision, string> = {
  noEvidence: 'No evidence yet',
  localObserved: 'Local match',
  localConfirmed: 'Local match confirmed',
  holdLowEvidence: 'Holding — weak evidence',
  holdOffScript: 'Holding — off script',
  holdAmbiguous: 'Holding — two places fit',
  relocationAccepted: 'Relocated',
  jumpForwardAccepted: 'Jumped forward',
  retakeAccepted: 'Retake accepted',
  jumpPending: 'Possible jump — gathering evidence',
  manualAnchor: 'You moved it',
};

/* ---------------------------------------------------------------------------
 * Confidence (§48 "without implying false precision")
 * ------------------------------------------------------------------------- */

export type ConfidenceBand = 'unknown' | 'low' | 'unsure' | 'steady' | 'strong';

/** Ordered weakest → strongest; index doubles as the meter position. */
export const CONFIDENCE_BANDS: ConfidenceBand[] = ['low', 'unsure', 'steady', 'strong'];

export const CONFIDENCE_BAND_LABELS: Record<ConfidenceBand, string> = {
  unknown: 'No reading yet',
  low: 'Low',
  unsure: 'Unsure',
  steady: 'Steady',
  strong: 'Strong',
};

/**
 * Coarse banding. The thresholds only decide *wording*; no control-system
 * behavior depends on them, so they are display constants rather than profile
 * parameters.
 */
export function confidenceBand(confidence: number | null | undefined): ConfidenceBand {
  if (confidence === null || confidence === undefined || Number.isNaN(confidence)) return 'unknown';
  if (confidence >= 0.8) return 'strong';
  if (confidence >= 0.6) return 'steady';
  if (confidence >= 0.35) return 'unsure';
  return 'low';
}

/** 0-based meter position, or -1 when there is nothing to show. */
export function confidenceBandIndex(band: ConfidenceBand): number {
  return CONFIDENCE_BANDS.indexOf(band);
}

/** Approximate pace. Always hedged — the estimator is not a stopwatch. */
export function formatPace(wordsPerMinute: number | null): string {
  if (wordsPerMinute === null || !Number.isFinite(wordsPerMinute) || wordsPerMinute <= 0) {
    return 'Pace not established yet';
  }
  return `≈ ${Math.round(wordsPerMinute / 5) * 5} words per minute`;
}

/* ---------------------------------------------------------------------------
 * Degraded operation (Part XI) — one honest state per condition
 * ------------------------------------------------------------------------- */

export type FollowNoticeId =
  /** §59 Transcription interrupted. */
  | 'transcription_interrupted'
  /** §60 Missing or weak transcript confidence. */
  | 'low_transcript_confidence'
  /** §61 The stage keeps missing its frame budget. */
  | 'frame_performance'
  /** §62 Line measurement failed or is inconsistent. */
  | 'invalid_line_map'
  /** §63 A runtime budget was exceeded. */
  | 'budget_exceeded';

export type FollowNoticeTone = 'info' | 'warning' | 'danger';

export interface FollowNoticeCopy {
  title: string;
  detail: string;
  tone: FollowNoticeTone;
}

/**
 * The static half of the degraded-state matrix.
 *
 * There used to be a sixth notice family here, for a second model that ranked
 * the local aligner's candidates — six variants of "assist is unavailable,
 * following continues on local matching". There is no second model now, so
 * following is *always* local matching and there is nothing to report the
 * absence of.
 */
export const FOLLOW_NOTICE_COPY: Record<
  Exclude<FollowNoticeId, 'budget_exceeded'>,
  FollowNoticeCopy
> = {
  transcription_interrupted: {
    title: 'Reconnecting — position held',
    detail:
      'Transcription dropped out. The stage decelerates and holds your place; it does not keep scrolling on an old pace estimate.',
    tone: 'warning',
  },
  low_transcript_confidence: {
    title: 'Following cautiously',
    detail:
      'The transcript is coming through weakly, so CandidCue is leaning on word order and rare phrases, reducing lead, and holding back tips.',
    tone: 'info',
  },
  frame_performance: {
    title: 'The stage is dropping frames',
    detail:
      'Nonessential visual effects were reduced to keep the text moving smoothly. Motion stays continuous — it never falls back to jumping.',
    tone: 'warning',
  },
  invalid_line_map: {
    title: 'Stage layout needs rebuilding',
    detail:
      'Line measurement came back inconsistent, so motion is held rather than guessing line positions. Rebuild the layout to resume following.',
    tone: 'danger',
  },
};

/** §63 budgets that can be surfaced quietly in control. */
export type RuntimeBudgetId =
  | 'alignment_update'
  | 'stage_frame'
  | 'semantic_latency'
  | 'frame_hitch';

export const RUNTIME_BUDGET_LABELS: Record<RuntimeBudgetId, string> = {
  alignment_update: 'Alignment update',
  stage_frame: 'Stage frame work',
  semantic_latency: 'Assist response time',
  frame_hitch: 'Frame hitches',
};

export function budgetNoticeCopy(
  breaches: Array<{ id: RuntimeBudgetId; observed: number; budget: number; unit: string }>,
): FollowNoticeCopy {
  const names = breaches.map((b) => RUNTIME_BUDGET_LABELS[b.id] ?? b.id);
  const detail = breaches
    .map((b) => `${RUNTIME_BUDGET_LABELS[b.id] ?? b.id}: ${b.observed}${b.unit} against a ${b.budget}${b.unit} budget`)
    .join(' · ');
  return {
    title: names.length === 1 ? `${names[0]} is over budget` : 'Some work is over budget',
    detail: `${detail}. Following continues; this is a measurement, not a failure.`,
    tone: 'info',
  };
}

/* ---------------------------------------------------------------------------
 * "Why did it move?" (§65)
 * ------------------------------------------------------------------------- */

/**
 * One movement, as the diagnostics timeline records it.
 *
 * Derived from consecutive snapshots rather than reported by the engine: the
 * engine states where the reader is, and "it moved from here to there" is a
 * fact about two of those statements, not a third thing it needs to send.
 * Redacted by design — no script or transcript text ever enters this record.
 */
export interface MovementDecisionRecord {
  /** The snapshot's sequence number. */
  seq: number;
  /** Audio-clock time of the snapshot, ms. */
  audioMs: number;
  fromToken: number;
  toToken: number;
  decision: AlignmentDecision;
  stateBefore: StageMotionState;
  stateAfter: StageMotionState;
  confidence: number;
}

export interface MovementExplanation {
  /** One line: what happened. */
  headline: string;
  /** Supporting sentence naming the evidence class. */
  detail: string;
  /** Compact key/value chips for the diagnostics list. */
  facts: Array<{ label: string; value: string }>;
}

/** Format a movement for humans. */
export function describeMovement(record: MovementDecisionRecord): MovementExplanation {
  const distance = record.toToken - record.fromToken;
  const direction = distance > 0 ? 'forward' : distance < 0 ? 'back' : 'nowhere';
  const magnitude = Math.abs(distance);
  const moved =
    magnitude < 0.05
      ? 'Held position'
      : `Moved ${direction} ${magnitude.toFixed(magnitude < 10 ? 1 : 0)} words`;

  const headline = `${moved} — ${FOLLOW_DECISION_LABELS[record.decision].toLowerCase()}`;
  const transition =
    record.stateBefore === record.stateAfter
      ? FOLLOW_STATE_LABELS[record.stateAfter]
      : `${FOLLOW_STATE_LABELS[record.stateBefore]} → ${FOLLOW_STATE_LABELS[record.stateAfter]}`;
  // "Confidence" is a documented heuristic, not a calibrated probability, so it
  // is reported as a bare score and never as a percentage.
  const detail = `${transition}. Match score ${formatScore(record.confidence)}.`;

  return {
    headline,
    detail,
    facts: [
      { label: 'Seq', value: String(record.seq) },
      { label: 'Audio time', value: formatSessionTime(record.audioMs) },
      { label: 'Decision', value: FOLLOW_DECISION_LABELS[record.decision] },
      { label: 'State', value: `${record.stateBefore} → ${record.stateAfter}` },
      { label: 'From', value: record.fromToken.toFixed(1) },
      { label: 'To', value: record.toToken.toFixed(1) },
      { label: 'Confidence', value: formatScore(record.confidence) },
    ],
  };
}

/** Two decimals, no percentage — scores are model quantities, not certainties. */
export function formatScore(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return value.toFixed(2);
}

/** `m:ss.mmm` session-relative stamp for the diagnostics timeline. */
export function formatSessionTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00.000';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const millis = Math.floor(ms % 1000);
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}
