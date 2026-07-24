/**
 * Suppression rules (§25.5: "show only after final/highly stable evidence",
 * "suppress when a self-correction is underway").
 *
 * Each suppression test is paired with a **control** built from the same script
 * and a spoken reading that differs only by the thing being tested. The control
 * asserts a candidate *is* produced. Without that pairing a suppression test
 * proves nothing — it would pass just as happily against a comparator that
 * never fired at all.
 */
import { describe, expect, it } from 'vitest';
import { compareSpanFidelity } from '../../../../src/shared/coaching/fidelity/comparator';
import { makeSpan, type SpanOptions } from './harness';

const NUMBER_SCRIPT = 'That is 1,500 customers signed up already this month.';
const NUMBER_MISREAD = 'That is fifteen thousand customers signed up already this month.';

const NEGATION_SCRIPT = 'The results are not final at this stage of the review.';
const NEGATION_MISREAD = 'The results are final at this stage of the review.';

function verdicts(script: string, spoken: string, options?: SpanOptions): string[] {
  return compareSpanFidelity(makeSpan(script, spoken, options)).verdicts.map(
    (entry) => `${entry.term.kind}=${entry.verdict}`,
  );
}

describe('self-correction suppression', () => {
  it('control: the uncorrected misreading does produce a candidate', () => {
    const result = compareSpanFidelity(makeSpan(NUMBER_SCRIPT, NUMBER_MISREAD));
    expect(result.candidates.map((candidate) => candidate.type)).toEqual([
      'critical_number_mismatch',
    ]);
  });

  it('suppresses a number mismatch corrected a few words later', () => {
    const spoken =
      'That is fifteen thousand customers, sorry, fifteen hundred customers signed up already this month.';
    const result = compareSpanFidelity(makeSpan(NUMBER_SCRIPT, spoken));
    expect(result.candidates).toEqual([]);
    // Specifically the self-correction path, not "the term was never found".
    expect(verdicts(NUMBER_SCRIPT, spoken)).toContain('number=suppressed_self_correction');
  });

  it('control: the uncorrected dropped negation does produce a candidate', () => {
    const result = compareSpanFidelity(makeSpan(NEGATION_SCRIPT, NEGATION_MISREAD));
    expect(result.candidates.map((candidate) => candidate.type)).toEqual([
      'critical_negation_mismatch',
    ]);
  });

  it('suppresses a dropped negation the presenter corrects with an apology', () => {
    const spoken =
      'The results are final at this stage, sorry, they aren’t final at this stage of the review.';
    const result = compareSpanFidelity(makeSpan(NEGATION_SCRIPT, spoken));
    expect(result.candidates).toEqual([]);
    expect(verdicts(NEGATION_SCRIPT, spoken)).toContain('negation=suppressed_self_correction');
  });

  it('still reports a dropped negation when a later negation carries no correction cue', () => {
    // A recurring "not" eight words downstream is ordinary English, not a
    // retraction. Treating it as one would silence the class almost entirely.
    const spoken =
      'The results are final at this stage, they aren’t final at this stage of the review.';
    const result = compareSpanFidelity(makeSpan(NEGATION_SCRIPT, spoken));
    expect(result.candidates.map((candidate) => candidate.type)).toEqual([
      'critical_negation_mismatch',
    ]);
  });
});

describe('provisional evidence suppression', () => {
  it('control: with a fully final transcript the mismatch is reported', () => {
    const result = compareSpanFidelity(makeSpan(NUMBER_SCRIPT, NUMBER_MISREAD));
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.finalEvidence).toBe(true);
  });

  it('reports the mismatch with exactly the minimum final speech beyond it', () => {
    // Three provisional trailing tokens still leaves two final tokens past the
    // term — the floor at which a correction would already have been seen.
    const result = compareSpanFidelity(
      makeSpan(NUMBER_SCRIPT, NUMBER_MISREAD, { provisionalTailTokens: 3 }),
    );
    expect(result.candidates).toHaveLength(1);
  });

  it('suppresses when too little final speech follows the term', () => {
    const options = { provisionalTailTokens: 4 };
    const result = compareSpanFidelity(makeSpan(NUMBER_SCRIPT, NUMBER_MISREAD, options));
    expect(result.candidates).toEqual([]);
    expect(verdicts(NUMBER_SCRIPT, NUMBER_MISREAD, options)).toContain(
      'number=suppressed_provisional',
    );
  });

  it('suppresses when the compared window itself is still provisional', () => {
    const options = { provisionalTailTokens: 8 };
    const result = compareSpanFidelity(makeSpan(NUMBER_SCRIPT, NUMBER_MISREAD, options));
    expect(result.candidates).toEqual([]);
    expect(verdicts(NUMBER_SCRIPT, NUMBER_MISREAD, options)).toContain(
      'number=suppressed_provisional',
    );
  });

  it('never emits a candidate carrying finalEvidence false', () => {
    for (const tail of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
      const result = compareSpanFidelity(
        makeSpan(NUMBER_SCRIPT, NUMBER_MISREAD, { provisionalTailTokens: tail }),
      );
      for (const candidate of result.candidates) {
        expect(candidate.finalEvidence).toBe(true);
      }
    }
  });
});

describe('anchoring gates', () => {
  it('reports nothing when the aligner produced no pairings at all', () => {
    const result = compareSpanFidelity(
      makeSpan(NUMBER_SCRIPT, NUMBER_MISREAD, { alignment: [] }),
    );
    expect(result.candidates).toEqual([]);
  });

  it('reports nothing when the presenter ad-libbed far more than the script said', () => {
    // The anchored gap exceeds the window bound, so we no longer know which of
    // the spoken numbers was meant to be the authored one.
    const spoken =
      'That is roughly somewhere in the region of maybe fifteen or twenty thousand or so customers signed up already this month.';
    const result = compareSpanFidelity(makeSpan(NUMBER_SCRIPT, spoken));
    expect(result.candidates).toEqual([]);
    expect(verdicts(NUMBER_SCRIPT, spoken)).toContain('number=unknown');
  });

  it('reports nothing when nothing follows the term in the transcript yet', () => {
    const result = compareSpanFidelity(makeSpan(NUMBER_SCRIPT, 'That is fifteen thousand'));
    expect(result.candidates).toEqual([]);
  });
});
