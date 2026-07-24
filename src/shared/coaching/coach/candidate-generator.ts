/**
 * §22/§26.5. Candidate intake for the coach policy.
 *
 * The *analyzers* generate candidates (`pace/`, `prosody/`, `disfluency/`,
 * `fidelity/`); this module is the take-scoped registry they feed. It exists
 * because three separate §23.1/§26.5 rules need one shared answer to "is this
 * evidence id real, current, and still believed":
 *
 * - §23.1 "any evidence ID is unknown or stale";
 * - §23.1 "a local deterministic rule has already invalidated the event";
 * - §26.5 "its evidence is revised away".
 *
 * Implementing that three times is how the same check ends up meaning three
 * different things — which is exactly what happened to the epoch check the
 * contract's `isEvidenceCurrent` was extracted to fix.
 */
import type { CoachCandidate } from '../../contracts/coaching';
import { isEvidenceCurrent } from '../../contracts/coaching';

/** Why a candidate stopped being believed. All of these are local decisions. */
export type InvalidationReason =
  | 'revised_away'
  | 'self_corrected'
  | 'demoted_to_probable'
  | 'superseded'
  | 'span_rewritten';

export type AdmissionRejection = 'duplicate_evidence_id' | 'stale_stamp' | 'coaching_disabled_span';

export type AdmissionResult = { ok: true } | { ok: false; reason: AdmissionRejection };

interface Entry {
  candidate: CoachCandidate;
  admittedAtMs: number;
  invalidatedBy: InvalidationReason | null;
}

export interface CandidateRegistryConfig {
  /** Evidence older than this is dropped from the registry, ms. */
  retentionMs?: number;
}

const DEFAULT_RETENTION_MS = 60_000;

/**
 * One registry per take pass. `reset()` on a new pass: evidence never crosses
 * a take boundary, and keeping it would let a previous performance's filler
 * cluster suppress a fresh one through the §26.3 repetition rules.
 */
export class CoachCandidateRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly retentionMs: number;

  constructor(config: CandidateRegistryConfig = {}) {
    this.retentionMs = config.retentionMs ?? DEFAULT_RETENTION_MS;
  }

  reset(): void {
    this.entries.clear();
  }

  /**
   * Take a candidate from an analyzer. A candidate whose stamp does not match
   * the current epoch and take pass is refused at the door rather than stored
   * and filtered later.
   */
  admit(
    candidate: CoachCandidate,
    currentTrackingEpoch: number,
    currentTakePassId: string,
    nowAudioMs: number,
    options: { coachingDisabledSpanIds?: ReadonlySet<string> } = {},
  ): AdmissionResult {
    if (this.entries.has(candidate.evidenceId)) {
      return { ok: false, reason: 'duplicate_evidence_id' };
    }
    if (!isEvidenceCurrent(candidate.stamp, currentTrackingEpoch, currentTakePassId)) {
      return { ok: false, reason: 'stale_stamp' };
    }
    // §19.4 `<!-- cc:coach off -->`: an authored span may opt out entirely.
    if (
      candidate.scriptSpanId !== null &&
      options.coachingDisabledSpanIds?.has(candidate.scriptSpanId) === true
    ) {
      return { ok: false, reason: 'coaching_disabled_span' };
    }
    this.entries.set(candidate.evidenceId, {
      candidate,
      admittedAtMs: nowAudioMs,
      invalidatedBy: null,
    });
    return { ok: true };
  }

  /** §26.5 / §23.1. Mark evidence as no longer believed. Idempotent. */
  invalidate(evidenceId: string, reason: InvalidationReason): boolean {
    const entry = this.entries.get(evidenceId);
    if (entry === undefined) return false;
    if (entry.invalidatedBy !== null) return false;
    entry.invalidatedBy = reason;
    return true;
  }

  /**
   * §26.5. Invalidate every candidate that aggregated a now-revised underlying
   * event, and return their evidence ids.
   *
   * This is the missing half of the invalidation channel. The disfluency lane
   * demotes by `FillerEvent.eventId` (`fil_…`) while a tip is built on a
   * `CoachCandidate.evidenceId` (`cand_…`), and there was no mapping between
   * them — so `invalidate`, `invalidatedIds()` and
   * `CoachTipPolicy.cancel('evidence_revised')` had no producer-side caller at
   * all and §26.5 was unimplementable. The count would correct downward while
   * the tip built on that very demoted "um" stayed on the presenter's glass.
   *
   * The returned ids are exactly what to pass to
   * `CoachTipPolicy.cancel('evidence_revised', { evidenceId })`.
   */
  invalidateByContributingEvent(eventId: string, reason: InvalidationReason): string[] {
    const affected: string[] = [];
    for (const [id, entry] of this.entries) {
      if (entry.invalidatedBy !== null) continue;
      if (!entry.candidate.contributingEventIds.includes(eventId)) continue;
      entry.invalidatedBy = reason;
      affected.push(id);
    }
    return affected;
  }

  has(evidenceId: string): boolean {
    return this.entries.has(evidenceId);
  }

  invalidationReason(evidenceId: string): InvalidationReason | null {
    return this.entries.get(evidenceId)?.invalidatedBy ?? null;
  }

  /** The set §23.1's "locally invalidated" rule consumes. */
  invalidatedIds(): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const [id, entry] of this.entries) {
      if (entry.invalidatedBy !== null) ids.add(id);
    }
    return ids;
  }

  /** Live candidates, newest last. Invalidated and stale entries are excluded. */
  active(currentTrackingEpoch: number, currentTakePassId: string): CoachCandidate[] {
    const result: CoachCandidate[] = [];
    for (const entry of this.entries.values()) {
      if (entry.invalidatedBy !== null) continue;
      if (!isEvidenceCurrent(entry.candidate.stamp, currentTrackingEpoch, currentTakePassId)) {
        continue;
      }
      result.push(entry.candidate);
    }
    result.sort((a, b) => a.stamp.audioEndMs - b.stamp.audioEndMs);
    return result;
  }

  /** Drop entries older than the retention window. Bounded memory (§33). */
  prune(nowAudioMs: number): number {
    let dropped = 0;
    for (const [id, entry] of this.entries) {
      if (nowAudioMs - entry.admittedAtMs > this.retentionMs) {
        this.entries.delete(id);
        dropped += 1;
      }
    }
    return dropped;
  }

  get size(): number {
    return this.entries.size;
  }
}
