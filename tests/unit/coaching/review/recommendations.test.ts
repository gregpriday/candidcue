/**
 * §31.5 recommendations, and the boundary that matters most in this feature:
 * Luna may select and phrase, but every figure must come from local data.
 *
 * The Luna fixtures below deliberately carry the model's *own* numbers — 47
 * fillers, 999 WPM — in every field a careless implementation might read: a
 * `text` on the selection, a `summary` beside it. The assertions require that
 * none of those digits appear anywhere in the rendered output, and one test
 * goes further and proves each rendered string is exactly an authored template
 * filled from the local facts.
 */
import { describe, expect, it } from 'vitest';
import {
  applyLunaSelection,
  buildRecommendationCandidates,
  describeTipFollowThrough,
  MAX_RECOMMENDATIONS,
  renderTemplate,
  selectRecommendations,
  TIP_FOLLOW_THROUGH_TEXT,
} from '../../../../src/shared/coaching/review/recommendations';
import { summarizeSession } from '../../../../src/shared/coaching/review/session-summary';
import { makeFiller, makePass, makeRecord, TEST_PROFILE } from './support';
import type { PaceSample } from '../../../../src/shared/coaching/review/types';

/** 12 confirmed fillers, 900 audible words, 6:00 of delivery. */
const twelveFillers = summarizeSession(
  makeRecord([
    makePass({
      fillers: Array.from({ length: 12 }, (_, index) =>
        makeFiller({ atMs: 10_000 + index * 25_000 }),
      ),
    }),
  ]),
);

describe('local recommendations', () => {
  const candidates = buildRecommendationCandidates(twelveFillers);

  it('states the locally measured counts verbatim', () => {
    const recommendations = selectRecommendations(candidates);
    const fillerRate = recommendations.find((entry) => entry.patternId === 'FILLER_RATE');
    expect(fillerRate?.text).toBe(
      'You used 12 fillers in this take — 1.33 per 100 words. A silent pause is shorter than it feels.',
    );
  });

  it('quotes the dominant strict form with its real count', () => {
    const dominant = buildRecommendationCandidates(twelveFillers).find(
      (candidate) => candidate.patternId === 'FILLER_DOMINANT_FORM',
    );
    expect(dominant?.facts).toEqual({ fillerForm: 'um', fillerFormCount: '12 times' });
  });

  it('returns at most three, highest impact first', () => {
    const noisy = summarizeSession(
      makeRecord(
        [
          makePass({
            fillers: Array.from({ length: 12 }, (_, i) => makeFiller({ atMs: 1_000 + i * 1_000 })),
            cadence: {
              runOnCount: 3,
              choppyPauseCount: 6,
              cadenceBalance: 0.4,
              longestBreathGroupMs: 20_000,
              eligibleBoundaries: 0,
              shapedBoundaries: 0,
            },
          }),
        ],
        {
          microphone: {
            spans: [{ startMs: 0, endMs: 40_000, status: 'noisy', sustained: true }],
            levelSamples: [{ atMs: 0, levelDbfs: -30, snrDb: 8 }],
            transcriptionDegradedMs: 0,
          },
        },
      ),
    );
    const recommendations = selectRecommendations(buildRecommendationCandidates(noisy));
    expect(recommendations).toHaveLength(MAX_RECOMMENDATIONS);
    // A broken microphone outranks anything about delivery.
    expect(recommendations[0]?.patternId).toBe('MICROPHONE_SUSTAINED_ISSUE');
    expect(recommendations[0]?.text).toBe(
      'Your microphone showed background noise for 40 seconds of this take. Fixing that first makes every other measurement more reliable.',
    );
  });

  it('invents no pattern for a metric that was never measured', () => {
    const patterns = buildRecommendationCandidates(twelveFillers).map((c) => c.patternId);
    // Variety was never sampled in this fixture.
    expect(patterns).not.toContain('VARIETY_BELOW_TARGET');
    expect(patterns).not.toContain('VARIETY_ABOVE_TARGET');
    // No terminal-rush sentences either.
    expect(patterns).not.toContain('PACE_ON_TARGET_WITH_TERMINAL_RUSH');
  });

  it('treats too much variety symmetrically with too little (§2.5)', () => {
    const animated = summarizeSession(
      makeRecord([
        makePass({
          varietySamples: [
            {
              startMs: 0,
              endMs: 60_000,
              level: 92,
              state: 'highly_animated',
              energyRangeDb: 14,
              pitchSpanSemitones: 11,
            },
          ],
        }),
      ]),
    );
    const patterns = buildRecommendationCandidates(animated).map((c) => c.patternId);
    expect(patterns).toContain('VARIETY_ABOVE_TARGET');
  });

  it('produces the §31.5 pace-plus-rush phrasing from real numbers', () => {
    const paceSamples: PaceSample[] = [
      { startMs: 0, endMs: 78_000, audibleWpm: 140, state: 'on_target' },
      { startMs: 78_000, endMs: 100_000, audibleWpm: 200, state: 'fast' },
    ];
    const summary = summarizeSession(
      makeRecord([
        makePass({
          paceSamples,
          terminalRushSentences: Array.from({ length: 5 }, (_, index) => ({
            startMs: index * 1_000,
            endMs: index * 1_000 + 900,
            wordCount: 12,
            ratio: 1.4,
            measurable: true,
            reason: 'ok' as const,
            spanId: null,
            scriptAnchorTokenId: null,
          })),
        }),
      ]),
    );
    const candidate = buildRecommendationCandidates(summary).find(
      (entry) => entry.patternId === 'PACE_ON_TARGET_WITH_TERMINAL_RUSH',
    );
    // 78 000 of 100 000 measured milliseconds.
    expect(candidate?.facts).toEqual({ inTargetPercent: '78%', rushedSentences: '5 sentences' });
    const text = renderTemplate(candidate?.variants[0]?.template ?? '', candidate?.facts ?? {});
    expect(text).toBe(
      'Your pace was on target for 78% of the take, but you rushed the ending of 5 sentences.',
    );
  });
});

describe('Luna may select, never supply a number', () => {
  const candidates = buildRecommendationCandidates(twelveFillers);
  const lunaResponse = {
    selections: [
      {
        pattern_id: 'FILLER_RATE',
        variant_id: 'rate_first',
        // Everything below is the model's own arithmetic. None of it is read.
        text: 'You used um 47 times across the take.',
        filler_count: 47,
        rate: '5.2 per 100 words',
      },
      { pattern_id: 'NOT_A_REAL_PATTERN', variant_id: 'default' },
      { pattern_id: 'FILLER_RATE', variant_id: 'default' },
    ],
    summary: 'Your pace averaged 999 WPM and you used 47 fillers.',
    recommendations: ['Slow down to 999 WPM.'],
  };
  const outcome = applyLunaSelection(candidates, lunaResponse);

  it('honours the model’s choice of authored phrasing', () => {
    expect(outcome.recommendations).toHaveLength(1);
    expect(outcome.recommendations[0]?.variantId).toBe('rate_first');
    expect(outcome.recommendations[0]?.source).toBe('luna_selected');
  });

  it('fills that phrasing with the locally measured numbers', () => {
    expect(outcome.recommendations[0]?.text).toBe('Fillers ran at 1.33 per 100 words, 12 fillers in all.');
  });

  it('lets none of the model’s figures reach the output', () => {
    const rendered = JSON.stringify(outcome.recommendations);
    expect(rendered).not.toContain('47');
    expect(rendered).not.toContain('999');
    expect(rendered).not.toContain('5.2');
    expect(rendered).not.toContain('Slow down');
    expect(rendered).not.toContain('across the take');
  });

  it('proves each rendered string is an authored template over local facts', () => {
    for (const recommendation of outcome.recommendations) {
      const candidate = candidates.find((entry) => entry.patternId === recommendation.patternId);
      const variant = candidate?.variants.find(
        (entry) => entry.variantId === recommendation.variantId,
      );
      expect(variant).toBeDefined();
      expect(recommendation.text).toBe(
        renderTemplate(variant?.template ?? '', candidate?.facts ?? {}),
      );
      expect(recommendation.facts).toBe(candidate?.facts);
    }
  });

  it('records why each rejected selection was rejected', () => {
    expect(outcome.rejections).toEqual([
      { patternId: 'NOT_A_REAL_PATTERN', reason: 'unknown_pattern' },
      { patternId: 'FILLER_RATE', reason: 'duplicate_pattern' },
    ]);
    expect(outcome.fellBackToLocal).toBe(false);
  });

  it('falls back to the local order when the response is unusable', () => {
    const malformed = applyLunaSelection(candidates, 'not json at all');
    expect(malformed.fellBackToLocal).toBe(true);
    expect(malformed.rejections).toEqual([{ patternId: null, reason: 'malformed_response' }]);
    expect(malformed.recommendations).toEqual(selectRecommendations(candidates));
  });

  it('falls back to local when every selection is bogus', () => {
    const bogus = applyLunaSelection(candidates, {
      selections: [{ pattern_id: 'MADE_UP' }, { pattern_id: 'ALSO_MADE_UP' }],
    });
    expect(bogus.fellBackToLocal).toBe(true);
    expect(bogus.recommendations.every((entry) => entry.source === 'local')).toBe(true);
  });

  it('uses the default phrasing when the model names a variant we did not author', () => {
    const outcome2 = applyLunaSelection(candidates, {
      selections: [{ pattern_id: 'FILLER_RATE', variant_id: 'invented_by_the_model' }],
    });
    expect(outcome2.recommendations[0]?.variantId).toBe('default');
    expect(outcome2.rejections).toEqual([
      { patternId: 'FILLER_RATE', reason: 'unknown_variant' },
    ]);
  });

  it('never returns more than three however many the model asks for', () => {
    const many = summarizeSession(
      makeRecord(
        [
          makePass({
            fillers: Array.from({ length: 12 }, (_, i) => makeFiller({ atMs: 1_000 + i * 1_000 })),
            cadence: {
              runOnCount: 3,
              choppyPauseCount: 6,
              cadenceBalance: 0.4,
              longestBreathGroupMs: 20_000,
              eligibleBoundaries: 0,
              shapedBoundaries: 0,
            },
          }),
        ],
        {
          microphone: {
            spans: [{ startMs: 0, endMs: 40_000, status: 'noisy', sustained: true }],
            levelSamples: [],
            transcriptionDegradedMs: 0,
          },
        },
      ),
    );
    const manyCandidates = buildRecommendationCandidates(many);
    expect(manyCandidates.length).toBeGreaterThan(MAX_RECOMMENDATIONS);
    const outcome3 = applyLunaSelection(
      manyCandidates,
      { selections: manyCandidates.map((entry) => ({ pattern_id: entry.patternId })) },
    );
    expect(outcome3.recommendations).toHaveLength(MAX_RECOMMENDATIONS);
    expect(outcome3.rejections.some((entry) => entry.reason === 'over_limit')).toBe(true);
  });
});

describe('template rendering fails closed', () => {
  it('drops a template whose fact is missing rather than printing a hole', () => {
    expect(renderTemplate('You used {fillerCount} fillers.', {})).toBeNull();
  });

  it('drops a fact that is too long or carries markup', () => {
    expect(renderTemplate('{x}', { x: 'a'.repeat(200) })).toBeNull();
    expect(renderTemplate('{x}', { x: '<script>alert(1)</script>' })).toBeNull();
    expect(renderTemplate('{x}', { x: '{y}' })).toBeNull();
  });

  it('substitutes an ordinary fact', () => {
    expect(renderTemplate('Rate {r} per 100 words.', { r: '1.33' })).toBe(
      'Rate 1.33 per 100 words.',
    );
  });
});

describe('§26.4 tip follow-through', () => {
  const pass = makePass({
    paceSamples: [
      { startMs: 0, endMs: 10_000, audibleWpm: 190, state: 'fast' },
      { startMs: 10_000, endMs: 20_000, audibleWpm: 140, state: 'on_target' },
      { startMs: 60_000, endMs: 70_000, audibleWpm: 200, state: 'fast' },
    ],
    tipsShown: [
      {
        tipId: 'tip-1',
        code: 'PACE_EASE_BACK',
        textKey: 'pace.ease_back',
        interpolations: {},
        severity: 'gentle',
        shownAtMs: 5_000,
        hiddenAtMs: 9_000,
        takePassId: 'pass-1',
        scriptAnchorTokenId: null,
        spanId: null,
      },
      {
        tipId: 'tip-2',
        code: 'PACE_EASE_BACK',
        textKey: 'pace.ease_back',
        interpolations: {},
        severity: 'gentle',
        shownAtMs: 55_000,
        hiddenAtMs: 59_000,
        takePassId: 'pass-1',
        scriptAnchorTokenId: null,
        spanId: null,
      },
      {
        tipId: 'tip-3',
        code: 'MIC_CLIPPING',
        textKey: 'mic.clipping',
        interpolations: {},
        severity: 'critical',
        shownAtMs: 1_000,
        hiddenAtMs: 3_000,
        takePassId: 'pass-1',
        scriptAnchorTokenId: null,
        spanId: null,
      },
    ],
  });

  const results = describeTipFollowThrough(
    pass,
    TEST_PROFILE.targetWpmLow,
    TEST_PROFILE.targetWpmHigh,
  );

  it('observes only the tips whose metric it can check', () => {
    expect(results.map((entry) => entry.tipId)).toEqual(['tip-1', 'tip-2']);
  });

  it('notices the metric returning to target inside the window', () => {
    expect(results[0]?.returnedToTarget).toBe(true);
    expect(results[0]?.text).toBe(TIP_FOLLOW_THROUGH_TEXT);
  });

  it('says nothing when the metric did not return', () => {
    expect(results[1]?.returnedToTarget).toBe(false);
    expect(results[1]?.text).toBeNull();
  });

  it('never claims the prompt caused anything', () => {
    expect(TIP_FOLLOW_THROUGH_TEXT).toBe('Your pace returned to target shortly after the prompt.');
    expect(TIP_FOLLOW_THROUGH_TEXT).not.toMatch(/fixed|caused|because|thanks to|worked/i);
  });
});
