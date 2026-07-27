/**
 * Follow settings semantics (companion §47) and the mapping from the
 * understandable user controls onto a versioned `SmoothFollowProfile` (§55).
 *
 * Design rules this module enforces:
 *
 *  - Every number is derived from `DEFAULT_SMOOTH_FOLLOW_PROFILE` (companion
 *    Appendix A). There are no new absolute tuning constants here — only
 *    documented ratios of the published starting values, so re-tuning the
 *    appendix re-tunes every feel automatically.
 *  - §47.1: a feel must never weaken section safety or retake evidence gates,
 *    so `alignment` is copied through untouched.
 *  - §47.3 voice lead is GONE, control and all: it moved the display ahead of
 *    the reader, which the alignment engine now treats as a defect to be
 *    measured rather than a comfort to be offered. Nothing here may reintroduce
 *    a setting whose effect is "claim the reader is further along than heard".
 */
import {
  DEFAULT_SMOOTH_FOLLOW_PROFILE,
  type SmoothFollowProfile,
} from '../../shared/contracts';

/* ---------------------------------------------------------------------------
 * User-facing setting values (§47)
 * ------------------------------------------------------------------------- */

/** §47.1 follow feel. */
export type FollowFeel = 'calm' | 'balanced' | 'responsive';
/** §45 fidelity modes — these change coaching thresholds, not navigation. */
export type FidelityMode = 'conversational' | 'balanced' | 'exact';
/** §47.6 coaching display. */

/** The persisted §47 settings block. */
export interface FollowingSettings {
  feel: FollowFeel;
  fidelityMode: FidelityMode;
  /** Versioned motion-profile family id (§55); see `MOTION_PROFILE_FAMILIES`. */
  motionProfileId: string;
  /**
   * Optional per-session cap on semantic-assist requests (§42.1). `null` means
   * no cap — CandidCue does not invent a limit on the user's own key.
   */
  semanticRequestLimit: number | null;
  /** §15.2 / §64: reveals the full diagnostics timeline in Live. */
  developerDiagnostics: boolean;
}

export const FOLLOW_FEELS: FollowFeel[] = ['calm', 'balanced', 'responsive'];
export const FIDELITY_MODES: FidelityMode[] = ['conversational', 'balanced', 'exact'];

/**
 * Defaults. Every value comes from the specification's stated default, and the
 * profile id comes from the Appendix A profile itself rather than a literal.
 */
export function defaultFollowingSettings(): FollowingSettings {
  return {
    feel: 'balanced', // §47.1 "Balanced — default"
    fidelityMode: 'balanced', // §45.2 "Balanced — default"
    motionProfileId: DEFAULT_SMOOTH_FOLLOW_PROFILE.id,
    semanticRequestLimit: null,
    developerDiagnostics: false, // primary §15.2: developer panel off by default
  };
}

/* ---------------------------------------------------------------------------
 * Option copy (§42.1 cost visibility, Appendix A.4 scheduling behavior)
 * ------------------------------------------------------------------------- */

export interface FollowOption<T extends string> {
  value: T;
  label: string;
  description: string;
}

export const FOLLOW_FEEL_OPTIONS: Array<FollowOption<FollowFeel>> = [
  {
    value: 'calm',
    label: 'Calm',
    description: 'Slower corrections and a longer settle. Best for measured, scripted delivery.',
  },
  {
    value: 'balanced',
    label: 'Balanced',
    description: 'The default tuning. Corrections are absorbed without feeling sluggish.',
  },
  {
    value: 'responsive',
    label: 'Responsive',
    description: 'Shorter grace before it acts and quicker local corrections. Livelier, slightly busier.',
  },
];

export const FIDELITY_MODE_OPTIONS: Array<FollowOption<FidelityMode>> = [
  {
    value: 'conversational',
    label: 'Conversational',
    description: 'Paraphrasing is expected. Tips only for numbers, negations, names, and large meaning changes.',
  },
  {
    value: 'balanced',
    label: 'Balanced',
    description: 'Normal variation is fine. Tips on likely critical changes and meaningful omissions.',
  },
  {
    value: 'exact',
    label: 'Exact',
    description: 'Stricter wording coverage and more omission tips. Tracking stays just as tolerant.',
  },
];

/* ---------------------------------------------------------------------------
 * Motion profile families (§55)
 * ------------------------------------------------------------------------- */

export interface MotionProfileFamily {
  id: string;
  label: string;
  description: string;
  profile: SmoothFollowProfile;
}

/**
 * Versioned profile families the user may choose between. Only the Appendix A
 * starting profile ships today; more appear as the motion corpus grows, and
 * each keeps its own id so eval snapshots stay comparable.
 */
export const MOTION_PROFILE_FAMILIES: MotionProfileFamily[] = [
  {
    id: DEFAULT_SMOOTH_FOLLOW_PROFILE.id,
    label: 'Standard motion (v1)',
    description:
      'The tuned starting profile. Follow feel adjusts it; section safety and retake evidence are never relaxed.',
    profile: DEFAULT_SMOOTH_FOLLOW_PROFILE,
  },
];

export function motionProfileFamily(id: string): MotionProfileFamily {
  return MOTION_PROFILE_FAMILIES.find((f) => f.id === id) ?? MOTION_PROFILE_FAMILIES[0]!;
}

/* ---------------------------------------------------------------------------
 * Resolution: settings → SmoothFollowProfile
 * ------------------------------------------------------------------------- */

/**
 * Documented ratios of the base profile. `balanced` is the identity.
 *
 * THE THREE §30.3 CATCH-UP BOUNDS.
 *
 * `catchUpMaxDurationMs`, `catchUpReleaseMs` and `catchUpDecayCorridors` are
 * spread through by `applyFeel`, so leaving them out of this table is a
 * decision, not an omission. Two of them must move with the feel and one must
 * not, and the arithmetic says which is which. Every number below is
 * `DEFAULT_SMOOTH_FOLLOW_PROFILE` at 1080p with its default 4% reading band:
 * corridor half-height 43.2 px, base forward velocity 900 px/s.
 *
 * A catch-up runs at `catchUpMultiplier` × the profile's velocity AND
 * acceleration limits (`stateMultipliers` in stage/motion/profiles.ts), and the
 * feel already scales `catchUpMultiplier`, `maxAccelerationPxS2` and
 * `maxJerkPxS3` together. So the boosted plant differs per feel:
 *
 *            multiplier   v_boost   a_boost   jerk     full-authority stop
 *   calm        1.36      1224      3006      10200          430 px
 *   balanced    1.60      1440      4160      12000          499 px
 *   responsive  1.84      1656      5502      13800          579 px
 *
 * (stop ≈ v²/2a + v·a/2j — the same estimate the appendix quotes as ~565 px for
 * balanced. The v²/2a half is identical at every feel, because the feel scales
 * the multiplier and the acceleration by the same ratio; the jerk half is not,
 * because acceleration is scaled twice over — once by the feel and once by the
 * boost — while jerk is scaled once.)
 *
 *  - `catchUpDecayCorridors` IS scaled, by the feel ratio. The appendix sizes
 *    14 corridors (~605 px) so the decay LEADS the plant's own braking rather
 *    than being masked by it, and notes the decay is decoration below about 13.
 *    That threshold is a property of the plant, and the plant just moved: at
 *    responsive, 14 corridors is 605 px against a 579 px stop — inside the
 *    margin the appendix calls decoration. Scaling by the feel ratio (calm 12,
 *    responsive 16) holds decay ÷ stopping distance at 1.21 / 1.21 / 1.19, so
 *    every feel gets the same shaped approach into the corridor.
 *  - `catchUpReleaseMs` IS scaled, by the same ratio and for the same reason.
 *    The release exists so a limit never moves faster than a jerk-limited plant
 *    can follow it, and the time to swing acceleration across its own range is
 *    2·a_boost/jerk: 0.59 s calm, 0.69 s balanced, 0.80 s responsive. Responsive
 *    therefore needs a LONGER ramp-out, not a shorter one, even though every
 *    other responsive number is quicker. This one is physics, not taste.
 *  - `catchUpMaxDurationMs` is shortened at calm and left alone at responsive.
 *    Calm closes 900 × (1.36 − 1) = 324 px/s of extra ground against balanced's
 *    540, so a full 2.5 s at calm buys 810 px of catch-up in exchange for two
 *    and a half seconds of visibly abnormal motion — long AND ineffective,
 *    which is the worst pair for a feel chosen to be unobtrusive. 2 s is the
 *    trade calm would make. Responsive is NOT extended: the cap is a ceiling on
 *    how long an exception may run, and §47.1 lets a feel tighten a bound but
 *    never relax one — the same rule that copies `alignment` through untouched.
 *    Nothing is stranded either way, because the residual gap closes at the base
 *    900 px/s, which no feel changes.
 */
const FEEL_RATIOS: Record<FollowFeel, { motion: Record<string, number> }> = {
  calm: {
    motion: {
      naturalFrequency: 0.8,
      catchUpMultiplier: 0.85,
      maxAccelerationPxS2: 0.85,
      maxJerkPxS3: 0.85,
      restDeadbandPx: 1.5,
      catchUpMaxDurationMs: 0.8, // 2500 → 2000 ms
      catchUpReleaseMs: 0.85, // 250 → 213 ms
      catchUpDecayCorridors: 0.85, // 14 → 12
    },
  },
  balanced: { motion: {} },
  responsive: {
    motion: {
      naturalFrequency: 1.2,
      catchUpMultiplier: 1.15,
      maxAccelerationPxS2: 1.15,
      maxJerkPxS3: 1.15,
      restDeadbandPx: 0.75,
      // No `catchUpMaxDurationMs`: a feel may lower the ceiling, never raise it.
      catchUpReleaseMs: 1.15, // 250 → 288 ms
      catchUpDecayCorridors: 1.15, // 14 → 16
    },
  },
};

function scale(base: number, ratio: number | undefined, decimals = 0): number {
  if (ratio === undefined) return base;
  const value = base * ratio;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * §47.1 — feel only touches motion comfort limits.
 *
 * It used to reshape prediction horizons too. Those are gone: prediction is the
 * alignment engine's, it is benchmarked there, and a per-feel horizon would be
 * a second set of tuning constants nothing measures. What a feel changes now is
 * exactly what it always visibly changed — how the document moves.
 */
export function applyFeel(base: SmoothFollowProfile, feel: FollowFeel): SmoothFollowProfile {
  const ratios = FEEL_RATIOS[feel] ?? FEEL_RATIOS.balanced;
  return {
    ...base,
    id: feel === 'balanced' ? base.id : `${base.id}/${feel}`,
    motion: {
      ...base.motion,
      naturalFrequency: scale(base.motion.naturalFrequency, ratios.motion.naturalFrequency, 2),
      catchUpMultiplier: scale(base.motion.catchUpMultiplier, ratios.motion.catchUpMultiplier, 2),
      maxAccelerationPxS2: scale(base.motion.maxAccelerationPxS2, ratios.motion.maxAccelerationPxS2),
      maxJerkPxS3: scale(base.motion.maxJerkPxS3, ratios.motion.maxJerkPxS3),
      restDeadbandPx: scale(base.motion.restDeadbandPx, ratios.motion.restDeadbandPx, 2),
      // §30.3. The catch-up bounds move with the plant the feel just retuned —
      // see the arithmetic on FEEL_RATIOS for why two of the three are scaled
      // and why the duration cap only ever comes down.
      catchUpMaxDurationMs: scale(
        base.motion.catchUpMaxDurationMs,
        ratios.motion.catchUpMaxDurationMs,
      ),
      catchUpReleaseMs: scale(base.motion.catchUpReleaseMs, ratios.motion.catchUpReleaseMs),
      catchUpDecayCorridors: scale(
        base.motion.catchUpDecayCorridors,
        ratios.motion.catchUpDecayCorridors,
      ),
    },
    coaching: { ...base.coaching },
  };
}

/** The full §47 → §55 resolution used by the session and the stage handoff. */
export function resolveFollowProfile(following: FollowingSettings): SmoothFollowProfile {
  const family = motionProfileFamily(following.motionProfileId);
  return applyFeel(family.profile, following.feel);
}

/* ---------------------------------------------------------------------------
 * Validation
 * ------------------------------------------------------------------------- */

function pick<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return typeof value === 'string' && (allowed as string[]).includes(value) ? (value as T) : fallback;
}

/**
 * Normalize an untrusted (persisted, patched, or hand-edited) value into a
 * valid `FollowingSettings`. Unknown enum values fall back to the default
 * rather than throwing — a bad settings row must never block a session.
 */
export function clampFollowing(value: Partial<FollowingSettings> | undefined | null): FollowingSettings {
  const defaults = defaultFollowingSettings();
  if (!value) return defaults;
  const limit = value.semanticRequestLimit;
  return {
    feel: pick(value.feel, FOLLOW_FEELS, defaults.feel),
    fidelityMode: pick(value.fidelityMode, FIDELITY_MODES, defaults.fidelityMode),
    motionProfileId: motionProfileFamily(value.motionProfileId ?? defaults.motionProfileId).id,
    semanticRequestLimit:
      typeof limit === 'number' && Number.isFinite(limit) && limit >= 1
        ? Math.floor(limit)
        : null,
    developerDiagnostics:
      typeof value.developerDiagnostics === 'boolean'
        ? value.developerDiagnostics
        : defaults.developerDiagnostics,
  };
}

