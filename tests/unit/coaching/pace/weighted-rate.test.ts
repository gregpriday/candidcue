/**
 * Weighted moving rate (spec §14.4).
 *
 * Every fixture here is a series whose true slope is known by construction, so
 * the assertions are exact numbers rather than "greater than zero". The bursty
 * fixture is the one that matters most: it is collinear in (time, cumulative
 * words) but arrives in three clumps, which is precisely the case §14.4 says a
 * moving-window division gets wrong.
 */
import { describe, expect, it } from 'vitest';
import {
  applySlewLimit,
  WeightedRateEstimator,
  type RateObservation,
} from '../../../../src/shared/coaching/pace/weighted-rate';

/** `wordsPerSecond` words per second, sampled every `stepMs`. */
function series(
  wordsPerSecond: number,
  fromMs: number,
  toMs: number,
  stepMs: number,
): RateObservation[] {
  const out: RateObservation[] = [];
  for (let t = fromMs; t <= toMs; t += stepMs) {
    out.push({ audioTimeMs: t, cumulativeWords: (t / 1_000) * wordsPerSecond });
  }
  return out;
}

describe('WeightedRateEstimator slope', () => {
  it('reads exactly 150 WPM for 2.5 words per second', () => {
    const estimator = new WeightedRateEstimator();
    for (const observation of series(2.5, 0, 13_800, 400)) {
      estimator.add(observation);
    }
    const estimate = estimator.estimate(14_000, 14_000);
    expect(estimate.wpm).toBeCloseTo(150, 9);
    expect(estimate.confidence).toBeCloseTo(1, 9);
  });

  it('is unaffected by irregular observation arrival', () => {
    // 2 words per second throughout, but the observations arrive in three
    // clumps. A `words in window / window length` division reads whatever
    // fraction of the window happened to be covered; the regression reads 120.
    const estimator = new WeightedRateEstimator();
    const clumped: RateObservation[] = [
      { audioTimeMs: 1_000, cumulativeWords: 2 },
      { audioTimeMs: 1_500, cumulativeWords: 3 },
      { audioTimeMs: 2_000, cumulativeWords: 4 },
      { audioTimeMs: 6_000, cumulativeWords: 12 },
      { audioTimeMs: 6_500, cumulativeWords: 13 },
      { audioTimeMs: 7_000, cumulativeWords: 14 },
      { audioTimeMs: 12_000, cumulativeWords: 24 },
      { audioTimeMs: 12_500, cumulativeWords: 25 },
      { audioTimeMs: 13_000, cumulativeWords: 26 },
    ];
    for (const observation of clumped) {
      estimator.add(observation);
    }
    expect(estimator.estimate(13_500, 10_000).wpm).toBeCloseTo(120, 9);
  });

  it('weights recent observations more heavily than old ones', () => {
    // 100 WPM for the first half of the horizon, 200 WPM for the second. With
    // a 4 s half-life the answer must sit well above the 150 WPM arithmetic
    // mean, and strictly inside the two rates.
    const estimator = new WeightedRateEstimator();
    let words = 0;
    for (let t = 0; t <= 7_000; t += 250) {
      words = (t / 60_000) * 100;
      estimator.add({ audioTimeMs: t, cumulativeWords: words });
    }
    const wordsAt7s = words;
    for (let t = 7_250; t <= 14_000; t += 250) {
      estimator.add({
        audioTimeMs: t,
        cumulativeWords: wordsAt7s + ((t - 7_000) / 60_000) * 200,
      });
    }
    const wpm = estimator.estimate(14_000, 14_000).wpm ?? 0;
    expect(wpm).toBeGreaterThan(165);
    expect(wpm).toBeLessThan(200);
  });
});

describe('WeightedRateEstimator evidence gating', () => {
  it('returns null — never 0 — below the minimum active evidence', () => {
    const estimator = new WeightedRateEstimator();
    for (const observation of series(2.5, 0, 3_000, 400)) {
      estimator.add(observation);
    }
    const estimate = estimator.estimate(3_000, 3_000);
    expect(estimate.wpm).toBeNull();
    expect(estimate.confidence).toBe(0);
  });

  it('returns null with a single observation, however long the take has run', () => {
    const estimator = new WeightedRateEstimator();
    estimator.add({ audioTimeMs: 1_000, cumulativeWords: 40 });
    expect(estimator.estimate(13_000, 12_000).wpm).toBeNull();
  });

  it('raises confidence as active evidence accumulates', () => {
    const estimator = new WeightedRateEstimator();
    for (const observation of series(2.5, 0, 13_800, 400)) {
      estimator.add(observation);
    }
    const thin = estimator.estimate(14_000, 4_000).confidence;
    const full = estimator.estimate(14_000, 14_000).confidence;
    expect(thin).toBeGreaterThan(0);
    expect(thin).toBeLessThan(full);
    // (4000 - 3500) / (7000 - 3500) with a perfect fit.
    expect(thin).toBeCloseTo(500 / 3_500, 9);
  });

  it('drops observations that fall out of the horizon', () => {
    const estimator = new WeightedRateEstimator();
    for (const observation of series(2.5, 0, 40_000, 400)) {
      estimator.add(observation);
    }
    estimator.estimate(40_000, 14_000);
    // 14 s horizon at 400 ms spacing: 36 observations survive (t = 26 000 … 40 000).
    expect(estimator.observationCount()).toBe(36);
  });

  it('ignores an observation whose cumulative count goes backwards', () => {
    const estimator = new WeightedRateEstimator();
    estimator.add({ audioTimeMs: 1_000, cumulativeWords: 10 });
    estimator.add({ audioTimeMs: 2_000, cumulativeWords: 4 });
    expect(estimator.observationCount()).toBe(1);
  });
});

describe('WeightedRateEstimator outlier rejection', () => {
  it('does not let a single transcript burst redefine the rate', () => {
    const build = (withBurst: boolean): WeightedRateEstimator => {
      const estimator = new WeightedRateEstimator();
      for (let t = 0; t <= 12_000; t += 500) {
        estimator.add({ audioTimeMs: t, cumulativeWords: t / 500 + 1 });
      }
      if (withBurst) {
        estimator.add({ audioTimeMs: 12_500, cumulativeWords: 41 });
      }
      return estimator;
    };

    const clean = build(false).estimate(12_600, 12_000);
    const burst = build(true).estimate(12_600, 12_000);

    expect(clean.wpm).toBeCloseTo(120, 6);
    expect(burst.rejectedCount).toBe(1);
    expect(burst.wpm).toBeCloseTo(120, 6);
  });
});

describe('WeightedRateEstimator provisional overlay', () => {
  it('uses provisional observations and reports that it did', () => {
    const estimator = new WeightedRateEstimator();
    for (const observation of series(2.5, 0, 10_000, 400)) {
      estimator.add(observation);
    }
    expect(estimator.usesProvisional(14_000)).toBe(false);

    estimator.setProvisional(series(2.5, 10_400, 13_800, 400));
    expect(estimator.usesProvisional(14_000)).toBe(true);
    expect(estimator.estimate(14_000, 14_000).wpm).toBeCloseTo(150, 9);
  });

  it('ignores a provisional observation already superseded by final evidence', () => {
    const estimator = new WeightedRateEstimator();
    for (const observation of series(2.5, 0, 13_800, 400)) {
      estimator.add(observation);
    }
    estimator.setProvisional([{ audioTimeMs: 5_000, cumulativeWords: 999 }]);
    expect(estimator.usesProvisional(14_000)).toBe(false);
    expect(estimator.estimate(14_000, 14_000).wpm).toBeCloseTo(150, 9);
  });

  it('clears the overlay on reset', () => {
    const estimator = new WeightedRateEstimator();
    estimator.setProvisional([{ audioTimeMs: 1_000, cumulativeWords: 5 }]);
    estimator.reset();
    expect(estimator.usesProvisional(2_000)).toBe(false);
  });
});

describe('applySlewLimit (§14.4 maximum displayed change)', () => {
  it('caps movement at 12 WPM per second', () => {
    expect(applySlewLimit(100, 200, 1_000)).toBe(112);
    expect(applySlewLimit(200, 100, 1_000)).toBe(188);
    expect(applySlewLimit(100, 200, 500)).toBe(106);
  });

  it('passes a change smaller than the cap through untouched', () => {
    expect(applySlewLimit(100, 105, 1_000)).toBe(105);
  });

  it('does not limit the first value or a zero-length step', () => {
    expect(applySlewLimit(null, 200, 1_000)).toBe(200);
    expect(applySlewLimit(100, 200, 0)).toBe(200);
  });
});
