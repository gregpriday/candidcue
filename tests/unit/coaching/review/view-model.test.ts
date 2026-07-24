/**
 * The mounting seam: one call in, one prop out.
 *
 * These tests exist because the route takes a single prop and does nothing
 * else — if the model is assembled wrongly the screen is wrong, and no
 * component test would catch it.
 */
import { describe, expect, it } from 'vitest';
import { buildReviewModel, selectPassage } from '../../../../src/shared/coaching/review';
import { summarizeSession } from '../../../../src/shared/coaching/review/session-summary';
import { makeFiller, makePass, makeRecord, TEST_SCRIPT } from './support';

const record = makeRecord([
  makePass({
    coveredSpanIds: ['span-a', 'span-b'],
    fillers: Array.from({ length: 12 }, (_, index) =>
      makeFiller({ atMs: 10_000 + index * 25_000, scriptAnchorTokenId: 't4' }),
    ),
  }),
]);

describe('assembly', () => {
  const model = buildReviewModel({ record, script: TEST_SCRIPT });

  it('carries the §31.2 cards in specification order', () => {
    expect(model.cards.map((card) => card.id)).toEqual([
      'audible_wpm',
      'articulation_wpm',
      'time_in_target_pace',
      'projected_vs_actual',
      'fillers',
      'most_frequent_filler',
      'longest_filler_free',
      'variety',
      'terminal_rush',
      'cadence_events',
      'retakes',
      'critical_discrepancies',
      'microphone',
    ]);
  });

  it('resolves a clicked event to its passage', () => {
    const filler = model.timeline.events.find((event) => event.track === 'fillers');
    const result = selectPassage(model, filler?.eventId ?? '');
    expect(result.resolved && result.selection.passage.spanId).toBe('span-b');
  });

  it('wires the retention statement and comparison through', () => {
    expect(model.retention.report).toBe(true);
    expect(model.retention.audio).toBe(false);
    expect(model.comparison.hasBaseline).toBe(false);
    expect(model.comparison.priorSessionCount).toBe(0);
  });

  it('uses the local recommendation order when no model response is supplied', () => {
    expect(model.recommendations.every((entry) => entry.source === 'local')).toBe(true);
    expect(model.narrationRejections).toEqual([]);
  });
});

describe('degradation', () => {
  it('opens without a script rather than refusing', () => {
    const model = buildReviewModel({ record, script: null });
    expect(model.annotatedScript).toBeNull();
    expect(model.passageIndex).toBeNull();
    // The summary and timeline are unaffected.
    expect(model.summary.metrics.fillers.confirmedCount).toBe(12);
    expect(model.timeline.events.length).toBeGreaterThan(0);
  });

  it('cannot resolve a passage without a script, and says so', () => {
    const model = buildReviewModel({ record, script: null });
    const filler = model.timeline.events[0];
    expect(selectPassage(model, filler?.eventId ?? '')).toEqual({
      resolved: false,
      reason: 'anchor_not_in_script',
    });
  });

  it('compares against prior sessions when they are supplied', () => {
    const prior = summarizeSession(
      makeRecord([makePass({ audibleWords: 900, fillers: [] })], {
        sessionId: 'prior',
        startedAtIso: '2026-06-01T09:00:00.000Z',
      }),
    );
    const model = buildReviewModel({ record, script: TEST_SCRIPT, priorSummaries: [prior] });
    const trend = model.comparison.trends.find(
      (entry) => entry.metricId === 'filler_rate_per_100_words',
    );
    expect(trend?.baseline).toBe(0);
    expect(trend?.delta).toBeCloseTo(12 / 9, 10);
  });
});
