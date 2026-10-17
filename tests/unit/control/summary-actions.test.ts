/**
 * The take summary's action row (§parts).
 *
 * The property worth pinning is not any individual row — it is that EXACTLY ONE
 * row is primary across every combination of the three facts the row is built
 * from. Written as `{#if}` blocks in the component that property broke without
 * anything noticing: the last part of a script, read to the end, promoted no
 * next part and suppressed "Present again", leaving a finished run looking at a
 * dialog with nothing highlighted.
 */
import { describe, expect, it } from 'vitest';
import {
  partOutcomeLabel,
  scriptFollowedLabel,
  summaryActions,
  type SummaryActionsInput,
} from '../../../src/control/lib/summary-actions';
import type { TakePart } from '../../../src/control/stores/session';

function part(ordinal: number, label: string, start: number, end: number): TakePart {
  return { id: `p${ordinal}`, label, ordinal, totalParts: 3, startTokenIndex: start, endTokenIndex: end };
}

const PART_TWO = part(2, 'Pricing', 50, 99);
const PART_THREE = part(3, 'Close', 100, 199);

function input(overrides: Partial<SummaryActionsInput> = {}): SummaryActionsInput {
  return {
    retrySectionTokenIndex: null,
    part: null,
    partComplete: false,
    nextPart: null,
    ...overrides,
  };
}

/** Every combination of the three facts the row is a matrix over. */
const MATRIX: SummaryActionsInput[] = [];
for (const p of [null, PART_TWO]) {
  for (const complete of [false, true]) {
    for (const next of [null, PART_THREE]) {
      for (const retry of [null, 40]) {
        MATRIX.push({
          retrySectionTokenIndex: retry,
          part: p,
          partComplete: complete,
          nextPart: next,
        });
      }
    }
  }
}

describe('summaryActions', () => {
  it('offers exactly one primary action in every combination', () => {
    for (const combination of MATRIX) {
      const primaries = summaryActions(combination).filter((a) => a.primary);
      expect(primaries, JSON.stringify(combination)).toHaveLength(1);
    }
  });

  it('offers at least one action in every combination', () => {
    for (const combination of MATRIX) {
      expect(summaryActions(combination).length, JSON.stringify(combination)).toBeGreaterThan(0);
    }
  });

  it('never repeats a row id', () => {
    for (const combination of MATRIX) {
      const ids = summaryActions(combination).map((a) => a.id);
      expect(new Set(ids).size, JSON.stringify(combination)).toBe(ids.length);
    }
  });

  it('is unchanged for an unbounded take', () => {
    const actions = summaryActions(input({ retrySectionTokenIndex: 40 }));
    expect(actions.map((a) => a.id)).toEqual(['retry-section', 'present-again']);
    expect(actions.find((a) => a.id === 'present-again')?.primary).toBe(true);
  });

  it('hides "retry last section" for a part-bounded take', () => {
    const actions = summaryActions(input({ retrySectionTokenIndex: 40, part: PART_TWO }));
    expect(actions.map((a) => a.id)).not.toContain('retry-section');
  });

  it('promotes the next part once this one is finished', () => {
    const actions = summaryActions(
      input({ part: PART_TWO, partComplete: true, nextPart: PART_THREE }),
    );
    expect(actions.find((a) => a.primary)?.id).toBe('record-next-part');
    expect(actions.map((a) => a.id)).not.toContain('present-again');
  });

  it('promotes retrying this part when the take stopped part way', () => {
    // Somebody who launched part three and did not finish it fumbled a line.
    // Offering the whole script as the highlighted response to that was wrong.
    const actions = summaryActions(
      input({ part: PART_TWO, partComplete: false, nextPart: PART_THREE }),
    );
    expect(actions.find((a) => a.primary)?.id).toBe('record-part-again');
    expect(actions.find((a) => a.id === 'record-next-part')?.primary).toBe(false);
  });

  /*
   * The combinations the store can actually produce. `nextPart` is only ever
   * resolved for a take that HAS a part — `startTake` computes it from the
   * resolved part or not at all — so "no part but a next part" is a state that
   * cannot exist. It stays in MATRIX above, where the invariant checks are
   * deliberately defensive about states this module might one day be handed,
   * and comes out here, where the assertion is about what a presenter sees.
   */
  const REACHABLE = MATRIX.filter((c) => c.nextPart === null || c.part !== null);

  it('never shows more than two rows, so the footer cannot wrap', () => {
    // Two unconditional buttons sit beside these in the dialog. The narrow
    // footer is why "Present again" stands down rather than lingering as a
    // fifth option nobody in this state was going to take.
    for (const combination of REACHABLE) {
      expect(summaryActions(combination).length, JSON.stringify(combination)).toBeLessThanOrEqual(2);
    }
  });

  it('keeps a primary action after the LAST part is read to the end', () => {
    // The regression this module exists for: nothing to promote, and the take
    // was bounded, so both candidates used to stand down.
    const actions = summaryActions(input({ part: PART_THREE, partComplete: true, nextPart: null }));
    expect(actions.find((a) => a.primary)?.id).toBe('present-again');
  });

  it('carries identity and a start for every row that launches a part', () => {
    const actions = summaryActions(
      input({ part: PART_TWO, partComplete: true, nextPart: PART_THREE }),
    );
    expect(actions.find((a) => a.id === 'record-part-again')).toMatchObject({
      startTokenIndex: 50,
      partId: 'p2',
    });
    expect(actions.find((a) => a.id === 'record-next-part')).toMatchObject({
      startTokenIndex: 100,
      partId: 'p3',
    });
  });

  it('gives "present again" no start, so it opens the whole script', () => {
    const actions = summaryActions(input());
    const again = actions.find((a) => a.id === 'present-again');
    expect(again?.startTokenIndex).toBeUndefined();
    expect(again?.partId).toBeUndefined();
  });
});

/*
 * The Part row's claim about how far the take got (#276).
 *
 * A voice take that fell back to auto-scroll is still a `voice` take, so the
 * mode alone used to decide it — and a part the transport rolled off the bottom
 * of the glass was reported "stopped part way".
 */
describe('partOutcomeLabel', () => {
  it('says a voice take read to the end when it did', () => {
    expect(partOutcomeLabel({ mode: 'voice', partComplete: true, partRolledToEnd: false })).toBe(
      '— read to the end',
    );
  });

  it('says a voice take stopped part way when it did', () => {
    expect(partOutcomeLabel({ mode: 'voice', partComplete: false, partRolledToEnd: false })).toBe(
      '— stopped part way',
    );
  });

  it('says the transport carried it, not that anybody read it, in every mode', () => {
    for (const mode of ['voice', 'manual', 'fixed'] as const) {
      expect(partOutcomeLabel({ mode, partComplete: true, partRolledToEnd: true }), mode).toBe(
        '— carried to the end by auto-scroll',
      );
    }
  });

  it('makes no claim about a take without a voice that the transport did not carry', () => {
    // No snapshots and no roll: there is no evidence either way, and "stopped
    // part way" would be a wrong answer rather than a cautious one.
    for (const mode of ['manual', 'fixed'] as const) {
      expect(partOutcomeLabel({ mode, partComplete: false, partRolledToEnd: false }), mode).toBeNull();
    }
  });
});

/*
 * The "Script followed" row (#285). It was a fraction of the whole script
 * whatever the take was given, so a part read to its last word scored a quarter
 * and a "From here" take near the end could never look complete.
 */
describe('scriptFollowedLabel', () => {
  const base = { wordsFollowed: 49, coverageWords: 50, part: null, retakes: 0 } as const;

  it('says nothing more for the whole script from its first word', () => {
    expect(scriptFollowedLabel({ ...base, coverageWords: 200, coverageScope: 'script' })).toBe(
      '49 of 200 words (25%)',
    );
  });

  it('measures a part take against the part, and names it', () => {
    expect(scriptFollowedLabel({ ...base, coverageScope: 'part', part: PART_TWO })).toBe(
      '49 of 50 words in part 2 (98%)',
    );
  });

  it('says where a take started part way into a part was measured from', () => {
    expect(
      scriptFollowedLabel({
        ...base,
        wordsFollowed: 24,
        coverageWords: 25,
        coverageScope: 'restOfPart',
        part: PART_TWO,
      }),
    ).toBe('24 of 25 words from the start point to the end of part 2 (96%)');
  });

  it('says an unbounded take that started part way in ran to the end of the script', () => {
    expect(scriptFollowedLabel({ ...base, coverageScope: 'restOfScript' })).toBe(
      '49 of 50 words from the start point to the end of the script (98%)',
    );
  });

  it('measures from the retake once one opened the pass being reported', () => {
    expect(scriptFollowedLabel({ ...base, coverageScope: 'restOfScript', retakes: 2 })).toBe(
      '49 of 50 words from the retake to the end of the script (98%)',
    );
    expect(
      scriptFollowedLabel({ ...base, coverageScope: 'restOfPart', part: PART_THREE, retakes: 1 }),
    ).toBe('49 of 50 words from the retake to the end of part 3 (98%)');
  });

  it('says when a retake began past the end of the part', () => {
    expect(
      scriptFollowedLabel({
        ...base,
        wordsFollowed: 0,
        coverageWords: 0,
        coverageScope: 'restOfPart',
        part: PART_TWO,
        retakes: 1,
      }),
    ).toBe('None of part 2 was left after the retake');
  });

  it('still names a part it was not handed', () => {
    expect(scriptFollowedLabel({ ...base, coverageScope: 'part' })).toBe(
      '49 of 50 words in the part (98%)',
    );
    expect(scriptFollowedLabel({ ...base, coverageScope: 'restOfPart' })).toBe(
      '49 of 50 words from the start point to the end of the part (98%)',
    );
  });

  it('gives no percentage of nothing', () => {
    expect(
      scriptFollowedLabel({ ...base, wordsFollowed: 0, coverageWords: 0, coverageScope: 'script' }),
    ).toBe('0 of 0 words');
  });
});
