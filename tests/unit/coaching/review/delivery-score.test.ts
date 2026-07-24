/**
 * The delivery score in the post-take review (Speaking Score report §9, §11.2).
 *
 * §11.2 forbids seven dimension scores during a take and says in the same
 * breath that they belong in a post-take review. The live tests
 * (`tests/unit/stage/coach-rail-score.test.ts`) prove the first half; these
 * prove the second, and prove that the review keeps the project's absence
 * discipline while doing it — an unavailable dimension states a reason and is
 * never a zero, and an unscored take says so rather than reporting 0/100.
 */
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import Review from '../../../../src/control/routes/Review.svelte';
import {
  buildDeliveryDimensionRows,
  buildReviewModel,
  buildSummaryCards,
  DELIVERY_TIER_COPY,
} from '../../../../src/shared/coaching/review';
import { buildStoredReport } from '../../../../src/shared/coaching/review/report-store';
import { summarizeSession } from '../../../../src/shared/coaching/review/session-summary';
import { DELIVERY_SCORE_WEIGHTS } from '../../../../src/shared/contracts/coaching';
import { makeDeliveryScore, makePass, makeRecord, TEST_SCRIPT } from './support';

function text(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const scoredRecord = makeRecord([makePass({ deliveryScore: makeDeliveryScore() })]);
const unscoredRecord = makeRecord([makePass()]);

/* ---------------------------------------------------------------------------
 * The summary
 * ------------------------------------------------------------------------- */

describe('summarizeDeliveryScore', () => {
  it('reports the smoothed figure and the tier, not a confidence number', () => {
    const score = summarizeSession(scoredRecord).metrics.deliveryScore;
    expect(score.displayScore).toEqual({ value: 84, absent: null });
    expect(score.tier).toBe('usable');
    // §9.7: the trust ladder reaches the screen as words. The raw 0.68 is not
    // in the summary at all, so no consumer can print it by accident.
    expect(JSON.stringify(score)).not.toContain('0.68');
  });

  it('keeps the unsmoothed figure so the smoothing can be audited', () => {
    const score = summarizeSession(scoredRecord).metrics.deliveryScore;
    expect(score.rawScore).toEqual({ value: 86, absent: null });
    expect(score.displayScore.value).not.toBe(score.rawScore.value);
  });

  it('states all seven dimensions with the contract weights', () => {
    const score = summarizeSession(scoredRecord).metrics.deliveryScore;
    expect(score.dimensions).toHaveLength(7);
    expect(score.dimensions.map((d) => d.dimension)).toEqual(
      Object.keys(DELIVERY_SCORE_WEIGHTS),
    );
    for (const dimension of score.dimensions) {
      expect(dimension.weight).toBe(DELIVERY_SCORE_WEIGHTS[dimension.dimension]);
    }
    expect(score.dimensions.reduce((total, d) => total + d.weight, 0)).toBe(100);
  });

  it('renders an unavailable dimension as an absence and never as zero (§9.4)', () => {
    const score = summarizeSession(scoredRecord).metrics.deliveryScore;
    const emphasis = score.dimensions.find((d) => d.dimension === 'emphasis')!;
    expect(emphasis.score).toEqual({ value: null, absent: 'dimension_unavailable' });
    expect(emphasis.score.value).not.toBe(0);
  });

  it('says a take was not scored rather than reporting zero', () => {
    const score = summarizeSession(unscoredRecord).metrics.deliveryScore;
    expect(score.displayScore).toEqual({ value: null, absent: 'not_scored' });
    expect(score.tier).toBeNull();
    expect(score.sourcePassOrdinal).toBeNull();
    for (const dimension of score.dimensions) {
      expect(dimension.score.value).toBeNull();
      expect(dimension.score.absent).toBe('not_scored');
    }
  });

  it('distinguishes a score that never left warm-up from one that never ran', () => {
    const warming = makeRecord([
      makePass({
        deliveryScore: makeDeliveryScore({
          tier: 'warming_up',
          displayScore: null,
          rawScore: null,
        }),
      }),
    ]);
    const score = summarizeSession(warming).metrics.deliveryScore;
    expect(score.displayScore.absent).toBe('score_never_left_warm_up');
    expect(score.sourcePassOrdinal).toBe(1);
    // The dimensions still have evidence behind them, so they are still stated.
    expect(score.dimensions.find((d) => d.dimension === 'clarity')!.score.value).toBe(83);
  });

  it('reports the latest scored pass rather than averaging two performances', () => {
    // §11.3: every pass is its own performance. A mean of 40 and 90 describes
    // neither take, and nobody delivered a 65.
    const record = makeRecord([
      makePass({
        takePassId: 'pass-1',
        passOrdinal: 1,
        deliveryScore: makeDeliveryScore({ displayScore: 40 }),
      }),
      makePass({
        takePassId: 'pass-2',
        passOrdinal: 2,
        deliveryScore: makeDeliveryScore({ displayScore: 90 }),
      }),
    ]);
    const summary = summarizeSession(record);
    expect(summary.metrics.deliveryScore.displayScore.value).toBe(90);
    expect(summary.metrics.deliveryScore.sourcePassOrdinal).toBe(2);
    // And each pass keeps its own figure.
    expect(summary.passes.map((pass) => pass.metrics.deliveryScore.displayScore.value)).toEqual([
      40, 90,
    ]);
  });

  it('skips an unscored later pass rather than losing the score it does have', () => {
    const record = makeRecord([
      makePass({
        takePassId: 'pass-1',
        passOrdinal: 1,
        deliveryScore: makeDeliveryScore({ displayScore: 40 }),
      }),
      makePass({ takePassId: 'pass-2', passOrdinal: 2 }),
    ]);
    const score = summarizeSession(record).metrics.deliveryScore;
    expect(score.displayScore.value).toBe(40);
    expect(score.sourcePassOrdinal).toBe(1);
  });
});

/* ---------------------------------------------------------------------------
 * The cards and rows
 * ------------------------------------------------------------------------- */

describe('the delivery score card', () => {
  it('leads the §31.2 cards and states the tier in words', () => {
    const cards = buildSummaryCards(summarizeSession(scoredRecord));
    const card = cards[0]!;
    expect(card.id).toBe('delivery_score');
    expect(card.value).toBe('84 / 100');
    expect(card.detail).toBe(DELIVERY_TIER_COPY.usable);
    // Never a percentage, never a second figure competing with the score.
    expect(card.detail).not.toMatch(/\d/);
  });

  it('states why there is no score rather than showing one', () => {
    const card = buildSummaryCards(summarizeSession(unscoredRecord))[0]!;
    expect(card.id).toBe('delivery_score');
    expect(card.value).toBeNull();
    expect(card.absentLabel).toBe('This take was not scored.');
  });

  it('carries the weight beside every dimension', () => {
    const rows = buildDeliveryDimensionRows(
      summarizeSession(scoredRecord).metrics.deliveryScore,
    );
    expect(rows).toHaveLength(7);
    expect(rows[0]).toEqual({
      dimension: 'pace',
      label: 'Pace',
      value: '71',
      absentLabel: null,
      detail: 'Worth 18 points of 100',
    });
    const emphasis = rows.find((row) => row.dimension === 'emphasis')!;
    expect(emphasis.value).toBeNull();
    expect(emphasis.absentLabel).toBe('Not enough evidence to judge this.');
  });

  it('never puts a contract key on the screen', () => {
    const rows = buildDeliveryDimensionRows(
      summarizeSession(scoredRecord).metrics.deliveryScore,
    );
    for (const row of rows) {
      expect(row.label).not.toBe(row.dimension);
      expect(row.label[0]).toBe(row.label[0]!.toUpperCase());
    }
  });
});

/* ---------------------------------------------------------------------------
 * The screen
 * ------------------------------------------------------------------------- */

describe('Review.svelte shows the breakdown the rail may not', () => {
  function screen(record = scoredRecord): string {
    return render(Review, {
      props: { model: buildReviewModel({ record, script: TEST_SCRIPT }) },
    }).body;
  }

  it('renders all seven dimension rows with their figures', () => {
    const markup = screen();
    const body = text(markup);
    expect(body).toContain('What the score is made of');
    for (const label of ['Pace', 'Pausing', 'Vocal variety', 'Emphasis', 'Fluency', 'Clarity', 'Consistency']) {
      expect(body).toContain(label);
    }
    for (const value of ['71', '73', '77', '79', '83', '89']) {
      expect(body).toContain(value);
    }
    expect(markup.match(/data-dimension="/g)).toHaveLength(7);
  });

  it('renders the unavailable dimension as a stated reason, not a zero', () => {
    const markup = screen();
    const emphasisRow = /<li[^>]*data-dimension="emphasis"[\s\S]*?<\/li>/.exec(markup)![0];
    expect(text(emphasisRow)).toContain('Not enough evidence to judge this.');
    expect(emphasisRow).not.toMatch(/>\s*0\s*</);
  });

  it('shows the score itself and the pass it came from', () => {
    const body = text(screen());
    expect(body).toContain('Delivery score');
    expect(body).toContain('84 / 100');
    expect(body).toContain('From Take 1');
  });

  it('states the absence when the take was not scored', () => {
    const markup = screen(unscoredRecord);
    expect(text(markup)).toContain('This take was not scored.');
    expect(markup).toContain('data-testid="score-absent"');
    // No breakdown at all rather than seven empty rows.
    expect(markup).not.toContain('data-dimension="pace"');
  });

  it('never renders the confidence figure or the raw score', () => {
    const markup = screen();
    expect(markup).not.toContain('0.68');
    expect(markup).not.toContain('68%');
    // `rawScore` is 86 in the fixture and `displayScore` is 84: the review keeps
    // the raw figure for audit but never shows it beside the smoothed one.
    expect(text(markup)).not.toContain('86');
    expect(summarizeSession(scoredRecord).metrics.deliveryScore.rawScore.value).toBe(86);
  });
});

/* ---------------------------------------------------------------------------
 * Persistence
 * ------------------------------------------------------------------------- */

describe('the stored report keeps the score', () => {
  it('persists the score and the breakdown with the summary (§36.2)', () => {
    const stored = buildStoredReport(scoredRecord);
    const score = stored.summary.metrics.deliveryScore;
    expect(score.displayScore.value).toBe(84);
    expect(score.dimensions).toHaveLength(7);
    // It survives a JSON round trip, which is what the persistence layer does.
    const roundTripped = JSON.parse(JSON.stringify(stored)) as typeof stored;
    expect(roundTripped.summary.metrics.deliveryScore).toEqual(score);
  });

  it('survives transcript redaction untouched — the score is not transcript text', () => {
    const withoutConsent = makeRecord([makePass({ deliveryScore: makeDeliveryScore() })], {
      consent: { saveReport: true, saveTranscript: false, saveAudio: false },
    });
    const stored = buildStoredReport(withoutConsent);
    expect(stored.summary.metrics.deliveryScore.displayScore.value).toBe(84);
    expect(stored.summary.metrics.deliveryScore.dimensions[0]!.score.value).toBe(71);
  });
});
