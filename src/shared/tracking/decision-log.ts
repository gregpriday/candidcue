/**
 * "Why did it move?" records (companion §65).
 *
 * For every nontrivial movement transition the engine stores one compact,
 * text-free explanation object. This is the artifact that makes false jumps
 * and false retakes tunable instead of anecdotal, and §57.3 requires that it
 * carry no script or transcript text — only ids, distances, scores, and
 * decisions.
 *
 * The buffer is bounded (`profile.decisionLogCapacity`) so a long session
 * cannot grow the worker's heap.
 */
import type { TrackingBehavior, TrackingStateV2 } from '../contracts/smooth-follow';
import type { SectionEligibility, TransitionAuthority } from './section-graph';

/** Companion §65. */
export interface MovementDecisionRecord {
  revision: number;
  sessionTimeMs: number;
  fromUnit: number;
  toUnit: number;
  behavior: TrackingBehavior;
  stateBefore: TrackingStateV2;
  stateAfter: TrackingStateV2;
  localConfidence: number;
  secondBestMargin: number;
  sectionGate: 'allowed' | 'blocked';
  authority: TransitionAuthority;
  visualDisposition: 'absorbed' | 'catch_up' | 'rewind' | 'reanchor' | 'hold';

  /* Local additions — still text-free, and useful for triage. */
  /** Short machine reason from the decision layer, e.g. `commit_advance`. */
  reason: string;
  fromTokenIndex: number;
  toTokenIndex: number;
  fromSectionId: string;
  toSectionId: string;
  /** Winning hypothesis id and lineage (§11). */
  hypothesisId?: string;
  lineageId?: string;
  /** Prior applied to the winning candidate (§16.1–§16.4). */
  continuityPrior: number;
  /** Number of candidates the section gate rejected this update (§13.1). */
  blockedCandidateCount: number;
  /** The best rejected candidate, when there was one. */
  blockedReason?: SectionEligibility;
  beamSize: number;
  positionVariance: number;
  finalEvidence: boolean;
  /** Directive id issued alongside this decision, when any (§53). */
  transitionId?: string;
}

export class MovementDecisionLog {
  private readonly capacity: number;
  private records: MovementDecisionRecord[] = [];

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  push(record: MovementDecisionRecord): MovementDecisionRecord {
    this.records.push(record);
    if (this.records.length > this.capacity) {
      this.records.splice(0, this.records.length - this.capacity);
    }
    return record;
  }

  /** Newest last. */
  all(): readonly MovementDecisionRecord[] {
    return this.records;
  }

  latest(): MovementDecisionRecord | undefined {
    return this.records[this.records.length - 1];
  }

  /** Records matching a behavior — the shape the metrics harness consumes. */
  withBehavior(behavior: TrackingBehavior): MovementDecisionRecord[] {
    return this.records.filter((record) => record.behavior === behavior);
  }

  clear(): void {
    this.records = [];
  }
}
