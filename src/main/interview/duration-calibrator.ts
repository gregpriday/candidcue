import { RUNTIME_DEFAULTS } from '@shared/constants/runtime-defaults';

/** EWMA weight applied to the newly observed rate; the rest favours history. */
const NEW_SAMPLE_WEIGHT = 0.2;

/** Sane bounds for words-per-second so a noisy sample cannot poison estimates. */
const MIN_WPS = 1.5;
const MAX_WPS = 4.5;

/**
 * Tracks Mira's observed speaking rate (words per second) and estimates the
 * audio duration of upcoming speech (spec §16.16).
 *
 * The rate is smoothed with an exponentially weighted moving average so a
 * single slow or fast clip nudges, rather than dominates, the running estimate.
 */
export class DurationCalibrator {
  private wps: number;

  constructor(initialWps: number = RUNTIME_DEFAULTS.defaultWordsPerSecond) {
    this.wps = clampWps(initialWps);
  }

  /** Current smoothed speaking rate in words per second. */
  get wordsPerSecond(): number {
    return this.wps;
  }

  /**
   * Fold an observed clip into the running rate via EWMA:
   *   wps = 0.2 * observed + 0.8 * previous
   * Non-positive word counts or durations are ignored as unusable samples.
   */
  update(words: number, actualAudioMs: number): void {
    if (words <= 0 || actualAudioMs <= 0) {
      return;
    }
    const observed = words / (actualAudioMs / 1000);
    const blended = NEW_SAMPLE_WEIGHT * observed + (1 - NEW_SAMPLE_WEIGHT) * this.wps;
    this.wps = clampWps(blended);
  }

  /** Estimate the audio duration (ms) for `words` at the current rate. */
  estimateMs(words: number): number {
    if (words <= 0) {
      return 0;
    }
    return Math.round((words / this.wps) * 1000);
  }
}

/** Constrain a words-per-second value to the supported range. */
function clampWps(value: number): number {
  if (!Number.isFinite(value)) {
    return RUNTIME_DEFAULTS.defaultWordsPerSecond;
  }
  return Math.min(MAX_WPS, Math.max(MIN_WPS, value));
}
