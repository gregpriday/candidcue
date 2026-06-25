import { describe, it, expect } from 'vitest';
import { resolveTargetQuestionCount } from '@main/app-controller';
import { APPROX_MINUTES_PER_QUESTION } from '@shared/constants/runtime-defaults';

/**
 * Both interview-target mapping sites (session setup and prepareProject) delegate
 * to resolveTargetQuestionCount, so this proves the shared conversion behaviour
 * that flows into the SessionContext.targetQuestionCount and the prepareProject
 * model input. STOPGAP: approximate_duration is translated to a question count;
 * a real elapsed-time budget is deferred.
 */
describe('resolveTargetQuestionCount', () => {
  it('passes a question_count target through unchanged (target is a count)', () => {
    expect(resolveTargetQuestionCount('question_count', 12)).toBe(12);
    expect(resolveTargetQuestionCount('question_count', 1)).toBe(1);
    expect(resolveTargetQuestionCount('question_count', 40)).toBe(40);
  });

  it('translates approximate_duration minutes to ~minutes/AVG questions', () => {
    // 20 minutes / 2 min-per-question = 10 questions (no longer treated as 20).
    expect(resolveTargetQuestionCount('approximate_duration', 20)).toBe(10);
    expect(resolveTargetQuestionCount('approximate_duration', 30)).toBe(15);
  });

  it('rounds to the nearest question and floors at 1 (never zero questions)', () => {
    expect(resolveTargetQuestionCount('approximate_duration', 5)).toBe(3); // 2.5 -> 3
    expect(resolveTargetQuestionCount('approximate_duration', 1)).toBe(1); // 0.5 -> 1, floored at 1
  });

  it('does not cap large durations — a long interview is translated, not rejected', () => {
    expect(resolveTargetQuestionCount('approximate_duration', 600)).toBe(300);
  });

  it('uses the single shared minutes-per-question constant', () => {
    expect(APPROX_MINUTES_PER_QUESTION).toBe(2);
    const minutes = 24;
    expect(resolveTargetQuestionCount('approximate_duration', minutes)).toBe(
      Math.round(minutes / APPROX_MINUTES_PER_QUESTION),
    );
  });
});
