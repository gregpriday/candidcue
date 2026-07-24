/**
 * §12.7. Microphone quality, as {@link MicrophoneCoachState}.
 *
 * Every condition here requires **sustained** evidence. §12.7.1 says it
 * outright — "Do not react to a single isolated clipped sample" — and the same
 * logic applies to level and noise: a rail that flashes CLIPPING because one
 * frame touched full scale trains the presenter to ignore the rail.
 *
 * Evidence accumulates leakily: a condition that is true adds a frame, a
 * condition that is false subtracts one, so a flapping 50/50 condition never
 * reaches its threshold while a genuine one does.
 *
 * ---------------------------------------------------------------------------
 * §12.7.4 — NO ABSOLUTE LOUDNESS CLAIM, EVER.
 * ---------------------------------------------------------------------------
 * Without a calibrated microphone and a known mouth-to-mic distance there is no
 * physical sound-pressure level to report, and this module MUST NOT invent one.
 * The only level it emits is `levelDbfs`: digital full-scale, relative,
 * negative. There is no dB SPL field on the contract and there must never be
 * one here — "you are speaking at 62 dB" is a claim CandidCue cannot support.
 * `low_level` means "quiet relative to your own calibration", nothing more.
 *
 * Clock: frame `audioTimeMs` only (Rule 3). No `Date.now()`.
 */
import type { AudioFrameFeatures, MicrophoneCoachState } from '../../contracts/coaching';

export interface MicrophoneHealthOptions {
  frameMs?: number;

  // §12.7.1 clipping
  /** A frame counts as clipped at or above this peak, dBFS. Default -0.3. */
  clippingPeakDbfs?: number;
  /** ...or at or above this fraction of clipped samples. Default 0.001. */
  clippingRatioGate?: number;
  /** Clipped evidence needed inside the rolling second, ms. Default 150. */
  clippingSustainedMs?: number;

  // §12.7.2 low level
  /**
   * Bottom of the user's calibration range, dBFS. Speech below this is "quiet
   * for this user" — a relative statement, never an SPL one. Default -42.
   */
  calibrationLowDbfs?: number;
  /** SNR below which a quiet signal is also a *poor* one, dB. Default 12. */
  lowLevelSnrDb?: number;
  /** §12.7.2 "persists for at least two seconds". Default 2000. */
  lowLevelSustainedMs?: number;

  // §12.7.3 noise
  /** Noise floor above which the room is materially noisy, dBFS. Default -45. */
  noisyFloorDbfs?: number;
  /** SNR under which that noise is materially hurting us, dB. Default 12. */
  noisySnrDb?: number;
  /** §12.7.3 "for several seconds". Default 3000. */
  noisySustainedMs?: number;

  // no signal
  /** Level at or below which there is effectively nothing arriving, dBFS. Default -75. */
  noSignalDbfs?: number;
  noSignalSustainedMs?: number;

  /** Audio observed before any judgement is offered, ms. Default 1000. */
  learningMs?: number;
  /** Rolling window for `levelDbfs`, ms. Default 1000. */
  levelWindowMs?: number;
  /** Rolling window for `snrDb` over speech frames, ms. Default 3000. */
  snrWindowMs?: number;
}

/** Diagnostic view of how much evidence each condition currently holds. */
export interface MicrophoneConditionHold {
  clippingMs: number;
  lowLevelMs: number;
  noisyMs: number;
  noSignalMs: number;
}

export class MicrophoneHealthMonitor {
  private readonly frameMs: number;
  private readonly options: Required<Omit<MicrophoneHealthOptions, 'frameMs'>>;

  private readonly levelRing: Float64Array;
  private levelWrite = 0;
  private levelCount = 0;
  private levelPowerSum = 0;

  private readonly snrRing: Float64Array;
  private snrWrite = 0;
  private snrCount = 0;
  private snrSum = 0;

  private clippingHoldMs = 0;
  private lowLevelHoldMs = 0;
  private noisyHoldMs = 0;
  private noSignalHoldMs = 0;
  private observedMs = 0;

  private transcriptionDegraded = false;
  private disconnected = false;
  private current: MicrophoneCoachState;

  constructor(options: MicrophoneHealthOptions = {}) {
    this.frameMs = options.frameMs ?? 20;
    this.options = {
      clippingPeakDbfs: options.clippingPeakDbfs ?? -0.3,
      clippingRatioGate: options.clippingRatioGate ?? 0.001,
      clippingSustainedMs: options.clippingSustainedMs ?? 150,
      calibrationLowDbfs: options.calibrationLowDbfs ?? -42,
      lowLevelSnrDb: options.lowLevelSnrDb ?? 12,
      lowLevelSustainedMs: options.lowLevelSustainedMs ?? 2000,
      noisyFloorDbfs: options.noisyFloorDbfs ?? -45,
      noisySnrDb: options.noisySnrDb ?? 12,
      noisySustainedMs: options.noisySustainedMs ?? 3000,
      noSignalDbfs: options.noSignalDbfs ?? -75,
      noSignalSustainedMs: options.noSignalSustainedMs ?? 1500,
      learningMs: options.learningMs ?? 1000,
      levelWindowMs: options.levelWindowMs ?? 1000,
      snrWindowMs: options.snrWindowMs ?? 3000,
    };

    this.levelRing = new Float64Array(Math.max(1, Math.round(this.options.levelWindowMs / this.frameMs)));
    this.snrRing = new Float64Array(Math.max(1, Math.round(this.options.snrWindowMs / this.frameMs)));
    this.current = {
      status: 'learning',
      levelDbfs: null,
      snrDb: null,
      sustained: false,
      transcriptionDegraded: false,
    };
  }

  get state(): MicrophoneCoachState {
    return this.current;
  }

  /** §25.1. The Realtime transcription path itself is degraded. */
  setTranscriptionDegraded(degraded: boolean): void {
    this.transcriptionDegraded = degraded;
    this.current = { ...this.current, transcriptionDegraded: degraded };
  }

  /** Device lost. Outranks every acoustic condition. */
  setDisconnected(disconnected: boolean): void {
    this.disconnected = disconnected;
  }

  /** How much evidence each condition holds right now. Diagnostics only. */
  get conditionHold(): MicrophoneConditionHold {
    return {
      clippingMs: this.clippingHoldMs,
      lowLevelMs: this.lowLevelHoldMs,
      noisyMs: this.noisyHoldMs,
      noSignalMs: this.noSignalHoldMs,
    };
  }

  reset(): void {
    this.levelRing.fill(0);
    this.levelWrite = 0;
    this.levelCount = 0;
    this.levelPowerSum = 0;
    this.snrRing.fill(0);
    this.snrWrite = 0;
    this.snrCount = 0;
    this.snrSum = 0;
    this.clippingHoldMs = 0;
    this.lowLevelHoldMs = 0;
    this.noisyHoldMs = 0;
    this.noSignalHoldMs = 0;
    this.observedMs = 0;
    this.disconnected = false;
    this.current = {
      status: 'learning',
      levelDbfs: null,
      snrDb: null,
      sustained: false,
      transcriptionDegraded: this.transcriptionDegraded,
    };
  }

  /**
   * Fold one frame in and return the current state.
   *
   * `speaking` comes from the {@link SpeechClock}, because §12.7.2 requires
   * "active speech is confidently detected" before a low-level warning — the
   * alternative is warning a presenter about their microphone while they are
   * silent, which is both useless and alarming.
   *
   * Dropout frames are skipped entirely: they are unmeasured, and a dropout is
   * not evidence of a quiet microphone.
   */
  process(frame: AudioFrameFeatures, speaking: boolean): MicrophoneCoachState {
    if (frame.processorDropout) return this.current;

    this.observedMs += this.frameMs;
    this.pushLevel(frame.rmsDbfs);
    const isSpeechFrame = speaking && frame.speechProbability >= 0.5;
    if (isSpeechFrame) this.pushSnr(frame.estimatedSnrDb);

    const levelDbfs = this.rollingLevelDbfs();
    const snrDb = this.rollingSnrDb();

    // §12.7.1 clipping.
    const clippedFrame =
      frame.peakDbfs >= this.options.clippingPeakDbfs ||
      frame.clippingRatio > this.options.clippingRatioGate;
    this.clippingHoldMs = hold(this.clippingHoldMs, clippedFrame, this.frameMs);

    // §12.7.2 low level: confident speech, quiet against the user's own
    // calibration, and evidence the result is actually suffering.
    const lowLevelFrame =
      isSpeechFrame &&
      frame.rmsDbfs < this.options.calibrationLowDbfs &&
      (frame.estimatedSnrDb < this.options.lowLevelSnrDb || this.transcriptionDegraded);
    this.lowLevelHoldMs = hold(this.lowLevelHoldMs, lowLevelFrame, this.frameMs);

    // §12.7.3 noise: the *floor* is high, not merely the voice quiet. Quiet
    // speech in a quiet room must never produce a noise alert.
    const noisyFrame =
      frame.noiseFloorDbfs > this.options.noisyFloorDbfs &&
      isSpeechFrame &&
      frame.estimatedSnrDb < this.options.noisySnrDb;
    this.noisyHoldMs = hold(this.noisyHoldMs, noisyFrame, this.frameMs);

    const noSignalFrame = frame.rmsDbfs <= this.options.noSignalDbfs;
    this.noSignalHoldMs = hold(this.noSignalHoldMs, noSignalFrame, this.frameMs);

    const status = this.resolveStatus();
    this.current = {
      status,
      levelDbfs,
      snrDb,
      sustained: status !== 'ok' && status !== 'learning',
      transcriptionDegraded: this.transcriptionDegraded,
    };
    return this.current;
  }

  /**
   * Status is only ever a *sustained* condition, which is why `sustained` reads
   * as a mirror of it: §12.7 is explicit that the rail must not react to
   * isolated evidence, so publishing a status the presenter should ignore would
   * be the bug, not a feature. Pre-threshold evidence is available through
   * {@link conditionHold} for policy that wants to anticipate.
   */
  private resolveStatus(): MicrophoneCoachState['status'] {
    if (this.disconnected) return 'disconnected';
    if (this.noSignalHoldMs >= this.options.noSignalSustainedMs) return 'no_signal';
    if (this.observedMs < this.options.learningMs) return 'learning';
    if (this.clippingHoldMs >= this.options.clippingSustainedMs) return 'clipping';
    if (this.lowLevelHoldMs >= this.options.lowLevelSustainedMs) return 'low_level';
    if (this.noisyHoldMs >= this.options.noisySustainedMs) return 'noisy';
    return 'ok';
  }

  private pushLevel(rmsDbfs: number): void {
    const power = 10 ** (rmsDbfs / 10);
    if (this.levelCount === this.levelRing.length) {
      this.levelPowerSum -= this.levelRing[this.levelWrite] as number;
    } else {
      this.levelCount += 1;
    }
    this.levelRing[this.levelWrite] = power;
    this.levelPowerSum += power;
    this.levelWrite = (this.levelWrite + 1) % this.levelRing.length;
  }

  private pushSnr(snrDb: number): void {
    if (this.snrCount === this.snrRing.length) {
      this.snrSum -= this.snrRing[this.snrWrite] as number;
    } else {
      this.snrCount += 1;
    }
    this.snrRing[this.snrWrite] = snrDb;
    this.snrSum += snrDb;
    this.snrWrite = (this.snrWrite + 1) % this.snrRing.length;
  }

  /** Energy-domain mean, converted back to dBFS. Always negative. */
  private rollingLevelDbfs(): number | null {
    if (this.levelCount === 0) return null;
    const meanPower = this.levelPowerSum / this.levelCount;
    if (!(meanPower > 0)) return -100;
    return Math.max(10 * Math.log10(meanPower), -100);
  }

  private rollingSnrDb(): number | null {
    if (this.snrCount === 0) return null;
    return this.snrSum / this.snrCount;
  }
}

function hold(currentMs: number, present: boolean, frameMs: number): number {
  if (present) return currentMs + frameMs;
  return Math.max(0, currentMs - frameMs);
}
