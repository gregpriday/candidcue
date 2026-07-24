/**
 * Target-duration pacing (spec §14.10).
 *
 * Sign convention, stated once because getting it backwards is the whole bug:
 * `projectedFinishDeltaMs` is **projected finish minus target**, so a
 * *positive* value means the take is running **long**. That matches the
 * contract's `PaceDisplayState.projectedFinishDeltaMs` comment.
 *
 * §14.10 also insists the live schedule state use *projected finish*, not
 * instantaneous pace — an instantaneous number swings with every sentence and
 * would have a presenter chasing a target they are already going to hit.
 *
 * ---------------------------------------------------------------------------
 * SEAM NOTE — `ScriptProgress` now lives in the shared contract.
 * ---------------------------------------------------------------------------
 * It was declared locally while this module was built, because
 * `remainingSpokenWordEquivalents` is a property of the *script and the
 * alignment cursor* and could not be derived from `AudioFrameFeatures`,
 * `SpeechInterval`, or the transcript. It has since been promoted into
 * `shared/contracts/coaching.ts` and is re-exported here for callers, so there
 * is exactly one definition and the alignment engine — which already owns the
 * cursor and the total unit count — has a single shape to satisfy.
 */
import type { ScriptProgress } from '../../contracts/coaching';

export type { ScriptProgress };

export interface TargetDurationOptions {
  /** EMA half-life applied to the projected delta, ms. */
  smoothingHalfLifeMs: number;
  /** EMA half-life applied to the required rate, ms (§14.10 "smooth this value"). */
  requiredWpmHalfLifeMs: number;
  /**
   * §14.10: "Avoid displaying schedule error smaller than 5–10 seconds."
   * Reported on the result rather than folded into the number, so the renderer
   * decides how to present "on schedule" and the analyzer never lies about
   * what it computed.
   */
  toleranceMs: number;
  /** Cap on how fast the smoothed delta may move, ms of delta per second. */
  maxDeltaChangeMsPerSecond: number;
  /** Cap on how fast the smoothed required rate may move, WPM per second. */
  maxRequiredWpmChangePerSecond: number;
  /** Below this WPM no projection is made; dividing by ~0 projects infinity. */
  minimumProjectionWpm: number;
  /** Alignment confidence below which the cursor is not believed. */
  minimumProgressConfidence: number;
  /** A cursor older than this is stale and no longer projected from, ms. */
  maximumProgressStalenessMs: number;
}

export const DEFAULT_TARGET_DURATION_OPTIONS: TargetDurationOptions = {
  smoothingHalfLifeMs: 6_000,
  requiredWpmHalfLifeMs: 6_000,
  toleranceMs: 7_500,
  maxDeltaChangeMsPerSecond: 4_000,
  maxRequiredWpmChangePerSecond: 8,
  minimumProjectionWpm: 40,
  minimumProgressConfidence: 0.5,
  maximumProgressStalenessMs: 6_000,
};

export interface TargetDurationInput {
  audioTimeMs: number;
  /** Delivery time consumed so far this take, ms (§14.1). */
  elapsedDeliveryMs: number;
  /** The alignment cursor, or `null` when the engine has nothing to say. */
  progress: ScriptProgress | null;
  /** The rate to project with — the displayed audible WPM. `null` while unknown. */
  currentWpm: number | null;
  /** Current tracking epoch. A mismatch against `progress` discards it (§5.4). */
  trackingEpoch: number;
}

export type ProgressRejectionReason =
  | 'no_progress'
  | 'stale_epoch'
  | 'reacquiring'
  | 'low_confidence'
  | 'stale_cursor'
  | 'negative_remainder';

export interface TargetDurationResult {
  /** §14.10 `remainingSpokenWordEquivalents / remainingTargetMinutes`, smoothed. */
  requiredWpm: number | null;
  /** Smoothed projected finish minus target, ms. Positive = running long. */
  projectedFinishDeltaMs: number | null;
  /** Unsmoothed projection, ms. Exposed for tests and diagnostics. */
  rawProjectedFinishDeltaMs: number | null;
  /** Projected total take duration, ms. */
  projectedTotalMs: number | null;
  /** True when |delta| is inside the display tolerance (§14.10). */
  withinTolerance: boolean;
  /** Why the script cursor was not used, or `null` when it was. */
  progressRejected: ProgressRejectionReason | null;
}

const NO_TARGET: TargetDurationResult = {
  requiredWpm: null,
  projectedFinishDeltaMs: null,
  rawProjectedFinishDeltaMs: null,
  projectedTotalMs: null,
  withinTolerance: true,
  progressRejected: null,
};

/**
 * Rolling projected-finish tracker. One instance per take pass; call
 * {@link reset} at a skipped section, command, or retake so the smoother does
 * not drag a stale projection across a discontinuity (§14.10 "cap changes
 * around skipped sections, commands, and retakes"). An epoch change resets it
 * automatically.
 */
export class TargetDurationTracker {
  private readonly options: TargetDurationOptions;
  private smoothedDeltaMs: number | null = null;
  private smoothedRequiredWpm: number | null = null;
  private lastUpdateMs: number | null = null;
  private lastEpoch: number | null = null;

  constructor(
    /** Authored target duration for the script, ms, or `null` when not set. */
    private targetDurationMs: number | null,
    options: Partial<TargetDurationOptions> = {},
  ) {
    this.options = { ...DEFAULT_TARGET_DURATION_OPTIONS, ...options };
  }

  setTargetDurationMs(targetDurationMs: number | null): void {
    if (targetDurationMs !== this.targetDurationMs) {
      this.targetDurationMs = targetDurationMs;
      this.reset();
    }
  }

  /** Forget the smoothed state; the next update seeds it fresh. */
  reset(): void {
    this.smoothedDeltaMs = null;
    this.smoothedRequiredWpm = null;
    this.lastUpdateMs = null;
  }

  update(input: TargetDurationInput): TargetDurationResult {
    if (this.lastEpoch !== null && this.lastEpoch !== input.trackingEpoch) {
      this.reset();
    }
    this.lastEpoch = input.trackingEpoch;

    const target = this.targetDurationMs;
    if (target === null || target <= 0) {
      return NO_TARGET;
    }

    const rejection = rejectProgress(input, this.options);
    const progress = input.progress;
    if (rejection !== null || progress === null) {
      return {
        ...NO_TARGET,
        progressRejected: rejection ?? 'no_progress',
      };
    }

    const remainingWords = progress.remainingSpokenWordEquivalents;
    const remainingTargetMs = target - input.elapsedDeliveryMs;
    const rawRequiredWpm =
      remainingTargetMs <= 0 ? null : (remainingWords / remainingTargetMs) * 60_000;

    const wpm = input.currentWpm;
    if (wpm === null || wpm < this.options.minimumProjectionWpm) {
      // Still report the required rate — it needs no current rate to compute —
      // but do not invent a projection from a rate we do not have.
      const requiredWpm =
        rawRequiredWpm === null
          ? null
          : this.smoothRequiredWpm(rawRequiredWpm, input.audioTimeMs);
      this.lastUpdateMs = input.audioTimeMs;
      return {
        requiredWpm,
        projectedFinishDeltaMs: null,
        rawProjectedFinishDeltaMs: null,
        projectedTotalMs: null,
        withinTolerance: true,
        progressRejected: null,
      };
    }

    const projectedRemainingMs = (remainingWords / wpm) * 60_000;
    const projectedTotalMs = input.elapsedDeliveryMs + projectedRemainingMs;
    const rawDeltaMs = projectedTotalMs - target;

    const smoothed = this.smoothDelta(rawDeltaMs, input.audioTimeMs);
    const requiredWpm =
      rawRequiredWpm === null ? null : this.smoothRequiredWpm(rawRequiredWpm, input.audioTimeMs);
    this.lastUpdateMs = input.audioTimeMs;

    return {
      requiredWpm,
      projectedFinishDeltaMs: smoothed,
      rawProjectedFinishDeltaMs: rawDeltaMs,
      projectedTotalMs,
      withinTolerance: Math.abs(smoothed) <= this.options.toleranceMs,
      progressRejected: null,
    };
  }

  private smoothDelta(rawDeltaMs: number, audioTimeMs: number): number {
    const previous = this.smoothedDeltaMs;
    const previousMs = this.lastUpdateMs;
    if (previous === null || previousMs === null || audioTimeMs <= previousMs) {
      this.smoothedDeltaMs = rawDeltaMs;
      return rawDeltaMs;
    }
    const elapsedMs = audioTimeMs - previousMs;
    const alpha = 1 - Math.pow(0.5, elapsedMs / this.options.smoothingHalfLifeMs);
    let next = previous + alpha * (rawDeltaMs - previous);

    const maxChange = this.options.maxDeltaChangeMsPerSecond * (elapsedMs / 1000);
    const change = next - previous;
    if (Math.abs(change) > maxChange) {
      next = previous + Math.sign(change) * maxChange;
    }
    this.smoothedDeltaMs = next;
    return next;
  }

  private smoothRequiredWpm(rawWpm: number, audioTimeMs: number): number {
    const previous = this.smoothedRequiredWpm;
    const previousMs = this.lastUpdateMs;
    if (previous === null || previousMs === null || audioTimeMs <= previousMs) {
      this.smoothedRequiredWpm = rawWpm;
      return rawWpm;
    }
    const elapsedMs = audioTimeMs - previousMs;
    const alpha = 1 - Math.pow(0.5, elapsedMs / this.options.requiredWpmHalfLifeMs);
    let next = previous + alpha * (rawWpm - previous);

    const maxChange = this.options.maxRequiredWpmChangePerSecond * (elapsedMs / 1000);
    const change = next - previous;
    if (Math.abs(change) > maxChange) {
      next = previous + Math.sign(change) * maxChange;
    }
    this.smoothedRequiredWpm = next;
    return next;
  }
}

/** §14.10 / §5.4 trust gates on the alignment cursor. */
export function rejectProgress(
  input: TargetDurationInput,
  options: TargetDurationOptions = DEFAULT_TARGET_DURATION_OPTIONS,
): ProgressRejectionReason | null {
  const progress = input.progress;
  if (progress === null) {
    return 'no_progress';
  }
  if (progress.trackingEpoch !== input.trackingEpoch) {
    return 'stale_epoch';
  }
  if (progress.reacquiring) {
    return 'reacquiring';
  }
  if (progress.confidence < options.minimumProgressConfidence) {
    return 'low_confidence';
  }
  if (input.audioTimeMs - progress.observedAtMs > options.maximumProgressStalenessMs) {
    return 'stale_cursor';
  }
  if (progress.remainingSpokenWordEquivalents < 0) {
    return 'negative_remainder';
  }
  return null;
}
