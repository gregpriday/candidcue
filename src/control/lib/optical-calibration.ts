/**
 * How complete a rig's calibration actually is.
 *
 * WHY THIS IS NOT IN `shared/contracts/optical.ts`
 * ---------------------------------------------------------------------------
 * `OpticalCalibrationStep` is PERSISTED vocabulary: the set of tokens a stored
 * profile is allowed to carry, which is deliberately wider than the set the
 * current wizard writes. It still admits `follow-test`, a step that no longer
 * exists, because a document written by an older build must keep loading. A
 * denominator derived from that union would count a screen nobody can reach.
 *
 * What "how far along is this rig" needs is the opposite thing — the checks the
 * CURRENT wizard actually performs — and that is workflow, not wire format. So
 * it lives here, in the control layer, beside the screens that ask.
 *
 * WHY THE COUNT IS NOT `completedSteps.length`
 * ---------------------------------------------------------------------------
 * Two ways that number lies, and both are reachable rather than theoretical:
 *
 *   - A profile stored by an older build carries `follow-test`. Against a
 *     hardcoded denominator of 8 that renders "9 of 8 steps".
 *   - The array is a list, not a set. Nothing in the normaliser dedupes it, so
 *     a token written twice counts twice.
 *
 * Counting by MEMBERSHIP of the checks below is immune to both: an unknown or
 * repeated token cannot raise the numerator, because the numerator is derived
 * from what we are looking for rather than from what happens to be stored.
 *
 * WHY SCALE IS A CHECK WITH NO TOKEN
 * ---------------------------------------------------------------------------
 * This is the defect the whole module exists for. The wizard deliberately gives
 * the scale step `records: null` — the fact is already evident from
 * `profile.scale`, and a token would be a second, unsynchronised place to store
 * it. That reasoning is sound and is left alone.
 *
 * But it means the token count reaches its maximum while `scale` is still null,
 * and a rig then reports itself finished with the one measurement every angular
 * result is multiplied by never taken. So scale is counted here directly off
 * `profile.scale`, which is where the answer really lives. A rig that has
 * answered every question but never measured its glass reads 8 of 9 — which is
 * true, and is the point.
 *
 * `preset` is the other tokenless step and is NOT counted: it is a shortcut that
 * fills in the obvious answers, and every one of them stays open to correction
 * on the steps ahead. Skipping it costs the rig nothing.
 */

import type { OpticalCalibrationStep, OpticalProfile } from '../../shared/contracts';

/**
 * The steps whose completion this module has an opinion about.
 *
 * `follow-test` is excluded because the wizard that recorded it is gone; it
 * survives in the persisted union only so old documents load. Everything else
 * in the union must be classified below.
 */
export type CountedCalibrationStep = Exclude<OpticalCalibrationStep, 'follow-test'>;

/**
 * Every counted step, and where the answer is actually kept.
 *
 * This is a total `Record`, and that is the point: it is the forcing function
 * that keeps this file honest. Add a step to `OpticalCalibrationStep` and this
 * map stops compiling until somebody says whether the new step counts — which
 * is the check that was missing when the denominator was the literal `8`.
 */
const CALIBRATION_CHECKS: Record<CountedCalibrationStep, true> = {
  hardware: true,
  'safe-area': true,
  orientation: true,
  lens: true,
  distance: true,
  'text-size': true,
  'line-width': true,
  brightness: true,
};

/** The token-backed checks, in the order the wizard asks them. */
const TOKEN_CHECKS = Object.keys(CALIBRATION_CHECKS) as CountedCalibrationStep[];

/**
 * Total checks: every token-backed step, plus scale.
 *
 * Derived rather than written down, so the next step added to the wizard moves
 * this number by adding itself to `CALIBRATION_CHECKS` — the failure mode of
 * the literal it replaces was that nothing made it move.
 */
export const TOTAL_CALIBRATION_CHECKS = TOKEN_CHECKS.length + 1;

export interface CalibrationProgress {
  /** Checks answered, out of `total`. Never exceeds `total`. */
  completed: number;
  total: number;
  /** Whether the physical scale has been established. */
  scaleMeasured: boolean;
  /** True when every check including scale is answered. */
  complete: boolean;
}

/**
 * How far along a stored rig is.
 *
 * Pure, and deliberately tolerant of a malformed `completedSteps`: this runs
 * against documents the user may have carried across several builds, and a
 * progress readout is the wrong place to throw.
 */
export function calibrationProgress(profile: OpticalProfile): CalibrationProgress {
  const recorded = new Set(Array.isArray(profile.completedSteps) ? profile.completedSteps : []);
  const scaleMeasured = profile.scale !== null && profile.scale !== undefined;
  const tokensAnswered = TOKEN_CHECKS.filter((step) => recorded.has(step)).length;
  const completed = tokensAnswered + (scaleMeasured ? 1 : 0);
  return {
    completed,
    total: TOTAL_CALIBRATION_CHECKS,
    scaleMeasured,
    complete: completed === TOTAL_CALIBRATION_CHECKS,
  };
}

/**
 * The one line a rig row says about its own completeness.
 *
 * Scale gets named rather than folded into the count, because "8 of 9" alone
 * sends somebody hunting through ten wizard screens for the one they missed —
 * and because an unmeasured scale is not one missing answer among nine. It is
 * the fact every angular result is multiplied by, so the row says which one it
 * is and the reader can go straight to it.
 */
export function describeCalibrationProgress(profile: OpticalProfile): string {
  const progress = calibrationProgress(profile);
  const count = `${progress.completed} of ${progress.total} calibration checks`;
  if (!progress.scaleMeasured) return `Scale not measured · ${count}`;
  return progress.complete ? 'Fully calibrated' : count;
}
