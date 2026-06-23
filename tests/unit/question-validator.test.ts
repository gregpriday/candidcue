import { describe, expect, it } from 'vitest';
import {
  deterministicRepair,
  validateQuestion,
  type QuestionValidationInput,
} from '@main/interview/question-validator';
import { RUNTIME_DEFAULTS } from '@shared/constants/runtime-defaults';
import { estimateSpeechMs, wordCount } from '@shared/utils';

/** Build a fully-valid input, overridable per-test. */
function makeInput(overrides: Partial<QuestionValidationInput> = {}): QuestionValidationInput {
  return {
    spokenText: 'What changed after launch?',
    action: 'ask',
    targetCoverageItemIds: [],
    validCoverageIds: [],
    recentQuestions: [],
    ...overrides,
  };
}

describe('validateQuestion', () => {
  it('accepts a well-formed short question', () => {
    const result = validateQuestion(makeInput());
    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('reports wordCount and estimatedDurationMs consistently with the spine helpers', () => {
    const spokenText = 'What changed after the product launch last spring?';
    const result = validateQuestion(makeInput({ spokenText }));
    const expectedWords = wordCount(spokenText);
    expect(result.wordCount).toBe(expectedWords);
    expect(result.estimatedDurationMs).toBe(
      estimateSpeechMs(expectedWords, RUNTIME_DEFAULTS.defaultWordsPerSecond),
    );
  });

  it('honors a custom wordsPerSecond for duration', () => {
    const spokenText = 'What changed after launch?';
    const result = validateQuestion(makeInput({ spokenText, wordsPerSecond: 1 }));
    expect(result.estimatedDurationMs).toBe(estimateSpeechMs(wordCount(spokenText), 1));
  });

  describe('empty', () => {
    it('flags an empty ask', () => {
      const result = validateQuestion(makeInput({ spokenText: '   ', action: 'ask' }));
      expect(result.valid).toBe(false);
      expect(result.violations).toContain('empty');
    });

    it('allows empty text when action is complete', () => {
      const result = validateQuestion(makeInput({ spokenText: '', action: 'complete' }));
      expect(result.valid).toBe(true);
      expect(result.violations).toEqual([]);
      expect(result.wordCount).toBe(0);
    });
  });

  describe('too_many_words', () => {
    it('rejects a question with 43+ words', () => {
      // 43 words, ending in a single '?'.
      const words = Array.from({ length: 42 }, (_, i) => `word${i}`).join(' ');
      const spokenText = `${words} really?`;
      expect(wordCount(spokenText)).toBe(43);
      const result = validateQuestion(makeInput({ spokenText }));
      expect(result.violations).toContain('too_many_words');
      expect(result.valid).toBe(false);
    });

    it('accepts a question exactly at the default max word count', () => {
      const words = Array.from({ length: 41 }, (_, i) => `word${i}`).join(' ');
      const spokenText = `${words} really?`;
      expect(wordCount(spokenText)).toBe(RUNTIME_DEFAULTS.maxQuestionWords);
      const result = validateQuestion(makeInput({ spokenText }));
      expect(result.violations).not.toContain('too_many_words');
    });

    it('respects a custom maxWords', () => {
      const result = validateQuestion(
        makeInput({ spokenText: 'one two three four five?', maxWords: 4 }),
      );
      expect(result.violations).toContain('too_many_words');
    });
  });

  describe('multiple_question_marks', () => {
    it('rejects two question marks', () => {
      const result = validateQuestion(
        makeInput({ spokenText: 'What happened? And then what?' }),
      );
      expect(result.violations).toContain('multiple_question_marks');
      expect(result.valid).toBe(false);
    });

    it('allows a single question mark', () => {
      const result = validateQuestion(makeInput({ spokenText: 'What happened next?' }));
      expect(result.violations).not.toContain('multiple_question_marks');
    });
  });

  describe('no_question_when_action_ask', () => {
    it('flags an ask that does not end with a question mark', () => {
      const result = validateQuestion(
        makeInput({ spokenText: 'Tell me about the launch.', action: 'ask' }),
      );
      expect(result.violations).toContain('no_question_when_action_ask');
    });

    it('does not flag a complete action without a question mark', () => {
      const result = validateQuestion(
        makeInput({ spokenText: 'Thanks, that wraps things up.', action: 'complete' }),
      );
      expect(result.violations).not.toContain('no_question_when_action_ask');
    });
  });

  describe('markdown', () => {
    it('rejects asterisks/bold markup', () => {
      const result = validateQuestion(makeInput({ spokenText: 'What **really** changed?' }));
      expect(result.violations).toContain('markdown');
    });

    it('rejects heading markup', () => {
      const result = validateQuestion(makeInput({ spokenText: '# What changed after launch?' }));
      expect(result.violations).toContain('markdown');
    });

    it('rejects backticks and underscores', () => {
      const tick = validateQuestion(makeInput({ spokenText: 'What did `npm` do?' }));
      expect(tick.violations).toContain('markdown');
      const underscore = validateQuestion(makeInput({ spokenText: 'What _exactly_ changed?' }));
      expect(underscore.violations).toContain('markdown');
    });

    it('does not flag a plain question with normal punctuation', () => {
      const result = validateQuestion(
        makeInput({ spokenText: "What changed, exactly, after launch?" }),
      );
      expect(result.violations).not.toContain('markdown');
    });
  });

  describe('contains_stage_direction', () => {
    it('rejects a parenthetical stage direction', () => {
      const result = validateQuestion(makeInput({ spokenText: '(smiles) What changed?' }));
      expect(result.violations).toContain('contains_stage_direction');
    });

    it('rejects a bracketed stage direction', () => {
      const result = validateQuestion(makeInput({ spokenText: 'What changed [laughs]?' }));
      expect(result.violations).toContain('contains_stage_direction');
    });
  });

  describe('mentions_internal_system', () => {
    it('flags an internal term phrase', () => {
      const result = validateQuestion(
        makeInput({ spokenText: 'What is the next coverage item to discuss?' }),
      );
      expect(result.violations).toContain('mentions_internal_system');
    });

    it('matches internal terms case-insensitively', () => {
      const result = validateQuestion(
        makeInput({ spokenText: 'Did the State Machine recover after the crash?' }),
      );
      expect(result.violations).toContain('mentions_internal_system');
    });

    it('does NOT flag the ordinary word "transcript"', () => {
      const result = validateQuestion(
        makeInput({ spokenText: 'What did the transcript miss about launch?' }),
      );
      expect(result.violations).not.toContain('mentions_internal_system');
    });

    it('does NOT flag the ordinary word "AI"', () => {
      const result = validateQuestion(
        makeInput({ spokenText: 'How did AI change your workflow after launch?' }),
      );
      expect(result.violations).not.toContain('mentions_internal_system');
      expect(result.valid).toBe(true);
    });
  });

  describe('repeats_recent_question', () => {
    it('detects a near-repeat of a recent question', () => {
      const result = validateQuestion(
        makeInput({
          spokenText: 'What changed after the product launch?',
          // Differs only by a trailing stop word — lexically near-identical.
          recentQuestions: ['What changed after the product launch then?'],
        }),
      );
      expect(result.violations).toContain('repeats_recent_question');
    });

    it('does not flag a genuinely different question', () => {
      const result = validateQuestion(
        makeInput({
          spokenText: 'How did the team celebrate the win?',
          recentQuestions: ['What changed after the product launch last year?'],
        }),
      );
      expect(result.violations).not.toContain('repeats_recent_question');
    });

    it('only compares the last five recent questions', () => {
      // This near-identical question sits 6th from the end, outside the window.
      const recentQuestions = [
        'What changed after the product launch then?',
        'q1 alpha beta gamma',
        'q2 delta epsilon zeta',
        'q3 eta theta iota',
        'q4 kappa lambda mu',
        'q5 nu xi omicron',
      ];
      const result = validateQuestion(
        makeInput({ spokenText: 'What changed after the product launch?', recentQuestions }),
      );
      expect(result.violations).not.toContain('repeats_recent_question');
    });

    it('detects a near-repeat that falls within the last five', () => {
      const recentQuestions = [
        'q1 alpha beta gamma',
        'q2 delta epsilon zeta',
        'q3 eta theta iota',
        'q4 kappa lambda mu',
        'What changed after the product launch then?',
      ];
      const result = validateQuestion(
        makeInput({ spokenText: 'What changed after the product launch?', recentQuestions }),
      );
      expect(result.violations).toContain('repeats_recent_question');
    });
  });

  describe('invalid_coverage_id', () => {
    it('enforces valid coverage IDs', () => {
      const result = validateQuestion(
        makeInput({
          targetCoverageItemIds: ['cov_1', 'cov_missing'],
          validCoverageIds: ['cov_1', 'cov_2'],
        }),
      );
      expect(result.violations).toContain('invalid_coverage_id');
    });

    it('passes when all targeted IDs are valid', () => {
      const result = validateQuestion(
        makeInput({
          targetCoverageItemIds: ['cov_1', 'cov_2'],
          validCoverageIds: ['cov_1', 'cov_2', 'cov_3'],
        }),
      );
      expect(result.violations).not.toContain('invalid_coverage_id');
    });

    it('passes with no targeted IDs', () => {
      const result = validateQuestion(
        makeInput({ targetCoverageItemIds: [], validCoverageIds: [] }),
      );
      expect(result.violations).not.toContain('invalid_coverage_id');
    });
  });

  describe('acknowledgment plus question', () => {
    it('allows a short acknowledgment followed by exactly one question', () => {
      const result = validateQuestion(makeInput({ spokenText: 'Got it. What changed after launch?' }));
      expect(result.valid).toBe(true);
      expect(result.violations).toEqual([]);
    });
  });

  it('accumulates multiple violations', () => {
    const result = validateQuestion(
      makeInput({
        spokenText: 'What changed? (smiles) **bold**?',
        action: 'ask',
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toContain('multiple_question_marks');
    expect(result.violations).toContain('contains_stage_direction');
    expect(result.violations).toContain('markdown');
  });
});

describe('deterministicRepair', () => {
  it('shortens an overlong line to <= maxWords ending in a single "?"', () => {
    const longLine =
      'I really appreciate you sharing all of that context with me today, ' +
      'and I am curious to understand much more deeply about what specifically ' +
      'changed across your entire engineering organization after the big launch ' +
      'event happened last spring and how the team responded to it?';
    const maxWords = RUNTIME_DEFAULTS.maxQuestionWords;
    expect(wordCount(longLine)).toBeGreaterThan(maxWords);

    const repaired = deterministicRepair(longLine, maxWords);
    expect(wordCount(repaired)).toBeLessThanOrEqual(maxWords);
    expect(repaired.endsWith('?')).toBe(true);
    expect((repaired.match(/\?/g) ?? []).length).toBe(1);
  });

  it('drops a leading acknowledgment and keeps the final question', () => {
    const input = 'Got it, that makes a lot of sense. What changed after launch?';
    const repaired = deterministicRepair(input);
    expect(repaired.toLowerCase()).toContain('what changed after launch');
    expect(repaired.toLowerCase()).not.toContain('got it');
    expect(repaired.endsWith('?')).toBe(true);
  });

  it('collapses multiple question marks into one', () => {
    const repaired = deterministicRepair('What happened? And then what?');
    expect((repaired.match(/\?/g) ?? []).length).toBe(1);
    expect(repaired.endsWith('?')).toBe(true);
  });

  it('strips markup and stage directions', () => {
    const repaired = deterministicRepair('(leans in) What **really** changed after launch?');
    expect(repaired).not.toMatch(/[*()]/);
    expect(repaired.endsWith('?')).toBe(true);
  });

  it('a repaired overlong line passes validation', () => {
    const longLine =
      'I really appreciate you sharing all of that context with me today, ' +
      'and I am curious to understand much more about what specifically ' +
      'changed across your engineering organization after the big launch ' +
      'happened last spring and how the team responded to it?';
    const repaired = deterministicRepair(longLine);
    const result = validateQuestion(
      makeInput({ spokenText: repaired, action: 'ask' }),
    );
    expect(result.violations).not.toContain('too_many_words');
    expect(result.violations).not.toContain('no_question_when_action_ask');
    expect(result.violations).not.toContain('multiple_question_marks');
  });

  it('returns an empty string for empty input', () => {
    expect(deterministicRepair('')).toBe('');
    expect(deterministicRepair('   ')).toBe('');
  });

  it('leaves an already-short question essentially intact', () => {
    const repaired = deterministicRepair('What changed after launch?');
    expect(repaired).toBe('What changed after launch?');
  });
});
