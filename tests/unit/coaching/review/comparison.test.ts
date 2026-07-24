/**
 * §31.6 comparison over time.
 *
 * Two claims carry the whole section and both are tested by absence:
 * there is no baseline when there is no history, and there is no population
 * comparison anywhere. The second is checked by walking the returned object
 * for forbidden keys and values, not by trusting the TypeScript type — a
 * percentile could be added to an inner object without changing the outer one.
 */
import { describe, expect, it } from 'vitest';
import { compareWithHistory } from '../../../../src/shared/coaching/review/comparison';
import { summarizeSession } from '../../../../src/shared/coaching/review/session-summary';
import { makeFiller, makePass, makeRecord, TEST_PROFILE, TEST_VERSIONS } from './support';
import type { CoachingSessionRecord } from '../../../../src/shared/coaching/review/types';

/** N confirmed fillers over exactly 900 audible words → N/9 per 100 words. */
function summaryWith(
  sessionId: string,
  fillerCount: number,
  startedAtIso: string,
  overrides: Partial<CoachingSessionRecord> = {},
) {
  return summarizeSession(
    makeRecord(
      [
        makePass({
          audibleWords: 900,
          fillers: Array.from({ length: fillerCount }, (_, index) =>
            makeFiller({ atMs: 1_000 + index * 1_000 }),
          ),
        }),
      ],
      { sessionId, startedAtIso, ...overrides },
    ),
  );
}

const current = summaryWith('now', 12, '2026-07-10T09:00:00.000Z');

function collectKeys(value: unknown, keys: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      collectKeys(child, keys);
    }
  }
  return keys;
}

describe('no prior data', () => {
  const comparison = compareWithHistory(current, []);

  it('invents no baseline', () => {
    expect(comparison.hasBaseline).toBe(false);
    expect(comparison.priorSessionCount).toBe(0);
    expect(comparison.trends.every((trend) => trend.baseline === null)).toBe(true);
    expect(comparison.trends.every((trend) => trend.delta === null)).toBe(true);
  });

  it('says why, rather than showing an empty chart', () => {
    expect(comparison.trends.every((trend) => trend.notComparable === 'no_prior_sessions')).toBe(
      true,
    );
  });

  it('still reports this session’s own measured values', () => {
    const fillerRate = comparison.trends.find(
      (trend) => trend.metricId === 'filler_rate_per_100_words',
    );
    expect(fillerRate?.current).toBeCloseTo(12 / 9, 10);
  });
});

describe('no population claims (§31.6)', () => {
  const comparison = compareWithHistory(current, [
    summaryWith('a', 18, '2026-07-01T09:00:00.000Z'),
  ]);

  it('exposes no percentile, rank, cohort or population field anywhere', () => {
    const keys = [...collectKeys(comparison)];
    for (const key of keys) {
      expect(key).not.toMatch(/percentile|cohort|population|benchmark|peer|averageUser|rank/i);
    }
  });

  it('mentions no population wording in any string it returns', () => {
    expect(JSON.stringify(comparison)).not.toMatch(
      /percentile|other (users|presenters)|average speaker|top \d+%/i,
    );
  });
});

describe('baselines are the mean of the user’s own comparable sessions', () => {
  const comparison = compareWithHistory(current, [
    summaryWith('a', 18, '2026-07-01T09:00:00.000Z'),
    summaryWith('b', 36, '2026-07-02T09:00:00.000Z'),
  ]);
  const fillerRate = comparison.trends.find(
    (trend) => trend.metricId === 'filler_rate_per_100_words',
  );

  it('averages the priors rather than taking the most recent', () => {
    // 18/9 = 2, 36/9 = 4 → 3.
    expect(fillerRate?.baseline).toBe(3);
    expect(fillerRate?.baselineSessionCount).toBe(2);
  });

  it('reports the signed difference from that baseline', () => {
    expect(fillerRate?.delta).toBeCloseTo(12 / 9 - 3, 10);
    expect(comparison.hasBaseline).toBe(true);
  });

  it('excludes the current session from its own history', () => {
    const withSelf = compareWithHistory(current, [current, summaryWith('a', 18, '2026-07-01T09:00:00.000Z')]);
    const trend = withSelf.trends.find((entry) => entry.metricId === 'filler_rate_per_100_words');
    expect(trend?.baselineSessionCount).toBe(1);
    expect(trend?.baseline).toBe(2);
  });

  it('takes only the most recent sessions when the history is long', () => {
    const priors = Array.from({ length: 5 }, (_, index) =>
      summaryWith(`s${index}`, 9 * (index + 1), `2026-06-0${index + 1}T09:00:00.000Z`),
    );
    // Two most recent are 9×4=36 (4 per 100) and 9×5=45 (5 per 100) → 4.5.
    const trimmed = compareWithHistory(current, priors, { maxPriorSessions: 2 });
    const trend = trimmed.trends.find((entry) => entry.metricId === 'filler_rate_per_100_words');
    expect(trend?.baselineSessionCount).toBe(2);
    expect(trend?.baseline).toBe(4.5);
    expect(trimmed.priorSessionCount).toBe(5);
  });
});

describe('§36.3 a metric is not compared across a change in how it was computed', () => {
  const olderAlgorithm = summaryWith('old-alg', 18, '2026-07-01T09:00:00.000Z', {
    versions: { ...TEST_VERSIONS, algorithmVersion: 'alg-0' },
  });
  const comparison = compareWithHistory(current, [olderAlgorithm]);

  it('blocks version-sensitive metrics with a named reason', () => {
    const fillerRate = comparison.trends.find(
      (trend) => trend.metricId === 'filler_rate_per_100_words',
    );
    expect(fillerRate?.baseline).toBeNull();
    expect(fillerRate?.notComparable).toBe('algorithm_version_changed');
  });

  it('still compares metrics that do not depend on the scoring formula', () => {
    const retakes = comparison.trends.find((trend) => trend.metricId === 'retake_count');
    expect(retakes?.notComparable).toBeNull();
    expect(retakes?.baseline).toBe(0);
  });

  it('blocks a band-relative metric when the target band changed', () => {
    const differentBand = summaryWith('band', 18, '2026-07-01T09:00:00.000Z', {
      profile: { ...TEST_PROFILE, targetWpmLow: 90, targetWpmHigh: 120 },
    });
    const banded = compareWithHistory(current, [differentBand]);
    const inTarget = banded.trends.find((trend) => trend.metricId === 'time_in_pace_target');
    expect(inTarget?.notComparable).toBe('target_profile_changed');
    // The filler rate does not depend on the WPM band, so it still compares.
    const fillerRate = banded.trends.find(
      (trend) => trend.metricId === 'filler_rate_per_100_words',
    );
    expect(fillerRate?.baseline).toBe(2);
  });
});

describe('metrics this take could not measure', () => {
  it('reports the baseline but no delta, with a reason', () => {
    // Neither session sampled variety, so there is no prior value either.
    const comparison = compareWithHistory(current, [
      summaryWith('a', 18, '2026-07-01T09:00:00.000Z'),
    ]);
    const variety = comparison.trends.find((trend) => trend.metricId === 'average_variety');
    expect(variety?.current).toBeNull();
    expect(variety?.baseline).toBeNull();
    expect(variety?.notComparable).toBe('no_comparable_prior_sessions');
  });

  it('keeps a prior baseline when only this take failed to measure', () => {
    const priorWithVariety = summarizeSession(
      makeRecord(
        [
          makePass({
            varietySamples: [
              {
                startMs: 0,
                endMs: 60_000,
                level: 55,
                state: 'balanced',
                energyRangeDb: 8,
                pitchSpanSemitones: 5,
              },
            ],
          }),
        ],
        { sessionId: 'prior', startedAtIso: '2026-07-01T09:00:00.000Z' },
      ),
    );
    const comparison = compareWithHistory(current, [priorWithVariety]);
    const variety = comparison.trends.find((trend) => trend.metricId === 'average_variety');
    expect(variety?.baseline).toBe(55);
    expect(variety?.current).toBeNull();
    expect(variety?.delta).toBeNull();
    expect(variety?.notComparable).toBe('metric_not_measured_now');
  });
});

describe('direction of desirability', () => {
  it('takes no view on variety or retakes (§2.5)', () => {
    const comparison = compareWithHistory(current, []);
    const byId = new Map(comparison.trends.map((trend) => [trend.metricId, trend]));
    expect(byId.get('average_variety')?.desirableDirection).toBe('none');
    expect(byId.get('retake_count')?.desirableDirection).toBe('none');
    expect(byId.get('filler_rate_per_100_words')?.desirableDirection).toBe('lower');
    expect(byId.get('time_in_pace_target')?.desirableDirection).toBe('higher');
  });
});
