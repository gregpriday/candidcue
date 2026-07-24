/**
 * §9.4 dimension scoring and §9.6 combination.
 *
 * The two load-bearing properties are proved here against hand-computed
 * numbers:
 *
 * 1. **An unavailable dimension is excluded, not defaulted.** The test that
 *    matters is not "the overall score is a number" — that passes whether the
 *    missing dimension is treated as 0, as 100, or as absent. It is: four
 *    available dimensions all scoring 100 must produce exactly 100, and the
 *    weighted mean must equal the mean over *available* weights only.
 * 2. **The weak term does what it exists for.** Six strong dimensions and one
 *    persistently bad one must land materially below the mean, by the exact
 *    amount `0.75 × mean + 0.25 × weak` implies.
 */
import { describe, expect, it } from 'vitest';
import {
  DELIVERY_SCORE_WEIGHTS,
  type DeliveryDimension,
  type DimensionScore,
} from '../../../../src/shared/contracts/coaching';
import {
  combineDimensions,
  scoreDimension,
  weightedQuantile,
  type SubmetricSample,
} from '../../../../src/shared/coaching/score/dimension';

function dimension(name: DeliveryDimension, score: number | null): DimensionScore {
  return {
    dimension: name,
    score,
    confidence: score === null ? 0 : 1,
    weight: DELIVERY_SCORE_WEIGHTS[name],
  };
}

function sample(overrides: Partial<SubmetricSample> = {}): SubmetricSample {
  return { id: 'x', weight: 1, score: 100, confidence: 1, ...overrides };
}

describe('§9.4 confidence-weighted dimension scores', () => {
  it('computes Σ(w·c·s)/Σ(w·c) exactly', () => {
    // (6×1×90 + 4×0.5×50) / (6×1 + 4×0.5) = (540 + 100) / 8 = 80
    const result = scoreDimension(
      'pace',
      [
        sample({ id: 'a', weight: 6, score: 90, confidence: 1 }),
        sample({ id: 'b', weight: 4, score: 50, confidence: 0.5 }),
      ],
      0.25,
    );
    expect(result.score).toBeCloseTo(80, 10);
    // Confidence is the evidence fraction: 8 of a sourceable 10.
    expect(result.confidence).toBeCloseTo(0.8, 10);
  });

  it('lets a low-confidence submetric barely move the dimension', () => {
    // A confidence-0.01 disaster must not drag a well-evidenced dimension down.
    const result = scoreDimension(
      'pace',
      [
        sample({ id: 'a', weight: 6, score: 90, confidence: 1 }),
        sample({ id: 'b', weight: 4, score: 0, confidence: 0.01 }),
      ],
      0.25,
    );
    // (540 + 0) / (6 + 0.04) = 89.4…
    expect(result.score).toBeCloseTo(540 / 6.04, 10);
    expect(result.score as number).toBeGreaterThan(89);
  });

  it('reports the dimension as null — not 100 and not 0 — below the evidence floor', () => {
    const result = scoreDimension(
      'emphasis',
      [sample({ id: 'a', weight: 6, score: 20, confidence: 0.1 })],
      0.25,
    );
    expect(result.score).toBeNull();
    expect(result.score).not.toBe(0);
    expect(result.score).not.toBe(100);
    expect(result.confidence).toBeCloseTo(0.1, 10);
  });

  it('is null when every submetric is unsourceable, whatever their weights', () => {
    const result = scoreDimension(
      'emphasis',
      [
        sample({ id: 'a', weight: 6, score: null, confidence: 0, sourceable: false }),
        sample({ id: 'b', weight: 3, score: null, confidence: 0, sourceable: false }),
      ],
      0.25,
    );
    expect(result.score).toBeNull();
    expect(result.confidence).toBe(0);
    expect(result.weight).toBe(DELIVERY_SCORE_WEIGHTS.emphasis);
  });

  it('does not let an unsourceable submetric depress a sourced one', () => {
    const withGap = scoreDimension(
      'variety',
      [
        sample({ id: 'a', weight: 5, score: 80, confidence: 1 }),
        sample({ id: 'b', weight: 4, score: null, confidence: 0, sourceable: false }),
      ],
      0.25,
    );
    const withoutGap = scoreDimension(
      'variety',
      [sample({ id: 'a', weight: 5, score: 80, confidence: 1 })],
      0.25,
    );
    expect(withGap.confidence).toBe(withoutGap.confidence);
    expect(withGap.score).toBe(withoutGap.score);
    expect(withGap.confidence).toBe(1);
  });

  it('does count a sourceable-but-starved submetric against confidence', () => {
    // Same shape as above but the missing submetric *has* a producer, so the
    // dimension honestly reports that it is only partly evidenced.
    const result = scoreDimension(
      'variety',
      [
        sample({ id: 'a', weight: 5, score: 80, confidence: 1 }),
        sample({ id: 'b', weight: 5, score: null, confidence: 0 }),
      ],
      0.25,
    );
    expect(result.confidence).toBeCloseTo(0.5, 10);
    expect(result.score).toBe(80);
  });

  it('clamps a submetric score into 0–100 before weighting it', () => {
    const result = scoreDimension('pace', [sample({ weight: 1, score: 140, confidence: 1 })], 0.25);
    expect(result.score).toBe(100);
  });
});

describe('§9.6 — the unavailable dimension is excluded from the mean', () => {
  it('scores 100 when every available dimension is 100, whatever is missing', () => {
    const result = combineDimensions(
      [
        dimension('pace', 100),
        dimension('pausing', 100),
        dimension('variety', 100),
        dimension('emphasis', null),
        dimension('fluency', 100),
        dimension('clarity', null),
        dimension('consistency', null),
      ],
      0.25,
    );
    // If the three nulls were folded in as 0 this would be 72; as 100 it would
    // also be 100, so the next test pins the direction from the other side.
    expect(result.raw).toBe(100);
    expect(result.mean).toBe(100);
    expect(result.availableCount).toBe(4);
  });

  it('renormalizes over available weights only', () => {
    // pace 18 @ 60, fluency 18 @ 90; everything else unavailable.
    // mean = (18×60 + 18×90) / 36 = 75, not (18×60 + 18×90) / 100 = 27.
    const result = combineDimensions(
      [
        dimension('pace', 60),
        dimension('pausing', null),
        dimension('variety', null),
        dimension('emphasis', null),
        dimension('fluency', 90),
        dimension('clarity', null),
        dimension('consistency', null),
      ],
      0.25,
    );
    expect(result.mean).toBeCloseTo(75, 10);
    expect(result.mean).not.toBeCloseTo(27, 1);
    // weak = the weighted 25th percentile of {60, 90} with equal weights.
    // Positions are 0.25 and 0.75, so the quantile at 0.25 is exactly 60.
    expect(result.weak).toBeCloseTo(60, 10);
    expect(result.raw).toBeCloseTo(0.75 * 75 + 0.25 * 60, 10);
  });

  it('returns null overall when nothing is available at all', () => {
    const result = combineDimensions(
      [
        dimension('pace', null),
        dimension('pausing', null),
        dimension('variety', null),
        dimension('emphasis', null),
        dimension('fluency', null),
        dimension('clarity', null),
        dimension('consistency', null),
      ],
      0.25,
    );
    expect(result.raw).toBeNull();
    expect(result.mean).toBeNull();
    expect(result.weakest).toBeNull();
    expect(result.availableCount).toBe(0);
  });

  it('an unavailable dimension neither drags toward 0 nor props toward 100', () => {
    const withGap = combineDimensions(
      [dimension('pace', 40), dimension('fluency', 40), dimension('variety', null)],
      0.25,
    );
    const asZero = combineDimensions(
      [dimension('pace', 40), dimension('fluency', 40), dimension('variety', 0)],
      0.25,
    );
    const asHundred = combineDimensions(
      [dimension('pace', 40), dimension('fluency', 40), dimension('variety', 100)],
      0.25,
    );
    expect(withGap.raw).toBeCloseTo(40, 10);
    expect(asZero.raw as number).toBeLessThan(40);
    expect(asHundred.raw as number).toBeGreaterThan(40);
  });
});

describe('§9.6 — the weak-dimension term makes a persistent flaw visible', () => {
  const strongSix: DimensionScore[] = [
    dimension('pace', 92),
    dimension('pausing', 92),
    dimension('variety', 92),
    dimension('emphasis', 92),
    dimension('clarity', 92),
    dimension('consistency', 92),
  ];

  it('lands materially below the mean when one dimension is persistently bad', () => {
    const result = combineDimensions([...strongSix, dimension('fluency', 25)], 0.25);
    expect(result.mean).not.toBeNull();
    expect(result.raw).not.toBeNull();
    const mean = result.mean as number;
    const raw = result.raw as number;
    // The weak term pulls the visible score well below the arithmetic answer.
    expect(raw).toBeLessThan(mean - 5);
    // And by exactly the blend, not by an arbitrary fudge.
    expect(raw).toBeCloseTo(0.75 * mean + 0.25 * (result.weak as number), 10);
    expect(result.weakest).toBe('fluency');
  });

  it('is inert when every dimension is equal', () => {
    const flat = combineDimensions(
      [...strongSix, dimension('fluency', 92)],
      0.25,
    );
    expect(flat.raw).toBeCloseTo(92, 10);
    expect(flat.weak).toBeCloseTo(92, 10);
  });

  it('separates one bad dimension from the same total spread out', () => {
    // Same weighted mean, different shape: one collapse versus a broad sag.
    const spike = combineDimensions(
      [
        dimension('pace', 100),
        dimension('pausing', 100),
        dimension('variety', 100),
        dimension('fluency', 20),
      ],
      0.25,
    );
    const sag = combineDimensions(
      [
        dimension('pace', 80),
        dimension('pausing', 80),
        dimension('variety', 80),
        dimension('fluency', 80),
      ],
      0.25,
    );
    expect(spike.mean).toBeCloseTo(80, 10);
    expect(sag.mean).toBeCloseTo(80, 10);
    expect(spike.raw as number).toBeLessThan(sag.raw as number);
    expect(sag.raw).toBeCloseTo(80, 10);
  });

  it('with blend 0 collapses to the plain weighted mean', () => {
    const result = combineDimensions([...strongSix, dimension('fluency', 25)], 0);
    expect(result.raw).toBeCloseTo(result.mean as number, 10);
  });
});

describe('weightedQuantile', () => {
  it('reads the empirical CDF from the bottom', () => {
    const entries = [10, 20, 30, 40].map((value) => ({ value, weight: 1 }));
    // Cumulative positions: 0.25, 0.5, 0.75, 1.0. p=0.25 lands exactly on the
    // first point and p=0.375 exactly halfway to the second.
    expect(weightedQuantile(entries, 0.25)).toBeCloseTo(10, 10);
    expect(weightedQuantile(entries, 0.5)).toBeCloseTo(20, 10);
    expect(weightedQuantile(entries, 0.375)).toBeCloseTo(15, 10);
  });

  it('lets a light weak dimension pull only partly', () => {
    // 25 holds 18 of 100 points, so its cumulative position is 0.18 and the
    // next point sits at 1.0: p=0.25 is 0.07/0.82 of the way across.
    const entries = [
      { value: 25, weight: 18 },
      { value: 92, weight: 82 },
    ];
    expect(weightedQuantile(entries, 0.25)).toBeCloseTo(25 + (0.07 / 0.82) * 67, 10);
    // Spread the same 82 points over six dimensions and the next point sits at
    // 0.36 instead, so the quantile lands further down: 25 + (7/18) × 67.
    const spread = [
      { value: 25, weight: 18 },
      ...[18, 18, 18, 14, 9, 5].map((weight) => ({ value: 92, weight })),
    ];
    expect(weightedQuantile(spread, 0.25)).toBeCloseTo(25 + (7 / 18) * 67, 10);
  });

  it('pins onto a heavy weak dimension entirely', () => {
    const entries = [
      { value: 25, weight: 40 },
      { value: 92, weight: 60 },
    ];
    expect(weightedQuantile(entries, 0.25)).toBe(25);
  });

  it('pins to the extremes outside the cumulative range', () => {
    const entries = [10, 20, 30].map((value) => ({ value, weight: 1 }));
    expect(weightedQuantile(entries, 0)).toBe(10);
    expect(weightedQuantile(entries, 1)).toBe(30);
  });

  it('gives a heavy dimension more say than a light one', () => {
    const heavyLow = weightedQuantile(
      [
        { value: 20, weight: 18 },
        { value: 90, weight: 5 },
      ],
      0.25,
    );
    const heavyHigh = weightedQuantile(
      [
        { value: 20, weight: 5 },
        { value: 90, weight: 18 },
      ],
      0.25,
    );
    expect(heavyLow).not.toBeNull();
    expect(heavyHigh).not.toBeNull();
    expect(heavyLow as number).toBeLessThan(heavyHigh as number);
  });

  it('returns null for an empty or zero-weight sample', () => {
    expect(weightedQuantile([], 0.25)).toBeNull();
    expect(weightedQuantile([{ value: 50, weight: 0 }], 0.25)).toBeNull();
  });
});
