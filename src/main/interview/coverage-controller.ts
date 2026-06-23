import type { CoverageStatus } from '@shared/domain';
import type { SessionCoverageItem, CoverageDelta } from '@shared/domain';

/** A single coverage update proposed by the model (or an operator). */
export interface CoverageUpdate {
  coverageItemId: string;
  status: CoverageStatus;
  evidenceTurnIds: string[];
}

/** Options controlling how updates are validated and applied. */
export interface ApplyCoverageOptions {
  /** Turn ids that actually exist; evidence is filtered against this set. */
  validTurnIds: string[];
  /** When true, the change originates from a human operator and bypasses
   *  the model-only safety guards (no backward / skipped transitions). */
  operator?: boolean;
}

/** An update that was discarded, with a machine-readable reason. */
export interface RejectedCoverageUpdate {
  coverageItemId: string;
  reason: string;
}

export interface ApplyCoverageResult {
  coverage: SessionCoverageItem[];
  deltas: CoverageDelta[];
  rejected: RejectedCoverageUpdate[];
}

/**
 * Linear ordering of the progress statuses (spec §16.13). `skipped` is a
 * terminal side-state and is intentionally absent here — it has no rank along
 * the progress axis and is handled by dedicated guards below.
 */
const STATUS_RANK: Record<Exclude<CoverageStatus, 'skipped'>, number> = {
  not_started: 0,
  partial: 1,
  covered: 2,
};

/** True when `next` represents less progress than `current` along the axis. */
function isBackward(current: CoverageStatus, next: CoverageStatus): boolean {
  if (current === 'skipped' || next === 'skipped') return false;
  return STATUS_RANK[next] < STATUS_RANK[current];
}

/** Merge `incoming` into `existing` preserving order, dropping duplicates. */
function mergeEvidence(existing: string[], incoming: string[]): string[] {
  const seen = new Set(existing);
  const merged = [...existing];
  for (const id of incoming) {
    if (!seen.has(id)) {
      seen.add(id);
      merged.push(id);
    }
  }
  return merged;
}

/**
 * Apply model- (or operator-) proposed COVERAGE updates to the live session
 * coverage state (spec §16.13).
 *
 * Rules:
 *  - An update for an unknown coverage item is rejected.
 *  - Status may not move BACKWARD from `covered` (to `partial`/`not_started`)
 *    unless `opts.operator === true`.
 *  - An item currently `skipped` may not be set to `covered`/`partial` by the
 *    model; an operator may override.
 *  - `evidenceTurnIds` are filtered to `opts.validTurnIds`, then merged
 *    (de-duplicated) into the item — even when the status itself is unchanged.
 *  - A {@link CoverageDelta} is produced for every item whose status actually
 *    changed.
 *
 * The input array is never mutated; a new coverage array is returned.
 */
export function applyCoverageUpdates(
  current: SessionCoverageItem[],
  updates: CoverageUpdate[],
  opts: ApplyCoverageOptions,
): ApplyCoverageResult {
  const operator = opts.operator === true;
  const validTurnIds = new Set(opts.validTurnIds);

  // Index items by id so repeated updates against the same item compound.
  const byId = new Map<string, SessionCoverageItem>();
  for (const item of current) byId.set(item.id, item);

  const deltas: CoverageDelta[] = [];
  const rejected: RejectedCoverageUpdate[] = [];

  for (const update of updates) {
    const item = byId.get(update.coverageItemId);
    if (!item) {
      rejected.push({ coverageItemId: update.coverageItemId, reason: 'unknown_coverage_item' });
      continue;
    }

    const from = item.status;
    const to = update.status;

    // Guard: model cannot regress a covered item or revive a skipped one.
    if (!operator) {
      if (isBackward(from, to)) {
        rejected.push({ coverageItemId: update.coverageItemId, reason: 'backward_status' });
        continue;
      }
      if (from === 'skipped' && (to === 'covered' || to === 'partial')) {
        rejected.push({ coverageItemId: update.coverageItemId, reason: 'skipped_terminal' });
        continue;
      }
    }

    // Evidence is always mergeable, independent of whether the status moved.
    const filteredEvidence = update.evidenceTurnIds.filter((id) => validTurnIds.has(id));
    const mergedEvidence = mergeEvidence(item.evidenceTurnIds, filteredEvidence);

    const statusChanged = to !== from;
    if (statusChanged) {
      deltas.push({
        coverageItemId: item.id,
        fromStatus: from,
        toStatus: to,
        evidenceTurnIds: filteredEvidence,
      });
    }

    byId.set(item.id, {
      ...item,
      status: to,
      evidenceTurnIds: mergedEvidence,
    });
  }

  // Preserve original ordering of the coverage list.
  const coverage = current.map((item) => byId.get(item.id) ?? item);
  return { coverage, deltas, rejected };
}

/**
 * Increment `followUpCount` for a single coverage item, returning a new
 * coverage array. Items other than the target are returned unchanged; an
 * unknown id is a no-op.
 */
export function incrementFollowUp(
  current: SessionCoverageItem[],
  coverageItemId: string,
): SessionCoverageItem[] {
  return current.map((item) =>
    item.id === coverageItemId ? { ...item, followUpCount: item.followUpCount + 1 } : item,
  );
}
