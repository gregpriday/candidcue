/**
 * Continuous semantic position estimator (companion §5, §24, §25, App. B.3).
 *
 * A constant-acceleration Kalman-style filter in *spoken-unit* space (§6), not
 * token indexes. It turns the aligner's sparse, noisy, occasionally-wrong
 * measurements into the continuous trajectory the stage follows between
 * transcript events — which is what makes following look paced rather than
 * event-driven (§1.2, §3.1).
 *
 *   x = [positionUnits, velocityUnitsPerSecond, accelerationUnitsPerSecond²]ᵀ
 *
 * Everything the spec insists on is here and testable: prediction between
 * measurements, confidence/finality-derived measurement noise, bounded
 * innovation, asymmetric forward/backward handling, authority resets, an
 * explicit covariance, the ad-lib coast→decelerate→hold schedule (§19.2), and
 * the hard coast-distance budget (§24.6, A.1) that stops a stale pace estimate
 * from running away.
 *
 * Pure and deterministic: every time value is an argument.
 */
import type { SmoothFollowProfile } from '../contracts/smooth-follow';
import type { TrackingStateV2 } from '../contracts/smooth-follow';
import type { TrackingProfile } from './profile';

/** Companion §24.1. */
export interface SemanticMotionEstimate {
  positionUnits: number;
  velocityUnitsPerSecond: number;
  accelerationUnitsPerSecond2: number;
  positionVariance: number;
  velocityVariance: number;
  lastMeasurementAtMs: number;
  lastStrongMeasurementAtMs: number;
  state: TrackingStateV2;
  epoch: number;
}

export interface FilterObservation {
  /** Measured position in spoken units. */
  positionUnits: number;
  /** Aligner confidence in [0, 1]. */
  confidence: number;
  /** Margin over the best materially different candidate. */
  margin: number;
  /** Beam position variance in units². */
  beamVariance: number;
  finalEvidence: boolean;
  /** True when the observation came only from a semantic (Luna) relation. */
  semanticOnly?: boolean;
  atMs: number;
}

/** Optional direct velocity observation (§24.2.1 `H_v = [0 1 0]`). */
export interface VelocityObservation {
  unitsPerSecond: number;
  weight: number;
  atMs: number;
}

const IDENTITY_STATES: ReadonlySet<TrackingStateV2> = new Set<TrackingStateV2>([
  'paused',
  'reconnecting',
  'command_pending',
]);

export class SemanticFilter {
  private readonly profile: TrackingProfile;
  private readonly smooth: SmoothFollowProfile;

  /** State vector. */
  private position = 0;
  private velocity = 0;
  private acceleration = 0;
  /** Diagonal-plus-correlation covariance, stored as a dense 3×3. */
  private covariance: number[] = [];

  private state: TrackingStateV2 = 'acquiring';
  private epoch = 0;
  private lastMeasurementAtMs = 0;
  private lastStrongMeasurementAtMs = 0;
  /** Position at the last accepted measurement — the coast budget anchor. */
  private anchorUnits = 0;
  private nowMs = 0;
  /** Upper bound the prediction may never cross (prohibited section edge). */
  private ceilingUnits = Number.POSITIVE_INFINITY;
  private floorUnits = Number.NEGATIVE_INFINITY;

  constructor(profile: TrackingProfile, smooth: SmoothFollowProfile) {
    this.profile = profile;
    this.smooth = smooth;
    this.covariance = diag(profile.filterInitialVariance, 1, 0.5);
  }

  get currentEpoch(): number {
    return this.epoch;
  }

  get committedAnchorUnits(): number {
    return this.anchorUnits;
  }

  setState(state: TrackingStateV2): void {
    this.state = state;
  }

  /**
   * Constrain the prediction so it can never drift across a prohibited
   * boundary (§24.2.1 "the predicted position cannot cross a prohibited
   * section boundary"). The engine supplies the current section's unit span.
   */
  setSectionBounds(floorUnits: number, ceilingUnits: number): void {
    this.floorUnits = Number.isFinite(floorUnits) ? floorUnits : Number.NEGATIVE_INFINITY;
    this.ceilingUnits = Number.isFinite(ceilingUnits) ? ceilingUnits : Number.POSITIVE_INFINITY;
  }

  /**
   * Hard reset around an authoritative destination (§24.2 "state reset on
   * command/manual navigation", §56.1).
   */
  resetTo(positionUnits: number, atMs: number, epoch: number, state: TrackingStateV2): void {
    this.position = finite(positionUnits, 0);
    this.velocity = 0;
    this.acceleration = 0;
    this.covariance = diag(this.profile.filterMeasurementNoiseFinal, 0.5, 0.25);
    this.epoch = epoch;
    this.state = state;
    this.lastMeasurementAtMs = atMs;
    this.lastStrongMeasurementAtMs = atMs;
    this.anchorUnits = this.position;
    this.nowMs = atMs;
  }

  /**
   * Predict the trajectory forward to `atMs` without consuming evidence.
   * Idempotent for a given time: repeated calls with the same `atMs` return
   * the same estimate and do not integrate twice.
   */
  predict(atMs: number): SemanticMotionEstimate {
    const dt = Math.max(0, (atMs - this.nowMs) / 1000);
    if (dt > 0) {
      this.integrate(dt, atMs);
      this.nowMs = atMs;
    }
    return this.estimate();
  }

  /**
   * Consume one aligner measurement (Appendix B.3 `observeMeasurement`).
   * The caller has already run the section gate and the retake/skip
   * authorization; this method only performs the statistical update.
   */
  observe(observation: FilterObservation): void {
    this.predict(observation.atMs);
    const variance = this.measurementVariance(observation);
    const clamp = this.innovationClamp();
    const rawInnovation = finite(observation.positionUnits, this.position) - this.position;
    const innovation = Math.max(-clamp, Math.min(clamp, rawInnovation));

    // Standard scalar Kalman update with H = [1 0 0].
    const p00 = this.covariance[0] ?? 0;
    const p10 = this.covariance[3] ?? 0;
    const p20 = this.covariance[6] ?? 0;
    const s = p00 + variance;
    if (!(s > 0)) return;
    const k0 = p00 / s;
    const k1 = p10 / s;
    const k2 = p20 / s;

    this.position += k0 * innovation;
    this.velocity += k1 * innovation;
    this.acceleration += k2 * innovation;

    // P = (I - K H) P
    const next: number[] = new Array(9).fill(0);
    const k = [k0, k1, k2];
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        const p = this.covariance[row * 3 + col] ?? 0;
        const correction = (k[row] ?? 0) * (this.covariance[col] ?? 0);
        next[row * 3 + col] = p - correction;
      }
    }
    this.covariance = symmetrize(next);

    this.lastMeasurementAtMs = observation.atMs;
    if (observation.finalEvidence && observation.confidence >= this.profile.lockedThreshold) {
      this.lastStrongMeasurementAtMs = observation.atMs;
    }
    this.anchorUnits = this.position;
    this.applyConstraints();
  }

  /** Optional velocity measurement (§24.2.1 `H_v`). */
  observeVelocity(observation: VelocityObservation): void {
    this.predict(observation.atMs);
    const weight = Math.max(0, Math.min(1, observation.weight));
    if (weight === 0) return;
    const target = finite(observation.unitsPerSecond, this.velocity);
    this.velocity = this.velocity * (1 - weight) + target * weight;
    this.applyConstraints();
  }

  estimate(): SemanticMotionEstimate {
    return {
      positionUnits: this.position,
      velocityUnitsPerSecond: this.velocity,
      accelerationUnitsPerSecond2: this.acceleration,
      positionVariance: this.covariance[0] ?? 0,
      velocityVariance: this.covariance[4] ?? 0,
      lastMeasurementAtMs: this.lastMeasurementAtMs,
      lastStrongMeasurementAtMs: this.lastStrongMeasurementAtMs,
      state: this.state,
      epoch: this.epoch,
    };
  }

  /**
   * Companion §24.7. Bounded look-ahead used only to compute a display
   * position; never fed back into the state.
   */
  leadUnits(confidence: number): number {
    const { leadSecondsMin, leadSecondsMax } = this.smooth.prediction;
    const clampedConfidence = Math.max(0, Math.min(1, confidence));
    const seconds = leadSecondsMin + (leadSecondsMax - leadSecondsMin) * clampedConfidence;
    const lead = Math.max(0, this.velocity) * seconds;
    return Math.min(lead, this.smooth.prediction.maxCoastUnits * this.profile.unitsPerRenderedLine);
  }

  /* ----------------------------------------------------------------------- */

  /**
   * Constant-acceleration prediction plus the state-dependent decay schedule.
   * Companion §19.2 (ad-lib), §24.6 (prediction horizon), §3.5 (uncertainty).
   */
  private integrate(dt: number, atMs: number): void {
    const profile = this.profile;
    const sinceEvidenceMs = atMs - this.lastMeasurementAtMs;
    const horizonMs =
      this.state === 'following' || this.state === 'catching_up'
        ? this.smooth.prediction.normalHorizonMs
        : this.smooth.prediction.uncertainHorizonMs;

    if (IDENTITY_STATES.has(this.state)) {
      // §17.11: preserve motion state so the stage can stop and resume
      // cleanly; do not integrate while paused/reconnecting/command-pending.
      return;
    }

    // Velocity schedule. Inside the horizon the estimate coasts at pace; past
    // it, velocity decays through the ad-lib schedule to zero.
    if (sinceEvidenceMs > horizonMs) {
      const elapsed = sinceEvidenceMs - horizonMs;
      let target: number;
      if (elapsed <= profile.adlibCoastMs) {
        target = this.velocity;
      } else if (elapsed <= profile.adlibCoastMs + profile.adlibDecayMs) {
        target = this.velocity * profile.adlibResidualVelocityFraction;
      } else if (elapsed <= profile.adlibSettleMs) {
        target =
          this.velocity *
          profile.adlibResidualVelocityFraction *
          Math.max(
            0,
            1 - (elapsed - profile.adlibCoastMs - profile.adlibDecayMs) /
              Math.max(1, profile.adlibSettleMs - profile.adlibCoastMs - profile.adlibDecayMs),
          );
      } else {
        target = 0;
      }
      // Move toward the schedule target proportionally to dt so the result is
      // frame-rate independent.
      const blend = Math.min(1, dt * profile.filterVelocityScheduleGain);
      this.velocity = this.velocity * (1 - blend) + target * blend;
      this.acceleration = 0;
    }

    this.position += this.velocity * dt + 0.5 * this.acceleration * dt * dt;
    this.velocity += this.acceleration * dt;

    // P = F P Fᵀ + Q
    const q = this.processNoise() * dt;
    this.covariance = addProcessNoise(propagate(this.covariance, dt), q);
    this.applyConstraints();
  }

  /** Companion §24.2.1 state-dependent `Q`. */
  private processNoise(): number {
    switch (this.state) {
      case 'acquiring':
      case 'reanchoring':
      case 'catching_up':
        return this.profile.filterProcessNoiseAcquiring;
      case 'uncertain':
      case 'adlib_hold':
      case 'retake_pending':
      case 'lost_local':
        return this.profile.filterProcessNoiseUncertain;
      default:
        return this.profile.filterProcessNoiseFollowing;
    }
  }

  /** Companion §24.2.1 `R`, and §60 low-transcript-confidence widening. */
  private measurementVariance(observation: FilterObservation): number {
    const profile = this.profile;
    const base = observation.finalEvidence
      ? profile.filterMeasurementNoiseFinal
      : profile.filterMeasurementNoiseProvisional;
    const confidence = Math.max(0.05, Math.min(1, observation.confidence));
    const margin = Math.max(0, Math.min(1, observation.margin));
    const beam = Math.max(0, observation.beamVariance);
    const semanticPenalty =
      observation.semanticOnly === true ? profile.filterSemanticOnlyVarianceFactor : 1;
    return (
      base * (1 / confidence) * (1 + (1 - margin)) * semanticPenalty +
      beam * profile.filterBeamVarianceFactor
    );
  }

  /** Companion B.3 `innovationClampFor(behavior)`. */
  private innovationClamp(): number {
    const base = this.profile.filterInnovationClampUnits;
    switch (this.state) {
      case 'reanchoring':
      case 'rewinding':
        // The transition already authorized the discontinuity.
        return Number.POSITIVE_INFINITY;
      case 'catching_up':
        return base * this.smooth.motion.catchUpMultiplier;
      case 'uncertain':
      case 'adlib_hold':
      case 'retake_pending':
        return base * this.profile.filterUncertainInnovationFactor;
      default:
        return base;
    }
  }

  /** Companion §24.2.1 post-update state constraints. */
  private applyConstraints(): void {
    const profile = this.profile;
    if (!Number.isFinite(this.position)) this.position = this.anchorUnits;
    if (!Number.isFinite(this.velocity)) this.velocity = 0;
    if (!Number.isFinite(this.acceleration)) this.acceleration = 0;

    // Negative semantic velocity is allowed only for a committed rewind.
    if (this.state !== 'rewinding' && this.velocity < 0) this.velocity = 0;
    if (this.state === 'retake_pending' && this.velocity > 0) {
      // May approach zero but must not reverse before commitment (§17.7).
      this.velocity = Math.max(0, this.velocity);
    }

    this.velocity = clamp(
      this.velocity,
      -profile.filterMaxVelocityUnitsPerSecond,
      profile.filterMaxVelocityUnitsPerSecond,
    );
    this.acceleration = clamp(
      this.acceleration,
      -profile.filterMaxAccelerationUnitsPerSecond2,
      profile.filterMaxAccelerationUnitsPerSecond2,
    );

    // §24.2.1: a stale prediction cannot exceed the coast budget. This is the
    // bounded-drift guarantee for ad-libs (§19.2 step 4, §85).
    const coastBudget =
      this.smooth.prediction.maxCoastUnits * Math.max(1, profile.unitsPerRenderedLine);
    const maxUnits = this.anchorUnits + coastBudget;
    if (this.position > maxUnits) {
      this.position = maxUnits;
      if (this.velocity > 0) this.velocity = 0;
    }
    if (this.position < this.anchorUnits - coastBudget) {
      this.position = this.anchorUnits - coastBudget;
      if (this.velocity < 0) this.velocity = 0;
    }

    // Prohibited-boundary containment.
    if (this.position > this.ceilingUnits) {
      this.position = this.ceilingUnits;
      if (this.velocity > 0) this.velocity = 0;
    }
    if (this.position < this.floorUnits) {
      this.position = this.floorUnits;
      if (this.velocity < 0) this.velocity = 0;
    }

    for (let i = 0; i < this.covariance.length; i++) {
      const value = this.covariance[i] ?? 0;
      this.covariance[i] = Number.isFinite(value) ? value : 0;
    }
    if ((this.covariance[0] ?? 0) < 0) this.covariance[0] = 0;
  }
}

/* --------------------------------------------------------------------------- */

function diag(a: number, b: number, c: number): number[] {
  return [a, 0, 0, 0, b, 0, 0, 0, c];
}

/** `F P Fᵀ` for the constant-acceleration `F`. */
function propagate(p: number[], dt: number): number[] {
  const f = [1, dt, 0.5 * dt * dt, 0, 1, dt, 0, 0, 1];
  const fp: number[] = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += (f[i * 3 + k] ?? 0) * (p[k * 3 + j] ?? 0);
      fp[i * 3 + j] = sum;
    }
  }
  const out: number[] = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let sum = 0;
      // multiply by Fᵀ: (F P) * Fᵀ  ⇒  sum_k FP[i][k] * F[j][k]
      for (let k = 0; k < 3; k++) sum += (fp[i * 3 + k] ?? 0) * (f[j * 3 + k] ?? 0);
      out[i * 3 + j] = sum;
    }
  }
  return out;
}

function addProcessNoise(p: number[], q: number): number[] {
  const out = [...p];
  out[0] = (out[0] ?? 0) + q;
  out[4] = (out[4] ?? 0) + q * 0.5;
  out[8] = (out[8] ?? 0) + q * 0.25;
  return out;
}

/** Keep the covariance symmetric (§24.2.1 numerical note). */
function symmetrize(p: number[]): number[] {
  const out = [...p];
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) {
      const average = ((out[i * 3 + j] ?? 0) + (out[j * 3 + i] ?? 0)) / 2;
      out[i * 3 + j] = average;
      out[j * 3 + i] = average;
    }
  }
  return out;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}
