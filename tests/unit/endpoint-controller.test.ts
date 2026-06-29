import type { EndpointDecision } from '@shared/domain';
import { RUNTIME_DEFAULTS } from '@shared/constants/runtime-defaults';
import {
  autoCommitAllowed,
  endsWithContinuation,
  shouldRunClassifier,
  decideEndpoint,
} from '@main/interview/endpoint-controller';

/** Build an EndpointDecision with sensible defaults. */
function decision(overrides: Partial<EndpointDecision> = {}): EndpointDecision {
  return {
    shouldCommit: true,
    completeProbability: 0.95,
    incompleteReason: 'none',
    ...overrides,
  };
}

describe('autoCommitAllowed', () => {
  it('is false for manual mode', () => {
    expect(autoCommitAllowed('manual')).toBe(false);
  });

  it('is true for conservative and balanced modes', () => {
    expect(autoCommitAllowed('conservative')).toBe(true);
    expect(autoCommitAllowed('balanced')).toBe(true);
  });
});

describe('endsWithContinuation', () => {
  it('detects a trailing continuation word ("and")', () => {
    expect(endsWithContinuation('I went to the store and')).toBe(true);
  });

  it('detects a trailing continuation word ("because")', () => {
    expect(endsWithContinuation('It mattered because')).toBe(true);
  });

  it('detects a trailing continuation phrase ("for example")', () => {
    expect(endsWithContinuation('There are many cases, for example')).toBe(true);
  });

  it('detects a trailing phrase that itself ends in a continuation word', () => {
    expect(endsWithContinuation('The reason is')).toBe(true);
  });

  it('ignores trailing punctuation after the continuation word', () => {
    expect(endsWithContinuation('I was thinking, and...')).toBe(true);
  });

  it('detects a trailing phrase even with trailing punctuation', () => {
    expect(endsWithContinuation('There are many cases, for example.')).toBe(true);
    expect(endsWithContinuation('The reason is...')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(endsWithContinuation('We talked AND')).toBe(true);
    expect(endsWithContinuation('FOR EXAMPLE')).toBe(true);
  });

  it('returns false for a completed sentence', () => {
    expect(endsWithContinuation('That is my final answer.')).toBe(false);
  });

  it('returns false for an empty or whitespace transcript', () => {
    expect(endsWithContinuation('')).toBe(false);
    expect(endsWithContinuation('   ')).toBe(false);
  });

  it('does not flag a continuation word that is not the last word', () => {
    expect(endsWithContinuation('and then it was done')).toBe(false);
  });
});

describe('shouldRunClassifier', () => {
  const base = {
    mode: 'balanced' as const,
    silenceMs: 1000,
    speechMs: 2000,
    transcript: 'A real answer here',
    commitInFlight: false,
  };

  it('is false for manual mode', () => {
    expect(shouldRunClassifier({ ...base, mode: 'manual' })).toBe(false);
  });

  it('is false when a commit is already in flight', () => {
    expect(shouldRunClassifier({ ...base, commitInFlight: true })).toBe(false);
  });

  it('is false when the transcript is empty or whitespace', () => {
    expect(shouldRunClassifier({ ...base, transcript: '' })).toBe(false);
    expect(shouldRunClassifier({ ...base, transcript: '   ' })).toBe(false);
  });

  it('is false when speech is shorter than 1500ms', () => {
    expect(shouldRunClassifier({ ...base, speechMs: 1499 })).toBe(false);
    expect(shouldRunClassifier({ ...base, speechMs: 1500 })).toBe(true);
  });

  it('requires silence to reach the balanced classification floor (900ms)', () => {
    expect(shouldRunClassifier({ ...base, silenceMs: 899 })).toBe(false);
    expect(shouldRunClassifier({ ...base, silenceMs: 900 })).toBe(true);
  });

  it('requires silence to reach the conservative classification floor (1200ms)', () => {
    const conservative = { ...base, mode: 'conservative' as const };
    expect(shouldRunClassifier({ ...conservative, silenceMs: 1199 })).toBe(false);
    expect(shouldRunClassifier({ ...conservative, silenceMs: 1200 })).toBe(true);
  });

  it('is true when every condition is satisfied', () => {
    expect(shouldRunClassifier(base)).toBe(true);
  });
});

describe('decideEndpoint', () => {
  const transcript = 'This is a complete and meaningful answer.';

  describe('manual mode', () => {
    it('never commits and reports "manual"', () => {
      const result = decideEndpoint({
        mode: 'manual',
        silenceMs: 99999,
        speechMs: 99999,
        transcript,
        classifier: decision(),
      });
      expect(result).toEqual({ commit: false, reason: 'manual' });
    });
  });

  describe('empty transcript', () => {
    it('never commits and reports "empty"', () => {
      const result = decideEndpoint({
        mode: 'balanced',
        silenceMs: 99999,
        speechMs: 5000,
        transcript: '   ',
        classifier: decision(),
      });
      expect(result).toEqual({ commit: false, reason: 'empty' });
    });

    it('reports "empty" even under hard silence', () => {
      const result = decideEndpoint({
        mode: 'balanced',
        silenceMs: RUNTIME_DEFAULTS.endpointHardSilenceMs + 1000,
        speechMs: 5000,
        transcript: '',
        classifier: null,
      });
      expect(result).toEqual({ commit: false, reason: 'empty' });
    });
  });

  describe('conservative mode classifier commit', () => {
    it('commits with prob >= 0.9 and silence >= 1900', () => {
      const result = decideEndpoint({
        mode: 'conservative',
        silenceMs: 1900,
        speechMs: 4000,
        transcript,
        classifier: decision({ shouldCommit: true, completeProbability: 0.9 }),
      });
      expect(result).toEqual({ commit: true, reason: 'classifier' });
    });

    it('does not commit when probability is below 0.9', () => {
      const result = decideEndpoint({
        mode: 'conservative',
        silenceMs: 1900,
        speechMs: 4000,
        transcript,
        classifier: decision({ shouldCommit: true, completeProbability: 0.89 }),
      });
      expect(result.commit).toBe(false);
      expect(result.reason).toBe('wait');
    });

    it('does not commit when silence is below 1900', () => {
      const result = decideEndpoint({
        mode: 'conservative',
        silenceMs: 1899,
        speechMs: 4000,
        transcript,
        classifier: decision({ shouldCommit: true, completeProbability: 0.95 }),
      });
      expect(result.commit).toBe(false);
      expect(result.reason).toBe('wait');
    });

    it('does not commit when the classifier declined to commit', () => {
      const result = decideEndpoint({
        mode: 'conservative',
        silenceMs: 2500,
        speechMs: 4000,
        transcript,
        classifier: decision({ shouldCommit: false, completeProbability: 0.95 }),
      });
      expect(result.commit).toBe(false);
    });
  });

  describe('balanced mode classifier commit', () => {
    it('commits with prob >= 0.82 and silence >= 1500', () => {
      const result = decideEndpoint({
        mode: 'balanced',
        silenceMs: 1500,
        speechMs: 4000,
        transcript,
        classifier: decision({ shouldCommit: true, completeProbability: 0.82 }),
      });
      expect(result).toEqual({ commit: true, reason: 'classifier' });
    });

    it('does not commit when probability is below 0.82', () => {
      const result = decideEndpoint({
        mode: 'balanced',
        silenceMs: 1500,
        speechMs: 4000,
        transcript,
        classifier: decision({ shouldCommit: true, completeProbability: 0.81 }),
      });
      expect(result.commit).toBe(false);
      expect(result.reason).toBe('wait');
    });

    it('does not commit when silence is below 1500', () => {
      const result = decideEndpoint({
        mode: 'balanced',
        silenceMs: 1499,
        speechMs: 4000,
        transcript,
        classifier: decision({ shouldCommit: true, completeProbability: 0.95 }),
      });
      expect(result.commit).toBe(false);
      expect(result.reason).toBe('wait');
    });
  });

  describe('hard silence', () => {
    const hard = RUNTIME_DEFAULTS.endpointHardSilenceMs;

    it('balanced commits any non-empty transcript on hard silence', () => {
      const result = decideEndpoint({
        mode: 'balanced',
        silenceMs: hard,
        speechMs: 3000,
        transcript,
        classifier: null,
      });
      expect(result).toEqual({ commit: true, reason: 'hard_silence' });
    });

    it('balanced does NOT force commit when classifier is explicitly incomplete', () => {
      const result = decideEndpoint({
        mode: 'balanced',
        silenceMs: hard,
        speechMs: 3000,
        transcript,
        classifier: decision({ shouldCommit: false, completeProbability: 0.3 }),
      });
      expect(result.commit).toBe(false);
      expect(result.reason).toBe('wait');
    });

    it('conservative waits on hard silence without a high-confidence classifier', () => {
      const result = decideEndpoint({
        mode: 'conservative',
        silenceMs: hard,
        speechMs: 3000,
        transcript,
        classifier: null,
      });
      expect(result.commit).toBe(false);
      expect(result.reason).toBe('wait');
    });

    it('conservative waits on hard silence when the classifier is low-confidence', () => {
      const result = decideEndpoint({
        mode: 'conservative',
        silenceMs: hard,
        speechMs: 3000,
        transcript,
        classifier: decision({ shouldCommit: true, completeProbability: 0.7 }),
      });
      expect(result.commit).toBe(false);
      expect(result.reason).toBe('wait');
    });

    it('conservative force-commits on hard silence with a prior high-confidence completion', () => {
      // Hard silence is well past the 1900ms total floor, so this would also
      // resolve via the classifier path; the resulting commit is what matters.
      const result = decideEndpoint({
        mode: 'conservative',
        silenceMs: hard,
        speechMs: 3000,
        transcript,
        classifier: decision({ shouldCommit: true, completeProbability: 0.95 }),
      });
      expect(result.commit).toBe(true);
    });
  });

  describe('too short', () => {
    it('reports "too_short" for sub-1200ms speech before the silence floor with no confident completion', () => {
      // Below balanced's 1500ms natural floor the short-answer fast path does not
      // fire, so a stray blip is still held back as "too_short".
      const result = decideEndpoint({
        mode: 'balanced',
        silenceMs: 1000,
        speechMs: 800,
        transcript: 'um',
        classifier: null,
      });
      expect(result).toEqual({ commit: false, reason: 'too_short' });
    });

    it('reports "too_short" when a low-confidence classifier accompanies short speech', () => {
      const result = decideEndpoint({
        mode: 'balanced',
        silenceMs: 1500,
        speechMs: 1000,
        transcript: 'yes',
        classifier: decision({ shouldCommit: false, completeProbability: 0.4 }),
      });
      expect(result.reason).toBe('too_short');
    });

    it('still commits short speech when the classifier is highly confident', () => {
      const result = decideEndpoint({
        mode: 'balanced',
        silenceMs: 1500,
        speechMs: 800,
        transcript: 'Absolutely, yes.',
        classifier: decision({ shouldCommit: true, completeProbability: 0.95 }),
      });
      expect(result).toEqual({ commit: true, reason: 'classifier' });
    });
  });

  describe('short answer fast path', () => {
    const hard = RUNTIME_DEFAULTS.endpointHardSilenceMs;

    it('commits a short "Yes" at the conservative natural silence floor', () => {
      const result = decideEndpoint({
        mode: 'conservative',
        silenceMs: 1900,
        speechMs: 500,
        transcript: 'Yes',
        classifier: null,
      });
      expect(result).toEqual({ commit: true, reason: 'short_answer' });
    });

    it('commits a short "Three years" at the conservative floor', () => {
      const result = decideEndpoint({
        mode: 'conservative',
        silenceMs: 1900,
        speechMs: 700,
        transcript: 'Three years',
        classifier: null,
      });
      expect(result).toEqual({ commit: true, reason: 'short_answer' });
    });

    it('commits a short answer at the lower balanced floor (1500ms)', () => {
      const result = decideEndpoint({
        mode: 'balanced',
        silenceMs: 1500,
        speechMs: 600,
        transcript: 'Right',
        classifier: null,
      });
      expect(result).toEqual({ commit: true, reason: 'short_answer' });
    });

    it('commits a 1200-1499ms answer that is real but too brief to classify', () => {
      const result = decideEndpoint({
        mode: 'conservative',
        silenceMs: 1900,
        speechMs: 1400,
        transcript: 'I would say yes',
        classifier: null,
      });
      expect(result).toEqual({ commit: true, reason: 'short_answer' });
    });

    it('previously hung forever — now commits a short answer even at hard silence', () => {
      const result = decideEndpoint({
        mode: 'conservative',
        silenceMs: hard,
        speechMs: 500,
        transcript: 'Yes',
        classifier: null,
      });
      expect(result).toEqual({ commit: true, reason: 'short_answer' });
    });

    it('waits below the silence floor instead of fast-committing', () => {
      const result = decideEndpoint({
        mode: 'conservative',
        silenceMs: 1899,
        speechMs: 500,
        transcript: 'Yes',
        classifier: null,
      });
      expect(result).toEqual({ commit: false, reason: 'too_short' });
    });

    it('does not fast-commit when the classifier explicitly judged the answer incomplete', () => {
      const result = decideEndpoint({
        mode: 'conservative',
        silenceMs: 1900,
        speechMs: 800,
        transcript: 'Yes',
        classifier: decision({ shouldCommit: false, completeProbability: 0.3 }),
      });
      expect(result).toEqual({ commit: false, reason: 'too_short' });
    });

    it('does not fast-commit speech long enough to classify (classifier path owns it)', () => {
      // At exactly the classification gate the fast path no longer applies; a
      // null classifier here means the classifier should have run, so we wait
      // rather than commit blindly.
      const result = decideEndpoint({
        mode: 'conservative',
        silenceMs: 1900,
        speechMs: 1500,
        transcript: 'This is a complete and meaningful answer.',
        classifier: null,
      });
      expect(result).toEqual({ commit: false, reason: 'wait' });
    });

    it('commits even a filler blip at the floor — duration cannot tell "um" from "Yes"', () => {
      // Accepted tradeoff (#54): a sub-MIN_MEANINGFUL_SPEECH_MS reply that the
      // blip guard would normally drop still commits once silence reaches the
      // floor, because a real short answer and a filler are indistinguishable by
      // speech duration alone. Step 2 already discards a truly empty transcript.
      const result = decideEndpoint({
        mode: 'balanced',
        silenceMs: 1500,
        speechMs: 800,
        transcript: 'um',
        classifier: null,
      });
      expect(result).toEqual({ commit: true, reason: 'short_answer' });
    });

    it('does not fast-commit a 1200-1499ms answer the classifier judged incomplete', () => {
      // 1400ms is above the blip guard, so this falls through to the default
      // wait (not too_short) once the explicit-incomplete verdict blocks the
      // fast path.
      const result = decideEndpoint({
        mode: 'conservative',
        silenceMs: 1900,
        speechMs: 1400,
        transcript: 'I would say',
        classifier: decision({ shouldCommit: false, completeProbability: 0.3 }),
      });
      expect(result).toEqual({ commit: false, reason: 'wait' });
    });
  });

  describe('continuation hold', () => {
    const hard = RUNTIME_DEFAULTS.endpointHardSilenceMs;

    it('holds back the short-answer fast path when the turn trails off mid-thought', () => {
      // Brief speech at the natural floor would normally short_answer-commit, but
      // the dangling "and" keeps the turn open (spec §14.3).
      const result = decideEndpoint({
        mode: 'balanced',
        silenceMs: 1500,
        speechMs: 600,
        transcript: 'I was thinking, and',
        classifier: null,
      });
      expect(result).toEqual({ commit: false, reason: 'continuation_hold' });
    });

    it('holds back the balanced hard-silence commit on a dangling conjunction (the issue scenario)', () => {
      // The exact bug from #55: a respondent trailing off on "because" was
      // force-committed at the hard-silence ceiling; now the turn is held.
      const result = decideEndpoint({
        mode: 'balanced',
        silenceMs: hard,
        speechMs: 3000,
        transcript: 'because',
        classifier: null,
      });
      expect(result).toEqual({ commit: false, reason: 'continuation_hold' });
    });

    it('never overrides a high-confidence classifier, even with a trailing continuation', () => {
      // Spec §14.3: the hint only suppresses *borderline* commits. A confident
      // completion (step 3) wins despite the dangling "and".
      const result = decideEndpoint({
        mode: 'balanced',
        silenceMs: 1500,
        speechMs: 4000,
        transcript: 'I absolutely agree and',
        classifier: decision({ shouldCommit: true, completeProbability: 0.82 }),
      });
      expect(result).toEqual({ commit: true, reason: 'classifier' });
    });

    it('a confident conservative completion still commits despite a trailing continuation', () => {
      // The conservative hard-silence branch is guarded too, but the classifier
      // path (step 3) intercepts at the 1900ms total floor — so a confident
      // completion commits as 'classifier' rather than holding.
      const result = decideEndpoint({
        mode: 'conservative',
        silenceMs: hard,
        speechMs: 3000,
        transcript: 'We discussed and',
        classifier: decision({ shouldCommit: true, completeProbability: 0.95 }),
      });
      expect(result).toEqual({ commit: true, reason: 'classifier' });
    });

    it('still short_answer-commits a complete brief reply that does not trail off', () => {
      // Regression guard: the continuation check must not block ordinary commits.
      const result = decideEndpoint({
        mode: 'balanced',
        silenceMs: 1500,
        speechMs: 600,
        transcript: 'Yes',
        classifier: null,
      });
      expect(result).toEqual({ commit: true, reason: 'short_answer' });
    });

    it('still hard-silence-commits a complete reply that does not trail off', () => {
      // Regression guard for the balanced hard-silence branch.
      const result = decideEndpoint({
        mode: 'balanced',
        silenceMs: hard,
        speechMs: 3000,
        transcript: 'That is my final answer',
        classifier: null,
      });
      expect(result).toEqual({ commit: true, reason: 'hard_silence' });
    });

    it('is a hint, not a decider — below the silence floor it never holds on its own', () => {
      // The continuation guard only fires inside a commit branch. Below the
      // floor there is no commit to suppress, so a trailing "because" falls
      // through to the ordinary blip handling, not 'continuation_hold'.
      const result = decideEndpoint({
        mode: 'balanced',
        silenceMs: 1499,
        speechMs: 800,
        transcript: 'because',
        classifier: null,
      });
      expect(result).toEqual({ commit: false, reason: 'too_short' });
    });

    it('holds a low-confidence positive classifier at hard silence', () => {
      // A positive-but-not-confident classifier does not satisfy step 3, so the
      // balanced hard-silence branch owns the decision — and the continuation
      // guard holds it.
      const result = decideEndpoint({
        mode: 'balanced',
        silenceMs: hard,
        speechMs: 3000,
        transcript: 'because',
        classifier: decision({ shouldCommit: true, completeProbability: 0.5 }),
      });
      expect(result).toEqual({ commit: false, reason: 'continuation_hold' });
    });

    it('holds a common trailing-word answer per the current word list (known tradeoff)', () => {
      // 'so' is in CONTINUATION_WORDS, so "I think so" is held rather than
      // committed. Pinned deliberately: whether such common closers belong in
      // the list is a separate product tuning question (see #55 follow-up).
      const result = decideEndpoint({
        mode: 'balanced',
        silenceMs: 1500,
        speechMs: 600,
        transcript: 'I think so',
        classifier: null,
      });
      expect(result).toEqual({ commit: false, reason: 'continuation_hold' });
    });
  });

  describe('default wait', () => {
    it('waits when speech is meaningful but no commit condition is met', () => {
      const result = decideEndpoint({
        mode: 'balanced',
        silenceMs: 1000,
        speechMs: 2500,
        transcript,
        classifier: null,
      });
      expect(result).toEqual({ commit: false, reason: 'wait' });
    });

    it('waits when the classifier wants to commit but silence is insufficient', () => {
      const result = decideEndpoint({
        mode: 'balanced',
        silenceMs: 1200,
        speechMs: 2500,
        transcript,
        classifier: decision({ shouldCommit: true, completeProbability: 0.9 }),
      });
      expect(result).toEqual({ commit: false, reason: 'wait' });
    });
  });
});
