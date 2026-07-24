/**
 * Candidate intake — the shared answer to "is this evidence real, current, and
 * still believed" that §23.1 and §26.5 both depend on.
 *
 * Each test asserts a positive and a negative on the same registry, so a
 * method that always returned `true`, `false`, or an empty array fails.
 */
import { describe, expect, it } from 'vitest';
import { CoachCandidateRegistry } from '../../../../src/shared/coaching/coach';
import { EPOCH, TAKE, candidate } from './fixtures';

describe('admission', () => {
  it('accepts current evidence and refuses a duplicate id', () => {
    const registry = new CoachCandidateRegistry();
    expect(registry.admit(candidate(), EPOCH, TAKE, 1_000)).toEqual({ ok: true });
    const again = registry.admit(candidate(), EPOCH, TAKE, 1_100);
    expect(again).toEqual({ ok: false, reason: 'duplicate_evidence_id' });
    expect(registry.size).toBe(1);
  });

  it('refuses evidence stamped with another epoch or take pass', () => {
    const registry = new CoachCandidateRegistry();
    const wrongEpoch = candidate({
      evidenceId: 'a',
      stamp: { ...candidate().stamp, trackingEpoch: EPOCH + 1 },
    });
    const wrongTake = candidate({
      evidenceId: 'b',
      stamp: { ...candidate().stamp, takePassId: 'take-9' },
    });
    expect(registry.admit(wrongEpoch, EPOCH, TAKE, 0)).toEqual({ ok: false, reason: 'stale_stamp' });
    expect(registry.admit(wrongTake, EPOCH, TAKE, 0)).toEqual({ ok: false, reason: 'stale_stamp' });
    // The same candidate with a matching stamp is accepted.
    expect(registry.admit(candidate({ evidenceId: 'c' }), EPOCH, TAKE, 0).ok).toBe(true);
  });

  it('§19.4: refuses a candidate on a span with coaching switched off', () => {
    const registry = new CoachCandidateRegistry();
    const off = new Set(['span-3']);
    expect(registry.admit(candidate(), EPOCH, TAKE, 0, { coachingDisabledSpanIds: off })).toEqual({
      ok: false,
      reason: 'coaching_disabled_span',
    });
    expect(
      registry.admit(candidate({ evidenceId: 'other', scriptSpanId: 'span-4' }), EPOCH, TAKE, 0, {
        coachingDisabledSpanIds: off,
      }).ok,
    ).toBe(true);
  });
});

describe('invalidation (§26.5 / §23.1)', () => {
  it('marks evidence as revised away and reports it exactly once', () => {
    const registry = new CoachCandidateRegistry();
    registry.admit(candidate(), EPOCH, TAKE, 0);
    expect(registry.invalidate('ev-1', 'revised_away')).toBe(true);
    // Idempotent: a second call changes nothing.
    expect(registry.invalidate('ev-1', 'self_corrected')).toBe(false);
    expect(registry.invalidationReason('ev-1')).toBe('revised_away');
    expect(registry.invalidate('ev-unknown', 'revised_away')).toBe(false);
  });

  it('exposes the invalidated set §23.1 consumes, and excludes the live ones', () => {
    const registry = new CoachCandidateRegistry();
    registry.admit(candidate({ evidenceId: 'live' }), EPOCH, TAKE, 0);
    registry.admit(candidate({ evidenceId: 'dead' }), EPOCH, TAKE, 0);
    registry.invalidate('dead', 'demoted_to_probable');

    const invalid = registry.invalidatedIds();
    expect(invalid.has('dead')).toBe(true);
    expect(invalid.has('live')).toBe(false);

    const active = registry.active(EPOCH, TAKE).map((entry) => entry.evidenceId);
    expect(active).toEqual(['live']);
  });

  it('drops from `active` when the epoch moves on, without deleting history', () => {
    const registry = new CoachCandidateRegistry();
    registry.admit(candidate(), EPOCH, TAKE, 0);
    expect(registry.active(EPOCH, TAKE)).toHaveLength(1);
    expect(registry.active(EPOCH + 1, TAKE)).toHaveLength(0);
    expect(registry.has('ev-1')).toBe(true);
  });

  it('orders active candidates oldest first', () => {
    const registry = new CoachCandidateRegistry();
    registry.admit(
      candidate({ evidenceId: 'late', stamp: { ...candidate().stamp, audioEndMs: 9_000 } }),
      EPOCH,
      TAKE,
      0,
    );
    registry.admit(
      candidate({ evidenceId: 'early', stamp: { ...candidate().stamp, audioEndMs: 2_000 } }),
      EPOCH,
      TAKE,
      0,
    );
    expect(registry.active(EPOCH, TAKE).map((entry) => entry.evidenceId)).toEqual(['early', 'late']);
  });
});

describe('bounded memory', () => {
  it('prunes entries past the retention window and keeps the rest', () => {
    const registry = new CoachCandidateRegistry({ retentionMs: 10_000 });
    registry.admit(candidate({ evidenceId: 'old' }), EPOCH, TAKE, 0);
    registry.admit(candidate({ evidenceId: 'new' }), EPOCH, TAKE, 9_000);
    // Exactly at the retention window it is still kept…
    expect(registry.prune(10_000)).toBe(0);
    // …and one millisecond past it, it goes.
    expect(registry.prune(10_001)).toBe(1);
    expect(registry.has('old')).toBe(false);
    expect(registry.has('new')).toBe(true);
  });

  it('reset clears everything for the next take pass', () => {
    const registry = new CoachCandidateRegistry();
    registry.admit(candidate(), EPOCH, TAKE, 0);
    registry.invalidate('ev-1', 'superseded');
    registry.reset();
    expect(registry.size).toBe(0);
    expect(registry.invalidatedIds().size).toBe(0);
    // The same id may be admitted again in the new pass.
    expect(registry.admit(candidate(), EPOCH, TAKE, 0).ok).toBe(true);
  });
});
