/**
 * B4 — the stage half of the Follow-feel wire (§47.1, §55).
 *
 * The control side resolved a profile and the stage engine had a `profile`
 * option, and between them there was nothing: `createStageMotionEngine()` was
 * called with no arguments and every feel produced `DEFAULT_SMOOTH_FOLLOW_PROFILE`.
 *
 * Two things are proved here, both of which fail if the wire is pulled out:
 *
 *   1. a profile handed to the engine is the one it USES — not merely stored,
 *      but read by the limits the controller runs on;
 *   2. a profile the stage cannot interpret does not get applied — it falls
 *      back to the default rather than half-applying numbers whose meaning it
 *      is guessing at.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SMOOTH_FOLLOW_PROFILE,
  SMOOTH_FOLLOW_PROFILE_VERSION,
  isInterpretableSmoothFollowProfile,
  type SmoothFollowProfile,
} from '../../../src/shared/contracts';
import {
  createStageMotionEngine,
  limitsForState,
  stageFollowProfile,
} from '../../../src/stage/motion';
import {
  defaultFollowingSettings,
  resolveFollowProfile,
} from '../../../src/control/lib/follow-profiles';

function profileFor(feel: 'calm' | 'balanced' | 'responsive'): SmoothFollowProfile {
  return resolveFollowProfile({ ...defaultFollowingSettings(), feel });
}

describe('stageFollowProfile — version fallback (§55)', () => {
  it('accepts a profile of the version this build interprets', () => {
    const responsive = profileFor('responsive');
    expect(responsive.version).toBe(SMOOTH_FOLLOW_PROFILE_VERSION);
    expect(stageFollowProfile(responsive)).toBe(responsive);
  });

  it('falls back to the default for a version it cannot interpret', () => {
    const fromTheFuture: SmoothFollowProfile = {
      ...profileFor('responsive'),
      version: SMOOTH_FOLLOW_PROFILE_VERSION + 1,
    };
    // Not "merged", not "partially applied": ignored entirely.
    expect(stageFollowProfile(fromTheFuture)).toBe(DEFAULT_SMOOTH_FOLLOW_PROFILE);
    expect(isInterpretableSmoothFollowProfile(fromTheFuture)).toBe(false);
  });

  it('rejects an older version too, not just a newer one', () => {
    // A version bump means a field's MEANING changed, so an older profile is
    // not a safe subset — it is a different language with the same words.
    const older = { ...profileFor('calm'), version: SMOOTH_FOLLOW_PROFILE_VERSION - 1 };
    expect(stageFollowProfile(older)).toBe(DEFAULT_SMOOTH_FOLLOW_PROFILE);
  });

  it('falls back for a truncated or non-finite profile of the right version', () => {
    const right = profileFor('calm');
    const truncated = { ...right, motion: { ...right.motion, naturalFrequency: undefined } };
    const nonFinite = { ...right, motion: { ...right.motion, maxJerkPxS3: Number.NaN } };
    const missingSection = { version: SMOOTH_FOLLOW_PROFILE_VERSION, id: 'x' };

    // A missing number becomes NaN limits on the first multiplication, and NaN
    // propagates through the whole controller — worse than the default.
    expect(stageFollowProfile(truncated as unknown as SmoothFollowProfile)).toBe(
      DEFAULT_SMOOTH_FOLLOW_PROFILE,
    );
    expect(stageFollowProfile(nonFinite)).toBe(DEFAULT_SMOOTH_FOLLOW_PROFILE);
    expect(stageFollowProfile(missingSection as unknown as SmoothFollowProfile)).toBe(
      DEFAULT_SMOOTH_FOLLOW_PROFILE,
    );
  });

  it('falls back when nothing was sent at all', () => {
    expect(stageFollowProfile(undefined)).toBe(DEFAULT_SMOOTH_FOLLOW_PROFILE);
    expect(stageFollowProfile(null)).toBe(DEFAULT_SMOOTH_FOLLOW_PROFILE);
  });
});

describe('the engine runs on the profile it is given (§47.1)', () => {
  it('uses a non-default feel in the limits the controller runs on', () => {
    const responsive = profileFor('responsive');
    const engine = createStageMotionEngine({ profile: responsive });

    expect(engine.profile).toBe(responsive);

    // The value that actually reaches the plant: `following` limits derive
    // omega from the profile's natural frequency.
    const chosen = limitsForState('following', engine.profile);
    const fallback = limitsForState('following', DEFAULT_SMOOTH_FOLLOW_PROFILE);
    expect(chosen.omega).toBeGreaterThan(fallback.omega);
    expect(chosen.jerkMax).toBeGreaterThan(fallback.jerkMax);
  });

  it('adopts a profile that arrives AFTER construction', () => {
    // The ordering that matters in the app: a stage window outlives a session,
    // so a second take publishes its envelope into an engine that already
    // exists. A construction-only read would leave take two on take one's feel.
    const engine = createStageMotionEngine();
    expect(engine.profile).toBe(DEFAULT_SMOOTH_FOLLOW_PROFILE);

    const calm = profileFor('calm');
    engine.setProfile(calm);

    expect(engine.profile).toBe(calm);
    expect(limitsForState('following', engine.profile).omega).toBeLessThan(
      limitsForState('following', DEFAULT_SMOOTH_FOLLOW_PROFILE).omega,
    );
  });

  it('reads a swapped profile live rather than capturing it at construction', () => {
    const engine = createStageMotionEngine();
    const swapped: SmoothFollowProfile = {
      ...DEFAULT_SMOOTH_FOLLOW_PROFILE,
      id: 'test-swap',
      motion: { ...DEFAULT_SMOOTH_FOLLOW_PROFILE.motion, maxForwardVelocityPxS: 1234 },
    };
    engine.setProfile(swapped);
    expect(engine.profile.id).toBe('test-swap');
    expect(engine.profile.motion.maxForwardVelocityPxS).toBe(1234);
  });

  /*
   * §47.3 voice lead was a profile field — `prediction.leadSeconds`, resolved
   * from a user setting and applied by asking `alignmentDisplayAt` for a moment
   * in the future. It is gone because it doubled the share of a take the
   * display spent ahead of the reader (3.8% → 6.5% at its default, 9.6% at its
   * maximum, measured on the live captures).
   *
   * The field's absence is asserted, not just its value, because a profile
   * crosses a process boundary: as long as the stage reads a lead from the
   * profile at all, any envelope that reaches it can reintroduce the defect
   * without a line of stage code changing.
   */
  it('publishes no lead field for a profile to reintroduce', () => {
    expect(DEFAULT_SMOOTH_FOLLOW_PROFILE).not.toHaveProperty('prediction');
    for (const feel of ['calm', 'balanced', 'responsive'] as const) {
      expect(profileFor(feel)).not.toHaveProperty('prediction');
    }
  });
});
