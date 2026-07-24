/**
 * LineHandoffPlanner (companion §8, §28, Appendix B.4).
 *
 * Turns a predicted semantic position into the two numbers the controller
 * follows: where the document should be, and how fast that place is moving.
 *
 * Because every line-start knot of the motion path places its line at the same
 * reading position `R`, reaching the start of the next line means that line is
 * already at `R` — the line-handoff contract (§3.2) is a property of the path,
 * not something the planner has to arrange per event.
 */
import type { LineMotionSample } from '../../shared/contracts';
import type { StageRenderedLineMap } from './lineMap';

export type LineTargetSource = 'path' | 'line_fallback' | 'none';

export interface LineTarget {
  scrollPx: number;
  derivativePxPerUnit: number;
  /** Feed-forward velocity: dScroll/dUnit × semantic velocity (§28.2). */
  feedForwardVelocityPxS: number;
  lineId: string | null;
  lineProgress: number;
  source: LineTargetSource;
  /** True when the predicted unit lies outside the measured coverage. */
  outOfCoverage: boolean;
}

export interface LineHandoffPlannerOptions {
  /** Clamp for the feed-forward term; the controller clamps velocity again. */
  maxFeedForwardPxS: number;
  /** Clamp for unstable derivatives around layout boundaries (§28.2). */
  maxDerivativePxPerUnit?: number;
}

export interface LineHandoffPlanner {
  readonly map: StageRenderedLineMap;
  target(spokenUnit: number, semanticVelocityUnitsPerS: number): LineTarget;
}

const NO_TARGET: LineTarget = {
  scrollPx: 0,
  derivativePxPerUnit: 0,
  feedForwardVelocityPxS: 0,
  lineId: null,
  lineProgress: 0,
  source: 'none',
  outOfCoverage: true,
};

export function createLineHandoffPlanner(
  map: StageRenderedLineMap,
  options: LineHandoffPlannerOptions,
): LineHandoffPlanner {
  const maxDerivative = options.maxDerivativePxPerUnit ?? Number.POSITIVE_INFINITY;

  function finish(
    sample: LineMotionSample,
    source: LineTargetSource,
    velocityUnitsPerS: number,
    outOfCoverage: boolean,
  ): LineTarget {
    const derivative = Math.min(Math.max(0, sample.derivativePxPerUnit), maxDerivative);
    const feedForward = Math.max(
      -options.maxFeedForwardPxS,
      Math.min(options.maxFeedForwardPxS, derivative * velocityUnitsPerS),
    );
    return {
      scrollPx: sample.scrollPx,
      derivativePxPerUnit: derivative,
      feedForwardVelocityPxS: feedForward,
      lineId: sample.lineId,
      lineProgress: sample.lineProgress,
      source,
      outOfCoverage,
    };
  }

  return {
    map,
    target(spokenUnit, semanticVelocityUnitsPerS): LineTarget {
      const outOfCoverage = !map.covers(spokenUnit);
      const path = map.sampleMotionPath(spokenUnit);
      if (path) return finish(path, 'path', semanticVelocityUnitsPerS, outOfCoverage);

      // Explicitly tested degraded fallback (Appendix B.4). Production Voice
      // Follow normally has a valid path for every spoken interval.
      const fallback = map.fallbackTarget(spokenUnit);
      if (fallback) return finish(fallback, 'line_fallback', semanticVelocityUnitsPerS, outOfCoverage);

      return NO_TARGET;
    },
  };
}
