/**
 * §12.5. Local voice activity detection and the speech clock.
 *
 * This is **the timing authority for coaching** and is deliberately
 * independent of OpenAI's commit behaviour: commits are a transport artefact,
 * and pace measured against them would move whenever the provider's endpointing
 * changed.
 *
 * Three behaviours here are requirements rather than tuning:
 *
 * 1. **Hysteresis.** Speech opens after ~100 ms above threshold and closes
 *    after ~250 ms below it (§12.5 allows 80–140 / 180–350). The interval start
 *    is backdated to the first frame of the qualifying run, not to the moment
 *    the run was confirmed — otherwise every utterance loses its first 100 ms
 *    and every WPM reads high.
 * 2. **Micro-pauses are preserved, not deleted.** A gap shorter than the close
 *    threshold stays inside the interval and is reported as `silenceMs`. §12.5:
 *    "label pauses rather than deleting them from the clock". Articulation rate
 *    is only meaningful if the silence inside an utterance is still counted.
 * 3. **A dropout is not a pause.** Frames flagged `processorDropout` neither
 *    advance the close timer nor accumulate as silence; their duration is
 *    reported separately as `unmeasuredMs`. A dropout misread as a pause
 *    corrupts both pace and cadence (contract note on `processorDropout`).
 *
 * There is no `Date.now()` anywhere in this file: every duration comes from
 * `AudioFrameFeatures.audioTimeMs` (Rule 3).
 *
 * ---------------------------------------------------------------------------
 * RELATIONSHIP TO `control/services/audio/vad.ts` — READ BEFORE "UNIFYING"
 * ---------------------------------------------------------------------------
 * There are two VADs in this codebase and that is intentional. They answer
 * different questions for different consumers, and §12.5 mandates the split:
 * "It is independent of OpenAI's commit behavior and acts as the timing
 * authority for coaching."
 *
 * `LocalVad` (control/services/audio) is the **transport endpointing
 * authority**. Its output drives `CommitDriver.handleVadEvent`, i.e. when to
 * send `input_audio_buffer.commit`. It runs on the main thread from a 50 ms
 * `AnalyserNode` poll, stamps with `performance.now()`, works in linear RMS,
 * and closes a turn after 420 ms of silence (`DEFAULT_VAD_CONFIG`). Those
 * choices are correct *for endpointing*: 420 ms is a turn boundary, and moving
 * it changes transcription latency, cost and the commit driver's behaviour.
 *
 * `SpeechClock` (this file) is the **coaching measurement instrument**. It runs
 * on 20 ms worklet frames stamped with the audio clock, in dB, closes at
 * 250 ms per §12.5, and produces things `LocalVad` has no way to produce:
 * `voicedMs` (needs periodicity), `meanSnrDb` (needs a noise floor in dB),
 * `silenceMs` (needs internal pauses to be preserved rather than discarded),
 * `takePassId`, and `unmeasuredMs` (needs `processorDropout`). Retro-fitting
 * all of that into `LocalVad` would mean one class serving two clocks, two
 * frame rates and two close thresholds simultaneously — and would put a
 * measurement change one edit away from a transcription regression.
 *
 * **They must never both be asked "is the presenter speaking?"** The division
 * is: `LocalVad` owns commits and the input level meter; `SpeechClock` owns
 * every coaching-visible timing claim — pace, cadence, pauses, the ribbon,
 * evidence stamps. Nothing in the coaching subsystem may consume `VadEvent`,
 * and nothing in the transport may consume `SpeechInterval`. They will disagree
 * at the boundaries (different thresholds, deliberately); that disagreement is
 * only a bug if some consumer reads both.
 */
import type { AudioFrameFeatures, SpeechInterval } from '../../contracts/coaching';

export interface SpeechClockOptions {
  takePassId: string;
  /** Nominal analysis frame, ms. Only used for the very first frame's width. */
  frameMs?: number;
  /** `speechProbability` at or above this counts toward opening. Default 0.6. */
  openThreshold?: number;
  /** Below this counts toward closing. Default 0.35. Must be < openThreshold. */
  closeThreshold?: number;
  /** §12.5: 80–140 ms. Default 100. */
  openDurationMs?: number;
  /** §12.5: 180–350 ms. Default 250. */
  closeDurationMs?: number;
  /** `voicedProbability` at or above this counts toward `voicedMs`. Default 0.5. */
  voicedThreshold?: number;
}

/**
 * A closed interval plus the local diagnostics that do not belong on the
 * shared seam. `interval` is the contract type and the only thing that should
 * cross a module boundary; `unmeasuredMs` exists so an aggregator can tell the
 * difference between "he paused" and "we lost the audio".
 *
 * Invariant: `voicedMs + silenceMs + unmeasuredMs <= endMs - startMs`.
 */
export interface ClosedSpeechInterval {
  interval: SpeechInterval;
  /** Milliseconds inside the interval that were never measured (§12.4 dropout). */
  unmeasuredMs: number;
  dropoutFrames: number;
}

type ClockState = 'idle' | 'opening' | 'speech' | 'closing';

export class SpeechClock {
  private readonly openThreshold: number;
  private readonly closeThreshold: number;
  private readonly openDurationMs: number;
  private readonly closeDurationMs: number;
  private readonly voicedThreshold: number;
  private readonly nominalFrameMs: number;

  private takePassId: string;
  private state: ClockState = 'idle';
  private lastFrameEndMs: number | null = null;

  private candidateStartMs = 0;
  private aboveMs = 0;
  private belowMs = 0;

  private startMs = 0;
  private lastSpeechEndMs = 0;
  private voicedMs = 0;
  private silenceMs = 0;
  private unmeasuredMs = 0;
  private dropoutFrames = 0;
  private snrWeightedSum = 0;
  private snrWeight = 0;

  /**
   * The frames of an opening run, held until the run is confirmed.
   *
   * The interval is backdated to the start of the run, so those ~100 ms are
   * *inside* the interval and their voiced time and SNR have to be counted from
   * the frames themselves. Attributing them from the confirming frame instead
   * would misreport up to 100 ms of `voicedMs` per utterance — and articulation
   * WPM is words over voiced time, so that error would land directly on a
   * number the presenter is reading mid-take.
   */
  private readonly pendingVoiced: Float64Array;
  private readonly pendingSpeech: Float64Array;
  private readonly pendingSnr: Float64Array;
  private pendingCount = 0;

  constructor(options: SpeechClockOptions) {
    this.takePassId = options.takePassId;
    this.nominalFrameMs = options.frameMs ?? 20;
    this.openThreshold = options.openThreshold ?? 0.6;
    this.closeThreshold = options.closeThreshold ?? 0.35;
    this.openDurationMs = options.openDurationMs ?? 100;
    this.closeDurationMs = options.closeDurationMs ?? 250;
    this.voicedThreshold = options.voicedThreshold ?? 0.5;
    if (this.closeThreshold >= this.openThreshold) {
      throw new Error('SpeechClock: closeThreshold must be below openThreshold (hysteresis)');
    }
    const openingFrames = Math.ceil(this.openDurationMs / this.nominalFrameMs) + 4;
    this.pendingVoiced = new Float64Array(openingFrames);
    this.pendingSpeech = new Float64Array(openingFrames);
    this.pendingSnr = new Float64Array(openingFrames);
  }

  /** True while an interval is open, including during a micro-pause. */
  get speaking(): boolean {
    return this.state === 'speech' || this.state === 'closing';
  }

  get currentTakePassId(): string {
    return this.takePassId;
  }

  /** Audio time the open interval began, or `null` when not speaking. */
  get openIntervalStartMs(): number | null {
    return this.speaking ? this.startMs : null;
  }

  /**
   * Feed one analysis frame. Returns the interval that just closed, or `null`.
   * At most one interval can close per frame.
   */
  process(frame: AudioFrameFeatures): ClosedSpeechInterval | null {
    const frameStartMs = frame.audioTimeMs;
    const durationMs = this.nominalFrameMs;
    if (this.lastFrameEndMs !== null && this.speaking) {
      const gapMs = frameStartMs - this.lastFrameEndMs;
      // The producer skipped stamps without emitting dropout frames. Treat the
      // hole as unmeasured, never as silence, then carry on.
      if (gapMs > durationMs * 0.5) this.unmeasuredMs += gapMs;
    }
    this.lastFrameEndMs = frameStartMs + durationMs;

    if (frame.processorDropout) {
      this.handleDropout(durationMs);
      return null;
    }

    const speech = frame.speechProbability;
    if (this.speaking) {
      this.accumulate(frame, durationMs);
    }

    switch (this.state) {
      case 'idle':
        if (speech >= this.openThreshold) {
          this.state = 'opening';
          this.candidateStartMs = frameStartMs;
          this.aboveMs = durationMs;
          this.pendingCount = 0;
          this.pushPending(frame);
          if (this.aboveMs >= this.openDurationMs) {
            this.confirmOpen(frameStartMs + durationMs, durationMs);
          }
        }
        return null;

      case 'opening':
        if (speech >= this.openThreshold) {
          this.aboveMs += durationMs;
          this.pushPending(frame);
          if (this.aboveMs >= this.openDurationMs) {
            this.confirmOpen(frameStartMs + durationMs, durationMs);
          }
        } else {
          this.state = 'idle';
          this.aboveMs = 0;
          this.pendingCount = 0;
        }
        return null;

      case 'speech':
        if (speech < this.closeThreshold) {
          this.state = 'closing';
          this.belowMs = durationMs;
          if (this.belowMs >= this.closeDurationMs) return this.close();
        } else {
          this.lastSpeechEndMs = frameStartMs + durationMs;
        }
        return null;

      case 'closing':
        if (speech < this.closeThreshold) {
          this.belowMs += durationMs;
          if (this.belowMs >= this.closeDurationMs) return this.close();
        } else {
          // §12.5: the gap was shorter than the close threshold, so it is an
          // internal pause. It stays on the clock.
          this.silenceMs += this.belowMs;
          this.belowMs = 0;
          this.state = 'speech';
          this.lastSpeechEndMs = frameStartMs + durationMs;
        }
        return null;

      default:
        return null;
    }
  }

  /**
   * Close any open interval — take end, microphone stop, hard pause. Returns
   * the interval if one was open.
   */
  flush(): ClosedSpeechInterval | null {
    if (!this.speaking) {
      this.state = 'idle';
      return null;
    }
    return this.close();
  }

  /**
   * §11.3. Move to a new take pass. Any open interval is closed *under the old
   * pass id* first, because conflating passes is the exact failure §11.3 names.
   */
  setTakePass(takePassId: string): ClosedSpeechInterval | null {
    const closed = this.flush();
    this.takePassId = takePassId;
    this.reset();
    return closed;
  }

  reset(): void {
    this.state = 'idle';
    this.lastFrameEndMs = null;
    this.aboveMs = 0;
    this.belowMs = 0;
    this.pendingCount = 0;
    this.clearAccumulators();
  }

  private handleDropout(durationMs: number): void {
    this.dropoutFrames += 1;
    // Hold in every state. While speaking, the close timer does not advance, so
    // a dropout cannot end an utterance; while `opening`, the partial run is
    // kept rather than discarded, because a dropout is not evidence that the
    // speaker stopped. The only bookkeeping is the unmeasured duration.
    if (this.speaking) this.unmeasuredMs += durationMs;
  }

  private confirmOpen(speechEndMs: number, durationMs: number): void {
    this.state = 'speech';
    this.startMs = this.candidateStartMs;
    this.lastSpeechEndMs = speechEndMs;
    this.clearAccumulators();
    // Replay the qualifying run: those frames are inside the backdated
    // interval, so they are measured, not estimated.
    for (let i = 0; i < this.pendingCount; i += 1) {
      this.accumulateValues(
        this.pendingVoiced[i] as number,
        this.pendingSpeech[i] as number,
        this.pendingSnr[i] as number,
        durationMs,
      );
    }
    this.pendingCount = 0;
  }

  private pushPending(frame: AudioFrameFeatures): void {
    if (this.pendingCount >= this.pendingVoiced.length) return;
    this.pendingVoiced[this.pendingCount] = frame.voicedProbability;
    this.pendingSpeech[this.pendingCount] = frame.speechProbability;
    this.pendingSnr[this.pendingCount] = frame.estimatedSnrDb;
    this.pendingCount += 1;
  }

  private accumulate(frame: AudioFrameFeatures, durationMs: number): void {
    this.accumulateValues(
      frame.voicedProbability,
      frame.speechProbability,
      frame.estimatedSnrDb,
      durationMs,
    );
  }

  private accumulateValues(
    voicedProbability: number,
    speechProbability: number,
    estimatedSnrDb: number,
    durationMs: number,
  ): void {
    if (voicedProbability >= this.voicedThreshold) this.voicedMs += durationMs;
    if (speechProbability >= this.closeThreshold) {
      this.snrWeightedSum += estimatedSnrDb * durationMs;
      this.snrWeight += durationMs;
    }
  }

  private close(): ClosedSpeechInterval {
    const interval: SpeechInterval = {
      startMs: this.startMs,
      endMs: this.lastSpeechEndMs,
      voicedMs: this.voicedMs,
      silenceMs: this.silenceMs,
      meanSnrDb: this.snrWeight > 0 ? this.snrWeightedSum / this.snrWeight : 0,
      takePassId: this.takePassId,
    };
    const closed: ClosedSpeechInterval = {
      interval,
      unmeasuredMs: this.unmeasuredMs,
      dropoutFrames: this.dropoutFrames,
    };
    this.state = 'idle';
    this.aboveMs = 0;
    this.belowMs = 0;
    this.clearAccumulators();
    return closed;
  }

  private clearAccumulators(): void {
    this.voicedMs = 0;
    this.silenceMs = 0;
    this.unmeasuredMs = 0;
    this.dropoutFrames = 0;
    this.snrWeightedSum = 0;
    this.snrWeight = 0;
  }
}
