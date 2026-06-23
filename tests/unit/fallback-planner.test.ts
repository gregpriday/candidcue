import { describe, it, expect } from 'vitest';
import type { PlannedQuestion, SessionCoverageItem, CoveragePriority, CoverageStatus } from '@shared/domain';
import { rankFallbacks, pickFallback, isRepeat } from '@main/interview/fallback-planner';

function coverage(
  id: string,
  priority: CoveragePriority,
  status: CoverageStatus = 'not_started',
  followUpCount = 0,
): SessionCoverageItem {
  return {
    id,
    label: id,
    objective: `objective ${id}`,
    priority,
    status,
    evidenceTurnIds: [],
    maxFollowUps: 3,
    sourceRefs: [],
    followUpCount,
  };
}

function fallback(
  text: string,
  targetCoverageItemIds: string[],
  type: PlannedQuestion['type'] = 'context',
): PlannedQuestion {
  return { text, type, targetCoverageItemIds, useWhen: 'fallback' };
}

const emptyCtx = (overrides: Partial<Parameters<typeof rankFallbacks>[1]> = {}) => ({
  coverage: [],
  currentSectionId: null,
  recentQuestions: [],
  usedFallbackTexts: [],
  ...overrides,
});

describe('rankFallbacks', () => {
  it('ranks a must-priority fallback targeting an uncovered item above an optional one', () => {
    const cov = [
      coverage('must-item', 'must', 'not_started'),
      coverage('opt-item', 'optional', 'not_started'),
    ];
    const fallbacks = [
      fallback('Tell me about the optional thing.', ['opt-item']),
      fallback('Tell me about the must thing.', ['must-item']),
    ];

    const ranked = rankFallbacks(fallbacks, emptyCtx({ coverage: cov }));

    expect(ranked).toHaveLength(2);
    expect(ranked[0]!.question.targetCoverageItemIds).toEqual(['must-item']);
    // must = 3 + uncovered 2 = 5 ; optional = 1 + uncovered 2 = 3.
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
    expect(ranked[0]!.score).toBe(5);
    expect(ranked[1]!.score).toBe(3);
  });

  it('uses the best priority among multiple targets', () => {
    const cov = [
      coverage('opt', 'optional', 'not_started'),
      coverage('should', 'should', 'not_started'),
    ];
    const fallbacks = [fallback('Multi target question.', ['opt', 'should'])];

    const [scored] = rankFallbacks(fallbacks, emptyCtx({ coverage: cov }));
    // max priority should=2 + uncovered 2 = 4.
    expect(scored!.score).toBe(4);
  });

  it('does not add the uncovered bonus when all targets are covered', () => {
    const cov = [coverage('m', 'must', 'covered')];
    const fallbacks = [fallback('Covered must question.', ['m'])];

    const [scored] = rankFallbacks(fallbacks, emptyCtx({ coverage: cov }));
    // must=3, no uncovered bonus.
    expect(scored!.score).toBe(3);
  });

  it('treats partial status as uncovered', () => {
    const cov = [coverage('m', 'should', 'partial')];
    const fallbacks = [fallback('Partial question.', ['m'])];

    const [scored] = rankFallbacks(fallbacks, emptyCtx({ coverage: cov }));
    // should=2 + uncovered 2 = 4.
    expect(scored!.score).toBe(4);
  });

  it('adds section relevance when a target belongs to the current section coverage', () => {
    const cov = [coverage('m', 'optional', 'covered')];
    const fallbacks = [fallback('Section relevant question.', ['m'])];

    const inSection = rankFallbacks(
      fallbacks,
      emptyCtx({ coverage: cov, currentSectionId: 'sec-1' }),
    );
    // optional=1 + section 0.5 = 1.5 (covered → no uncovered bonus).
    expect(inSection[0]!.score).toBe(1.5);

    const noSection = rankFallbacks(fallbacks, emptyCtx({ coverage: cov, currentSectionId: null }));
    expect(noSection[0]!.score).toBe(1);
  });

  it('does not add section relevance when the target is not in the coverage snapshot', () => {
    const cov = [coverage('other', 'must', 'covered')];
    const fallbacks = [fallback('Targets a missing item.', ['ghost'])];

    const ranked = rankFallbacks(
      fallbacks,
      emptyCtx({ coverage: cov, currentSectionId: 'sec-1' }),
    );
    // No resolvable target → priority 0, no bonuses, no section relevance.
    expect(ranked[0]!.score).toBe(0);
  });

  it('lowers the score for high similarity to a recent question', () => {
    const cov = [coverage('m', 'must', 'not_started')];
    const text = 'What inspired you to start building the lighthouse project?';
    const fallbacks = [fallback(text, ['m'])];

    const baseline = rankFallbacks(fallbacks, emptyCtx({ coverage: cov }));
    const withRecent = rankFallbacks(
      fallbacks,
      emptyCtx({ coverage: cov, recentQuestions: [text] }),
    );

    // Identical recent question → similarity 1 → penalty 3.
    expect(withRecent[0]!.score).toBeLessThan(baseline[0]!.score);
    expect(withRecent[0]!.score).toBeCloseTo(baseline[0]!.score - 3, 5);
  });

  it('applies the already-used penalty of 5', () => {
    const cov = [coverage('m', 'must', 'not_started')];
    const text = 'A reused fallback question.';
    const fallbacks = [fallback(text, ['m'])];

    const baseline = rankFallbacks(fallbacks, emptyCtx({ coverage: cov }));
    const used = rankFallbacks(
      fallbacks,
      emptyCtx({ coverage: cov, usedFallbackTexts: [text] }),
    );

    expect(used[0]!.score).toBeCloseTo(baseline[0]!.score - 5, 5);
  });

  it('applies the recent-followup penalty using the max followUpCount among targets', () => {
    const cov = [
      coverage('a', 'must', 'not_started', 2),
      coverage('b', 'must', 'not_started', 4),
    ];
    const fallbacks = [fallback('Heavily followed up.', ['a', 'b'])];

    const [scored] = rankFallbacks(fallbacks, emptyCtx({ coverage: cov }));
    // must 3 + uncovered 2 - 0.5 * max(2,4)=2 -> 5 - 2 = 3.
    expect(scored!.score).toBe(3);
  });

  it('sorts descending by score and returns every candidate', () => {
    const cov = [
      coverage('must', 'must', 'not_started'),
      coverage('should', 'should', 'not_started'),
      coverage('opt', 'optional', 'covered'),
    ];
    const fallbacks = [
      fallback('opt q', ['opt']),
      fallback('must q', ['must']),
      fallback('should q', ['should']),
    ];

    const ranked = rankFallbacks(fallbacks, emptyCtx({ coverage: cov }));
    expect(ranked.map((r) => r.question.text)).toEqual(['must q', 'should q', 'opt q']);
    const scores = ranked.map((r) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('returns an empty array for no fallbacks', () => {
    expect(rankFallbacks([], emptyCtx())).toEqual([]);
  });
});

describe('pickFallback', () => {
  it('returns the highest-scoring usable fallback', () => {
    const cov = [
      coverage('must', 'must', 'not_started'),
      coverage('opt', 'optional', 'not_started'),
    ];
    const fallbacks = [
      fallback('optional q', ['opt']),
      fallback('must q', ['must']),
    ];

    const picked = pickFallback(fallbacks, emptyCtx({ coverage: cov }));
    expect(picked?.text).toBe('must q');
  });

  it('excludes an already-used fallback even if it would score highest', () => {
    const cov = [
      coverage('must', 'must', 'not_started'),
      coverage('should', 'should', 'not_started'),
    ];
    const fallbacks = [
      fallback('must q', ['must']),
      fallback('should q', ['should']),
    ];

    const picked = pickFallback(
      fallbacks,
      emptyCtx({ coverage: cov, usedFallbackTexts: ['must q'] }),
    );
    expect(picked?.text).toBe('should q');
  });

  it('skips fallbacks whose targets are all covered', () => {
    const cov = [
      coverage('covered', 'must', 'covered'),
      coverage('open', 'optional', 'not_started'),
    ];
    const fallbacks = [
      fallback('covered must q', ['covered']),
      fallback('open optional q', ['open']),
    ];

    const picked = pickFallback(fallbacks, emptyCtx({ coverage: cov }));
    expect(picked?.text).toBe('open optional q');
  });

  it('returns null when all targets are already covered', () => {
    const cov = [
      coverage('a', 'must', 'covered'),
      coverage('b', 'should', 'covered'),
    ];
    const fallbacks = [
      fallback('a q', ['a']),
      fallback('b q', ['b']),
    ];

    expect(pickFallback(fallbacks, emptyCtx({ coverage: cov }))).toBeNull();
  });

  it('returns null when every usable fallback has already been used', () => {
    const cov = [coverage('a', 'must', 'not_started')];
    const fallbacks = [fallback('a q', ['a'])];

    expect(
      pickFallback(fallbacks, emptyCtx({ coverage: cov, usedFallbackTexts: ['a q'] })),
    ).toBeNull();
  });

  it('returns null when a fallback targets a non-existent coverage item', () => {
    const cov = [coverage('real', 'must', 'not_started')];
    const fallbacks = [fallback('ghost q', ['ghost'])];

    // No resolvable target → no uncovered target → not usable.
    expect(pickFallback(fallbacks, emptyCtx({ coverage: cov }))).toBeNull();
  });

  it('returns null for no fallbacks', () => {
    expect(pickFallback([], emptyCtx())).toBeNull();
  });
});

describe('isRepeat', () => {
  it('flags an identical recent question as a repeat', () => {
    const q = 'What first drew you to underwater photography?';
    expect(isRepeat(q, [q])).toBe(true);
  });

  it('does not flag a clearly distinct question', () => {
    expect(
      isRepeat('What first drew you to underwater photography?', [
        'How do you fund your expeditions to remote regions?',
      ]),
    ).toBe(false);
  });

  it('returns false when there are no recent questions', () => {
    expect(isRepeat('Any question at all here?', [])).toBe(false);
  });

  it('checks every recent question and flags when one is similar', () => {
    const q = 'Describe the moment you realised the experiment had failed completely.';
    const recents = [
      'What did you have for breakfast?',
      'Describe the moment you realised the experiment had failed completely.',
    ];
    expect(isRepeat(q, recents)).toBe(true);
  });

  it('requires similarity strictly above 0.8 (boundary is not a repeat)', () => {
    // A near-identical question that shares most but not all content. The exact
    // similarity stays at/under 0.8 so it should not flag.
    const q = 'one two three four five';
    const recent = 'one two three four six';
    // High but not extreme overlap; assert it is treated as below threshold.
    expect(isRepeat(q, [recent])).toBe(false);
  });
});
