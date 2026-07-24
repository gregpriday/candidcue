/**
 * Disfluency-pipeline internal types (spec §15, §16, §29).
 *
 * Everything that crosses a *subsystem* seam lives in
 * `src/shared/contracts/coaching.ts` and is imported from there — never
 * re-declared here. The types in this file describe the inputs the disfluency
 * modules consume and the intermediate evidence they pass to one another; they
 * are deliberately narrow structural shapes so a caller can satisfy them from
 * the transcript ledger, the tracking engine, or a fixture without importing
 * either implementation.
 *
 * Units follow contract Rule 2: every number carries its unit in the name.
 * Times are milliseconds on the application's monotonic **audio** clock
 * (contract Rule 3) — no wall-clock value ever enters this pipeline, and there
 * is no `Date.now()` anywhere below `disfluency/`.
 */
import type {
  CoachEvidenceStamp,
  FillerEvent,
  FillerKind,
  SpeechInterval,
} from '../../contracts/coaching';

/* ---------------------------------------------------------------------------
 * Take identity
 * ------------------------------------------------------------------------- */

/**
 * The evidence identity every event is stamped with. Held by the pipeline and
 * rotated on retake / re-anchor so {@link isEvidenceCurrent} can reject stale
 * coaching downstream.
 */
export interface TakeIdentity {
  takePassId: string;
  trackingEpoch: number;
}

/* ---------------------------------------------------------------------------
 * Layer A input: realtime transcript (§16.1)
 * ------------------------------------------------------------------------- */

/**
 * A Realtime transcript item as the disfluency pipeline needs it.
 *
 * Structurally satisfiable from `LedgerItem` (tracking) plus the audio-clock
 * interval the commit driver already tracks; deliberately not an import of the
 * ledger type, so this module can be tested with plain fixtures and so a
 * change to ledger internals cannot silently change filler semantics.
 */
export interface RealtimeTranscriptItem {
  itemId: string;
  /** Realtime commit ordinal (§5.4). `null` only for synthesized items. */
  commitSequence: number | null;
  /** Monotonic audio-clock start of the audio this text describes. */
  audioStartMs: number;
  /** Monotonic audio-clock end. `>= audioStartMs`. */
  audioEndMs: number;
  /** Finalized text for the item. Punctuation is preserved as received. */
  text: string;
  /**
   * True when this is the start of a speaking turn, which is the only place a
   * bare `so` / `well` / `okay` may be treated as a discourse opener without
   * further evidence (§15.3).
   */
  turnStart?: boolean;
  /**
   * Mean token log-probability for the item when the provider supplies it.
   * Used as *one* confidence feature (§16.1 step 7), never as a gate on its
   * own — providers omit it far more often than they supply it.
   */
  meanLogprob?: number | null;
  /**
   * Per-word audio intervals when the provider supplies them. When absent the
   * detector places tokens proportionally and lowers `timingConfidence`
   * accordingly (§16.3.4).
   */
  wordTimings?: readonly WordTiming[];
}

export interface WordTiming {
  /** Normalized word this timing belongs to; matched positionally. */
  startMs: number;
  endMs: number;
}

/**
 * The authored script material aligned to a transcript item. Supplied by the
 * caller from the tracking engine's current alignment; `text` is `''` when
 * alignment is unavailable, which makes every "absent from authored text"
 * test fail closed (i.e. nothing is treated as an insertion).
 */
export interface AuthoredSpanContext {
  spanId: string | null;
  scriptAnchorTokenId: string | null;
  /** Authored text covering the same script region, as authored. */
  text: string;
  /**
   * Forms the author explicitly marked as intentional delivery (§15.5), e.g.
   * from `*um*` emphasis or a `<!-- cc:filler intentional -->` annotation.
   * Normalized, lowercase.
   */
  intentionalForms?: readonly string[];
  /** True when the author disabled coaching for this span. */
  coachingDisabled?: boolean;
  /**
   * True when the caller's alignment confidence is too low to trust the
   * authored comparison. Treated exactly like a missing span: no insertion
   * claims may be made against it.
   */
  alignmentUnreliable?: boolean;
}

/**
 * A provisional-transcript observation. Deliberately *not* a
 * {@link FillerEvent}: §16.1 forbids provisional text from producing a visible
 * tick, and the cheapest way to guarantee that is to make it impossible to
 * express. Hints exist so the pipeline can pre-warm a precision chunk.
 */
export interface ProvisionalFillerHint {
  itemId: string;
  normalizedForm: string;
  kind: FillerKind;
  audioStartMs: number;
  audioEndMs: number;
}

/* ---------------------------------------------------------------------------
 * Layer B: local acoustic candidates (§16.2)
 * ------------------------------------------------------------------------- */

/**
 * A hesitation-like acoustic region. §16.2 is emphatic that this layer is
 * conservative: a generic sustained vowel is not automatically "um", so a
 * candidate may raise confidence in a lexical detection or request precision
 * transcription, but never on its own produce a high-severity live critique.
 */
export interface AcousticHesitationCandidate {
  candidateId: string;
  startMs: number;
  endMs: number;
  /** 0–1. Capped below {@link ACOUSTIC_ONLY_CONFIDENCE_CEILING} by design. */
  score: number;
  features: {
    durationMs: number;
    /** Pitch stability across the region, semitones of standard deviation. */
    pitchStabilitySemitones: number | null;
    /** Mean spectral flux relative to the recent speech median, unitless ratio. */
    spectralMovementRatio: number;
    meanSnrDb: number;
    /** Silence immediately before / after the region, ms. */
    leadingPauseMs: number;
    trailingPauseMs: number;
    /** True when no finalized token landed in this region (§16.2). */
    lowLexicalProgress: boolean;
  };
}

/**
 * §16.2: acoustic evidence alone may never carry a detection past `probable`,
 * and may never drive a high-severity tip. Enforced at the one place the score
 * is produced.
 */
export const ACOUSTIC_ONLY_CONFIDENCE_CEILING = 0.6;

/* ---------------------------------------------------------------------------
 * Layer C: precision transcription (§16.3, §29)
 * ------------------------------------------------------------------------- */

/** §29.3 cost modes. */
export type PrecisionCostMode = 'off' | 'on_candidates' | 'full_precision' | 'review_only';

/**
 * Why a chunk was created. Also its queue value class: under pressure the
 * queue drops `ordinary` before `candidate`, and never drops `take_tail`
 * while review is enabled (§29.1).
 */
export type PrecisionChunkPriority = 'ordinary' | 'candidate' | 'take_tail';

export const PRECISION_PRIORITY_RANK: Readonly<Record<PrecisionChunkPriority, number>> = {
  ordinary: 0,
  candidate: 1,
  take_tail: 2,
};

/** One unit of audio queued for a promptable, disfluency-preserving pass. */
export interface PrecisionChunkRequest {
  chunkId: string;
  audioStartMs: number;
  audioEndMs: number;
  priority: PrecisionChunkPriority;
  takePassId: string;
  trackingEpoch: number;
  /** Realtime commit this chunk's audio came from, or `null`. */
  commitSequence: number | null;
  /** Short nearby-name dictionary for the prompt (§16.3.3). Never the script. */
  scriptDictionary: readonly string[];
}

/** The verbatim result for a chunk. */
export interface PrecisionTranscriptResult {
  chunkId: string;
  /**
   * The audio interval this text describes — carried through from the request
   * so a delayed result is mapped *back* onto its interval (§5.4) rather than
   * stamped with its arrival time.
   */
  audioStartMs: number;
  audioEndMs: number;
  takePassId: string;
  trackingEpoch: number;
  commitSequence: number | null;
  /** Verbatim text, hesitations preserved. */
  text: string;
  /** Per-word intervals when the model returns them. */
  wordTimings?: readonly WordTiming[];
}

/**
 * The network seam. The queue owns bounding, ordering, retry and dropping;
 * it owns no HTTP. Implementations live outside `disfluency/`.
 */
export interface PrecisionTranscriptionClient {
  transcribe(request: PrecisionChunkRequest): Promise<PrecisionTranscriptResult>;
}

/** Why a chunk never produced a result. */
export type PrecisionDropReason =
  | 'mode_off'
  | 'oversized_chunk'
  | 'queue_full'
  | 'evicted_lower_value'
  | 'stale_take_pass'
  | 'in_flight_timeout'
  | 'transport_failed';

export interface PrecisionDropRecord {
  chunkId: string;
  reason: PrecisionDropReason;
  priority: PrecisionChunkPriority;
  audioStartMs: number;
  audioEndMs: number;
  /** Audio-clock time the drop decision was made. */
  decidedAtAudioMs: number;
}

/* ---------------------------------------------------------------------------
 * Detections (the pipeline's internal record around a FillerEvent)
 * ------------------------------------------------------------------------- */

/**
 * A {@link FillerEvent} plus everything promotion, demotion and candidate
 * generation later need. Lives here rather than beside the detector because
 * three modules produce and consume it.
 */
export interface FillerDetection {
  event: FillerEvent;
  /** Canonical lexicon form (`um`, `you know`), for grouping and cooldowns. */
  canonicalForm: string;
  /**
   * §16.5 conjunct 1. True when this detection rests on a **final** transcript
   * — Realtime or precision. A detection derived from a provisional tail may
   * never be confirmed, however good the other evidence looks, because a
   * provisional tail is routinely revised away.
   *
   * Today this is structurally always true (`observeProvisional` returns
   * hints, not detections), and the guard exists so that a future producer
   * cannot quietly change that.
   */
  finalEvidence: boolean;
  /**
   * §15.1 qualification for the *conditional* strict forms `hmm` / `mm` / `ah`,
   * which are fillers only when used to hold the floor or hesitate. For those
   * forms this is the §16.5 "contextual classification passes" term, and only
   * local audio can supply it. It is **not** a general corroboration
   * requirement: `um` / `uh` / `er` / `erm` and contextual forms never set it.
   */
  requiresHesitationEvidence: boolean;
  /** Contextual classifier score, or 1 for strict forms. */
  contextScore: number;
  /**
   * §29.2 "neighboringTokenIds": the normalized tokens either side, joined.
   * Two placements of the same utterance from overlapping chunks agree on
   * this even when their estimated audio centres do not, which is what makes
   * de-duplication survive an unlocalized placement.
   */
  neighbourKey: string;
  commitSequence: number | null;
  trackingEpoch: number;
  itemId: string;
  tokenIndex: number;
  spokenFragment: string;
  authoredFragment: string;
  /** Diagnostics: why this detection was accepted. */
  reasons: string[];
}

/* ---------------------------------------------------------------------------
 * Reconciliation output (§16.3.4, §16.5)
 * ------------------------------------------------------------------------- */

export interface ReconciliationOutcome {
  /** Detections newly created from precision-only insertions. */
  created: FillerDetection[];
  /** Event ids promoted `probable` → `confirmed`. */
  promoted: string[];
  /** Event ids demoted `probable` → `rejected` by the precision transcript. */
  demoted: string[];
  /**
   * Event ids the precision transcript agreed with that were already
   * `confirmed` — no confidence change, but real corroborating evidence, and
   * the reason `evidenceSources` can show both layers agreeing.
   */
  corroborated: string[];
  /** Precision insertions merged into an existing event by §29.2 identity. */
  deduplicated: string[];
}

/**
 * §16.3.4. Below this, a filler is counted but *not* localized: no precise
 * gutter dot may be placed. `FillerEvent` has no `unlocalized` flag by design —
 * `timingConfidence` already carries exactly this claim — so the threshold is
 * exported rather than duplicated as a boolean at each call site.
 */
export const UNLOCALIZED_TIMING_CONFIDENCE = 0.35;

/** §16.3.4 helper: the event was counted, but its position is not trustworthy. */
export function isUnlocalized(event: FillerEvent): boolean {
  return event.timingConfidence < UNLOCALIZED_TIMING_CONFIDENCE;
}

/**
 * The local-audio view a timing check runs against.
 *
 * `vadObservedUpToMs` is the audio time the local VAD has reported *through*.
 * It is what separates "the VAD says there was silence here" from "the VAD has
 * not got here yet", which are opposite claims that a bare interval list
 * cannot distinguish.
 */
export interface TimingEvidence {
  speechIntervals: readonly SpeechInterval[];
  /** Audio time the VAD has reported through, or `null` when there is no local audio at all. */
  vadObservedUpToMs: number | null;
  /** Fraction of the event that must be covered by speech. Default 0.6. */
  coverageRatio?: number;
}

/**
 * §16.5 conjunct 3 — **"timing is credible"**, as a named predicate rather
 * than an accident of how an interval happened to be derived.
 *
 * It resolves to exactly two claims:
 *
 * 1. The interval is well formed — finite, non-negative, non-inverted.
 * 2. The local VAD does not *contradict* it. Local audio may veto a filler
 *    stamped across silence, but its **absence can never block a confirmation**
 *    (`vadObservedUpToMs === null`, or the VAD has not yet reported through the
 *    event's end). The opposite choice reads as caution and behaves as a lie:
 *    a rail showing "FILLERS 0" for a take full of them whenever the audio
 *    worklet is unavailable.
 *
 * In practice the VAD runs 20 ms frames locally and is always *ahead* of a
 * Realtime commit, so the permissive branch is the degraded path, not the
 * normal one.
 *
 * Deliberately **not** a localization test. §16.3.4 requires an unlocalized
 * filler to still be counted, so `timingConfidence` does not gate confirmation;
 * {@link isUnlocalized} governs only whether a precise gutter dot may be placed.
 */
export function hasCredibleTiming(event: FillerEvent, evidence: TimingEvidence): boolean {
  const { audioStartMs, audioEndMs } = event;
  if (!Number.isFinite(audioStartMs) || !Number.isFinite(audioEndMs)) return false;
  if (audioStartMs < 0 || audioEndMs < audioStartMs) return false;

  const observedUpToMs = evidence.vadObservedUpToMs;
  if (observedUpToMs === null || audioEndMs > observedUpToMs) return true;

  const durationMs = Math.max(1, audioEndMs - audioStartMs);
  let coveredMs = 0;
  for (const interval of evidence.speechIntervals) {
    const overlap = Math.min(interval.endMs, audioEndMs) - Math.max(interval.startMs, audioStartMs);
    if (overlap > 0) coveredMs += overlap;
  }
  return coveredMs / durationMs >= (evidence.coverageRatio ?? 0.6);
}

/**
 * The single place that decides whether an event contributes to the number the
 * presenter reads on the filler tile (§2.4, §15.3, §15.5, §16.5).
 *
 * Only the two *filler* kinds count. The rest of the taxonomy is still
 * detected, stamped and reported, but:
 *
 * - `repetitive_opener` is a **session pattern**, not a filler (§15.3);
 *   counting "and" into the filler total is precisely the failure §2.4
 *   forbids. It is excluded by *kind*, not merely by never being promoted, so
 *   that no later promotion path — including Luna — can leak it into the total.
 * - repetitions, false starts and self-corrections are disfluencies, not
 *   fillers; §15.4 explicitly keeps a successful self-correction out of live
 *   critique. They drive `repeated_stumble` and the post-take report instead
 *   (see {@link isCountableDisfluency}).
 */
export function isCountableFiller(event: FillerEvent): boolean {
  if (event.kind !== 'strict_vocalized' && event.kind !== 'contextual') return false;
  if (event.authoredIntentional) return false;
  return event.confidence === 'confirmed';
}

/**
 * Wider than {@link isCountableFiller}: every confirmed, non-authored
 * disfluency except the opener *pattern*. This is the review-mode population
 * (§16.6) and the evidence pool for `repeated_stumble`.
 */
export function isCountableDisfluency(event: FillerEvent): boolean {
  if (event.kind === 'repetitive_opener') return false;
  if (event.authoredIntentional) return false;
  return event.confidence === 'confirmed';
}

/* ---------------------------------------------------------------------------
 * Evidence identity (§29.2)
 * ------------------------------------------------------------------------- */

/** FNV-1a, 32-bit. Deterministic and dependency-free; ids must be stable. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * §29.2. Adjacent precision chunks overlap by 300–600 ms, so the same filler
 * is seen twice and MUST produce one event. Identity therefore hashes the
 * fields that are stable across an overlap — never the chunk id, and never an
 * arrival time.
 *
 * `roundedAudioCenterMs` is quantized to {@link EVENT_IDENTITY_QUANTUM_MS} so
 * two estimates of the same utterance that differ by a few tens of
 * milliseconds collapse to one id.
 */
export const EVENT_IDENTITY_QUANTUM_MS = 250;

/** Deterministic id from stable parts. No counters, no clock, no randomness. */
export function stableId(prefix: string, parts: readonly (string | number)[]): string {
  return `${prefix}_${fnv1a(parts.join(' '))}`;
}

export function fillerEventId(parts: {
  takePassId: string;
  normalizedForm: string;
  audioCenterMs: number;
  neighboringTokenIds: readonly string[];
}): string {
  const quantized =
    Math.round(parts.audioCenterMs / EVENT_IDENTITY_QUANTUM_MS) * EVENT_IDENTITY_QUANTUM_MS;
  const key = [
    parts.takePassId,
    parts.normalizedForm,
    String(quantized),
    parts.neighboringTokenIds.join('|'),
  ].join(' ');
  return `fil_${fnv1a(key)}`;
}

/** Convenience: build a stamp from an event plus take identity. */
export function stampFor(
  event: Pick<FillerEvent, 'audioStartMs' | 'audioEndMs' | 'takePassId'>,
  commitSequence: number | null,
  trackingEpoch: number,
): CoachEvidenceStamp {
  return {
    audioStartMs: event.audioStartMs,
    audioEndMs: event.audioEndMs,
    commitSequence,
    trackingEpoch,
    takePassId: event.takePassId,
  };
}
