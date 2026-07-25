/**
 * Local voice-activity detection and level analysis core (spec §28.4).
 *
 * Pure: consumes per-frame RMS/peak statistics with monotonic timestamps and
 * produces `AudioLevelSnapshot`s plus speech-boundary events. All tunables
 * come from `VadConfig` (Appendix A.6 defaults) — no magic numbers inline.
 */
import type { AudioLevelSnapshot } from '../../../shared/contracts';
import { DEFAULT_VAD_CONFIG, type VadConfig } from './defaults';

export type VadEvent =
  | { type: 'calibrated'; noiseFloor: number; atMs: number }
  | { type: 'speech_started'; atMs: number }
  | { type: 'speech_ended'; atMs: number; speechStartMs: number; durationMs: number }
  | { type: 'max_utterance'; atMs: number; speechStartMs: number; durationMs: number };

export interface FrameStats {
  rms: number;
  peak: number;
}

/** Compute RMS and absolute peak from a time-domain sample frame. Pure. */
export function computeFrameStats(samples: Float32Array): FrameStats {
  let sumSquares = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i] ?? 0;
    sumSquares += s * s;
    const abs = Math.abs(s);
    if (abs > peak) peak = abs;
  }
  const rms = samples.length > 0 ? Math.sqrt(sumSquares / samples.length) : 0;
  return { rms, peak };
}

/**
 * The ambient floor of a calibration window.
 *
 * A low percentile rather than a mean, and then a hard ceiling. Speech is
 * sparse enough that even continuous reading leaves gaps between words, so the
 * percentile finds the room underneath it; the ceiling covers the case it
 * cannot — someone who never pauses — where the honest answer is that this
 * window contains no measurement of the room at all and a conservative floor
 * beats a confident wrong one.
 */
export function estimateNoiseFloor(
  samples: readonly number[],
  config: Pick<VadConfig, 'calibrationPercentile' | 'maxNoiseFloor'>,
): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((sorted.length - 1) * config.calibrationPercentile)),
  );
  return Math.min(config.maxNoiseFloor, sorted[index] ?? 0);
}

interface VadState {
  phase: 'calibrating' | 'silence' | 'opening' | 'speaking';
  calibrationStartMs: number | null;
  /** Every RMS in the window, so a percentile can be taken rather than a mean. */
  calibrationSamples: number[];
  noiseFloor: number;
  smoothedRms: number;
  aboveSinceMs: number | null;
  belowSinceMs: number | null;
  speechStartMs: number | null;
  /** Reset after a forced max-utterance commit so bounds stay bounded. */
  utteranceAnchorMs: number | null;
  lastSnapshot: AudioLevelSnapshot | null;
}

/**
 * Adaptive local VAD (spec §28.4):
 * - noise floor from an initial calibration window, then a slow EMA during
 *   silence (adaptive floor);
 * - speech opens after `speechOpenMs` above threshold;
 * - speech survives gaps shorter than `endOfTurnSilenceMs`;
 * - `speech_ended` fires after `endOfTurnSilenceMs` of silence (commit cue);
 * - `max_utterance` fires when continuous speech reaches `maxUtteranceMs`
 *   (forced-commit cue) and re-anchors so reconciliation stays bounded.
 */
export class LocalVad {
  private readonly config: VadConfig;
  private state: VadState;

  constructor(config: Partial<VadConfig> = {}) {
    this.config = { ...DEFAULT_VAD_CONFIG, ...config };
    this.state = this.freshState();
  }

  private freshState(): VadState {
    return {
      phase: 'calibrating',
      calibrationStartMs: null,
      calibrationSamples: [],
      noiseFloor: this.config.minSpeechRms / this.config.noiseFloorMargin,
      smoothedRms: 0,
      aboveSinceMs: null,
      belowSinceMs: null,
      speechStartMs: null,
      utteranceAnchorMs: null,
      lastSnapshot: null,
    };
  }

  reset(): void {
    this.state = this.freshState();
  }

  get speaking(): boolean {
    return this.state.phase === 'speaking';
  }

  get noiseFloor(): number {
    return this.state.noiseFloor;
  }

  private threshold(): number {
    return Math.max(this.config.minSpeechRms, this.state.noiseFloor * this.config.noiseFloorMargin);
  }

  getSnapshot(): AudioLevelSnapshot | null {
    return this.state.lastSnapshot;
  }

  /** Feed one analysis frame; returns zero or more boundary events. */
  processFrame(stats: FrameStats, atMs: number): VadEvent[] {
    const s = this.state;
    const c = this.config;
    const events: VadEvent[] = [];

    const alpha = c.levelSmoothing;
    s.smoothedRms = s.smoothedRms === 0 ? stats.rms : alpha * stats.rms + (1 - alpha) * s.smoothedRms;

    if (s.phase === 'calibrating') {
      if (s.calibrationStartMs === null) s.calibrationStartMs = atMs;
      s.calibrationSamples.push(stats.rms);
      if (atMs - s.calibrationStartMs >= c.calibrationMs) {
        s.noiseFloor = estimateNoiseFloor(s.calibrationSamples, c);
        s.phase = 'silence';
        events.push({ type: 'calibrated', noiseFloor: s.noiseFloor, atMs });
      }
      this.snapshot(stats, atMs);
      return events;
    }

    const above = stats.rms >= this.threshold();

    if (s.phase === 'silence' || s.phase === 'opening') {
      if (above) {
        if (s.aboveSinceMs === null) s.aboveSinceMs = atMs;
        s.phase = 'opening';
        if (atMs - s.aboveSinceMs >= c.speechOpenMs) {
          s.phase = 'speaking';
          s.speechStartMs = s.aboveSinceMs;
          s.utteranceAnchorMs = s.aboveSinceMs;
          s.belowSinceMs = null;
          events.push({ type: 'speech_started', atMs: s.aboveSinceMs });
        }
      } else {
        s.aboveSinceMs = null;
        s.phase = 'silence';
        /*
         * Adaptive floor, asymmetric on purpose: quick to come DOWN, slow to
         * go up.
         *
         * A symmetric EMA is the reason a bad calibration used to be close to
         * permanent — speech below the inflated gate counts as silence, so the
         * floor it feeds is speech, and the estimate sits there. Falling fast
         * lets a poisoned floor recover in a second or two instead of a take;
         * rising slowly keeps a door slam or a cough from deafening the
         * detector, which is the standard fast-fall/slow-rise shape.
         */
        const rate = stats.rms < s.noiseFloor ? 0.3 : 0.02;
        s.noiseFloor = Math.min(
          c.maxNoiseFloor,
          rate * stats.rms + (1 - rate) * s.noiseFloor,
        );
      }
    } else if (s.phase === 'speaking') {
      if (above) {
        s.belowSinceMs = null;
      } else if (s.belowSinceMs === null) {
        s.belowSinceMs = atMs;
      } else if (atMs - s.belowSinceMs >= c.endOfTurnSilenceMs) {
        const speechStartMs = s.speechStartMs ?? atMs;
        events.push({
          type: 'speech_ended',
          atMs,
          speechStartMs,
          durationMs: s.belowSinceMs - speechStartMs,
        });
        s.phase = 'silence';
        s.aboveSinceMs = null;
        s.belowSinceMs = null;
        s.speechStartMs = null;
        s.utteranceAnchorMs = null;
      }
      if (s.phase === 'speaking' && s.utteranceAnchorMs !== null) {
        if (atMs - s.utteranceAnchorMs >= c.maxUtteranceMs) {
          events.push({
            type: 'max_utterance',
            atMs,
            speechStartMs: s.utteranceAnchorMs,
            durationMs: atMs - s.utteranceAnchorMs,
          });
          s.utteranceAnchorMs = atMs; // keep partial/final reconciliation bounded
        }
      }
    }

    this.snapshot(stats, atMs);
    return events;
  }

  private snapshot(stats: FrameStats, atMs: number): void {
    const s = this.state;
    s.lastSnapshot = {
      rms: s.smoothedRms,
      peak: stats.peak,
      noiseFloor: s.noiseFloor,
      speaking: s.phase === 'speaking',
      clipped: stats.peak >= this.config.clipPeak,
      signalPresent: stats.rms >= this.config.signalPresentRms,
      generatedAtMs: atMs,
    };
  }
}
