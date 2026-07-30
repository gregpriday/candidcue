import { describe, it, expect } from 'vitest';
import {
  TOTAL_CALIBRATION_CHECKS,
  calibrationProgress,
  describeCalibrationProgress,
  type CountedCalibrationStep,
} from '../../../src/control/lib/optical-calibration';
import {
  defaultOpticalProfile,
  type OpticalProfile,
  type OpticalScale,
} from '../../../src/shared/contracts';

/**
 * The rig row used to say "{completedSteps.length} of 8 steps".
 *
 * Both halves of that were wrong in a way somebody acts on. The denominator was
 * an unsourced literal that nothing made move, and the numerator was the raw
 * length of a stored array — so a rig could reach "8 of 8", read as finished,
 * and still have no measured scale, which is the number every angular result is
 * multiplied by.
 *
 * These pin the replacement: a derived denominator, a numerator counted by
 * membership, and scale counted as the check it is.
 */

const ALL_TOKENS: CountedCalibrationStep[] = [
  'hardware',
  'safe-area',
  'orientation',
  'lens',
  'distance',
  'text-size',
  'line-width',
  'brightness',
];

const MEASURED_SCALE: OpticalScale = { mmPerCssPx: 0.25, source: 'ruler' };

function profile(patch: Partial<OpticalProfile> = {}): OpticalProfile {
  return { ...defaultOpticalProfile(), ...patch };
}

describe('calibration progress', () => {
  it('counts every token-backed step plus scale', () => {
    // Eight questions the wizard records a token for, and the scale it does
    // not — nine substantive checks in total.
    expect(TOTAL_CALIBRATION_CHECKS).toBe(9);
  });

  it('reports nothing done for a rig that has told us nothing', () => {
    const p = calibrationProgress(defaultOpticalProfile());
    expect(p.completed).toBe(0);
    expect(p.scaleMeasured).toBe(false);
    expect(p.complete).toBe(false);
  });

  /**
   * THE DEFECT, pinned.
   *
   * Every token answered and no scale. The old readout called this "8 of 8
   * steps" — done. It is not done: the one measurement that cannot be inferred
   * is missing.
   */
  it('does not call a rig complete when the scale was never measured', () => {
    const p = calibrationProgress(profile({ completedSteps: [...ALL_TOKENS], scale: null }));
    expect(p.completed).toBe(8);
    expect(p.total).toBe(9);
    expect(p.complete).toBe(false);
    expect(describeCalibrationProgress(profile({ completedSteps: [...ALL_TOKENS], scale: null })))
      .toBe('Scale not measured · 8 of 9 calibration checks');
  });

  it('is complete only once the scale is measured too', () => {
    const p = calibrationProgress(
      profile({ completedSteps: [...ALL_TOKENS], scale: MEASURED_SCALE }),
    );
    expect(p.completed).toBe(9);
    expect(p.complete).toBe(true);
    expect(
      describeCalibrationProgress(profile({ completedSteps: [...ALL_TOKENS], scale: MEASURED_SCALE })),
    ).toBe('Fully calibrated');
  });

  it('counts a measured scale even when no step token exists for it', () => {
    // Scale is deliberately tokenless in the wizard — the profile field IS the
    // record. A rig that has only measured its glass is 1 of 9, not 0 of 9.
    const p = calibrationProgress(profile({ completedSteps: [], scale: MEASURED_SCALE }));
    expect(p.completed).toBe(1);
    expect(p.scaleMeasured).toBe(true);
  });

  /**
   * A profile written by an older build carries `follow-test`, a step the
   * wizard no longer has. Against the old hardcoded 8 that rendered "9 of 8".
   */
  it('ignores the retired follow-test token instead of inflating the count', () => {
    const p = calibrationProgress(
      profile({
        completedSteps: [...ALL_TOKENS, 'follow-test'],
        scale: MEASURED_SCALE,
      }),
    );
    expect(p.completed).toBe(9);
    expect(p.complete).toBe(true);
  });

  it('counts a repeated token once', () => {
    // `completedSteps` is a list and nothing dedupes it on the way in.
    const p = calibrationProgress(
      profile({ completedSteps: ['hardware', 'hardware', 'lens'], scale: null }),
    );
    expect(p.completed).toBe(2);
  });

  it('survives a completedSteps that is not an array', () => {
    // Progress readouts run against documents carried across several builds;
    // this is the wrong place to throw.
    const p = calibrationProgress(
      profile({ completedSteps: undefined as unknown as OpticalProfile['completedSteps'] }),
    );
    expect(p.completed).toBe(0);
  });

  it('does not require the preset shortcut', () => {
    // `preset` fills in obvious answers and every one stays correctable, so
    // skipping it costs the rig nothing and must not hold the count down.
    const p = calibrationProgress(
      profile({ completedSteps: [...ALL_TOKENS], scale: MEASURED_SCALE }),
    );
    expect(p.complete).toBe(true);
  });

  it('names the missing scale even on a part-finished rig', () => {
    expect(describeCalibrationProgress(profile({ completedSteps: ['hardware'], scale: null }))).toBe(
      'Scale not measured · 1 of 9 calibration checks',
    );
  });
});
