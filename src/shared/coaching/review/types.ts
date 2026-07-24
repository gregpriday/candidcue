/**
 * Post-take review inputs (spec §31, §36).
 *
 * This module owns the *record* the review screen reads: the session-local
 * evidence the live lanes already produce, frozen at the end of a take. It
 * declares no behaviour — `session-summary.ts`, `event-map.ts`,
 * `script-annotations.ts`, `recommendations.ts` and `comparison.ts` are the
 * only places a number is computed, and `report-store.ts` is the only place
 * anything is persisted.
 *
 * ---------------------------------------------------------------------------
 * RULE — TIME IS ACCOUNTED FOR, NEVER INFERRED BY SUBTRACTION.
 * ---------------------------------------------------------------------------
 * `pace/speech-clock.ts` is explicit that
 * `voicedMs + internalPauseMs + unmeasuredMs <= elapsed`, **not** `=`. A
 * dropout, a device change or a starved worklet leaves audio nobody can make a
 * claim about, and folding it into either voiced time or pause time is a lie
 * with two different signs. So {@link TakeTimeAccounting} carries all four
 * quantities separately and the review reports the residual as
 * `unaccountedMs` rather than absorbing it. Nothing in `review/` computes
 * silence as `duration - voicedMs`.
 *
 * ---------------------------------------------------------------------------
 * RULE — EVERY PASS IS ITS OWN PERFORMANCE (§11.3).
 * ---------------------------------------------------------------------------
 * Events are grouped by `takePassId` all the way through. The live rail shows
 * only the most recent pass; the review shows every pass, labelled, and never
 * merges two readings of the same sentence into one set of numbers unless the
 * caller explicitly asks for the session aggregate.
 *
 * ---------------------------------------------------------------------------
 * RULE — ABSENCE IS A VALUE (§27.1).
 * ---------------------------------------------------------------------------
 * Anything the take did not produce is `null` with a reason, never `0` and
 * never a fabricated fallback. That applies to variety on a take too short to
 * score, to a projection with no target duration, to a comparison with no
 * prior sessions, and to audio playback when recording was off.
 */
import type {
  CoachTipCode,
  CoachTipSeverity,
  DeliveryScoreState,
  DeliveryStyle,
  FillerEvent,
  MicrophoneCoachState,
  PaceState,
  SpeechInterval,
  VarietyState,
} from '../../contracts/coaching';
import type { Uuid } from '../../contracts/core';
import type { UnmeasuredSpan } from '../pace/speech-clock';
import type { TerminalRushUnmeasurableReason } from '../pace/terminal-rush';
import type {
  BoundaryStrength,
  CadenceMetrics,
  PauseEvent,
} from '../prosody/cadence-analyzer';
import type { EmphasisMeasurement } from '../prosody/emphasis-analyzer';

/** The version of the review record and stored-report shape. */
export const REVIEW_SCHEMA_VERSION = 1;

/* ---------------------------------------------------------------------------
 * §36.3 provenance
 * ------------------------------------------------------------------------- */

/**
 * §36.3. Recorded with every report so a historical report is never silently
 * reinterpreted under a newer formula. `comparison.ts` refuses to trend a
 * version-sensitive metric across an algorithm change rather than quietly
 * comparing two different scales.
 */
export interface ReviewVersions {
  coachingSchemaVersion: number;
  algorithmVersion: string;
  tipPolicyVersion: string;
  lunaPromptVersion: string;
  transcriptionModels: readonly string[];
  precisionTranscriptionActive: boolean;
}

/** The target profile the take was scored against (§20, §30). */
export interface ReviewTargetProfile {
  deliveryStyle: DeliveryStyle;
  targetWpmLow: number;
  targetWpmHigh: number;
  targetVarietyLow: number;
  targetVarietyHigh: number;
  /** Authored target duration, ms, or `null` when the script has none. */
  targetDurationMs: number | null;
  /** §14.9 ratio at or above which a sentence ending counts as rushed. */
  terminalRushRatioThreshold: number;
}

/* ---------------------------------------------------------------------------
 * §32.2 retention consent
 * ------------------------------------------------------------------------- */

/**
 * §32.2. Three separate toggles, never one. Saving a report does not imply
 * saving a transcript, and neither implies saving audio.
 */
export interface RetentionConsent {
  saveReport: boolean;
  saveTranscript: boolean;
  saveAudio: boolean;
}

export const NO_RETENTION_CONSENT: RetentionConsent = {
  saveReport: false,
  saveTranscript: false,
  saveAudio: false,
};

/* ---------------------------------------------------------------------------
 * Per-pass evidence
 * ------------------------------------------------------------------------- */

/**
 * The four kinds of audio time in a take pass, kept apart.
 *
 * `spanMs` is the wall of audio the pass occupied. The rest are measured
 * claims about parts of it, and their sum may legitimately be *less* than
 * `spanMs`. See the module header.
 */
export interface TakeTimeAccounting {
  /** Monotonic audio-clock start of the pass. */
  startMs: number;
  /** Monotonic audio-clock end of the pass. `>= startMs`. */
  endMs: number;
  /** Milliseconds the VAD classified as voiced (§14.1 articulation denominator). */
  voicedMs: number;
  /** Silence the VAD preserved *inside* speech runs, ms (§12.5). Real pause time. */
  internalPauseMs: number;
  /**
   * Audio no claim can be made about: worklet dropout, manual or system pause,
   * a voice command, a retake. Supplied as spans so the review can subtract
   * them from any sub-interval it measures, not just from the total.
   */
  unmeasuredSpans: readonly UnmeasuredSpan[];
}

/** §14.1 word counts for a pass. */
export interface TakeWordCounts {
  /** All spoken lexical units including confirmed fillers and repetitions. */
  audibleWords: number;
  /** Meaningful delivered words only. */
  contentWords: number;
}

/**
 * One interval of the pace track. Carries its own bounds rather than relying
 * on a sample cadence, so "percentage of time inside target pace" is an exact
 * sum of durations and a test can assert the millisecond.
 */
export interface PaceSample {
  startMs: number;
  endMs: number;
  /** Displayed audible WPM over the interval, or `null` when not measured. */
  audibleWpm: number | null;
  state: PaceState;
}

/** One interval of the variety track (§17). */
export interface VarietySample {
  startMs: number;
  endMs: number;
  /** 0–100 variety level, or `null` when pitch was not usable (§13.4). */
  level: number | null;
  state: VarietyState;
  /** Loudness range over the interval, dB, or `null`. */
  energyRangeDb: number | null;
  /** Pitch movement span, semitones, or `null`. */
  pitchSpanSemitones: number | null;
}

/** Where the alignment cursor sat, sampled for the timeline (§31.3). */
export interface ScriptPositionSample {
  atMs: number;
  cursorUnitIndex: number;
  totalUnits: number;
  /** 0–1 alignment confidence. */
  confidence: number;
  reacquiring: boolean;
  /** Authored span the cursor was inside, or `null`. */
  spanId: string | null;
}

/** A tip the presenter actually saw (§26, §31.3). */
export interface ShownTipRecord {
  tipId: string;
  code: CoachTipCode;
  /** Authored catalog key. Copy is never model-authored (§25). */
  textKey: string;
  interpolations: Readonly<Record<string, string>>;
  severity: CoachTipSeverity;
  shownAtMs: number;
  hiddenAtMs: number | null;
  takePassId: string;
  scriptAnchorTokenId: string | null;
  spanId: string | null;
}

/** §14.9. One eligible sentence, as the terminal-rush analyzer measured it. */
export interface TerminalRushRecord {
  startMs: number;
  endMs: number;
  wordCount: number;
  /** `finalSegmentWpm / earlierSegmentWpm`, or `null` when unmeasurable. */
  ratio: number | null;
  measurable: boolean;
  reason: 'ok' | TerminalRushUnmeasurableReason;
  spanId: string | null;
  scriptAnchorTokenId: string | null;
}

/** §18.3. A sentence boundary and how it was shaped. */
export interface BoundaryRecord {
  atMs: number;
  strength: BoundaryStrength;
  /** Whether §18.3 found any shaping cue. Assessed live by `assessBoundary`. */
  shaped: boolean;
  spanId: string | null;
  scriptAnchorTokenId: string | null;
}

/** §21, §25.5. A critical script discrepancy that survived local validation. */
export interface CriticalFindingRecord {
  findingId: string;
  kind:
    | 'critical_number_mismatch'
    | 'critical_name_mismatch'
    | 'critical_unit_mismatch'
    | 'critical_negation_mismatch'
    | 'material_meaning_change';
  atMs: number;
  endMs: number;
  takePassId: string;
  spanId: string | null;
  scriptAnchorTokenId: string | null;
  /** Authored text, safe to quote back (§25.5). */
  authoredFragment: string;
  /** What was heard. Only ever shown beside the authored text, never alone. */
  spokenFragment: string;
  /** 0–1 local confidence. */
  localConfidence: number;
  /**
   * True when the presenter corrected it later in the same pass. Still listed
   * — the review shows what happened — but excluded from the discrepancy count
   * so a self-corrected slip is not scored twice (§15.4).
   */
  selfCorrected: boolean;
}

/** A transcript segment. Present only under §32.2 transcript consent. */
export interface TranscriptSegmentRecord {
  startMs: number;
  endMs: number;
  text: string;
  final: boolean;
}

/** One take pass (§11.3). Never merged with another pass implicitly. */
export interface TakePassRecord {
  takePassId: string;
  /** 1-based order the passes were performed in. */
  passOrdinal: number;
  time: TakeTimeAccounting;
  words: TakeWordCounts;
  /** Closed VAD speech runs, for the timeline's speech-activity track. */
  speechIntervals: readonly SpeechInterval[];
  paceSamples: readonly PaceSample[];
  varietySamples: readonly VarietySample[];
  scriptPositions: readonly ScriptPositionSample[];
  /** Every detected disfluency, all kinds. Counting rules live in `disfluency/types.ts`. */
  fillers: readonly FillerEvent[];
  pauses: readonly PauseEvent[];
  boundaries: readonly BoundaryRecord[];
  terminalRushSentences: readonly TerminalRushRecord[];
  cadence: CadenceMetrics;
  emphasis: readonly EmphasisMeasurement[];
  tipsShown: readonly ShownTipRecord[];
  criticalFindings: readonly CriticalFindingRecord[];
  /** Authored spans this pass actually covered — the basis of "repeated passage". */
  coveredSpanIds: readonly string[];
  /**
   * The delivery score as it stood at the end of this pass, or `null` when the
   * pass was not scored at all.
   *
   * ---------------------------------------------------------------------------
   * WHY THE WHOLE STATE AND NOT JUST THE NUMBER
   * ---------------------------------------------------------------------------
   * Speaking Score report §11.2 forbids seven dimension scores *live* and says
   * in the same breath that they "belong in a post-take review". This is that
   * review's copy of them, and it is the only place they are ever rendered. The
   * record keeps `rawScore` beside `displayScore` for the reason the contract
   * gives: the live smoothing should be auditable rather than trusted, and it
   * cannot be audited from the smoothed figure alone.
   *
   * `null` here means "not scored", which is not a score of zero and is not a
   * score that never left warm-up. `session-summary.ts` keeps the three apart
   * and states which one applies.
   */
  deliveryScore: DeliveryScoreState | null;
  /** Final projected total take duration, ms, or `null` when not projectable. */
  projectedTotalMs: number | null;
  /** Present only with §32.2 transcript consent. `null` otherwise. */
  transcript: readonly TranscriptSegmentRecord[] | null;
}

/* ---------------------------------------------------------------------------
 * Microphone (§12.7, §31.2)
 * ------------------------------------------------------------------------- */

export type MicrophoneStatus = MicrophoneCoachState['status'];

export interface MicrophoneStatusSpan {
  startMs: number;
  endMs: number;
  status: MicrophoneStatus;
  /** §12.7: the condition persisted long enough to warrant an alert. */
  sustained: boolean;
}

/**
 * A rolling level observation. `levelDbfs` is digital full-scale and negative
 * (§12.7.4): there is no SPL here and there must never be one.
 */
export interface MicrophoneLevelSample {
  atMs: number;
  levelDbfs: number;
  snrDb: number | null;
}

export interface MicrophoneSessionRecord {
  /** Ascending, non-overlapping status spans across the whole session. */
  spans: readonly MicrophoneStatusSpan[];
  levelSamples: readonly MicrophoneLevelSample[];
  /** Time the Realtime transcription path itself was degraded, ms (§25.1). */
  transcriptionDegradedMs: number;
}

/* ---------------------------------------------------------------------------
 * The session record
 * ------------------------------------------------------------------------- */

/**
 * §31.3. Whether audio playback may be offered. There is no "maybe" and no
 * silent fallback: either a recording exists and is playable, or the review
 * states why it does not.
 */
export type AudioPlaybackAvailability =
  | { available: true; recordingId: string; durationMs: number }
  | {
      available: false;
      reason:
        | 'recording_not_enabled'
        | 'recording_discarded'
        | 'consent_withdrawn'
        | 'recording_missing';
    };

/** The complete evidence the review screen reads. Immutable once built. */
export interface CoachingSessionRecord {
  schemaVersion: typeof REVIEW_SCHEMA_VERSION;
  sessionId: Uuid;
  scriptId: Uuid;
  scriptRevision: number;
  /**
   * Wall-clock ISO 8601, for ordering sessions in the history list and for
   * nothing else. Every measurement in this record is on the audio clock
   * (contract Rule 3); this field never enters a calculation.
   */
  startedAtIso: string;
  endedAtIso: string | null;
  versions: ReviewVersions;
  profile: ReviewTargetProfile;
  consent: RetentionConsent;
  /** Ascending by `passOrdinal`. At least one pass for a take that happened. */
  passes: readonly TakePassRecord[];
  microphone: MicrophoneSessionRecord;
  audio: AudioPlaybackAvailability;
}

/* ---------------------------------------------------------------------------
 * The script, as the review reads it (§31.4)
 * ------------------------------------------------------------------------- */

/**
 * One authored passage. `text` is the authored Markdown-derived text and is
 * **never** rewritten by anything in `review/` — §31.4 forbids editing the
 * source. Annotations are returned alongside, never merged in.
 */
export interface ReviewScriptPassage {
  spanId: string;
  /** Authored token ids in order. Used to resolve an event's anchor. */
  tokenIds: readonly string[];
  text: string;
  /** 0-based paragraph and sentence position, for stable ordering. */
  paragraphIndex: number;
  sentenceIndex: number;
}

export interface ReviewScript {
  scriptId: Uuid;
  scriptRevision: number;
  passages: readonly ReviewScriptPassage[];
}
