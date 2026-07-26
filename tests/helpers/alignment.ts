/**
 * Alignment snapshot builder for tests.
 *
 * One place that knows the shape, so a field added to the contract is added
 * once rather than in every stage test — and so a test that cares about, say,
 * the rate can say only that and inherit a coherent everything-else.
 */
import type { AlignmentSnapshot } from '../../src/shared/contracts';

let seq = 0;

/** Reset the sequence counter between tests that assert on `seq`. */
export function resetSnapshotSeq(): void {
  seq = 0;
}

/**
 * A healthy following snapshot, overridable field by field.
 *
 * `seq` auto-increments so consecutive calls are accepted by the receiver's
 * monotonicity gate without every test having to count.
 */
export function snapshot(overrides: Partial<AlignmentSnapshot> = {}): AlignmentSnapshot {
  seq += 1;
  const base: AlignmentSnapshot = {
    sessionGeneration: 1,
    seq,
    state: 'following',
    decision: 'localConfirmed',
    confirmedToken: 0,
    observedToken: 0,
    rateTokensPerSecond: 3,
    evidenceAudioMs: 0,
    atAudioMs: 0,
    maxPredictionMs: 900,
    confidence: 0.92,
    suggestionToken: null,
    scriptLenTokens: 10_000,
    observedAtom: 0,
    confirmedAtom: 0,
  };
  return { ...base, ...overrides };
}
