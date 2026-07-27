/**
 * Motion bounds in LINE PITCHES (§30, companion Appendix A).
 *
 * The pixel bounds in `SmoothFollowProfile.motion` were tuned at one body size
 * — 64 px at a 1.32 line height, a pitch of about 85 px — and mean something
 * else at every other one. `lineUnits` expresses the same bounds as multiples
 * of the measured pitch, and the pixel numbers become the band a line-relative
 * answer is clamped into.
 *
 * Three properties are load-bearing and all three are asserted here:
 *
 *   1. `lineUnits` is ADDITIVE. A profile of this version without it is fully
 *      interpretable and gets the pixel bounds; a profile with a half-written
 *      one is rejected outright, like any other partial payload.
 *   2. Absent a measured pitch, nothing changes. Every state and transition
 *      still resolves to the profile's own pixel numbers.
 *   3. With a pitch, the bounds track it — and a pitch outside the plausible
 *      band cannot drag them anywhere extreme, because a bad pitch is a
 *      measurement fault and must not become motion the presenter sees.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SMOOTH_FOLLOW_PROFILE,
  LINE_LIMIT_MAX_SCALE,
  LINE_LIMIT_MIN_SCALE,
  SMOOTH_FOLLOW_PROFILE_VERSION,
  isInterpretableSmoothFollowProfile,
  resolveLineLimitPx,
  type SmoothFollowProfile,
  type StageMotionState,
  type StageTransitionDirective,
} from '../../../src/shared/contracts';
import { limitsForState, stageFollowProfile } from '../../../src/stage/motion';
import {
  PROVISIONAL_MAX_CORRECTION_PX,
  classifyTransition,
  provisionalMaxCorrectionPx,
} from '../../../src/stage/renderer/motion';

const PROFILE = DEFAULT_SMOOTH_FOLLOW_PROFILE;
/** 64 px body at the default 1.32 line height — what the px bounds were tuned at. */
const REFERENCE_PITCH_PX = 64 * 1.32;

const STATES: StageMotionState[] = [
  'following',
  'searching',
  'holding',
  'ambiguous',
  'paused',
];
const TRANSITIONS: Array<StageTransitionDirective['type'] | undefined> = [
  undefined,
  'none',
  'settle',
  'catch_up',
  'rewind',
  'reanchor',
  'reset',
];

/** A same-version profile that predates the line-unit block. */
function withoutLineUnits(): SmoothFollowProfile {
  const { lineUnits: _dropped, ...rest } = PROFILE;
  return rest;
}

describe('lineUnits is additive, not required (§55)', () => {
  it('interprets a profile of this version that carries no lineUnits at all', () => {
    const legacy = withoutLineUnits();
    expect(legacy).not.toHaveProperty('lineUnits');
    expect(isInterpretableSmoothFollowProfile(legacy)).toBe(true);
    // Not merely "valid": actually applied, rather than swapped for the default.
    expect(stageFollowProfile(legacy)).toBe(legacy);
  });

  it('interprets the shipped default, which does carry one', () => {
    expect(PROFILE.lineUnits).toBeDefined();
    expect(isInterpretableSmoothFollowProfile(PROFILE)).toBe(true);
  });

  it('rejects a lineUnits block that is present but incomplete', () => {
    // Half a block is the same unreproducible third thing a half-applied
    // profile is — the whole reason the version gate is all-or-nothing.
    const partial = {
      ...PROFILE,
      lineUnits: { reverseTravelMaxLines: 5, reanchorThresholdLines: 4.25 },
    };
    expect(isInterpretableSmoothFollowProfile(partial)).toBe(false);
    expect(stageFollowProfile(partial as unknown as SmoothFollowProfile)).toBe(PROFILE);
  });

  it('rejects a lineUnits value that is not a finite number', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '4' as unknown as number]) {
      const poisoned = {
        ...PROFILE,
        lineUnits: { ...PROFILE.lineUnits!, reverseTravelMaxLines: bad },
      };
      expect(isInterpretableSmoothFollowProfile(poisoned)).toBe(false);
    }
  });

  it('rejects an explicit null, which is a written value rather than an omission', () => {
    expect(isInterpretableSmoothFollowProfile({ ...PROFILE, lineUnits: null })).toBe(false);
  });

  it('still refuses a version it cannot interpret, lineUnits or not', () => {
    const older = { ...withoutLineUnits(), version: SMOOTH_FOLLOW_PROFILE_VERSION - 1 };
    const newer = { ...PROFILE, version: SMOOTH_FOLLOW_PROFILE_VERSION + 1 };
    expect(isInterpretableSmoothFollowProfile(older)).toBe(false);
    expect(isInterpretableSmoothFollowProfile(newer)).toBe(false);
  });
});

describe('resolveLineLimitPx', () => {
  it('answers with the pixel value when there is no pitch to reason with', () => {
    expect(resolveLineLimitPx(4, 420, undefined)).toBe(420);
    expect(resolveLineLimitPx(4, 420, null)).toBe(420);
    expect(resolveLineLimitPx(4, 420, 0)).toBe(420);
    expect(resolveLineLimitPx(4, 420, Number.NaN)).toBe(420);
  });

  it('answers with the pixel value when the profile named no multiple', () => {
    expect(resolveLineLimitPx(undefined, 420, 100)).toBe(420);
    expect(resolveLineLimitPx(0, 420, 100)).toBe(420);
    expect(resolveLineLimitPx(-4, 420, 100)).toBe(420);
  });

  it('multiplies the pitch when both are usable', () => {
    expect(resolveLineLimitPx(4, 420, 100)).toBe(400);
    expect(resolveLineLimitPx(0.02, 1.5, 100)).toBeCloseTo(2, 10);
  });

  it('clamps a pitch outside the band a real rig can produce', () => {
    // A font that never loaded, or a measurement pass against an empty
    // document, must not license a bound nobody tuned.
    expect(resolveLineLimitPx(4, 420, 1)).toBe(420 * LINE_LIMIT_MIN_SCALE);
    expect(resolveLineLimitPx(4, 420, 100_000)).toBe(420 * LINE_LIMIT_MAX_SCALE);
  });
});

describe('limitsForState without a pitch is exactly what it always was', () => {
  it('resolves the profile pixel bounds across every state and transition', () => {
    for (const state of STATES) {
      for (const transition of TRANSITIONS) {
        for (const degraded of [false, true]) {
          const limits = limitsForState(state, PROFILE, { transition, degraded });
          expect(limits.reverseTravelMaxPx).toBe(PROFILE.motion.reverseTravelMaxPx);
          expect(limits.reanchorThresholdPx).toBe(PROFILE.motion.reanchorThresholdPx);
          expect(limits.restDeadbandPx).toBe(
            PROFILE.motion.restDeadbandPx * (degraded ? 2 : 1),
          );
        }
      }
    }
  });

  it('ignores a pitch when the profile carries no lineUnits', () => {
    const legacy = withoutLineUnits();
    const limits = limitsForState('following', legacy, { linePitchPx: 220 });
    expect(limits.reverseTravelMaxPx).toBe(legacy.motion.reverseTravelMaxPx);
    expect(limits.reanchorThresholdPx).toBe(legacy.motion.reanchorThresholdPx);
    expect(limits.restDeadbandPx).toBe(legacy.motion.restDeadbandPx);
  });
});

describe('limitsForState with a measured pitch', () => {
  it('reproduces the pixel bounds at the pitch they were tuned at', () => {
    /*
     * The load-bearing property of the whole change, and the one a tidier set of
     * line multiples silently breaks: measuring the pitch the appendix numbers
     * came from must not RETUNE them. A rig that lands on 84.48 px has to move
     * exactly as every rig moves today, or `lineUnits` is a retune of three
     * bounds disguised as a unit conversion — invisible on an uncalibrated stage
     * and unannounced on a calibrated one.
     */
    const limits = limitsForState('following', PROFILE, { linePitchPx: REFERENCE_PITCH_PX });
    const published = PROFILE.motion;
    const pairs: Array<[number, number]> = [
      [limits.reverseTravelMaxPx, published.reverseTravelMaxPx],
      [limits.reanchorThresholdPx, published.reanchorThresholdPx],
      [limits.restDeadbandPx, published.restDeadbandPx],
    ];
    for (const [resolved, expected] of pairs) {
      expect(Math.abs(resolved - expected) / expected).toBeLessThan(0.015);
    }
  });

  it('scales the travel bounds with the type, not with the panel', () => {
    const small = limitsForState('following', PROFILE, { linePitchPx: 60 });
    const large = limitsForState('following', PROFILE, { linePitchPx: 200 });
    expect(large.reverseTravelMaxPx / small.reverseTravelMaxPx).toBeCloseTo(200 / 60, 6);
    expect(large.reanchorThresholdPx / small.reanchorThresholdPx).toBeCloseTo(200 / 60, 6);
    // The bound the presenter experiences is the same either way, in lines.
    const lines = PROFILE.lineUnits!.reverseTravelMaxLines;
    expect(small.reverseTravelMaxPx / 60).toBeCloseTo(lines, 6);
    expect(large.reverseTravelMaxPx / 200).toBeCloseTo(lines, 6);
  });

  it('keeps the re-anchor threshold inside the reverse-travel cap at every pitch', () => {
    // The escape hatch has to be reachable before the travel budget is spent,
    // or a large regression exhausts its reverse against a target it was never
    // going to reach.
    for (const pitch of [20, 45, 84.5, 120, 200, 260, 600]) {
      const limits = limitsForState('following', PROFILE, { linePitchPx: pitch });
      expect(limits.reanchorThresholdPx).toBeLessThan(limits.reverseTravelMaxPx);
    }
  });

  it('still lets §61 degradation double the resting deadband', () => {
    const normal = limitsForState('following', PROFILE, { linePitchPx: 120 });
    const degraded = limitsForState('following', PROFILE, {
      linePitchPx: 120,
      degraded: true,
    });
    expect(degraded.restDeadbandPx).toBeCloseTo(normal.restDeadbandPx * 2, 10);
  });

  it('clamps an implausible pitch instead of following it', () => {
    const broken = limitsForState('following', PROFILE, { linePitchPx: 4000 });
    expect(broken.reverseTravelMaxPx).toBe(
      PROFILE.motion.reverseTravelMaxPx * LINE_LIMIT_MAX_SCALE,
    );
    const collapsed = limitsForState('following', PROFILE, { linePitchPx: 2 });
    expect(collapsed.reverseTravelMaxPx).toBe(
      PROFILE.motion.reverseTravelMaxPx * LINE_LIMIT_MIN_SCALE,
    );
  });

  it('leaves the plant dynamics alone — a pitch is not a retune', () => {
    const plain = limitsForState('following', PROFILE, { transition: 'catch_up' });
    const pitched = limitsForState('following', PROFILE, {
      transition: 'catch_up',
      linePitchPx: 200,
    });
    expect(pitched.vForwardMax).toBe(plain.vForwardMax);
    expect(pitched.vBackwardMax).toBe(plain.vBackwardMax);
    expect(pitched.aMax).toBe(plain.aMax);
    expect(pitched.jerkMax).toBe(plain.jerkMax);
    expect(pitched.omega).toBe(plain.omega);
    expect(pitched.zeta).toBe(plain.zeta);
  });
});

describe('provisionalMaxCorrectionPx (§16.4)', () => {
  it('falls back to the pixel cap with no pitch measured', () => {
    expect(provisionalMaxCorrectionPx()).toBe(PROVISIONAL_MAX_CORRECTION_PX);
    expect(provisionalMaxCorrectionPx(null)).toBe(PROVISIONAL_MAX_CORRECTION_PX);
    expect(provisionalMaxCorrectionPx(0)).toBe(PROVISIONAL_MAX_CORRECTION_PX);
  });

  it('is two rendered lines wherever the pitch is plausible', () => {
    expect(provisionalMaxCorrectionPx(85)).toBeCloseTo(170, 6);
    expect(provisionalMaxCorrectionPx(200)).toBeCloseTo(400, 6);
  });

  it('cannot be dragged anywhere extreme by a nonsense pitch', () => {
    expect(provisionalMaxCorrectionPx(5000)).toBe(
      PROVISIONAL_MAX_CORRECTION_PX * LINE_LIMIT_MAX_SCALE,
    );
    expect(provisionalMaxCorrectionPx(1)).toBe(
      PROVISIONAL_MAX_CORRECTION_PX * LINE_LIMIT_MIN_SCALE,
    );
  });
});

describe('classifyTransition with a measured pitch (§32.3)', () => {
  const relocation = { decision: 'jumpForwardAccepted', reducedMotion: false } as const;

  it('is unchanged when no pitch is supplied', () => {
    expect(
      classifyTransition({ ...relocation, distancePx: 1900, viewportHeightPx: 1000 }),
    ).toBe('smooth_jump');
    expect(
      classifyTransition({ ...relocation, distancePx: 2100, viewportHeightPx: 1000 }),
    ).toBe('fade_jump');
  });

  it('lets large type on a small panel travel a jump the viewport rule would fade', () => {
    // 600 px of glass at a 150 px pitch: two viewport heights is barely eight
    // lines, so the viewport rule fades corrections the presenter would read as
    // ordinary catching-up.
    const opts = { ...relocation, distancePx: 2000, viewportHeightPx: 600 };
    expect(classifyTransition(opts)).toBe('fade_jump');
    expect(classifyTransition({ ...opts, linePitchPx: 150 })).toBe('smooth_jump');
  });

  it('fades a jump that is many lines even when it is a small share of a tall panel', () => {
    const opts = { ...relocation, distancePx: 2000, viewportHeightPx: 1600 };
    expect(classifyTransition(opts)).toBe('smooth_jump');
    expect(classifyTransition({ ...opts, linePitchPx: 40 })).toBe('fade_jump');
  });

  it('leaves ordinary following and reduced motion alone', () => {
    expect(
      classifyTransition({
        decision: 'localConfirmed',
        distancePx: 5000,
        viewportHeightPx: 600,
        reducedMotion: false,
        linePitchPx: 150,
      }),
    ).toBe('spring');
    expect(
      classifyTransition({ ...relocation, distancePx: 5000, viewportHeightPx: 600, linePitchPx: 150, reducedMotion: true }),
    ).toBe('instant');
  });
});
