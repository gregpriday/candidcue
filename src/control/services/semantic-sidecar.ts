/**
 * Session-owned semantic sidecar (H6, spec §33.7–§33.12, companion §36).
 *
 * One scheduler per take. It owns the Luna invoker, is fed revisioned
 * candidate context, is cancelled with the take lifecycle, and forwards only
 * validated + fused evidence — the scheduler's own validation/fusion/clamp
 * layers do that work and are deliberately left untouched.
 *
 * WHAT THIS DOES NOT DO YET, and why: `AssistSchedulingContext.candidates`
 * must be `LocalCandidate[]` produced by the alignment engine. The tracking
 * worker does not emit candidates today (`TrackingWorkerOutbound` has no such
 * message), so nothing can build a context. That emission is a change to
 * `src/shared/tracking/**` + `worker-protocol.ts`, which this pass does not
 * own. Until a candidate source is attached via `attachContextSource`, the
 * sidecar deliberately stays inert rather than inventing assist activity — an
 * un-instrumented build shows no semantic activity, which is honest.
 */
import {
  SemanticAssistScheduler,
  createSemanticInvoker,
  type AssistSchedulingContext,
  type SemanticAvailability,
} from '../../shared/semantic';
import type { SmoothFollowProfile } from '../../shared/contracts/smooth-follow';
import type { SemanticAssistEvidence } from '../../shared/tracking/semantic-assist';
import type { IntelligenceMode } from '../../shared/contracts';
import { ipcInvoke } from './ipc';

export interface SemanticSidecarDeps {
  sessionId: string;
  sessionGeneration: number;
  profile: SmoothFollowProfile;
  mode?: IntelligenceMode;
  /**
   * Post fused, validated assist evidence to the tracking worker's existing
   * `semantic_assist` input. This is the single integration point.
   */
  postAssistEvidence(evidence: SemanticAssistEvidence): void;
  onAvailabilityChange?(availability: SemanticAvailability): void;
  onCoachTipCandidate?(candidate: unknown): void;
  now?: () => number;
}

/** A revisioned candidate feed. Returns an unsubscribe. */
export type ContextSource = (
  emit: (context: AssistSchedulingContext) => void,
) => () => void;

export class SemanticSidecar {
  readonly scheduler: SemanticAssistScheduler;
  private detachSource: (() => void) | null = null;
  private disposed = false;
  /**
   * Monotonic take generation. Context emitted by a source that belongs to a
   * finished take is dropped rather than scheduled — the scheduler's own
   * cancellation covers requests already in flight, this covers the input.
   */
  private takeGeneration = 0;

  constructor(private readonly deps: SemanticSidecarDeps) {
    this.scheduler = new SemanticAssistScheduler({
      invoker: createSemanticInvoker(ipcInvoke),
      now: deps.now ?? (() => Date.now()),
      profile: deps.profile,
      sessionId: deps.sessionId,
      sessionGeneration: deps.sessionGeneration,
      ...(deps.mode ? { mode: deps.mode } : {}),
      // Only fused + validated evidence reaches the worker; the scheduler
      // performs the validation and clamping and must not be bypassed.
      onTrackingAssist: (evidence) => {
        if (this.disposed) return;
        deps.postAssistEvidence(evidence);
      },
      ...(deps.onAvailabilityChange
        ? { onAvailabilityChange: (value: SemanticAvailability) => deps.onAvailabilityChange?.(value) }
        : {}),
      ...(deps.onCoachTipCandidate
        ? { onTipCandidate: (candidate: unknown) => deps.onCoachTipCandidate?.(candidate) }
        : {}),
    });
  }

  /** Attach the candidate feed. Replaces any previous source. */
  attachContextSource(source: ContextSource): void {
    if (this.disposed) return;
    this.detachSource?.();
    const generation = this.takeGeneration;
    this.detachSource = source((context) => {
      if (this.disposed || generation !== this.takeGeneration) return;
      this.scheduler.observe(context);
    });
  }

  /** §36.5: retake, epoch change or section reset invalidates everything. */
  cancelInFlight(): void {
    this.takeGeneration += 1;
    this.scheduler.cancelAll();
  }

  setMode(mode: IntelligenceMode): void {
    this.scheduler.setMode(mode);
  }

  /** End of take: detach the feed and cancel everything outstanding. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.takeGeneration += 1;
    this.detachSource?.();
    this.detachSource = null;
    this.scheduler.cancelAll();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }
}
