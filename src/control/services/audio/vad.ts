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

interface VadState {
  phase: 'calibrating' | 'silence' | 'opening' | 'speaking';
  calibrationStartMs: number | null;
  calibrationSum: number;
  calibrationFrames: number;
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
      calibrationSum: 0,
      calibrationFrames: 0,
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
      s.calibrationSum += stats.rms;
      s.calibrationFrames += 1;
      if (atMs - s.calibrationStartMs >= c.calibrationMs) {
        s.noiseFloor = s.calibrationFrames > 0 ? s.calibrationSum / s.calibrationFrames : 0;
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
        // Adaptive floor: slow EMA of ambient level during confirmed silence.
        s.noiseFloor = 0.05 * stats.rms + 0.95 * s.noiseFloor;
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
