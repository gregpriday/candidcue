/**
 * Semantic motion frames and stage transition directives
 * (companion §26.1, §53, A.3).
 *
 * The worker owns semantic progress; the stage owns pixels. This module is the
 * seam: it packages the filter/beam state into `SemanticMotionFrame`s at
 * 15–30 Hz while values change (and a slow heartbeat while held), and it mints
 * the bounded, authorized discontinuities the stage is allowed to apply.
 *
 * Directive rules enforced here (§53):
 *   - at most one directive is active at a time;
 *   - directives are idempotent by `id`, so re-sending one never re-runs the
 *     motion (the same id rides every frame until it expires);
 *   - every directive is epoch-stamped, so a directive from a superseded
 *     epoch is discarded by the stage rather than replayed.
 */
import type {
  SemanticMotionFrame,
  SmoothFollowProfile,
  StageTransitionDirective,
  TrackingBehavior,
  TrackingStateV2,
} from '../contracts/smooth-follow';
import type { CorrectionClass } from './alignment-v2';
import type { TrackingProfile } from './profile';

export type DirectiveType = StageTransitionDirective['type'];

export interface DirectiveRequest {
  type: Exclude<DirectiveType, 'none'>;
  authority: StageTransitionDirective['authority'];
  reason: StageTransitionDirective['reason'];
  fromUnit: number;
  toUnit: number;
  destinationTokenIndex: number;
  destinationLineHint?: string;
  issuedAtMs: number;
  semanticEpoch: number;
}

/**
 * Companion §53. One active directive; re-issuing an equivalent request while
 * one is live returns the existing directive unchanged (idempotency), so the
 * stage sees a stable `id` for the whole transition.
 */
export class TransitionDirectiveManager {
  private readonly profile: TrackingProfile;
  private current: StageTransitionDirective | undefined;
  private sequence = 0;

  constructor(profile: TrackingProfile) {
    this.profile = profile;
  }

  /** The directive that should ride on frames right now, if any. */
  active(nowMs: number): StageTransitionDirective | undefined {
    if (this.current === undefined) return undefined;
    if (nowMs >= this.current.expiresAtMs) {
      this.current = undefined;
      return undefined;
    }
    return this.current;
  }

  activeType(nowMs: number): DirectiveType {
    return this.active(nowMs)?.type ?? 'none';
  }

  /**
   * Issue (or re-affirm) a directive. Authoritative requests — command,
   * manual, reset — always supersede an in-flight ordinary directive; an
   * ordinary request is dropped while another directive is still live.
   */
  issue(request: DirectiveRequest): StageTransitionDirective | undefined {
    const live = this.active(request.issuedAtMs);
    // A session reset and a layout rebuild both invalidate the geometry any
    // in-flight directive was computed against (§62), so they supersede it
    // even though they carry ordinary authority.
    const authoritative =
      request.authority !== 'ordinary' ||
      request.type === 'reset' ||
      request.reason === 'layout_recovery';
    if (live !== undefined) {
      if (!authoritative) {
        // Same destination and type → idempotent no-op, keep the same id.
        if (live.type === request.type && live.destinationTokenIndex === request.destinationTokenIndex) {
          return live;
        }
        return undefined;
      }
    }
    const directive: StageTransitionDirective = {
      id: `td-${request.semanticEpoch}-${this.sequence++}`,
      type: request.type,
      authority: request.authority,
      fromUnit: request.fromUnit,
      toUnit: request.toUnit,
      destinationTokenIndex: request.destinationTokenIndex,
      ...(request.destinationLineHint !== undefined
        ? { destinationLineHint: request.destinationLineHint }
        : {}),
      issuedAtMs: request.issuedAtMs,
      expiresAtMs: request.issuedAtMs + this.profile.transitionTtlMs,
      semanticEpoch: request.semanticEpoch,
      reason: request.reason,
    };
    this.current = directive;
    return directive;
  }

  clear(): void {
    this.current = undefined;
  }
}

/**
 * Companion §25.1 + A.3: which visual disposition does a correction class
 * imply? The stage refines this with real line geometry; the worker only needs
 * the semantic classification to pick a directive.
 */
export function directiveTypeFor(correction: CorrectionClass): DirectiveType {
  switch (correction) {
    case 'catch_up':
      return 'catch_up';
    case 'reanchor':
    case 'backward_distant':
      return 'reanchor';
    case 'backward_near':
      return 'rewind';
    default:
      return 'none';
  }
}

export interface FrameInput {
  sessionId: string;
  sessionGeneration: number;
  scriptCompileHash: string;
  layoutGeneration: number;
  epoch: number;
  sessionTimeMs: number;
  estimatedUnit: number;
  committedUnit: number;
  velocityUnitsPerSecond: number;
  accelerationUnitsPerSecond2: number;
  positionVariance: number;
  confidence: number;
  sectionId: string;
  tokenIndex: number;
  sentenceId: string;
  blockId: string;
  state: TrackingStateV2;
  behavior: TrackingBehavior;
  finalEvidence: boolean;
  transition?: StageTransitionDirective;
  motionProfileId: string;
}

/**
 * Builds frames and owns the §26.1 emission policy. All numeric thresholds
 * come from the profile; the emitter itself holds no constants.
 */
export class SemanticFrameEmitter {
  private readonly profile: TrackingProfile;
  private revision = 0;
  private lastEmittedAtMs = Number.NEGATIVE_INFINITY;
  private last: SemanticMotionFrame | undefined;

  constructor(profile: TrackingProfile, _smooth: SmoothFollowProfile) {
    this.profile = profile;
  }

  get lastFrame(): SemanticMotionFrame | undefined {
    return this.last;
  }

  /**
   * Should a frame be emitted now?
   *
   *   - `force` (a decision, a transition, a state/behavior change) always
   *     emits, subject only to the 30 Hz ceiling being *ignored* so no
   *     authorized discontinuity is ever dropped;
   *   - a changing trajectory emits at up to `maxFramesPerSecond`;
   *   - a held trajectory emits a heartbeat every `heldFrameIntervalMs`.
   */
  shouldEmit(input: FrameInput, force: boolean): boolean {
    if (force) return true;
    const previous = this.last;
    if (previous === undefined) return true;
    const sinceMs = input.sessionTimeMs - this.lastEmittedAtMs;
    if (sinceMs < 1000 / Math.max(1, this.profile.maxFramesPerSecond)) return false;

    const changed =
      Math.abs(input.estimatedUnit - previous.estimatedUnit) >= this.profile.frameUnitEpsilon ||
      Math.abs(input.velocityUnitsPerSecond - previous.velocityUnitsPerSecond) >=
        this.profile.frameVelocityEpsilon ||
      input.state !== previous.state ||
      input.behavior !== previous.behavior ||
      input.transition !== undefined;
    if (changed) return true;
    return sinceMs >= this.profile.heldFrameIntervalMs;
  }

  /**
   * Produce the next frame. `revision` is strictly monotonic across the whole
   * session so the stage can discard stale frames by comparison alone (§26.1).
   *
   * *Every* numeric field is sanitized to a finite value — including the
   * identity/generation fields and the transition payload, which an earlier
   * version passed through raw. That mattered: a NaN `layoutGeneration`
   * silently disables the stage's stale-frame discard logic (every comparison
   * against NaN is false), and a NaN in the transition's `fromUnit`/`toUnit`
   * poisons the motion controller's integrator permanently.
   */
  emit(input: FrameInput): SemanticMotionFrame {
    this.revision++;
    this.lastEmittedAtMs = input.sessionTimeMs;
    const frame: SemanticMotionFrame = {
      sessionId: input.sessionId,
      sessionGeneration: integer(input.sessionGeneration, 0),
      scriptCompileHash: input.scriptCompileHash,
      layoutGeneration: integer(input.layoutGeneration, 0),
      revision: this.revision,
      epoch: integer(input.epoch, 0),
      sessionTimeMs: finite(input.sessionTimeMs, 0),

      estimatedUnit: finite(input.estimatedUnit, 0),
      committedUnit: finite(input.committedUnit, 0),
      velocityUnitsPerSecond: finite(input.velocityUnitsPerSecond, 0),
      accelerationUnitsPerSecond2: finite(input.accelerationUnitsPerSecond2, 0),
      positionVariance: Math.max(0, finite(input.positionVariance, 0)),
      confidence: clamp01(finite(input.confidence, 0)),

      sectionId: input.sectionId,
      tokenIndex: Math.max(0, Math.floor(finite(input.tokenIndex, 0))),
      sentenceId: input.sentenceId,
      blockId: input.blockId,
      state: input.state,
      behavior: input.behavior,
      finalEvidence: input.finalEvidence,

      ...(input.transition !== undefined
        ? { transition: sanitizeDirective(input.transition) }
        : {}),
      motionProfileId: input.motionProfileId,
    };
    this.last = frame;
    return frame;
  }

  reset(): void {
    // The revision counter deliberately survives a reset: the stage's
    // stale-frame test is "revision must increase", and restarting the count
    // would make post-reset frames look older than pre-reset ones.
    this.lastEmittedAtMs = Number.NEGATIVE_INFINITY;
    this.last = undefined;
  }
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function integer(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.floor(value) : fallback;
}

/** §53: a directive rides every frame, so its numbers need the same care. */
function sanitizeDirective(directive: StageTransitionDirective): StageTransitionDirective {
  return {
    ...directive,
    fromUnit: finite(directive.fromUnit, 0),
    toUnit: finite(directive.toUnit, 0),
    destinationTokenIndex: Math.max(0, integer(directive.destinationTokenIndex, 0)),
    issuedAtMs: finite(directive.issuedAtMs, 0),
    expiresAtMs: finite(directive.expiresAtMs, 0),
    semanticEpoch: integer(directive.semanticEpoch, 0),
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
