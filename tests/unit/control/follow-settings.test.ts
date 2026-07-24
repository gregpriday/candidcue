import { describe, expect, it } from 'vitest';
import { DEFAULT_SMOOTH_FOLLOW_PROFILE } from '../../../src/shared/contracts';
import {
  MOTION_PROFILE_FAMILIES,
  applyFeel,
  applyVoiceLead,
  clampFollowing,
  coachingEnabled,
  defaultFollowingSettings,
  motionProfileFamily,
  resolveFollowProfile,
  toggleCoachingDisplay,
  type FollowingSettings,
} from '../../../src/control/lib/follow-profiles';
import {
  followingFromRust,
  followingToRustPatch,
} from '../../../src/control/services/settings-following';
import { defaultAppSettings } from '../../../src/control/services/settings-types';

describe('follow settings defaults (§47, Appendix A)', () => {
  it('takes every default from the specification, including the profile id', () => {
    const defaults = defaultFollowingSettings();
    expect(defaults.feel).toBe('balanced');
    expect(defaults.voiceLead).toBe('balanced');
    expect(defaults.intelligenceMode).toBe('balanced'); // §35.2
    expect(defaults.fidelityMode).toBe('balanced'); // §45.2
    expect(defaults.coachingDisplay).toBe('control'); // §47.6 conservative
    expect(defaults.motionProfileId).toBe(DEFAULT_SMOOTH_FOLLOW_PROFILE.id);
    expect(defaults.semanticRequestLimit).toBeNull(); // no invented cap (§42.1)
    expect(defaults.developerDiagnostics).toBe(false); // primary §15.2
  });

  it('is part of the application settings document', () => {
    expect(defaultAppSettings().following).toEqual(defaultFollowingSettings());
  });
});

describe('profile resolution (§47.1, §47.3, §55)', () => {
  it('resolves the balanced defaults to exactly the Appendix A profile', () => {
    expect(resolveFollowProfile(defaultFollowingSettings())).toEqual(
      DEFAULT_SMOOTH_FOLLOW_PROFILE,
    );
  });

  it('never weakens the alignment gates for any feel (§47.1)', () => {
    for (const feel of ['calm', 'balanced', 'responsive'] as const) {
      const profile = applyFeel(DEFAULT_SMOOTH_FOLLOW_PROFILE, feel);
      expect(profile.alignment).toEqual(DEFAULT_SMOOTH_FOLLOW_PROFILE.alignment);
      expect(profile.coaching).toEqual(DEFAULT_SMOOTH_FOLLOW_PROFILE.coaching);
      expect(profile.version).toBe(DEFAULT_SMOOTH_FOLLOW_PROFILE.version);
    }
  });

  it('makes Calm slower to correct and Responsive quicker', () => {
    const base = DEFAULT_SMOOTH_FOLLOW_PROFILE;
    const calm = applyFeel(base, 'calm');
    const responsive = applyFeel(base, 'responsive');

    expect(calm.motion.naturalFrequency).toBeLessThan(base.motion.naturalFrequency);
    expect(calm.motion.catchUpMultiplier).toBeLessThan(base.motion.catchUpMultiplier);
    expect(calm.motion.restDeadbandPx).toBeGreaterThan(base.motion.restDeadbandPx);
    expect(calm.prediction.uncertainHorizonMs).toBeGreaterThan(base.prediction.uncertainHorizonMs);

    expect(responsive.motion.naturalFrequency).toBeGreaterThan(base.motion.naturalFrequency);
    expect(responsive.motion.catchUpMultiplier).toBeGreaterThan(base.motion.catchUpMultiplier);
    expect(responsive.prediction.uncertainHorizonMs).toBeLessThan(
      base.prediction.uncertainHorizonMs,
    );
  });

  it('keeps the maximum forward and backward velocities from the base profile', () => {
    for (const feel of ['calm', 'responsive'] as const) {
      const profile = applyFeel(DEFAULT_SMOOTH_FOLLOW_PROFILE, feel);
      expect(profile.motion.maxForwardVelocityPxS).toBe(
        DEFAULT_SMOOTH_FOLLOW_PROFILE.motion.maxForwardVelocityPxS,
      );
      expect(profile.motion.maxBackwardVelocityPxS).toBe(
        DEFAULT_SMOOTH_FOLLOW_PROFILE.motion.maxBackwardVelocityPxS,
      );
    }
  });

  it('clamps voice lead inside the profile’s published envelope (§47.3)', () => {
    const base = DEFAULT_SMOOTH_FOLLOW_PROFILE;
    for (const lead of ['less', 'balanced', 'more'] as const) {
      const profile = applyVoiceLead(base, lead);
      expect(profile.prediction.leadSecondsMin).toBeGreaterThanOrEqual(
        base.prediction.leadSecondsMin,
      );
      expect(profile.prediction.leadSecondsMax).toBeLessThanOrEqual(base.prediction.leadSecondsMax);
      expect(profile.prediction.leadSecondsMin).toBeLessThanOrEqual(
        profile.prediction.leadSecondsMax,
      );
    }
    expect(applyVoiceLead(base, 'more').prediction.leadSecondsMin).toBeGreaterThan(
      applyVoiceLead(base, 'less').prediction.leadSecondsMin,
    );
  });

  it('tags the resolved profile so eval snapshots stay comparable', () => {
    const profile = resolveFollowProfile({
      ...defaultFollowingSettings(),
      feel: 'calm',
      voiceLead: 'more',
    });
    expect(profile.id).toBe(`${DEFAULT_SMOOTH_FOLLOW_PROFILE.id}/calm/lead-more`);
  });

  it('falls back to the shipped family for an unknown motion profile id', () => {
    expect(motionProfileFamily('does-not-exist').id).toBe(MOTION_PROFILE_FAMILIES[0]!.id);
    expect(
      resolveFollowProfile({ ...defaultFollowingSettings(), motionProfileId: 'nope' }),
    ).toEqual(DEFAULT_SMOOTH_FOLLOW_PROFILE);
  });
});

describe('validation and coaching helpers', () => {
  it('clamps unknown or malformed values back to the defaults', () => {
    const clamped = clampFollowing({
      feel: 'turbo',
      voiceLead: 'more',
      intelligenceMode: 'psychic',
      semanticRequestLimit: 0,
      developerDiagnostics: 'yes',
    } as unknown as Partial<FollowingSettings>);
    expect(clamped.feel).toBe('balanced');
    expect(clamped.voiceLead).toBe('more');
    expect(clamped.intelligenceMode).toBe('balanced');
    expect(clamped.semanticRequestLimit).toBeNull();
    expect(clamped.developerDiagnostics).toBe(false);
  });

  it('keeps a usable request limit and floors fractional ones', () => {
    expect(clampFollowing({ semanticRequestLimit: 12.7 }).semanticRequestLimit).toBe(12);
    expect(clampFollowing({ semanticRequestLimit: -4 }).semanticRequestLimit).toBeNull();
  });

  it('treats any visible tip surface as coaching on', () => {
    expect(coachingEnabled('off')).toBe(false);
    expect(coachingEnabled('control')).toBe(true);
    expect(coachingEnabled('stage_and_control')).toBe(true);
  });

  it('preserves the stage preference when coaching is toggled off and on', () => {
    expect(toggleCoachingDisplay('stage_and_control', false)).toBe('off');
    expect(toggleCoachingDisplay('stage_and_control', true)).toBe('stage_and_control');
    expect(toggleCoachingDisplay('off', true)).toBe('control');
  });
});

describe('Rust round-trip (§47 settings persistence)', () => {
  it('reads a missing section as the defaults', () => {
    expect(followingFromRust(undefined)).toEqual(defaultFollowingSettings());
    expect(followingFromRust({})).toEqual(defaultFollowingSettings());
  });

  it('round-trips a full document unchanged', () => {
    const value: FollowingSettings = {
      feel: 'calm',
      voiceLead: 'more',
      intelligenceMode: 'enhanced',
      fidelityMode: 'exact',
      coachingDisplay: 'stage_and_control',
      motionProfileId: DEFAULT_SMOOTH_FOLLOW_PROFILE.id,
      semanticRequestLimit: 40,
      developerDiagnostics: true,
    };
    const patch = followingToRustPatch(value);
    expect(followingFromRust(patch as never)).toEqual(value);
  });

  it('emits only the keys that were actually changed', () => {
    expect(followingToRustPatch({ intelligenceMode: 'local_only' })).toEqual({
      intelligenceMode: 'local_only',
    });
    expect(followingToRustPatch({})).toEqual({});
    expect(followingToRustPatch(undefined)).toEqual({});
  });

  it('clamps a hostile value before it reaches the backend', () => {
    expect(
      followingToRustPatch({ feel: 'ludicrous' as unknown as FollowingSettings['feel'] }),
    ).toEqual({ feel: 'balanced' });
  });

  it('repairs an unknown persisted value instead of failing the session', () => {
    const repaired = followingFromRust({
      feel: 'calm',
      coachingDisplay: 'everywhere',
      semanticRequestLimit: null,
    });
    expect(repaired.feel).toBe('calm');
    expect(repaired.coachingDisplay).toBe('control');
  });
});
