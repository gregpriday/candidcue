/**
 * The delivery scoring engine — Speaking Score report §9 end to end.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS AND WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 * It is the §9 model: band scores (§9.2/§9.3) → confidence-weighted dimensions
 * (§9.4/§9.5) → `0.75 × mean + 0.25 × weak` (§9.6) → smoothing, a rate cap and
 * suppression, with an evidence confidence (§9.7) and the §9.8 protections
 * against transcript corrections.
 *
 * It is **not** an analyzer. It measures nothing; every number it consumes is
 * produced by a lane that already existed. The report's §12.1 proposes building
 * that lane tree in Rust — it is already built, in TypeScript, with its own
 * tests, and re-deriving a WPM here would immediately become a second answer
 * that disagrees with the one on the pace tile.
 *
 * ---------------------------------------------------------------------------
 * THE RULES IT INHERITS
 * ---------------------------------------------------------------------------
 * - **Advisory only.** Nothing here returns or accepts a scroll offset, cursor
 *   index, unit id or navigation directive. `DeliveryScoreState` has no
 *   positional field and there is no method that could produce one.
 * - **Audio clock only.** Every decision is stamped from `evidence.audioTimeMs`.
 *   There is no `Date.now`, no `performance.now`, and no assumption that
 *   `update` is called at any particular rate.
 * - **Deterministic.** No randomness, no wall clock, no iteration over an
 *   unordered collection. The same evidence sequence replays to the same
 *   numbers (§12.7), which is what the tests depend on.
 * - **Recording faults are not delivery faults.** `MicrophoneCoachState`
 *   reaches exactly one function, `signalQualityFrom`, and that function
 *   returns a confidence multiplier. There is no other path (§15, §1.3).
 */
import {
  DELIVERY_SCORE_WEIGHTS,
  type DeliveryDimension,
  type DeliveryScoreState,
  type DimensionScore,
} from '../../contracts/coaching';
import { clampScore } from './band';
import {
  calibrationMaturityFrom,
  combineConfidence,
  confidenceTier,
  coverageFrom,
  signalQualityFrom,
  type ConfidenceComponents,
} from './confidence';
import { combineDimensions, scoreDimension, type DimensionResult } from './dimension';
import {
  PaceDriftTracker,
  TranscriptEvidenceLedger,
  type DeliveryEvidence,
} from './evidence';
import {
  CONVERSATIONAL_AUTHORITY,
  DEFAULT_DELIVERY_SCORE_OPTIONS,
  type DeliveryScoreOptions,
  type DeliveryTargetProfile,
} from './profile';
import { advanceDisplayScore } from './smoothing';
import { buildSubmetrics, type DeliveryScoreMemory } from './submetrics';

const DIMENSION_ORDER = Object.keys(DELIVERY_SCORE_WEIGHTS) as DeliveryDimension[];

export interface DeliveryScoreEngineOptions {
  options?: Partial<DeliveryScoreOptions>;
  profile?: DeliveryTargetProfile;
}

/** Everything the engine computed this pass, for diagnostics and review. */
export interface DeliveryScoreSnapshot {
  readonly state: DeliveryScoreState;
  readonly confidence: ConfidenceComponents;
  readonly dimensions: readonly DimensionResult[];
  readonly mean: number | null;
  readonly weak: number | null;
}

export class DeliveryScoreEngine {
  readonly options: DeliveryScoreOptions;
  readonly profile: DeliveryTargetProfile;

  private readonly ledger: TranscriptEvidenceLedger;
  private readonly drift: PaceDriftTracker;

  private smoothed: number | null = null;
  private display: number | null = null;
  private lastUpdateMs: number | null = null;

  /** §9.8: the ratio and when it last *changed*, so a stale one can decay. */
  private terminalRushRatio: number | null = null;
  private terminalRushAtMs: number | null = null;

  /** Recent display values for the trend indicator, at the update cadence. */
  private trend: Array<{ audioTimeMs: number; score: number }> = [];

  private takePassId: string | null = null;
  private lastSnapshot: DeliveryScoreSnapshot | null = null;

  constructor(config: DeliveryScoreEngineOptions = {}) {
    this.options = { ...DEFAULT_DELIVERY_SCORE_OPTIONS, ...config.options };
    this.profile = config.profile ?? CONVERSATIONAL_AUTHORITY;
    this.ledger = new TranscriptEvidenceLedger(this.options);
    this.drift = new PaceDriftTracker(this.options.driftSamples);
  }

  /**
   * §11.3 / §5.4. A new take pass is a new performance: nothing crosses the
   * boundary, including the smoothed value, or the first seconds of take two
   * would be scored with take one's delivery.
   */
  reset(): void {
    this.ledger.reset();
    this.drift.reset();
    this.smoothed = null;
    this.display = null;
    this.lastUpdateMs = null;
    this.terminalRushRatio = null;
    this.terminalRushAtMs = null;
    this.trend = [];
    this.takePassId = null;
    this.lastSnapshot = null;
  }

  /**
   * §9.8. One transcript segment's word count.
   *
   * `audioTimeMs` is the segment's audio *end*: §3.2 is explicit that arrival
   * time is not speech time, and a per-100-words rate windowed by arrival time
   * would credit words to the wrong seconds under any transcription latency.
   */
  noteSpokenWords(audioTimeMs: number, words: number, final: boolean): void {
    this.ledger.note(audioTimeMs, words, final);
  }

  /** The most recent computed snapshot, or `null` before the first pass. */
  snapshot(): DeliveryScoreSnapshot | null {
    return this.lastSnapshot;
  }

  /**
   * One scoring pass. Cheap by construction: no window is rescanned from take
   * start, the drift ring is thirty numbers, and the filler counts are a single
   * linear pass over an already-bounded event list.
   */
  update(evidence: DeliveryEvidence): DeliveryScoreState {
    if (this.takePassId !== null && this.takePassId !== evidence.takePassId) this.reset();
    this.takePassId = evidence.takePassId;

    const nowMs = evidence.audioTimeMs;
    const elapsedMs = this.lastUpdateMs === null ? 0 : Math.max(0, nowMs - this.lastUpdateMs);

    this.noteTerminalRush(evidence.terminalRushRatio, nowMs);
    this.drift.note(nowMs, evidence.suppressed ? null : evidence.rates.audibleWpm);

    const memory: DeliveryScoreMemory = {
      wordsInWindow: this.ledger.wordsInWindow(nowMs),
      transcriptStability: this.transcriptStability(nowMs, evidence),
      paceDrift: this.drift.drift(),
      driftSpanMs: this.drift.spanMs(),
      terminalRushAgeMs: this.terminalRushAtMs === null ? null : nowMs - this.terminalRushAtMs,
    };

    const samples = buildSubmetrics(evidence, memory, this.options, this.profile);
    const dimensions: DimensionResult[] = DIMENSION_ORDER.map((dimension) =>
      scoreDimension(dimension, samples[dimension], this.options.minimumDimensionEvidence),
    );

    const overall = combineDimensions(dimensions, this.options.weakDimensionBlend);

    const confidence = combineConfidence(
      coverageFrom(evidence.voicedMsInWindow, memory.wordsInWindow, this.options),
      signalQualityFrom(evidence.microphone, evidence.pitchReliability),
      memory.transcriptStability,
      calibrationMaturityFrom(evidence.pitchReliability.usableVoicedMs, this.options),
    );

    // §9.6 steps 1–3. A pass with nothing available does **not** advance the
    // filter: §11.3 asks the score to hold through ordinary pauses, and a
    // silence is not evidence that the delivery got worse.
    if (overall.raw !== null) {
      const advanced = advanceDisplayScore(
        { smoothed: this.smoothed, display: this.display },
        overall.raw,
        elapsedMs,
        this.options.smoothingHalfLifeMs,
        this.options.visibleMaxDeltaPerSecond,
      );
      this.smoothed = advanced.smoothed;
      this.display = advanced.display;
    }
    this.lastUpdateMs = nowMs;

    // §9.6 step 5 / §9.7. Below the display threshold the rail shows
    // "Listening…" — `null`, never 0, and never a dimmed wrong number.
    const displayable =
      this.display !== null && confidence.overall >= this.options.minimumDisplayConfidence;
    const displayScore = displayable ? clampScore(this.display as number) : null;

    this.noteTrend(nowMs, displayScore);

    const state: DeliveryScoreState = {
      displayScore,
      rawScore: overall.raw,
      confidence: confidence.overall,
      tier: confidenceTier(confidence.overall),
      dimensions: dimensions.map(toDimensionScore),
      weakestDimension: overall.weakest,
      trend: this.trendDirection(nowMs, displayScore),
    };

    this.lastSnapshot = {
      state,
      confidence,
      dimensions,
      mean: overall.mean,
      weak: overall.weak,
    };
    return state;
  }

  /**
   * §9.8. `terminalRushRatio` is the last *eligible* sentence's ratio and it
   * persists until another eligible sentence arrives, so the engine remembers
   * when it changed and the submetric decays its confidence from there. Without
   * this a rushed ending from five minutes ago holds the pace dimension down
   * for the rest of the take.
   */
  private noteTerminalRush(ratio: number | null, nowMs: number): void {
    if (ratio === null) return;
    if (this.terminalRushRatio !== null && ratio === this.terminalRushRatio) return;
    this.terminalRushRatio = ratio;
    this.terminalRushAtMs = nowMs;
  }

  /**
   * §9.7 `transcript_stability`, with §25.1's degraded transcription folded in.
   *
   * A failing recogniser is not a recording fault in §15's sense, but it earns
   * the same treatment for the same reason: it removes the engine's ability to
   * judge fluency, and a speaker whose recogniser is stumbling has not become
   * less fluent.
   */
  private transcriptStability(nowMs: number, evidence: DeliveryEvidence): number {
    const base = this.ledger.stability(nowMs);
    return evidence.microphone.transcriptionDegraded ? base * 0.6 : base;
  }

  private noteTrend(nowMs: number, score: number | null): void {
    if (score === null) return;
    this.trend.push({ audioTimeMs: nowMs, score });
    const cutoff = nowMs - this.options.trendWindowMs * 2;
    while (this.trend.length > 0 && (this.trend[0]?.audioTimeMs ?? nowMs) < cutoff) {
      this.trend.shift();
    }
  }

  private trendDirection(nowMs: number, score: number | null): 'rising' | 'steady' | 'falling' {
    if (score === null) return 'steady';
    const cutoff = nowMs - this.options.trendWindowMs;
    let reference: number | null = null;
    for (const entry of this.trend) {
      if (entry.audioTimeMs > cutoff) break;
      reference = entry.score;
    }
    if (reference === null) return 'steady';
    const delta = score - reference;
    if (delta > this.options.trendThresholdPoints) return 'rising';
    if (delta < -this.options.trendThresholdPoints) return 'falling';
    return 'steady';
  }
}

function toDimensionScore(result: DimensionResult): DimensionScore {
  return {
    dimension: result.dimension,
    score: result.score,
    confidence: result.confidence,
    weight: result.weight,
  };
}
