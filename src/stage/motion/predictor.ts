/**
 * Semantic prediction on the stage (companion §27).
 *
 * A semantic frame is a measurement with a timestamp, not a command. Between
 * frames the stage extrapolates the presenter's progress so text keeps moving —
 * that is the whole difference between "continuously paced" and "event-driven".
 * The extrapolation is bounded three ways: a state-specific horizon, a smooth
 * exponential velocity decay past that horizon (§27.2), and a hard drift budget
 * so a stale frame can never scroll the document indefinitely.
 *
 * Pure: the caller supplies session time.
 */
import type {
  SemanticMotionFrame,
  SmoothFollowProfile,
  TrackingStateV2,
} from '../../shared/contracts';

export interface PredictionPolicy {
  /** Trusted extrapolation window in ms. */
  horizonMs: number;
  /** Multiplier applied to the frame's semantic velocity. */
  velocityScale: number;
  /** Exponential decay rate (1/s) applied past the horizon. */
  decayPerSecond: number;
  /** Maximum |predicted − measured| distance, in spoken units. */
  maxDriftUnits: number;
  /** Whether prediction may move backward from the measurement. */
  allowBackward: boolean;
  /** Which measured unit anchors the prediction. */
  anchor: 'estimated' | 'committed';
}

export interface SemanticPrediction {
  /** Predicted spoken-unit position for this display frame. */
  unit: number;
  /** Predicted semantic velocity, used for feed-forward (§28.2). */
  velocityUnitsPerSecond: number;
  /** Age of the driving frame, in ms. */
  ageMs: number;
  /** Portion of the age inside the trusted horizon. */
  effectiveAgeMs: number;
  /** True once the exponential decay is in effect. */
  decaying: boolean;
  /** True when the drift budget clamped the prediction. */
  driftClamped: boolean;
  state: TrackingStateV2;
  confidence: number;
}

/** Companion §27.1 — one policy per tracking state. */
export function predictionPolicy(
  state: TrackingStateV2,
  profile: SmoothFollowProfile,
): PredictionPolicy {
  const normal = profile.prediction.normalHorizonMs;
  const uncertain = profile.prediction.uncertainHorizonMs;
  const coast = profile.prediction.maxCoastUnits;
  const base: PredictionPolicy = {
    horizonMs: normal,
    velocityScale: 1,
    decayPerSecond: 1.6,
    maxDriftUnits: coast,
    allowBackward: false,
    anchor: 'estimated',
  };

  switch (state) {
    case 'following':
      return base;
    case 'acquiring':
      return { ...base, horizonMs: uncertain, velocityScale: 0.6, maxDriftUnits: coast * 0.5 };
    case 'coasting':
      // Decaying velocity model: keep moving, but spend the budget quickly.
      return { ...base, horizonMs: normal * 0.6, velocityScale: 0.85, decayPerSecond: 2.4 };
    case 'uncertain':
      return {
        ...base,
        horizonMs: uncertain,
        velocityScale: 0.5,
        decayPerSecond: 3.2,
        maxDriftUnits: coast * 0.5,
      };
    case 'adlib_hold':
      // Converge toward the held (committed) unit; speech alone must not
      // consume script (§4.3).
      return {
        ...base,
        horizonMs: 0,
        velocityScale: 0,
        decayPerSecond: 6,
        maxDriftUnits: 0,
        anchor: 'committed',
      };
    case 'catching_up':
      // The correction policy already supplied the semantic target.
      return { ...base, horizonMs: normal, velocityScale: 1, maxDriftUnits: coast * 1.5 };
    case 'retake_pending':
      // Never predict backward before the semantic commit (§30.4).
      return { ...base, horizonMs: uncertain, velocityScale: 0.35, maxDriftUnits: coast * 0.4 };
    case 'rewinding':
      return { ...base, allowBackward: true, horizonMs: uncertain, velocityScale: 0.8 };
    case 'reanchoring':
      return { ...base, allowBackward: true, horizonMs: uncertain, velocityScale: 0.6 };
    case 'command_pending':
      return { ...base, horizonMs: uncertain, velocityScale: 0.6, maxDriftUnits: coast * 0.5 };
    case 'paused':
    case 'reconnecting':
      return { ...base, horizonMs: 0, velocityScale: 0, maxDriftUnits: 0 };
    case 'lost_local':
      return { ...base, horizonMs: 0, velocityScale: 0, decayPerSecond: 4, maxDriftUnits: 0 };
    default:
      return base;
  }
}

/**
 * Extrapolate a frame to `sessionTimeMs`.
 *
 * Inside the horizon this is the constant-acceleration form of §27; past it,
 * velocity decays as `v0 · exp(-λ · excess)` and the extra distance is that
 * decay's integral, so both position and velocity stay continuous at the
 * horizon (§27.2).
 */
export function predictSemanticPosition(
  frame: SemanticMotionFrame,
  sessionTimeMs: number,
  profile: SmoothFollowProfile,
  policy: PredictionPolicy = predictionPolicy(frame.state, profile),
): SemanticPrediction {
  const ageMs = Math.max(0, sessionTimeMs - frame.sessionTimeMs);
  const anchorUnit = policy.anchor === 'committed' ? frame.committedUnit : frame.estimatedUnit;
  const v0 = frame.velocityUnitsPerSecond * policy.velocityScale;
  const a0 = frame.accelerationUnitsPerSecond2 * policy.velocityScale;

  const horizonSec = Math.max(0, policy.horizonMs) / 1000;
  const effectiveSec = Math.min(ageMs / 1000, horizonSec);
  // Inside the trusted horizon this is ordinary continuous following, bounded
  // by the horizon itself.
  const trustedDrift = v0 * effectiveSec + 0.5 * a0 * effectiveSec * effectiveSec;
  let velocity = v0 + a0 * effectiveSec;

  const excessSec = Math.max(0, ageMs / 1000 - horizonSec);
  const decaying = excessSec > 0;
  let coastDrift = 0;
  if (decaying) {
    const lambda = Math.max(1e-3, policy.decayPerSecond);
    const decayed = Math.exp(-lambda * excessSec);
    // ∫₀^excess v·e^(-λs) ds — a finite coast budget by construction.
    coastDrift = (velocity / lambda) * (1 - decayed);
    velocity *= decayed;
  }

  // The coast budget (§A.1: under one rendered line) applies to motion made on
  // *stale* evidence only — clamping the in-horizon prediction as well would
  // make the horizon meaningless at ordinary speaking rates.
  const maxCoast = Math.max(0, policy.maxDriftUnits);
  const clampedCoast = Math.max(
    policy.allowBackward ? -maxCoast : Math.min(0, coastDrift),
    Math.min(maxCoast, coastDrift),
  );
  const coastClamped = clampedCoast !== coastDrift;
  if (coastClamped) velocity = 0;

  let drift = trustedDrift + clampedCoast;
  let driftClamped = coastClamped;
  if (!policy.allowBackward && drift < 0) {
    drift = 0;
    driftClamped = true;
  }
  if (!policy.allowBackward && velocity < 0) velocity = 0;

  return {
    unit: anchorUnit + drift,
    velocityUnitsPerSecond: velocity,
    ageMs,
    effectiveAgeMs: effectiveSec * 1000,
    decaying,
    driftClamped,
    state: frame.state,
    confidence: frame.confidence,
  };
}
