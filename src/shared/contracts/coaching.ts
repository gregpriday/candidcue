/**
 * Coaching Rail and Live Delivery Intelligence contracts
 * (companion specification:
 * `docs/CandidCue_Coaching_Rail_and_Live_Delivery_Intelligence_Specification.md`).
 *
 * This module owns the *seams* of the coaching subsystem:
 *
 *   audio worklet ──AudioFrameFeatures──▶ analyzers (pace / prosody / disfluency)
 *   analyzers     ──CoachCandidate────▶ tip policy
 *   tip policy    ──CoachRailState────▶ stage rail renderer
 *   tip policy    ──LunaCoachRequest──▶ Luna observer ──LunaCoachDecision──▶ policy
 *
 * ---------------------------------------------------------------------------
 * RULE 1 — COACHING IS ADVISORY AND NEVER CONTROLS THE TELEPROMPTER (§2.1).
 * ---------------------------------------------------------------------------
 * Nothing in this module may cause the script to move. The coaching subsystem
 * MUST NOT: set scroll position; modify the semantic cursor; authorize a
 * section jump; commit or reject a retake; change alignment confidence; change
 * microphone gain; rewrite the script; pause the take; or interrupt a voice
 * command. This is enforced structurally: `CoachRailState` — the only coaching
 * payload that crosses to the stage — carries no positional, scroll, cursor,
 * or navigation field, and the stage rail renderer has no write path back into
 * the motion controller. If you find yourself wanting to add such a field,
 * the answer is no; the requirement belongs in the tracking specifications.
 *
 * ---------------------------------------------------------------------------
 * RULE 1a — EVERY TYPE HERE NAMES ITS PRODUCER.
 * ---------------------------------------------------------------------------
 * This subsystem was built by parallel authors, and the characteristic failure
 * was not a type mismatch — the compiler catches those — but an *orphan*: a
 * surface each author assumed the other filled. The microphone lane built the
 * health tile, the coach lane built the alert catalog and its priority band,
 * and nobody built the candidate that connects them, so four hardware alerts
 * were unreachable. That is the same shape as a coaching trigger whose only
 * input was hard-coded to an empty array, which sat undetected for months.
 *
 * So: a type added here MUST name the module that constructs it. If you cannot
 * name one, the type does not belong here yet.
 *
 *   AudioFrameFeatures, SpeechInterval, PitchReliability  → coaching/audio
 *   MicrophoneCoachState                                  → coaching/audio
 *   PaceDisplayState                                      → coaching/pace
 *   VarietyDisplayState                                   → coaching/prosody
 *   FillerEvent, FillerDisplayState                       → coaching/disfluency
 *   ScriptProgress                                        → tracking engine
 *   CoachCandidate  → coaching/{pace,prosody,disfluency,fidelity,audio}
 *   CoachRibbonEvent, CoachGutterMark                     → coaching/coach
 *   CoachRailTip, CoachRailState, CoachRailModules        → coaching/coach
 *   LunaCoachRequest/Decision                             → coaching/coach
 *   CoachDiagnostics                                      → coaching/coach
 *
 * ---------------------------------------------------------------------------
 * RULE 2 — UNITS ARE IN THE NAME, ALWAYS.
 * ---------------------------------------------------------------------------
 * The single worst defect found in this project was a Unix timestamp returned
 * in *seconds* and compared against `Date.now()` in *milliseconds*; it meant no
 * real session could ever transcribe, and it shipped behind a green test suite
 * because the fixture used the wrong unit too. Every numeric field here therefore
 * carries its unit as a suffix: `Ms`, `Hz`, `Db`, `Dbfs`, `Semitones`, `Wpm`,
 * `Ratio`, `Percent`. A bare number is only permitted for a unitless score, and
 * every such field documents its range. Reviewers: a new field without a unit
 * suffix and without a documented range is a finding.
 *
 * Sign conventions:
 * - `*Dbfs` values are dB relative to full scale and are therefore **negative**
 *   (silence ≈ -100, clipping ≈ 0). Do not "normalize" them to positive.
 * - `*Db` values are differences (e.g. SNR, range) and are **positive**.
 * - `*Semitones` values are signed offsets from the speaker's own rolling
 *   reference pitch (§13.3); there is no absolute or gendered target (§13.5).
 *
 * ---------------------------------------------------------------------------
 * RULE 3 — THE AUDIO CLOCK IS THE ONLY CLOCK (§5.4).
 * ---------------------------------------------------------------------------
 * All coaching evidence is stamped with the application's monotonic audio
 * clock, never with wall-clock arrival time from an API response. A delayed
 * model result is mapped *back* onto the interval it describes. Arrival time
 * exists only in `CoachDiagnostics` for latency measurement. Every evidence
 * type here embeds {@link CoachEvidenceStamp} for exactly this reason: a
 * timestamp with no take pass and no tracking epoch cannot be validated as
 * fresh, and stale coaching is worse than no coaching.
 */
import type { Uuid } from './core';

// ---------------------------------------------------------------------------
// Clock and evidence identity (§5.4)
// ---------------------------------------------------------------------------

/**
 * §5.4. Stamped onto every piece of coaching evidence at the moment it is
 * *observed*, not the moment it is processed.
 *
 * `trackingEpoch` and `takePassId` together are what make staleness decidable:
 * an epoch change means the presenter's position was re-established (command
 * jump, retake, re-anchor) and evidence from before it describes a different
 * performance. A take pass change means a different take entirely. Policy MUST
 * discard evidence whose stamp does not match the current pair — see
 * {@link isEvidenceCurrent}.
 */
export interface CoachEvidenceStamp {
  /** Monotonic audio-clock start of the interval this evidence describes. */
  audioStartMs: number;
  /** Monotonic audio-clock end of the interval. `>= audioStartMs`. */
  audioEndMs: number;
  /**
   * Realtime commit ordinal this evidence was derived from, or `null` for
   * evidence derived purely from local audio (which has no commit).
   */
  commitSequence: number | null;
  /** Tracking epoch current when the evidence was observed. */
  trackingEpoch: number;
  /** Take pass this evidence belongs to. */
  takePassId: string;
}

/**
 * §23.1 / §26.5. The freshness test every consumer of coaching evidence must
 * apply before acting on it. Exported as a function rather than restated at
 * each call site because "check the epoch" was previously implemented three
 * different ways, two of them wrong.
 */
export function isEvidenceCurrent(
  stamp: CoachEvidenceStamp,
  currentTrackingEpoch: number,
  currentTakePassId: string,
): boolean {
  return stamp.trackingEpoch === currentTrackingEpoch && stamp.takePassId === currentTakePassId;
}

// ---------------------------------------------------------------------------
// Audio analysis seam (§12, §13)
// ---------------------------------------------------------------------------

/**
 * §12.4. One 20 ms analysis frame produced by the audio worklet.
 *
 * The worklet must not allocate per frame, block on IPC, call Luna, perform
 * network I/O, or touch the DOM (§12.1). These objects are therefore expected
 * to be written into a preallocated ring, not constructed per frame in a hot
 * path; the interface describes the *shape*, not an allocation strategy.
 */
export interface AudioFrameFeatures {
  /** Monotonic audio-clock time of the frame's first sample. */
  audioTimeMs: number;
  /** Frame RMS level, dBFS (negative; ≈ -100 for digital silence). */
  rmsDbfs: number;
  /** Frame peak level, dBFS (negative; ≈ 0 at full scale). */
  peakDbfs: number;
  /** Fraction of samples in this frame at or beyond full scale, 0–1. */
  clippingRatio: number;
  /** Adaptive noise-floor estimate, dBFS (negative). Never trained on voiced frames (§12.5). */
  noiseFloorDbfs: number;
  /** Estimated signal-to-noise ratio, dB (positive when speech exceeds noise). */
  estimatedSnrDb: number;
  /** VAD speech likelihood for this frame, 0–1. */
  speechProbability: number;
  /** Voicing (periodicity) likelihood for this frame, 0–1. */
  voicedProbability: number;
  /** Estimated fundamental frequency in Hz, or `null` when unvoiced/unreliable. */
  f0Hz: number | null;
  /** Confidence in `f0Hz`, 0–1. Meaningless when `f0Hz` is `null`. */
  f0Confidence: number;
  /** Spectral flux, unitless and implementation-relative; used only for onset detection. */
  spectralFlux: number;
  /** Zero-crossing rate, crossings per sample, 0–1. */
  zeroCrossingRate: number;
  /**
   * True when the worklet detected a gap in its own input (buffer underrun,
   * device change, thread starvation). Downstream aggregation MUST treat the
   * covered interval as unmeasured rather than as silence — otherwise a
   * dropout reads as a pause and corrupts both pace and cadence.
   */
  processorDropout: boolean;
}

/**
 * §12.5. A contiguous run of detected speech, emitted by the local VAD once
 * the run closes. The VAD is the timing authority for coaching and is
 * deliberately independent of OpenAI's commit behaviour.
 */
export interface SpeechInterval {
  startMs: number;
  endMs: number;
  /** Milliseconds within the interval classified as voiced. */
  voicedMs: number;
  /** Milliseconds within the interval classified as internal (preserved) pause. */
  silenceMs: number;
  meanSnrDb: number;
  takePassId: string;
}

/**
 * §13.4. Whether pitch-derived coaching is permitted right now. When
 * `usable` is false the rail shows a learning/unknown state and MUST NOT
 * invent a variety score.
 */
export interface PitchReliability {
  usable: boolean;
  /** Fraction of recent speech frames with reliable F0, 0–1. Gate is 0.45. */
  reliableFrameFraction: number;
  /** Usable voiced audio accumulated this take, ms. Gate is 12 000. */
  usableVoicedMs: number;
  /** Rolling median reference pitch, Hz, or `null` before calibration completes. */
  referenceF0Hz: number | null;
  reason:
    | 'ok'
    | 'insufficient_voiced_audio'
    | 'low_reliable_frame_fraction'
    | 'low_snr'
    | 'competing_audio'
    | 'clipping'
    | 'octave_instability';
}

// ---------------------------------------------------------------------------
// Script progress (§14.10) — the alignment engine's input to pace projection
// ---------------------------------------------------------------------------

/**
 * §14.10. Where the presenter is in the authored script, as the alignment
 * engine sees it.
 *
 * This is the one coaching input that comes from neither the audio path nor
 * the transcript. `remainingSpokenWordEquivalents` is a property of the script
 * *and* the cursor, so target-duration pacing —
 * `requiredWpm = remaining / remainingTargetMinutes` — is not computable
 * without it. It was missing from the first cut of this contract, which made
 * §14.10 unbuildable as specified.
 *
 * Note the direction of the dependency, because it is the whole reason this is
 * safe: coaching *reads* the cursor and never writes it. There is no inverse
 * of this type, and adding one would breach the advisory-only rule at the top
 * of this file.
 *
 * Every field other than the remainder exists so a consumer can decide whether
 * to *believe* the cursor. A projection built on a stale or re-acquiring
 * cursor twitches, and §14.10 is explicit that a twitching projection is worse
 * than none — so the correct response to an untrusted cursor is to emit no
 * projection at all, never a fallback value.
 */
export interface ScriptProgress {
  /** Spoken-unit index the alignment cursor has reached, 0-based. */
  cursorUnitIndex: number;
  /** Total spoken units in the script's planned path. */
  totalUnits: number;
  /**
   * Spoken-word equivalents from the cursor to the end of the planned path.
   * Supplied rather than derived, because a "unit" is not always a word and a
   * skipped section changes the remainder without changing the index.
   */
  remainingSpokenWordEquivalents: number;
  /** 0–1 alignment confidence in the cursor. */
  confidence: number;
  /** Audio-clock time the cursor was established, ms (§5.4). */
  observedAtMs: number;
  /** Tracking epoch the cursor belongs to; a change invalidates it (§5.4). */
  trackingEpoch: number;
  /** True while the engine is re-acquiring and the cursor is not trustworthy. */
  reacquiring: boolean;
}

// ---------------------------------------------------------------------------
// Rail modes and display state (§6, §27)
// ---------------------------------------------------------------------------

/** §6. Rail mode, selected globally with an optional per-script override. */
export type CoachRailMode = 'off' | 'minimal' | 'coach' | 'studio' | 'review_only' | 'custom';

/** §27. Tip severity, which drives contrast and cooldown-bypass eligibility. */
export type CoachTipSeverity = 'status' | 'gentle' | 'important' | 'critical';

/** §27.1. */
export type PaceState =
  | 'learning'
  | 'on_target'
  | 'slightly_fast'
  | 'fast'
  | 'slightly_slow'
  | 'slow'
  | 'paused'
  | 'low_confidence';

/** §27.2. */
export type VarietyState =
  | 'learning'
  | 'very_steady'
  | 'steady'
  | 'balanced'
  | 'expressive'
  | 'highly_animated'
  | 'low_confidence';

/**
 * §27.1. The pace tile's complete display state.
 *
 * `wpm` is `null` — not `0` — while learning or paused. Zero is a real,
 * different claim ("measured, and it is zero"), and rendering `0` where we
 * mean "unknown" is how a telemetry tile starts lying to a presenter mid-take.
 */
export interface PaceDisplayState {
  wpm: number | null;
  /** 0–1. Below the display threshold the state becomes `low_confidence`. */
  confidence: number;
  state: PaceState;
  /** Inclusive target band, words per minute. */
  targetLowWpm: number;
  targetHighWpm: number;
  /** Authored target duration for the script, ms, or `null` when not set. */
  targetDurationMs: number | null;
  /**
   * Projected finish minus target, ms. Positive = running long. `null` when
   * there is no target duration or not enough evidence to project.
   */
  projectedFinishDeltaMs: number | null;
  /** Sparkline samples, oldest first. Studio mode only; bounded by the producer. */
  recentSeries: Array<{ audioTimeMs: number; wpm: number }>;
}

/**
 * §27.2. The variety tile's display state. `level` is a unitless 0–100 score
 * of *movement relative to the speaker's own usable range* (§13.5) — never a
 * comparison against a population norm, and never gendered.
 *
 * More variety is not automatically better (§2.5): both `very_steady` and
 * `highly_animated` sit outside the target band, and the rail treats them
 * symmetrically.
 */
export interface VarietyDisplayState {
  level: number | null;
  confidence: number;
  state: VarietyState;
  targetLow: number;
  targetHigh: number;
  /** Pitch movement span, semitones relative to the rolling reference. */
  pitchSpanSemitones: number | null;
  /** Loudness range across recent speech, dB (positive). */
  energyRangeDb: number | null;
}

/** §15. The disfluency taxonomy. `strict_vocalized` is the only class safe to quote back. */
export type FillerKind =
  | 'strict_vocalized'
  | 'contextual'
  | 'repetitive_opener'
  | 'repeated_word'
  | 'false_start'
  | 'self_correction';

/**
 * §27.3. One detected disfluency.
 *
 * `confidence` is a three-state *ladder*, not a number, because the detection
 * pipeline is layered (§2.3). Per §16.5 the ladder is:
 *
 * - `confirmed` — a **final** transcript (Realtime *or* precision) contains the
 *   event, contextual classification passes, **and** timing is credible. All
 *   three are required. Local audio and Luna may also promote.
 * - `probable` — acoustic or local evidence is meaningful but lexical evidence
 *   is incomplete. A hit on a *provisional* tail never rises above this.
 * - `rejected` — a later transcript revision or context shows a legitimate word.
 *
 * Note the asymmetry the three-part rule creates, which is the point of it: a
 * `strict_vocalized` "um" sitting in a final transcript clears all three easily,
 * while a `contextual` "like" turns on the classification gate, which is where
 * §2.4 does its work. Requiring acoustic corroboration for the former as well
 * would be stricter than the spec and would leave `confirmedCount` pinned at
 * zero whenever the local audio path is unavailable — a silent, permanent lie
 * on the rail rather than a visible failure.
 *
 * `countedLive` records whether the event was already shown to the presenter,
 * so a later demotion can correct the count without retroactively rewriting
 * what they saw.
 */
export interface FillerEvent {
  eventId: string;
  kind: FillerKind;
  /** Lowercased, punctuation-stripped form used for counting and cooldowns. */
  normalizedForm: string;
  /**
   * Form safe to display back to the presenter, or `null` when nothing may be
   * quoted. Only ever set for `strict_vocalized` from the fixed lexicon
   * (§25.3) — never arbitrary transcript or model text.
   */
  displayForm: string | null;
  confidence: 'probable' | 'confirmed' | 'rejected';
  evidenceSources: Array<'realtime' | 'local_audio' | 'precision_transcript' | 'luna'>;
  audioStartMs: number;
  audioEndMs: number;
  /** 0–1 confidence in the *timing*, distinct from confidence in the detection. */
  timingConfidence: number;
  scriptAnchorTokenId: string | null;
  takePassId: string;
  /** True when the script authored this disfluency deliberately; never counted (§15). */
  authoredIntentional: boolean;
  countedLive: boolean;
}

/** §8. The filler tile's display state for the current take. */
export interface FillerDisplayState {
  /** Confirmed fillers this take pass. Probable-only detections are excluded. */
  confirmedCount: number;
  /** Confirmed in the trailing 20 s window — the cluster signal (§24). */
  confirmedLast20s: number;
  confirmedLast60s: number;
  /**
   * The most repeated strict filler this take, safe to quote, or `null`.
   * Drawn from the fixed lexicon only.
   */
  dominantForm: string | null;
  /** True while detection is degraded (no precision queue, poor SNR). */
  degraded: boolean;
}

/**
 * §12.7, §25.1. Microphone health as the rail presents it.
 *
 * §12.7.4 is a hard constraint encoded here by omission: there is no SPL or
 * absolute-loudness field, because without a calibrated microphone and known
 * distance CandidCue cannot measure one and MUST NOT claim to.
 */
export interface MicrophoneCoachState {
  status: 'ok' | 'learning' | 'low_level' | 'clipping' | 'noisy' | 'no_signal' | 'disconnected';
  /** Rolling input level, dBFS (negative). `null` before the first estimate. */
  levelDbfs: number | null;
  /** Rolling SNR estimate, dB (positive). `null` before the first estimate. */
  snrDb: number | null;
  /** True while the condition has persisted long enough to warrant an alert (§12.7). */
  sustained: boolean;
  /** Set when the Realtime transcription path itself is degraded (§25.1). */
  transcriptionDegraded: boolean;
}

// ---------------------------------------------------------------------------
// Tips (§24, §25, §27)
// ---------------------------------------------------------------------------

/** §24. What the local analyzers can propose. Luna may only classify these, never add one. */
export type CoachCandidateType =
  | 'system_mic_clipping'
  | 'system_mic_low'
  | 'system_noise_high'
  | 'system_transcription_degraded'
  | 'critical_number_mismatch'
  | 'critical_name_mismatch'
  | 'critical_unit_mismatch'
  | 'critical_negation_mismatch'
  | 'material_meaning_change'
  | 'pace_too_fast'
  | 'pace_too_slow'
  | 'terminal_rush'
  | 'filler_cluster'
  | 'repeated_filler'
  | 'contextual_filler'
  | 'run_on_delivery'
  | 'choppy_delivery'
  | 'low_variety'
  | 'high_variety'
  | 'repetitive_opener'
  | 'repeated_stumble'
  | 'positive_pace'
  | 'positive_filler_streak';

/**
 * §24 priority bands. Higher wins. These are *band floors*: the scheduler may
 * adjust within a band using confidence, recency, actionability and repetition
 * (§26.1), but may never reorder across bands.
 */
export const COACH_PRIORITY_BANDS = {
  /** Microphone unavailable, severe clipping, transcription failed. */
  system_critical: 100,
  /** Critical number, unit, name, negation, meaning reversal. */
  fidelity_critical: 90,
  /** Repeated restart blocking progress. */
  progress_blocked: 75,
  /** Sustained fast pace, terminal rush, filler cluster. */
  delivery_pressure: 65,
  /** Run-on or choppy cadence. */
  cadence: 55,
  /** Sustained low variety. */
  variety: 45,
  /** Repetitive opener and other stylistic patterns. */
  style: 35,
  /** Positive reinforcement. Disabled by default (§25.6). */
  positive: 10,
} as const;

export type CoachPriorityBand = keyof typeof COACH_PRIORITY_BANDS;

/**
 * §25. The complete set of authored tip codes.
 *
 * Luna returns a *code* from this set and never writes stage copy (§25). The
 * app maps the code to fixed, localized, authored text. A tip code arriving
 * from the model that is not in this set is discarded, not rendered.
 */
export type CoachTipCode =
  // §25.1 system and microphone
  | 'MIC_CLIPPING'
  | 'MIC_LEVEL_LOW'
  | 'NOISE_HIGH'
  | 'TRANSCRIPTION_DEGRADED'
  | 'MIC_DISCONNECTED'
  // §25.2 pace
  | 'PACE_EASE_BACK'
  | 'PACE_LIFT_SLIGHTLY'
  | 'TERMINAL_RUSH'
  // §25.3 filler and disfluency
  | 'USE_SILENT_PAUSE'
  | 'REPEATED_FILLER'
  | 'REPETITIVE_OPENER'
  | 'TAKE_SENTENCE_FROM_TOP'
  // §25.4 cadence and variety
  | 'LET_BOUNDARY_BREATHE'
  | 'KEEP_SENTENCE_FLOWING'
  | 'LIFT_KEY_WORDS'
  | 'SETTLE_DELIVERY'
  // §25.5 critical script fidelity
  | 'CRITICAL_NUMBER'
  | 'CRITICAL_NAME'
  | 'CRITICAL_UNIT'
  | 'CRITICAL_NEGATION'
  | 'MATERIAL_MEANING_CHANGE'
  // §25.6 positive reinforcement (disabled by default)
  | 'POSITIVE_PACE'
  | 'POSITIVE_FILLER_STREAK'
  | 'POSITIVE_VARIETY';

/**
 * §27. One tip, as scheduled and rendered.
 *
 * Named `CoachRailTip` rather than the spec's bare `CoachTip` to avoid
 * colliding with the older `CoachTip` in `shared/semantic/types.ts`, which
 * belongs to the primary specification's simpler tip surface. They are
 * genuinely different shapes: this one carries the display *window*
 * (`earliestDisplayMs` … `maximumDisplayMs`) that the rail scheduler needs.
 *
 * Copy is addressed by `textKey` + `interpolations`, never by a literal
 * string, so that no model-authored text can reach the presenter's glass even
 * if the validation layer is bypassed. `interpolations` values MUST come from
 * a fixed lexicon or from escaped authored script text (§25.3, §25.5).
 */
export interface CoachRailTip {
  tipId: string;
  code: CoachTipCode;
  /** Localization key resolved against the authored catalog. */
  textKey: string;
  /** Safe, escaped, length-limited substitutions. Never raw model output. */
  interpolations: Record<string, string>;
  severity: CoachTipSeverity;
  /** Effective priority, seeded from {@link COACH_PRIORITY_BANDS}. */
  priority: number;
  createdAudioTimeMs: number;
  evidenceStartMs: number;
  evidenceEndMs: number;
  /** Earliest audio time this tip may appear — used to wait for a safe moment (§26.1). */
  earliestDisplayMs: number;
  /** After this audio time the tip is stale and must be dropped unshown. */
  expiresAudioTimeMs: number;
  minimumDisplayMs: number;
  maximumDisplayMs: number;
  /** Groups tips that share a cooldown (§26.2), typically the style category. */
  cooldownKey: string;
  trackingEpoch: number;
  takePassId: string;
  scriptAnchorTokenId: string | null;
  evidenceIds: string[];
  source: 'local' | 'luna_validated';
}

// ---------------------------------------------------------------------------
// Ribbon (§10, §27.4)
// ---------------------------------------------------------------------------

export type CoachRibbonEventType =
  | 'speech'
  | 'confirmed_filler'
  | 'probable_filler'
  | 'repetition'
  | 'pause'
  | 'retake'
  | 'critical_mismatch'
  | 'clipping';

/** §27.4. One tick on the recent-event ribbon. Time-based, not token-based. */
export interface CoachRibbonEvent {
  eventId: string;
  type: CoachRibbonEventType;
  startMs: number;
  endMs: number;
  confidence: number;
  takePassId: string;
}

/**
 * §11. One marker beside an already-read script line.
 *
 * Separate from {@link CoachRibbonEvent} because the two are indexed
 * differently and cannot substitute for one another: the ribbon is *time*-based
 * ("where recently did that happen?") while a gutter mark is *script*-based
 * ("which line contained the filler?"). A `FillerEvent` carries
 * `scriptAnchorTokenId`, but the full event never crosses to the stage, so
 * without this type §11 is not implementable from the rail payload at all.
 *
 * §11.2: marks appear only behind the active reading rail, never in unread
 * text, and the script text itself is never recoloured. A line with several
 * events collapses to one marker with a `count`. §11.3: every mark carries its
 * `takePassId` so a reread line does not conflate passes.
 */
export interface CoachGutterMark {
  markId: string;
  /** Authored token the mark anchors to; a filler between tokens anchors to the preceding one. */
  scriptAnchorTokenId: string;
  type: CoachRibbonEventType;
  /** Events collapsed into this marker. Always >= 1. */
  count: number;
  takePassId: string;
}

/**
 * §6.6. The rail's resolved feature flags.
 *
 * `CoachRailMode` alone is not sufficient for the stage to render correctly:
 * mode `custom` is defined entirely by individual module toggles that live in
 * {@link CoachingSettings}, which does not cross to the stage. Without this the
 * stage has to guess, and guessing means `custom` silently renders as `coach`
 * — the user turns a module off and it stays on.
 *
 * Resolved on the control side so there is one interpretation of a mode rather
 * than one per consumer.
 */
export interface CoachRailModules {
  paceNumber: boolean;
  paceStatus: boolean;
  paceSparkline: boolean;
  targetDurationStatus: boolean;
  varietyScore: boolean;
  varietyLabel: boolean;
  fillerCount: boolean;
  fillerRibbon: boolean;
  gutterMarks: boolean;
  liveTips: boolean;
}

// ---------------------------------------------------------------------------
// The control → stage payload (§27)
// ---------------------------------------------------------------------------

/**
 * §27. The complete rail snapshot. **This is the only coaching payload that
 * crosses into the stage window**, and the stage's entire coaching job is to
 * render it (§5.2).
 *
 * Deliberately absent, per Rule 1 at the top of this file: any scroll offset,
 * unit position, cursor index, section id, navigation directive, or motion
 * field. The stage must keep scrolling smoothly even if every coaching process
 * dies (§5.2), which is only true if the rail can never influence motion.
 *
 * The stage MUST validate on arrival rather than trusting the sender: reject a
 * snapshot whose `sessionId` is not the current session, or whose
 * `stageRevision` is not greater than the last one applied. Out-of-order
 * delivery is normal; a lower revision is stale, not a correction.
 */
export interface CoachRailState {
  schemaVersion: 1;
  /** Monotonically increasing per session. The stage rejects non-increasing values. */
  stageRevision: number;
  sessionId: Uuid;
  takePassId: string;
  mode: CoachRailMode;
  /**
   * §6.6. The mode's resolved feature flags, so the stage never has to
   * interpret `custom` — or any other mode — for itself.
   */
  modules: CoachRailModules;
  /**
   * The audio-clock time this snapshot describes.
   *
   * Required because the rail is full of *time-relative* rendering: the
   * ribbon's right edge is "now", a late event must fade in at its historical
   * position rather than jumping to now (§10.4), and a tip expires against
   * `expiresAudioTimeMs`. Without an authoritative clock in the payload the
   * stage has to estimate one by free-running from the newest timestamp it can
   * find, which drifts and needs resync heuristics. Sending the number the
   * producer already has removes that entire class of error.
   */
  audioTimeMs: number;
  /**
   * Whether the rail is currently shown. Toggled by the control UI or by the
   * "show me my stats" voice command.
   *
   * Hiding the rail MUST NOT reflow the script: the rail's geometry stays
   * reserved (§7.1) and only its contents fade. Reclaiming the space would
   * move the reading band under the presenter mid-take, which is exactly the
   * failure §7.1 exists to prevent.
   */
  visible: boolean;
  /** Mirror state, so the rail uses the same transform boundary as the script (§7.5). */
  mirrored: boolean;
  reducedMotion: boolean;
  pace: PaceDisplayState;
  variety: VarietyDisplayState;
  fillers: FillerDisplayState;
  microphone: MicrophoneCoachState;
  /** At most one tip is ever visible (§9). */
  activeTip: CoachRailTip | null;
  /** Oldest first. Bounded by the producer; the stage does not trim. */
  ribbonEvents: CoachRibbonEvent[];
  /**
   * §11. Marks for already-read lines. Empty unless `modules.gutterMarks` is
   * on — the feature is optional and off by default.
   */
  gutterMarks: CoachGutterMark[];
}

// ---------------------------------------------------------------------------
// Analyzer → policy seam (§20, §22)
// ---------------------------------------------------------------------------

/**
 * §22. One locally-detected candidate offered to the scheduler, and — when it
 * needs semantic classification — to Luna.
 *
 * `spokenFragment` and `authoredFragment` are bounded excerpts for
 * classification only. They are never rendered as tip copy: authored text may
 * be quoted back under §25.5, but only after the local layer selects it, never
 * because the model echoed it.
 */
export interface CoachCandidate {
  evidenceId: string;
  type: CoachCandidateType;
  /** 0–1 local confidence before any semantic validation. */
  localConfidence: number;
  stamp: CoachEvidenceStamp;
  /**
   * The authored **span** (sentence/clause) this candidate belongs to, or
   * `null`.
   *
   * This is a *span* id and nothing else. It was previously the only anchor
   * field, so producers with only a token-level anchor put a **token** id here,
   * and the scheduler — which compares this against the active span id every
   * tick — then cancelled the tip as out-of-scope on the very first tick. A
   * priority-90 "you misread that number" alert survived roughly one frame.
   * The same collision defeated the `<!-- cc:coach off -->` opt-out, because
   * admission compared a token id against a set of span ids and never matched.
   *
   * If you have a token, populate {@link scriptAnchorTokenId} instead and
   * leave this `null`; never cross-assign the two.
   */
  scriptSpanId: string | null;
  /**
   * The authored **token** this candidate points at, or `null`. Used for gutter
   * marks and for quoting authored text — never for scope comparison.
   */
  scriptAnchorTokenId: string | null;
  /**
   * Ids of the underlying evidence records (e.g. `FillerEvent.eventId`) this
   * candidate aggregates.
   *
   * Required for §26.5: a tip must be cancelled when its evidence is revised
   * away. Without this there is no path from a demoted event back to the
   * candidate that aggregated it, so the filler count could correct downward
   * while the tip built on that very "um" stayed on the presenter's glass.
   * Empty is legitimate for candidates derived from continuous measurement
   * (pace, variety) rather than from discrete events.
   */
  contributingEventIds: string[];
  /** Analyzer-specific sub-classification, e.g. the filler's normalized form. */
  detailCode: string;
  spokenFragment: string;
  authoredFragment: string;
  /**
   * True when the candidate rests on final transcript evidence. A candidate
   * built only from provisional text may never become a visible tip — a
   * provisional tail is routinely revised away, and a tip that appears and
   * then proves wrong costs more trust than the tip was worth.
   */
  finalEvidence: boolean;
}

/** §20. Delivery style, which sets target bands rather than changing behaviour. */
export type DeliveryStyle =
  | 'calm'
  | 'natural'
  | 'conversational'
  | 'expressive'
  | 'broadcast'
  | 'custom';

/** §22. The bounded snapshot sent to the Luna Coach Observer. */
export interface LunaCoachRequest {
  schemaVersion: '1.0';
  sessionId: Uuid;
  scriptId: Uuid;
  scriptRevision: number;
  trackingEpoch: number;
  takePassId: string;
  requestAudioTimeMs: number;
  /** After this audio time the answer is useless; the observer must not apply it late. */
  validUntilAudioTimeMs: number;
  language: string;

  state: {
    alignmentConfidence: number;
    commandActive: boolean;
    retakeState: 'none' | 'pending' | 'reversing' | 'settling';
    reacquiring: boolean;
    microphoneHealthy: boolean;
  };

  profile: {
    coachingMode: 'minimal' | 'coach' | 'studio';
    deliveryStyle: DeliveryStyle;
    targetWpmLow: number;
    targetWpmHigh: number;
    targetVarietyLow: number;
    targetVarietyHigh: number;
    liveTipFrequency: 'low' | 'normal' | 'high';
  };

  authoredSpans: Array<{
    spanId: string;
    text: string;
    criticalTokens: string[];
    emphasisTokens: string[];
    punctuationClass: 'weak' | 'medium' | 'strong' | 'paragraph';
    coachingDisabled: boolean;
  }>;

  speech: {
    finalText: string;
    provisionalTail: string;
    finalAudioStartMs: number;
    finalAudioEndMs: number;
  };

  metrics: {
    displayWpm: number | null;
    paceState: PaceState;
    pacePersistenceMs: number;
    terminalRushRatio: number | null;
    varietyLevel: number | null;
    varietyState: VarietyState;
    varietyPersistenceMs: number;
    cadenceBalance: number | null;
    runOnCount: number;
    choppyPauseCount: number;
    confirmedFillersLast20s: number;
    confirmedFillersLast60s: number;
  };

  candidates: Array<{
    evidenceId: string;
    type: CoachCandidateType;
    localConfidence: number;
    audioStartMs: number;
    audioEndMs: number;
    scriptSpanId: string | null;
    detailCode: string;
    spokenFragment: string;
    authoredFragment: string;
  }>;
}

/** §23. Reason codes the model must supply for every decision, including `none`. */
export type LunaCoachReasonCode =
  | 'NO_ACTIONABLE_ISSUE'
  | 'INSUFFICIENT_EVIDENCE'
  | 'ISSUE_SELF_CORRECTED'
  | 'ISSUE_STALE'
  | 'COACHING_SUPPRESSED'
  | 'HIGH_VALUE_LOCAL_PATTERN'
  | 'CONTEXTUAL_FILLER_CONFIRMED'
  | 'CONTEXTUAL_FILLER_REJECTED'
  | 'PARAPHRASE_PRESERVES_MEANING'
  | 'MATERIAL_DIFFERENCE_CONFIRMED'
  | 'BEST_OF_MULTIPLE_CANDIDATES';

/** §23. The set of codes Luna may return. Narrower than {@link CoachTipCode}. */
export type LunaCoachTipCode =
  | 'NONE'
  | 'PACE_EASE_BACK'
  | 'PACE_LIFT_SLIGHTLY'
  | 'TERMINAL_RUSH'
  | 'USE_SILENT_PAUSE'
  | 'REPEATED_FILLER'
  | 'LET_BOUNDARY_BREATHE'
  | 'KEEP_SENTENCE_FLOWING'
  | 'LIFT_KEY_WORDS'
  | 'SETTLE_DELIVERY'
  | 'REPETITIVE_OPENER'
  | 'TAKE_SENTENCE_FROM_TOP'
  | 'CRITICAL_NUMBER'
  | 'CRITICAL_NAME'
  | 'CRITICAL_UNIT'
  | 'CRITICAL_NEGATION'
  | 'MATERIAL_MEANING_CHANGE';

/**
 * §23. The structured-output response, in the model's snake_case wire shape.
 *
 * Kept in wire casing on purpose: this is what crosses the network, and
 * silently camelCasing it in the type while the JSON schema says otherwise is
 * how a validator ends up checking fields that never arrive. Convert at the
 * boundary in the observer, after validation.
 *
 * §23.1: schema-valid is not the same as acceptable. A response is still
 * rejected when decision and tip_code disagree, confidence is below the
 * per-code threshold, an evidence id is unknown or stale, the code is not
 * allowed by the local candidate types, current state suppresses it,
 * valid_for_ms has expired, the epoch or take pass is old, or a local
 * deterministic rule already invalidated the event.
 */
export interface LunaCoachDecision {
  decision: 'none' | 'candidate';
  tip_code: LunaCoachTipCode;
  confidence: number;
  evidence_ids: string[];
  scope: 'none' | 'current_phrase' | 'next_boundary' | 'session_pattern';
  reason_code: LunaCoachReasonCode;
  valid_for_ms: number;
}

// ---------------------------------------------------------------------------
// Settings (§30)
// ---------------------------------------------------------------------------

/**
 * §30. User-facing coaching configuration. `custom` mode reads the individual
 * module flags; the named modes derive them.
 */
export interface CoachingSettings {
  mode: CoachRailMode;
  deliveryStyle: DeliveryStyle;
  targetWpmLow: number;
  targetWpmHigh: number;
  targetVarietyLow: number;
  targetVarietyHigh: number;
  liveTipFrequency: 'low' | 'normal' | 'high';
  /** §12.6. Precision transcription keeps a short in-memory PCM ring buffer. */
  precisionTranscriptionEnabled: boolean;
  /** §25.6. Off by default; positive tips must never feel patronizing. */
  positiveReinforcementEnabled: boolean;
  postTakeReportEnabled: boolean;
  /** §7.6. Rail text scale, 0.8–1.5. */
  railTextScale: number;
  modules: {
    paceNumber: boolean;
    paceStatus: boolean;
    targetDurationStatus: boolean;
    varietyScore: boolean;
    fillerCount: boolean;
    fillerRibbon: boolean;
    inlineGutterMarks: boolean;
    liveTips: boolean;
  };
}

// ---------------------------------------------------------------------------
// Diagnostics (§37)
// ---------------------------------------------------------------------------

/**
 * §37. Observability for the coaching subsystem. This is the *only* place
 * wall-clock arrival time is legitimate (§5.4) — for measuring how late a
 * result landed relative to the audio interval it describes.
 */
export interface CoachDiagnostics {
  /** Audio frames the worklet reported as dropped this session. */
  droppedFrameCount: number;
  /** Analyzer aggregation cost, ms, rolling mean. */
  analyzerMeanCostMs: number;
  /** Luna observer requests issued, answered, rejected by local validation. */
  lunaRequests: number;
  lunaResponses: number;
  lunaRejected: number;
  /** Wall-clock latency from `requestAudioTimeMs` to answer application, ms. */
  lunaMeanLatencyMs: number;
  /** Precision transcription chunks queued, completed, dropped by the bound. */
  precisionQueued: number;
  precisionCompleted: number;
  precisionDropped: number;
  /** Tips proposed vs actually shown — the ratio that tells you the rail is too chatty. */
  tipsProposed: number;
  tipsShown: number;
  tipsSuppressed: number;
}
