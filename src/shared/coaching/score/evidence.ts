/**
 * The measurement snapshot the delivery score is computed from, and the two
 * pieces of state the engine has to keep for itself.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE IS RE-MEASURED
 * ---------------------------------------------------------------------------
 * Every field is an output of a lane that already exists, is already tested and
 * is already driven by the orchestrator: the pace analyzer's rates, the cadence
 * analyzer's boundary accounting, the pitch and energy aggregators, the filler
 * tracker's events, the VAD-derived pauses. The report's §12.1 proposes
 * re-implementing all of that; it is already built, so the scoring model
 * consumes it rather than duplicating it.
 *
 * The two exceptions are genuinely not produced anywhere else and are kept
 * here as rolling accumulators rather than by rescanning a window:
 *
 * - {@link TranscriptEvidenceLedger} — words per unit time and the §9.8
 *   provisional/final maturity ramp;
 * - {@link PaceDriftTracker} — §8's "pace drift within ±12% over 30 s", which
 *   needs a rate *series* and the pace lane only exposes a rate.
 */
import type {
  FillerEvent,
  MicrophoneCoachState,
  PaceDisplayState,
  PitchReliability,
} from '../../contracts/coaching';
import type { PaceRates } from '../pace/pace-analyzer';
import type { CadenceMetrics } from '../prosody/cadence-analyzer';
import type { EnergyAggregate } from '../prosody/energy-aggregator';
import type { PitchAggregate } from '../prosody/pitch-aggregator';
import type { DeliveryScoreOptions } from './profile';

/** A silence the VAD-derived pause path reported. Never a raw transcript gap. */
export interface ScoredPause {
  startMs: number;
  endMs: number;
}

export interface DeliveryEvidence {
  /** Audio clock (Rule 3). The only clock any decision here is stamped from. */
  audioTimeMs: number;
  takePassId: string;

  /** §14. The pace tile — carries the *effective* target band, user's or preset. */
  pace: PaceDisplayState;
  rates: PaceRates;
  /** §14.9. Most recent eligible sentence's final/earlier rate ratio. */
  terminalRushRatio: number | null;
  /**
   * True while a manual pause, a voice command or a retake is in effect. Audio
   * inside one carries no delivery claim (§14.5, §18.2), so pace and pausing
   * report nothing rather than reporting the silence as phrasing.
   */
  suppressed: boolean;

  /** Voiced ms inside the analysis window, from the accounting clock. */
  voicedMsInWindow: number;
  /** Delivery ms inside the window — elapsed minus unmeasured spans. */
  deliveryMsInWindow: number;

  /** §18. */
  cadence: CadenceMetrics;
  /** §18.5. 0–1 confidence in the alignment the boundary metrics rest on. */
  alignmentConfidence: number;

  /** §17. Pitch in semitones relative to the speaker's own median, never Hz. */
  pitch: PitchAggregate;
  energy: EnergyAggregate;
  /** §13.4. The gate deciding whether a pitch-derived number may exist at all. */
  pitchReliability: PitchReliability;

  /** §16. Every event this take pass; filtering to confirmed happens in scoring. */
  fillerEvents: readonly FillerEvent[];

  /** §12.4. Derived pauses inside the window. A dropout is never one of these. */
  pauses: readonly ScoredPause[];

  /**
   * §12.7. Recording quality.
   *
   * Reaches the score **only** through evidence confidence (§15). There is no
   * path from this field to a dimension score, and adding one would be the
   * defect §1.3 and §15 are both written about.
   */
  microphone: MicrophoneCoachState;
}

/** One transcript segment as the ledger records it. */
interface WordEntry {
  audioTimeMs: number;
  words: number;
}

/**
 * §9.8. Words per unit time, and how far the text under them can be trusted.
 *
 * Three of the section's four bullets live here:
 *
 * - "provisional transcript evidence receives a low confidence" — a provisional
 *   segment is held separately and weighted at
 *   {@link DeliveryScoreOptions.provisionalEvidenceConfidence};
 * - "final evidence increases confidence gradually over 0.5–1.5 seconds" — a
 *   final segment's weight ramps from that same low value to 1 across the
 *   configured window, on the audio clock;
 * - "corrected event counts replace provisional counts rather than stacking" —
 *   the provisional overlay is a single slot that is *replaced*, and cleared
 *   outright when a final segment arrives, exactly as the pace analyzer treats
 *   its own provisional tokens. Nothing accumulates twice.
 *
 * The fourth bullet — the rate cap — is enforced in `smoothing.ts`.
 */
export class TranscriptEvidenceLedger {
  private readonly options: DeliveryScoreOptions;
  private finals: WordEntry[] = [];
  private provisional: WordEntry | null = null;

  constructor(options: DeliveryScoreOptions) {
    this.options = options;
  }

  reset(): void {
    this.finals = [];
    this.provisional = null;
  }

  /**
   * Fold a segment in. `audioTimeMs` is the segment's audio *end*, because that
   * is when the words had been spoken — not when the transcript arrived (§3.2:
   * "transcript arrival time is not speech time").
   */
  note(audioTimeMs: number, words: number, final: boolean): void {
    if (words <= 0) {
      if (!final) this.provisional = null;
      return;
    }
    if (!final) {
      this.provisional = { audioTimeMs, words };
      return;
    }
    this.provisional = null;
    this.finals.push({ audioTimeMs, words });
    this.trim(audioTimeMs);
  }

  private trim(nowMs: number): void {
    // Twice the window: the score reads one window back, and keeping a little
    // history costs nothing while making an out-of-order arrival harmless.
    const cutoff = nowMs - this.options.windowMs * 2;
    if (this.finals.length > 0 && (this.finals[0]?.audioTimeMs ?? cutoff) >= cutoff) return;
    this.finals = this.finals.filter((entry) => entry.audioTimeMs >= cutoff);
  }

  /** Words spoken inside the window, provisional tail included. */
  wordsInWindow(nowMs: number): number {
    const start = nowMs - this.options.windowMs;
    let total = 0;
    for (const entry of this.finals) {
      if (entry.audioTimeMs >= start && entry.audioTimeMs <= nowMs) total += entry.words;
    }
    const provisional = this.provisional;
    if (provisional !== null && provisional.audioTimeMs >= start) total += provisional.words;
    return total;
  }

  /**
   * §9.7 `transcript_stability`: the word-weighted mean maturity of the text in
   * the window, 0–1.
   *
   * Returns 1 when there are no words at all rather than 0 — with no words the
   * *coverage* term is already zero, and multiplying two zeros for one absence
   * would make the confidence model impossible to reason about.
   */
  stability(nowMs: number): number {
    const start = nowMs - this.options.windowMs;
    let weighted = 0;
    let total = 0;
    for (const entry of this.finals) {
      if (entry.audioTimeMs < start || entry.audioTimeMs > nowMs) continue;
      weighted += entry.words * this.maturity(nowMs - entry.audioTimeMs);
      total += entry.words;
    }
    const provisional = this.provisional;
    if (provisional !== null && provisional.audioTimeMs >= start) {
      weighted += provisional.words * this.options.provisionalEvidenceConfidence;
      total += provisional.words;
    }
    if (total <= 0) return 1;
    return Math.min(1, Math.max(0, weighted / total));
  }

  /** §9.8's 0.5–1.5 s ramp, from the provisional floor to full trust. */
  private maturity(ageMs: number): number {
    const { provisionalEvidenceConfidence, finalEvidenceRampStartMs, finalEvidenceRampEndMs } =
      this.options;
    if (ageMs <= finalEvidenceRampStartMs) return provisionalEvidenceConfidence;
    if (ageMs >= finalEvidenceRampEndMs) return 1;
    const span = finalEvidenceRampEndMs - finalEvidenceRampStartMs;
    if (span <= 0) return 1;
    const progress = (ageMs - finalEvidenceRampStartMs) / span;
    return provisionalEvidenceConfidence + (1 - provisionalEvidenceConfidence) * progress;
  }
}

/**
 * §8's "Pace drift: within ±12% over 30 s".
 *
 * A rolling 1 Hz ring rather than a rescan of every rate observation: the pace
 * lane already holds the observations and re-deriving a slope from them ten
 * times a second next to a live WebRTC session is exactly the cost §12.6 warns
 * about. Thirty numbers and a modulo is the whole thing.
 */
export class PaceDriftTracker {
  private readonly capacity: number;
  private samples: Array<{ audioTimeMs: number; wpm: number }> = [];
  private lastSampleMs: number | null = null;

  constructor(capacity: number) {
    this.capacity = Math.max(2, Math.floor(capacity));
  }

  reset(): void {
    this.samples = [];
    this.lastSampleMs = null;
  }

  /** Sample at most once a second, on the audio clock. */
  note(audioTimeMs: number, wpm: number | null): void {
    if (wpm === null || !Number.isFinite(wpm) || wpm <= 0) return;
    if (this.lastSampleMs !== null && audioTimeMs - this.lastSampleMs < 1_000) return;
    this.lastSampleMs = audioTimeMs;
    this.samples.push({ audioTimeMs, wpm });
    while (this.samples.length > this.capacity) this.samples.shift();
  }

  /** Audio-time span the retained samples cover, ms. */
  spanMs(): number {
    if (this.samples.length < 2) return 0;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (first === undefined || last === undefined) return 0;
    return last.audioTimeMs - first.audioTimeMs;
  }

  /**
   * Largest relative deviation from the window's median rate, as a fraction.
   *
   * The median rather than the mean, and a deviation rather than a slope,
   * because §8's row is a *tolerance band* — "within ±12% over 30 s" — and a
   * slope would report a speaker who sped up and slowed back down as perfectly
   * steady.
   */
  drift(): number | null {
    if (this.samples.length < 3) return null;
    const rates = this.samples.map((sample) => sample.wpm).sort((a, b) => a - b);
    const middle = Math.floor(rates.length / 2);
    const upper = rates[middle];
    const lower = rates[middle - 1];
    if (upper === undefined) return null;
    const median = rates.length % 2 === 1 ? upper : ((lower ?? upper) + upper) / 2;
    if (!(median > 0)) return null;
    let worst = 0;
    for (const sample of this.samples) {
      worst = Math.max(worst, Math.abs(sample.wpm - median) / median);
    }
    return worst;
  }
}
