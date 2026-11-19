/**
 * Follow settings semantics and the mapping from the
 * understandable user controls onto a versioned `SmoothFollowProfile`.
 *
 * Design rules this module enforces:
 *
 *  - Every number is derived from `DEFAULT_SMOOTH_FOLLOW_PROFILE`. There are
 *    no new absolute tuning constants here — only
 *    documented ratios of the published starting values, so re-tuning the
 *    default profile re-tunes every feel automatically.
 *  - A feel must never weaken section safety or retake evidence gates,
 *    so `alignment` is copied through untouched.
 *  - Voice lead is GONE, control and all: it moved the display ahead of
 *    the reader, which the alignment engine now treats as a defect to be
 *    measured rather than a comfort to be offered. Nothing here may reintroduce
 *    a setting whose effect is "claim the reader is further along than heard".
 */
import {
  DEFAULT_SMOOTH_FOLLOW_PROFILE,
  type SmoothFollowProfile,
} from '../../shared/contracts';

/* ---------------------------------------------------------------------------
 * User-facing setting values
 * ------------------------------------------------------------------------- */

/** Follow feel. */
export type FollowFeel = 'calm' | 'balanced' | 'responsive';

/** The persisted follow settings block. */
export interface FollowingSettings {
  feel: FollowFeel;
  /** Versioned motion-profile family id; see `MOTION_PROFILE_FAMILIES`. */
  motionProfileId: string;
  /** Reveals the diagnostics timeline in Take controls → Why did it move? */
  developerDiagnostics: boolean;
}

export const FOLLOW_FEELS: FollowFeel[] = ['calm', 'balanced', 'responsive'];

/**
 * Defaults. The profile id comes from `DEFAULT_SMOOTH_FOLLOW_PROFILE` itself
 * rather than a literal.
 */
export function defaultFollowingSettings(): FollowingSettings {
  return {
    feel: 'balanced', // the default feel
    motionProfileId: DEFAULT_SMOOTH_FOLLOW_PROFILE.id,
    developerDiagnostics: false, // developer panel off by default
  };
}

/* ---------------------------------------------------------------------------
 * Option copy
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

/*
 * No fidelity-mode options: `resolveFollowProfile` below builds a take's motion
 * from `family` and `feel` alone. The control went in #124 and its
 * `fidelityMode` field in #218, along with `semanticRequestLimit`. A document
 * that still carries either one loads as it always did: `AppSettings` does not
 * deny unknown fields, and the adapter in `settings-following.ts` never reads
 * or sends them. Rust's
 * half went with #219, so the next write takes `fidelityMode` off disk.
 */

/* ---------------------------------------------------------------------------
 * Motion profile families
 * ------------------------------------------------------------------------- */

export interface MotionProfileFamily {
  id: string;
  label: string;
  description: string;
  profile: SmoothFollowProfile;
}

/**
 * Versioned profile families the user may choose between. Only the default
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
 * THE THREE CATCH-UP BOUNDS.
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
 * (stop ≈ v²/2a + v·a/2j. The ~565 px full-authority stop quoted in
 * `shared/contracts/smooth-follow.ts` comes from a different estimate. The v²/2a half is identical at every feel, because the
 * feel scales the multiplier and the acceleration by the same ratio; the jerk
 * half is not, because acceleration is scaled twice over — once by the feel
 * and once by the boost — while jerk is scaled once.)
 *
 *  - `catchUpDecayCorridors` IS scaled, by the feel ratio. The default
 *    profile sizes 14 corridors (~605 px) so the decay LEADS the plant's own
 *    braking rather than being masked by it, and notes the decay is
 *    decoration below about 13.
 *    That threshold is a property of the plant, and the plant just moved: at
 *    responsive, 14 corridors is 605 px against a 579 px stop — inside the
 *    margin the default profile calls decoration. Scaling by the feel ratio
 *    (calm 12, responsive 16) holds decay ÷ stopping distance at
 *    1.21 / 1.21 / 1.19, so every feel gets the same shaped approach into the
 *    corridor.
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
 *    how long an exception may run, and a feel may tighten a bound but
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
 * Feel only touches motion comfort limits.
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
      // The catch-up bounds move with the plant the feel just retuned —
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
  };
}

/** The full settings → profile resolution used by the session and stage handoff. */
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
  return {
    feel: pick(value.feel, FOLLOW_FEELS, defaults.feel),
    motionProfileId: motionProfileFamily(value.motionProfileId ?? defaults.motionProfileId).id,
    developerDiagnostics:
      typeof value.developerDiagnostics === 'boolean'
        ? value.developerDiagnostics
        : defaults.developerDiagnostics,
  };
}

