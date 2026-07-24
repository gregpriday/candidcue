import { describe, expect, it } from 'vitest';
import {
  alignmentLinksFromMatchedPairs,
  toCriticalChecks,
} from '../../../../src/shared/coaching/fidelity/assist-bridge';
import { compareSpanFidelity } from '../../../../src/shared/coaching/fidelity/comparator';
import { makeSpan } from './harness';

describe('alignmentLinksFromMatchedPairs', () => {
  it('rebases window-relative script indexes onto absolute ones', () => {
    expect(
      alignmentLinksFromMatchedPairs(
        [
          { transcriptIndex: 0, scriptTokenIndex: 0 },
          { transcriptIndex: 3, scriptTokenIndex: 2 },
        ],
        140,
      ),
    ).toEqual([
      { transcriptIndex: 0, scriptTokenIndex: 140 },
      { transcriptIndex: 3, scriptTokenIndex: 142 },
    ]);
  });
});

describe('toCriticalChecks', () => {
  it('maps a real comparator result onto the scheduler contract', () => {
    const result = compareSpanFidelity(
      makeSpan(
        'That is 1,500 customers signed up already this month.',
        'That is fifteen thousand customers signed up already this month.',
      ),
    );
    expect(toCriticalChecks(result.candidates)).toEqual([
      {
        kind: 'number',
        scriptFragment: '1,500',
        transcriptFragment: 'fifteen thousand',
        spanId: 'sentence-1',
      },
    ]);
  });

  it('reports a unit substitution as "unit", and keeps it material', () => {
    const result = compareSpanFidelity(
      makeSpan(
        'Response time is 250 milliseconds on a warm cache today.',
        'Response time is two hundred fifty seconds on a warm cache today.',
      ),
    );
    const [check] = toCriticalChecks(result.candidates);
    expect(check?.kind).toBe('unit');
    expect(check?.scriptFragment).toBe('milliseconds');

    // The kind is only half the contract. `classifyAssistTrigger` treats a
    // check as material iff its kind is neither `none` nor `uncertain`, so a
    // future rename that lands on either would silently drop a real
    // milliseconds-read-as-seconds error rather than fail loudly here.
    expect(check?.kind).not.toBe('none');
    expect(check?.kind).not.toBe('uncertain');
  });

  it('maps a dropped negation to the negation kind', () => {
    const result = compareSpanFidelity(
      makeSpan(
        'The results are not final at this stage of the review.',
        'The results are final at this stage of the review.',
      ),
    );
    expect(toCriticalChecks(result.candidates).map((check) => check.kind)).toEqual(['negation']);
  });

  it('drops candidate types that are not critical checks', () => {
    expect(
      toCriticalChecks([
        {
          evidenceId: 'x',
          type: 'pace_too_fast',
          localConfidence: 0.9,
          stamp: {
            audioStartMs: 0,
            audioEndMs: 1,
            commitSequence: null,
            trackingEpoch: 1,
            takePassId: 't',
          },
          scriptSpanId: null,
          detailCode: '',
          spokenFragment: '',
          authoredFragment: '',
          finalEvidence: true,
        },
      ]),
    ).toEqual([]);
  });
});
