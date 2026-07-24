/**
 * §13.2–§13.4. Post-processing of raw per-frame f0 into speaker-relative
 * semitones, plus the reliability gate that decides whether pitch-derived
 * coaching is allowed to exist at all.
 *
 * Not in the §28 module list, which shows a single `pitch-yin.ts`. Split
 * deliberately: `pitch-yin.ts` is the stateless estimator that runs *inside*
 * the worklet on the render thread, while everything here is take-scoped state
 * that belongs on the analyzer side and must be resettable per take pass. Two
 * lifetimes, two files.
 *
 * ---------------------------------------------------------------------------
 * §13.5 — THERE IS NO PITCH TARGET IN THIS FILE.
 * ---------------------------------------------------------------------------
 * No gendered norm, no absolute Hz band, no "ideal" median. The only reference
 * is `f0_reference`, the speaker's own rolling median (§13.3), and the only
 * output is a signed semitone offset from it. A speaker at 85 Hz and a speaker
 * at 240 Hz doing the same relative movement produce the same numbers here, and
 * a unit test asserts exactly that.
 */
import type { AudioFrameFeatures, PitchReliability } from '../../contracts/coaching';

export interface PitchTrackerOptions {
  /** Analysis frame duration, ms. Default 20. */
  frameMs?: number;
  /** §13.2 short median filter. Must be odd. Default 5 (≈100 ms). */
  medianTaps?: number;
  /** Minimum `f0Confidence` for a frame to count as reliable. Default 0.5. */
  minConfidence?: number;
  /** Minimum `voicedProbability` for a frame to count as voiced. Default 0.5. */
  minVoicedProbability?: number;
  /** §13.3 calibration period before a reference exists, ms. Default 10 000. */
  calibrationMs?: number;
  /** Rolling window the reference median is taken over, ms. Default 30 000. */
  referenceWindowMs?: number;
  /** How often the reference median is recomputed, ms. Default 500. */
  referenceUpdateMs?: number;
  /** Window for "recent speech frames" in §13.4, ms. Default 5000. */
  recentWindowMs?: number;
  /** §13.4 reliable-frame fraction gate. Default 0.45. */
  reliableFractionGate?: number;
  /** §13.4 usable voiced audio gate, ms. Default 12 000. */
  usableVoicedGateMs?: number;
  /** §13.4 SNR gate, dB. Default 8. */
  minSnrDb?: number;
  /** §13.4 "clipping heavily": mean clipping ratio over the recent window. Default 0.02. */
  clippingGate?: number;
  /** §13.4 fraction of reliable frames needing octave repair before we give up. Default 0.25. */
  octaveInstabilityGate?: number;
}

/** One accepted, post-processed pitch observation. */
export interface PitchSample {
  audioTimeMs: number;
  /** Median-filtered, octave-repaired f0 in Hz. */
  f0Hz: number;
  /**
   * §13.3 `12 × log2(f0 / f0_reference)`. `null` until calibration completes —
   * never 0, which would read as "exactly at the reference".
   */
  semitones: number | null;
  /** True when this sample was moved by an octave to match the running anchor. */
  octaveCorrected: boolean;
}

const OCTAVE_LOW = 1.8;
const OCTAVE_HIGH = 2.2;
/** A correction held this long stops being a correction and becomes the truth. */
const SUSTAINED_OCTAVE_MS = 300;

export class PitchTracker {
  private readonly frameMs: number;
  private readonly medianTaps: number;
  private readonly minConfidence: number;
  private readonly minVoicedProbability: number;
  private readonly calibrationMs: number;
  private readonly referenceUpdateMs: number;
  private readonly recentFrames: number;
  private readonly reliableFractionGate: number;
  private readonly usableVoicedGateMs: number;
  private readonly minSnrDb: number;
  private readonly clippingGate: number;
  private readonly octaveInstabilityGate: number;

  // Median filter ring.
  private readonly medianRing: Float64Array;
  private readonly medianScratch: Float64Array;
  private medianCount = 0;
  private medianWrite = 0;

  // Rolling reference median (§13.3).
  private readonly referenceRing: Float64Array;
  private readonly referenceScratch: Float64Array;
  private referenceCount = 0;
  private referenceWrite = 0;
  private referenceValue: number | null = null;
  private lastReferenceUpdateMs = Number.NEGATIVE_INFINITY;

  // Recent-window counters for §13.4, kept as O(1) running sums.
  private readonly speechFlags: Float64Array;
  private readonly reliableFlags: Float64Array;
  private readonly octaveFlags: Float64Array;
  private readonly snrValues: Float64Array;
  private readonly clipValues: Float64Array;
  private windowWrite = 0;
  private windowCount = 0;
  private speechSum = 0;
  private reliableSum = 0;
  private octaveSum = 0;
  private snrSum = 0;
  private clipSum = 0;

  private anchorHz: number | null = null;
  private octaveRunMs = 0;
  private octaveRunDirection = 0;
  private usableVoicedMs = 0;
  private competingAudio = false;

  constructor(options: PitchTrackerOptions = {}) {
    this.frameMs = options.frameMs ?? 20;
    const taps = options.medianTaps ?? 5;
    this.medianTaps = taps % 2 === 0 ? taps + 1 : taps;
    this.minConfidence = options.minConfidence ?? 0.5;
    this.minVoicedProbability = options.minVoicedProbability ?? 0.5;
    this.calibrationMs = options.calibrationMs ?? 10_000;
    this.referenceUpdateMs = options.referenceUpdateMs ?? 500;
    this.reliableFractionGate = options.reliableFractionGate ?? 0.45;
    this.usableVoicedGateMs = options.usableVoicedGateMs ?? 12_000;
    this.minSnrDb = options.minSnrDb ?? 8;
    this.clippingGate = options.clippingGate ?? 0.02;
    this.octaveInstabilityGate = options.octaveInstabilityGate ?? 0.25;

    this.medianRing = new Float64Array(this.medianTaps);
    this.medianScratch = new Float64Array(this.medianTaps);

    const referenceFrames = Math.max(
      1,
      Math.round((options.referenceWindowMs ?? 30_000) / this.frameMs),
    );
    this.referenceRing = new Float64Array(referenceFrames);
    this.referenceScratch = new Float64Array(referenceFrames);

    this.recentFrames = Math.max(1, Math.round((options.recentWindowMs ?? 5000) / this.frameMs));
    this.speechFlags = new Float64Array(this.recentFrames);
    this.reliableFlags = new Float64Array(this.recentFrames);
    this.octaveFlags = new Float64Array(this.recentFrames);
    this.snrValues = new Float64Array(this.recentFrames);
    this.clipValues = new Float64Array(this.recentFrames);
  }

  /**
   * §13.4 "background music or another speaker is detected". Detection lives
   * outside this module (it needs transcript and spectral evidence the pitch
   * path does not have); the flag is injected so the gate can honour it.
   */
  setCompetingAudio(present: boolean): void {
    this.competingAudio = present;
  }

  get referenceF0Hz(): number | null {
    return this.referenceValue;
  }

  reset(): void {
    this.medianCount = 0;
    this.medianWrite = 0;
    this.referenceCount = 0;
    this.referenceWrite = 0;
    this.referenceValue = null;
    this.lastReferenceUpdateMs = Number.NEGATIVE_INFINITY;
    this.windowWrite = 0;
    this.windowCount = 0;
    this.speechSum = 0;
    this.reliableSum = 0;
    this.octaveSum = 0;
    this.snrSum = 0;
    this.clipSum = 0;
    this.anchorHz = null;
    this.octaveRunMs = 0;
    this.octaveRunDirection = 0;
    this.usableVoicedMs = 0;
    this.competingAudio = false;
  }

  /**
   * Feed one frame. Returns the accepted pitch sample, or `null` for frames
   * that carry no usable pitch (unvoiced, low confidence, or a dropout — a
   * dropout is unmeasured, so it contributes to nothing at all, not even to
   * the denominator of the reliable-frame fraction).
   */
  process(frame: AudioFrameFeatures): PitchSample | null {
    if (frame.processorDropout) return null;

    const isSpeech = frame.speechProbability >= 0.5;
    const isReliable =
      frame.f0Hz !== null &&
      frame.f0Hz > 0 &&
      frame.f0Confidence >= this.minConfidence &&
      frame.voicedProbability >= this.minVoicedProbability;

    if (!isReliable) {
      this.pushWindow(isSpeech ? 1 : 0, 0, 0, frame.estimatedSnrDb, frame.clippingRatio);
      // A break in voicing must not let the median filter bridge two
      // unrelated pitch runs.
      this.medianCount = 0;
      this.medianWrite = 0;
      return null;
    }

    const raw = frame.f0Hz as number;
    const repaired = this.repairOctave(raw);
    const filtered = this.medianFilter(repaired.f0Hz);

    this.usableVoicedMs += this.frameMs;
    this.pushWindow(
      isSpeech ? 1 : 0,
      1,
      repaired.corrected ? 1 : 0,
      frame.estimatedSnrDb,
      frame.clippingRatio,
    );
    this.pushReference(filtered, frame.audioTimeMs);
    this.anchorHz = this.anchorHz === null ? filtered : this.anchorHz + 0.1 * (filtered - this.anchorHz);

    return {
      audioTimeMs: frame.audioTimeMs,
      f0Hz: filtered,
      semitones: this.referenceValue === null ? null : 12 * Math.log2(filtered / this.referenceValue),
      octaveCorrected: repaired.corrected,
    };
  }

  /**
   * §13.4. Evaluated in order of what the presenter should be told first:
   * still learning, then an external cause (competing audio, clipping, SNR),
   * then tracker-internal failure. The rail shows `VARIETY — · LEARNING` or
   * hides the tile; it never invents a score.
   */
  get reliability(): PitchReliability {
    const speechFrames = this.speechSum;
    const reliableFraction = speechFrames > 0 ? this.reliableSum / speechFrames : 0;
    const meanSnrDb = this.windowCount > 0 ? this.snrSum / this.windowCount : 0;
    const meanClipping = this.windowCount > 0 ? this.clipSum / this.windowCount : 0;
    const octaveFraction = this.reliableSum > 0 ? this.octaveSum / this.reliableSum : 0;

    const base = {
      reliableFrameFraction: reliableFraction,
      usableVoicedMs: this.usableVoicedMs,
      referenceF0Hz: this.referenceValue,
    };

    if (this.usableVoicedMs < this.usableVoicedGateMs) {
      return { usable: false, ...base, reason: 'insufficient_voiced_audio' };
    }
    if (this.competingAudio) {
      return { usable: false, ...base, reason: 'competing_audio' };
    }
    if (meanClipping > this.clippingGate) {
      return { usable: false, ...base, reason: 'clipping' };
    }
    if (meanSnrDb < this.minSnrDb) {
      return { usable: false, ...base, reason: 'low_snr' };
    }
    if (octaveFraction > this.octaveInstabilityGate) {
      return { usable: false, ...base, reason: 'octave_instability' };
    }
    if (reliableFraction < this.reliableFractionGate) {
      return { usable: false, ...base, reason: 'low_reliable_frame_fraction' };
    }
    return { usable: true, ...base, reason: 'ok' };
  }

  /**
   * §13.2 "detect and suppress isolated octave jumps ... preserve genuine
   * sustained changes". An isolated doubling or halving relative to the running
   * anchor is pulled back; the same correction sustained past
   * {@link SUSTAINED_OCTAVE_MS} is accepted as the speaker's real register and
   * the anchor moves instead.
   */
  private repairOctave(f0Hz: number): { f0Hz: number; corrected: boolean } {
    const anchor = this.anchorHz;
    if (anchor === null || anchor <= 0) return { f0Hz, corrected: false };
    const ratio = f0Hz / anchor;

    let direction = 0;
    let candidate = f0Hz;
    if (ratio >= OCTAVE_LOW && ratio <= OCTAVE_HIGH) {
      direction = 1;
      candidate = f0Hz / 2;
    } else if (ratio >= 1 / OCTAVE_HIGH && ratio <= 1 / OCTAVE_LOW) {
      direction = -1;
      candidate = f0Hz * 2;
    }

    if (direction === 0) {
      this.octaveRunMs = 0;
      this.octaveRunDirection = 0;
      return { f0Hz, corrected: false };
    }

    this.octaveRunMs = direction === this.octaveRunDirection ? this.octaveRunMs + this.frameMs : this.frameMs;
    this.octaveRunDirection = direction;

    if (this.octaveRunMs >= SUSTAINED_OCTAVE_MS) {
      // Genuine register change: stop fighting it and re-anchor.
      this.anchorHz = f0Hz;
      this.octaveRunMs = 0;
      this.octaveRunDirection = 0;
      return { f0Hz, corrected: false };
    }
    return { f0Hz: candidate, corrected: true };
  }

  private medianFilter(f0Hz: number): number {
    this.medianRing[this.medianWrite] = f0Hz;
    this.medianWrite = (this.medianWrite + 1) % this.medianTaps;
    if (this.medianCount < this.medianTaps) this.medianCount += 1;
    const count = this.medianCount;
    for (let i = 0; i < count; i += 1) this.medianScratch[i] = this.medianRing[i] as number;
    return median(this.medianScratch, count);
  }

  private pushReference(f0Hz: number, audioTimeMs: number): void {
    this.referenceRing[this.referenceWrite] = f0Hz;
    this.referenceWrite = (this.referenceWrite + 1) % this.referenceRing.length;
    if (this.referenceCount < this.referenceRing.length) this.referenceCount += 1;

    if (this.usableVoicedMs < this.calibrationMs) return;
    if (audioTimeMs - this.lastReferenceUpdateMs < this.referenceUpdateMs) return;
    this.lastReferenceUpdateMs = audioTimeMs;
    for (let i = 0; i < this.referenceCount; i += 1) {
      this.referenceScratch[i] = this.referenceRing[i] as number;
    }
    this.referenceValue = median(this.referenceScratch, this.referenceCount);
  }

  private pushWindow(
    speech: number,
    reliable: number,
    octave: number,
    snrDb: number,
    clippingRatio: number,
  ): void {
    if (this.windowCount === this.recentFrames) {
      this.speechSum -= this.speechFlags[this.windowWrite] as number;
      this.reliableSum -= this.reliableFlags[this.windowWrite] as number;
      this.octaveSum -= this.octaveFlags[this.windowWrite] as number;
      this.snrSum -= this.snrValues[this.windowWrite] as number;
      this.clipSum -= this.clipValues[this.windowWrite] as number;
    } else {
      this.windowCount += 1;
    }
    this.speechFlags[this.windowWrite] = speech;
    this.reliableFlags[this.windowWrite] = reliable;
    this.octaveFlags[this.windowWrite] = octave;
    this.snrValues[this.windowWrite] = snrDb;
    this.clipValues[this.windowWrite] = clippingRatio;
    this.speechSum += speech;
    this.reliableSum += reliable;
    this.octaveSum += octave;
    this.snrSum += snrDb;
    this.clipSum += clippingRatio;
    this.windowWrite = (this.windowWrite + 1) % this.recentFrames;
  }
}

/** In-place partial sort of `scratch[0..count)`, returning the median. */
function median(scratch: Float64Array, count: number): number {
  for (let i = 1; i < count; i += 1) {
    const value = scratch[i] as number;
    let j = i - 1;
    while (j >= 0 && (scratch[j] as number) > value) {
      scratch[j + 1] = scratch[j] as number;
      j -= 1;
    }
    scratch[j + 1] = value;
  }
  const middle = count >> 1;
  if (count % 2 === 1) return scratch[middle] as number;
  return ((scratch[middle - 1] as number) + (scratch[middle] as number)) / 2;
}
