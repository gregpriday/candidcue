/**
 * The true-positive suite.
 *
 * This is what gives the false-positive suite its meaning: a comparator that
 * never fires passes "no false positives" trivially. Every case here is a
 * genuine misreading, and the assertions pin the candidate type, the **exact**
 * authored text quoted back (§25.5), what the presenter actually said, and the
 * evidence stamp — including audio times, which must come from the spoken
 * tokens covering the window rather than from any wall clock (contract RULE 3).
 */
import { describe, expect, it } from 'vitest';
import { compareSpanFidelity } from '../../../../src/shared/coaching/fidelity/comparator';
import { makeSpan } from './harness';

describe('critical-term comparator — true positives', () => {
  it('flags a substituted percentage and quotes the authored form exactly', () => {
    const result = compareSpanFidelity(
      makeSpan(
        'We grew 50% last year across every single market.',
        'We grew fifteen percent last year across every single market.',
      ),
    );
    expect(
      result.candidates.map((candidate) => ({
        type: candidate.type,
        detailCode: candidate.detailCode,
        authoredFragment: candidate.authoredFragment,
        spokenFragment: candidate.spokenFragment,
        finalEvidence: candidate.finalEvidence,
      })),
    ).toEqual([
      {
        type: 'critical_number_mismatch',
        detailCode: 'number_substituted',
        authoredFragment: '50%',
        spokenFragment: 'fifteen',
        finalEvidence: true,
      },
    ]);
  });

  it('preserves the authored thousands separator in the quote', () => {
    const result = compareSpanFidelity(
      makeSpan(
        'That is 1,500 customers signed up already this month.',
        'That is fifteen thousand customers signed up already this month.',
      ),
    );
    const [candidate] = result.candidates;
    expect(result.candidates).toHaveLength(1);
    expect(candidate?.type).toBe('critical_number_mismatch');
    // The comma is part of the authored surface and must survive.
    expect(candidate?.authoredFragment).toBe('1,500');
    expect(candidate?.spokenFragment).toBe('fifteen thousand');
    expect(candidate?.localConfidence).toBe(0.85);
    // Audio clock: tokens 1..4 of the harness, at 1000 + index * 400 ms.
    expect(candidate?.stamp).toEqual({
      audioStartMs: 1400,
      audioEndMs: 2980,
      commitSequence: 7,
      trackingEpoch: 4,
      takePassId: 'take-a',
    });
    expect(candidate?.scriptSpanId).toBe('sentence-1');
    expect(candidate?.evidenceId).toContain('critical_number_mismatch');
  });

  it('flags a wrong year even though both readings are year-shaped', () => {
    const result = compareSpanFidelity(
      makeSpan(
        'The rollout completes in 2026 for every remaining region.',
        'The rollout completes in twenty twenty-seven for every remaining region.',
      ),
    );
    const [candidate] = result.candidates;
    expect(result.candidates).toHaveLength(1);
    expect(candidate?.type).toBe('critical_number_mismatch');
    expect(candidate?.authoredFragment).toBe('2026');
    // The whole spoken run, not just its first component.
    expect(candidate?.spokenFragment).toBe('twenty twenty seven');
  });

  it('flags a wrong order of magnitude', () => {
    const result = compareSpanFidelity(
      makeSpan(
        'The fund manages $50 million on behalf of its members.',
        'The fund manages fifty billion dollars on behalf of its members.',
      ),
    );
    const numbers = result.candidates.filter(
      (candidate) => candidate.type === 'critical_number_mismatch',
    );
    expect(numbers).toHaveLength(1);
    expect(numbers[0]?.authoredFragment).toBe('$50 million');
    expect(numbers[0]?.spokenFragment).toBe('fifty billion');
  });

  it('flags a substituted unit within the same dimension', () => {
    const result = compareSpanFidelity(
      makeSpan(
        'Response time is 250 milliseconds on a warm cache today.',
        'Response time is two hundred fifty seconds on a warm cache today.',
      ),
    );
    expect(
      result.candidates.map((candidate) => ({
        type: candidate.type,
        detailCode: candidate.detailCode,
        authoredFragment: candidate.authoredFragment,
        spokenFragment: candidate.spokenFragment,
        localConfidence: candidate.localConfidence,
      })),
    ).toEqual([
      {
        type: 'critical_unit_mismatch',
        detailCode: 'unit_substituted:second',
        authoredFragment: 'milliseconds',
        spokenFragment: 'seconds',
        localConfidence: 0.75,
      },
    ]);
  });

  it('flags a dropped negation and quotes it with its head word', () => {
    const result = compareSpanFidelity(
      makeSpan(
        'The results are not final at this stage of the review.',
        'The results are final at this stage of the review.',
      ),
    );
    const [candidate] = result.candidates;
    expect(result.candidates).toHaveLength(1);
    expect(candidate?.type).toBe('critical_negation_mismatch');
    expect(candidate?.detailCode).toBe('negation_dropped');
    expect(candidate?.authoredFragment).toBe('not final');
    expect(candidate?.localConfidence).toBe(0.8);
    // The window is empty — the presenter went straight from "are" to "final" —
    // so the stamp brackets those two tokens.
    expect(candidate?.stamp.audioStartMs).toBe(1800);
    expect(candidate?.stamp.audioEndMs).toBe(2580);
  });

  it('flags a negation lost when a contraction was read as its positive stem', () => {
    const result = compareSpanFidelity(
      makeSpan(
        'We don’t ship on Fridays under any circumstances at all.',
        'We do ship on Fridays under any circumstances at all.',
      ),
    );
    const [candidate] = result.candidates;
    expect(result.candidates).toHaveLength(1);
    expect(candidate?.type).toBe('critical_negation_mismatch');
    expect(candidate?.detailCode).toBe('negation_stem_read_positive');
    expect(candidate?.authoredFragment).toBe('don’t ship');
    expect(candidate?.spokenFragment).toBe('do');
  });

  it('flags a substituted surname', () => {
    const result = compareSpanFidelity(
      makeSpan(
        'Please welcome Ndlovu to the stage for the closing remarks.',
        'Please welcome Nakamura to the stage for the closing remarks.',
      ),
    );
    const [candidate] = result.candidates;
    expect(result.candidates).toHaveLength(1);
    expect(candidate?.type).toBe('critical_name_mismatch');
    expect(candidate?.detailCode).toBe('name_substituted');
    expect(candidate?.authoredFragment).toBe('Ndlovu');
    expect(candidate?.spokenFragment).toBe('nakamura');
    // Names are the least reliable class; the confidence must say so.
    expect(candidate?.localConfidence).toBeLessThan(0.65);
    expect(candidate?.localConfidence).toBeGreaterThan(0.3);
  });

  it('never invents a material_meaning_change locally (§25.5)', () => {
    // Luna classifies materiality; a local heuristic doing it would be
    // fabrication. This asserts the type is unreachable from this module.
    const result = compareSpanFidelity(
      makeSpan(
        'The quarterly results were broadly encouraging for the whole team.',
        'The quarterly numbers looked pretty rough for the whole team.',
      ),
    );
    expect(
      result.candidates.filter((candidate) => candidate.type === 'material_meaning_change'),
    ).toEqual([]);
  });
});
