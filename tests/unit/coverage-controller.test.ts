import {
  applyCoverageUpdates,
  incrementFollowUp,
} from '@main/interview/coverage-controller';
import type { SessionCoverageItem, CoverageStatus } from '@shared/domain';

/** Build a SessionCoverageItem with sensible defaults for tests. */
function makeItem(overrides: Partial<SessionCoverageItem> = {}): SessionCoverageItem {
  return {
    id: 'cov-1',
    label: 'Origin story',
    objective: 'Understand how it began',
    priority: 'must',
    status: 'not_started',
    evidenceTurnIds: [],
    maxFollowUps: 3,
    sourceRefs: [],
    followUpCount: 0,
    ...overrides,
  };
}

function makeUpdate(
  coverageItemId: string,
  status: CoverageStatus,
  evidenceTurnIds: string[] = [],
): { coverageItemId: string; status: CoverageStatus; evidenceTurnIds: string[] } {
  return { coverageItemId, status, evidenceTurnIds };
}

describe('applyCoverageUpdates', () => {
  describe('unknown coverage item', () => {
    it('rejects an update referencing an id that is not in the coverage list', () => {
      const current = [makeItem({ id: 'cov-1' })];
      const result = applyCoverageUpdates(current, [makeUpdate('ghost', 'covered')], {
        validTurnIds: [],
      });

      expect(result.rejected).toEqual([
        { coverageItemId: 'ghost', reason: 'unknown_coverage_item' },
      ]);
      expect(result.deltas).toHaveLength(0);
      // Coverage is unchanged.
      expect(result.coverage).toEqual(current);
    });
  });

  describe('forward transitions', () => {
    it('moves not_started -> partial and emits a delta', () => {
      const current = [makeItem({ status: 'not_started' })];
      const result = applyCoverageUpdates(
        current,
        [makeUpdate('cov-1', 'partial', ['t1'])],
        { validTurnIds: ['t1'] },
      );

      expect(result.rejected).toHaveLength(0);
      expect(result.coverage[0]?.status).toBe('partial');
      expect(result.coverage[0]?.evidenceTurnIds).toEqual(['t1']);
      expect(result.deltas).toEqual([
        {
          coverageItemId: 'cov-1',
          fromStatus: 'not_started',
          toStatus: 'partial',
          evidenceTurnIds: ['t1'],
        },
      ]);
    });

    it('moves partial -> covered and emits a delta', () => {
      const current = [makeItem({ status: 'partial' })];
      const result = applyCoverageUpdates(current, [makeUpdate('cov-1', 'covered')], {
        validTurnIds: [],
      });

      expect(result.coverage[0]?.status).toBe('covered');
      expect(result.deltas[0]?.fromStatus).toBe('partial');
      expect(result.deltas[0]?.toStatus).toBe('covered');
    });

    it('allows a model to skip an item from not_started', () => {
      const current = [makeItem({ status: 'not_started' })];
      const result = applyCoverageUpdates(current, [makeUpdate('cov-1', 'skipped')], {
        validTurnIds: [],
      });

      expect(result.rejected).toHaveLength(0);
      expect(result.coverage[0]?.status).toBe('skipped');
      expect(result.deltas[0]?.toStatus).toBe('skipped');
    });
  });

  describe('backward transitions (model)', () => {
    it('rejects covered -> partial without operator', () => {
      const current = [makeItem({ status: 'covered' })];
      const result = applyCoverageUpdates(current, [makeUpdate('cov-1', 'partial')], {
        validTurnIds: [],
      });

      expect(result.rejected).toEqual([
        { coverageItemId: 'cov-1', reason: 'backward_status' },
      ]);
      expect(result.deltas).toHaveLength(0);
      expect(result.coverage[0]?.status).toBe('covered');
    });

    it('rejects covered -> not_started without operator', () => {
      const current = [makeItem({ status: 'covered' })];
      const result = applyCoverageUpdates(current, [makeUpdate('cov-1', 'not_started')], {
        validTurnIds: [],
      });

      expect(result.rejected[0]?.reason).toBe('backward_status');
      expect(result.coverage[0]?.status).toBe('covered');
    });

    it('rejects partial -> not_started without operator', () => {
      const current = [makeItem({ status: 'partial' })];
      const result = applyCoverageUpdates(current, [makeUpdate('cov-1', 'not_started')], {
        validTurnIds: [],
      });

      expect(result.rejected[0]?.reason).toBe('backward_status');
      expect(result.coverage[0]?.status).toBe('partial');
    });
  });

  describe('backward transitions (operator)', () => {
    it('allows covered -> partial when operator is true', () => {
      const current = [makeItem({ status: 'covered' })];
      const result = applyCoverageUpdates(current, [makeUpdate('cov-1', 'partial')], {
        validTurnIds: [],
        operator: true,
      });

      expect(result.rejected).toHaveLength(0);
      expect(result.coverage[0]?.status).toBe('partial');
      expect(result.deltas).toEqual([
        {
          coverageItemId: 'cov-1',
          fromStatus: 'covered',
          toStatus: 'partial',
          evidenceTurnIds: [],
        },
      ]);
    });

    it('allows covered -> not_started when operator is true', () => {
      const current = [makeItem({ status: 'covered' })];
      const result = applyCoverageUpdates(current, [makeUpdate('cov-1', 'not_started')], {
        validTurnIds: [],
        operator: true,
      });

      expect(result.rejected).toHaveLength(0);
      expect(result.coverage[0]?.status).toBe('not_started');
    });
  });

  describe('skipped is terminal for the model', () => {
    it('rejects skipped -> covered without operator', () => {
      const current = [makeItem({ status: 'skipped' })];
      const result = applyCoverageUpdates(current, [makeUpdate('cov-1', 'covered')], {
        validTurnIds: [],
      });

      expect(result.rejected).toEqual([
        { coverageItemId: 'cov-1', reason: 'skipped_terminal' },
      ]);
      expect(result.coverage[0]?.status).toBe('skipped');
      expect(result.deltas).toHaveLength(0);
    });

    it('rejects skipped -> partial without operator', () => {
      const current = [makeItem({ status: 'skipped' })];
      const result = applyCoverageUpdates(current, [makeUpdate('cov-1', 'partial')], {
        validTurnIds: [],
      });

      expect(result.rejected[0]?.reason).toBe('skipped_terminal');
      expect(result.coverage[0]?.status).toBe('skipped');
    });

    it('allows an operator to revive skipped -> covered', () => {
      const current = [makeItem({ status: 'skipped' })];
      const result = applyCoverageUpdates(current, [makeUpdate('cov-1', 'covered')], {
        validTurnIds: [],
        operator: true,
      });

      expect(result.rejected).toHaveLength(0);
      expect(result.coverage[0]?.status).toBe('covered');
      expect(result.deltas[0]?.toStatus).toBe('covered');
    });

    it('does not treat skipped -> not_started as backward for the model', () => {
      // skipped is off the progress axis, so this is not a "backward" rejection,
      // but it is also not a covered/partial revival, so it is permitted.
      const current = [makeItem({ status: 'skipped' })];
      const result = applyCoverageUpdates(current, [makeUpdate('cov-1', 'not_started')], {
        validTurnIds: [],
      });

      expect(result.rejected).toHaveLength(0);
      expect(result.coverage[0]?.status).toBe('not_started');
    });
  });

  describe('evidence filtering and merging', () => {
    it('filters evidence turn ids to the valid set', () => {
      const current = [makeItem({ status: 'not_started', evidenceTurnIds: [] })];
      const result = applyCoverageUpdates(
        current,
        [makeUpdate('cov-1', 'partial', ['t1', 'bogus', 't2'])],
        { validTurnIds: ['t1', 't2'] },
      );

      expect(result.coverage[0]?.evidenceTurnIds).toEqual(['t1', 't2']);
      expect(result.deltas[0]?.evidenceTurnIds).toEqual(['t1', 't2']);
    });

    it('appends new evidence to existing without duplicating', () => {
      const current = [
        makeItem({ status: 'partial', evidenceTurnIds: ['t1', 't2'] }),
      ];
      const result = applyCoverageUpdates(
        current,
        [makeUpdate('cov-1', 'covered', ['t2', 't3'])],
        { validTurnIds: ['t1', 't2', 't3'] },
      );

      expect(result.coverage[0]?.evidenceTurnIds).toEqual(['t1', 't2', 't3']);
    });

    it('merges evidence even when the status does not change', () => {
      const current = [
        makeItem({ status: 'partial', evidenceTurnIds: ['t1'] }),
      ];
      const result = applyCoverageUpdates(
        current,
        [makeUpdate('cov-1', 'partial', ['t2'])],
        { validTurnIds: ['t1', 't2'] },
      );

      expect(result.coverage[0]?.evidenceTurnIds).toEqual(['t1', 't2']);
      // No status change => no delta.
      expect(result.deltas).toHaveLength(0);
    });

    it('drops all evidence when validTurnIds is empty', () => {
      const current = [makeItem({ status: 'not_started', evidenceTurnIds: [] })];
      const result = applyCoverageUpdates(
        current,
        [makeUpdate('cov-1', 'partial', ['t1', 't2'])],
        { validTurnIds: [] },
      );

      expect(result.coverage[0]?.evidenceTurnIds).toEqual([]);
      expect(result.deltas[0]?.evidenceTurnIds).toEqual([]);
    });
  });

  describe('deltas only for real changes', () => {
    it('produces no delta when status is identical', () => {
      const current = [makeItem({ status: 'covered' })];
      const result = applyCoverageUpdates(current, [makeUpdate('cov-1', 'covered')], {
        validTurnIds: [],
      });

      expect(result.rejected).toHaveLength(0);
      expect(result.deltas).toHaveLength(0);
    });

    it('produces one delta per item whose status changes across a batch', () => {
      const current = [
        makeItem({ id: 'a', status: 'not_started' }),
        makeItem({ id: 'b', status: 'partial' }),
        makeItem({ id: 'c', status: 'covered' }),
      ];
      const result = applyCoverageUpdates(
        current,
        [
          makeUpdate('a', 'partial'), // changes
          makeUpdate('b', 'partial'), // no change
          makeUpdate('c', 'covered'), // no change
        ],
        { validTurnIds: [] },
      );

      expect(result.deltas).toHaveLength(1);
      expect(result.deltas[0]?.coverageItemId).toBe('a');
    });
  });

  describe('batch behavior and immutability', () => {
    it('compounds multiple updates against the same item', () => {
      const current = [makeItem({ id: 'a', status: 'not_started', evidenceTurnIds: [] })];
      const result = applyCoverageUpdates(
        current,
        [
          makeUpdate('a', 'partial', ['t1']),
          makeUpdate('a', 'covered', ['t2']),
        ],
        { validTurnIds: ['t1', 't2'] },
      );

      expect(result.coverage[0]?.status).toBe('covered');
      expect(result.coverage[0]?.evidenceTurnIds).toEqual(['t1', 't2']);
      // Two real status changes => two deltas.
      expect(result.deltas).toHaveLength(2);
      expect(result.deltas[0]?.toStatus).toBe('partial');
      expect(result.deltas[1]?.toStatus).toBe('covered');
    });

    it('does not mutate the input coverage array or its items', () => {
      const item = makeItem({ status: 'not_started', evidenceTurnIds: ['t0'] });
      const current = [item];
      applyCoverageUpdates(current, [makeUpdate('cov-1', 'partial', ['t1'])], {
        validTurnIds: ['t1'],
      });

      expect(item.status).toBe('not_started');
      expect(item.evidenceTurnIds).toEqual(['t0']);
    });

    it('preserves the original ordering of the coverage list', () => {
      const current = [
        makeItem({ id: 'a' }),
        makeItem({ id: 'b' }),
        makeItem({ id: 'c' }),
      ];
      const result = applyCoverageUpdates(current, [makeUpdate('b', 'partial')], {
        validTurnIds: [],
      });

      expect(result.coverage.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    });

    it('returns an empty result shape for no updates', () => {
      const current = [makeItem()];
      const result = applyCoverageUpdates(current, [], { validTurnIds: [] });

      expect(result.deltas).toHaveLength(0);
      expect(result.rejected).toHaveLength(0);
      expect(result.coverage).toEqual(current);
    });
  });
});

describe('incrementFollowUp', () => {
  it('increments followUpCount only for the target item', () => {
    const current = [
      makeItem({ id: 'a', followUpCount: 0 }),
      makeItem({ id: 'b', followUpCount: 2 }),
    ];
    const next = incrementFollowUp(current, 'b');

    expect(next.find((i) => i.id === 'a')?.followUpCount).toBe(0);
    expect(next.find((i) => i.id === 'b')?.followUpCount).toBe(3);
  });

  it('is a no-op for an unknown id', () => {
    const current = [makeItem({ id: 'a', followUpCount: 1 })];
    const next = incrementFollowUp(current, 'missing');

    expect(next[0]?.followUpCount).toBe(1);
  });

  it('does not mutate the input array or items', () => {
    const item = makeItem({ id: 'a', followUpCount: 0 });
    const current = [item];
    incrementFollowUp(current, 'a');

    expect(item.followUpCount).toBe(0);
  });

  it('only changes the target reference, leaving others identical', () => {
    const a = makeItem({ id: 'a', followUpCount: 0 });
    const b = makeItem({ id: 'b', followUpCount: 0 });
    const next = incrementFollowUp([a, b], 'a');

    // The untouched item keeps its identity; the target is a fresh object.
    expect(next[1]).toBe(b);
    expect(next[0]).not.toBe(a);
  });
});
