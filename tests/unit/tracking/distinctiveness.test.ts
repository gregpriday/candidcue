/**
 * S1 — repetition and distinctiveness (§14.3, §23.1, §23.2).
 *
 * §23.2 is unambiguous: "never use one common repeated phrase as a large-jump
 * trigger." Nothing computed how repeated a phrase was, so the rule was
 * enforced only downstream and only by arithmetic coincidence — two copies of a
 * refrain scoring within `ambiguityMargin` of each other, which holds for an
 * exact duplicate and stops holding the moment their surroundings differ by a
 * word. `RARE_MAX_FREQUENCY = 2` plus a stopword list is a two-bucket answer to
 * a continuous question (§14.3).
 *
 * The gate added for this lives at *retrieval*: a phrase that repeats may still
 * confirm where the presenter already is, so its occurrences inside the
 * continuity band are kept, but it may not nominate a span far away. Both
 * halves are asserted here — refusing everything would be just as wrong as
 * admitting everything, and the second half is what catches that.
 */
import { describe, expect, it } from 'vitest';
import {
  generateCandidates,
  globalAnchorRepeatAllowance,
} from '../../../src/shared/tracking/candidates';
import { DocumentIndex } from '../../../src/shared/tracking/document-index';
import { DEFAULT_TRACKING_PROFILE } from '../../../src/shared/tracking/profile';
import { compileFixtureScript } from '../../fixtures/alignment/fixture-script';
import { STOPWORDS } from '../../../src/shared/tracking/normalize';
import type {
  CandidateWindow,
  LedgerToken,
  TrackingDocument,
} from '../../../src/shared/tracking/types';

/* ---------------------------------------------------------------------------
 * Fixture: one long chapter carrying a three-times refrain and one sentence
 * that is unique only as a *sequence* — every word in it is common.
 * ------------------------------------------------------------------------- */

const REFRAIN = 'the crimson pattern repeats itself every single time';
const UNIQUE_RUN = 'harbour ribbon candle pocket meadow signal';

const POOL = [
  'market', 'garden', 'letter', 'number', 'picture', 'window', 'paper', 'corner',
  'bridge', 'summer', 'winter', 'morning', 'evening', 'forest', 'river', 'ladder',
  'basket', 'kitchen', 'meadow', 'harbour', 'signal', 'ribbon', 'candle', 'pocket',
  'pattern', 'repeats', 'itself', 'every', 'single', 'time',
];

function filler(count: number, seed: number): string {
  let state = seed >>> 0;
  const random = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const sentences: string[] = [];
  while (sentences.length < count) {
    const words: string[] = [];
    while (words.length < 9) {
      const word = POOL[Math.floor(random() * POOL.length)] ?? 'market';
      if (words[words.length - 1] === word) continue;
      words.push(word);
    }
    sentences.push(`${words.join(' ')}.`);
  }
  return sentences.join(' ');
}

function refrainDocument(): { document: TrackingDocument; index: DocumentIndex } {
  const source = [
    '# One Long Chapter',
    '',
    filler(6, 11),
    `${REFRAIN}.`,
    '',
    filler(60, 22),
    `${REFRAIN}.`,
    '',
    filler(18, 33),
    `${UNIQUE_RUN}.`,
    '',
    filler(40, 44),
    `${REFRAIN}.`,
    '',
    filler(20, 55),
  ].join('\n');
  const document = compileFixtureScript(source);
  return {
    document,
    index: new DocumentIndex(document, { rareWeight: DEFAULT_TRACKING_PROFILE.rareWeight }),
  };
}

/** Every start index at which `words` occurs consecutively. */
function occurrencesOf(document: TrackingDocument, words: readonly string[]): number[] {
  const tokens = document.spokenTokens;
  const found: number[] = [];
  for (let i = 0; i + words.length <= tokens.length; i++) {
    let all = true;
    for (let j = 0; j < words.length; j++) {
      if (tokens[i + j]?.normalized !== words[j]) {
        all = false;
        break;
      }
    }
    if (all) found.push(i);
  }
  return found;
}

function tailFor(text: string): LedgerToken[] {
  return text.split(' ').map((word, i) => ({
    itemId: 'item-0',
    indexInItem: i,
    index: i,
    surface: word,
    normalized: word,
    final: true,
    filler: false,
    content: !STOPWORDS.has(word),
  })) as unknown as LedgerToken[];
}

function windowsFor(index: DocumentIndex, spoken: string): CandidateWindow[] {
  return generateCandidates(
    index,
    {
      committedTokenIndex: 0,
      transcriptTail: tailFor(spoken),
      checkpoints: [],
      globalSearch: false,
    },
    DEFAULT_TRACKING_PROFILE,
  );
}

const covers = (windows: CandidateWindow[], position: number, scope?: string): boolean =>
  windows.some(
    (w) =>
      w.startTokenIndex <= position &&
      position <= w.endTokenIndex &&
      (scope === undefined || w.scope === scope),
  );

/* ------------------------------------------------------------------------- */

describe('S1: the distinctiveness measure (§14.3, §23.1)', () => {
  it('distinctiveness is the reciprocal of occurrence count', () => {
    expect(DocumentIndex.distinctivenessOf(1)).toBe(1);
    expect(DocumentIndex.distinctivenessOf(4)).toBe(0.25);
    // Never-seen anchors are treated as unique rather than as division by zero.
    expect(DocumentIndex.distinctivenessOf(0)).toBe(1);
  });

  it('counts a refrain globally and within its section', () => {
    const { document, index } = refrainDocument();
    const key = 'crimson pattern repeats';
    expect(occurrencesOf(document, REFRAIN.split(' ')).length).toBe(3);
    expect(index.phraseOccurrences(key)).toBe(3);
    // A single-section document: section-local and global agree, which is the
    // honest answer here rather than a coincidence to hide.
    expect(index.phraseOccurrencesInSection(key, 0)).toBe(3);
  });

  it('separates the two section-local counts on a multi-section script', () => {
    const source = [
      '# Alpha',
      '',
      'we always close the segment the same way every episode.',
      '',
      '# Beta',
      '',
      'nothing here resembles the other section at all today.',
      '',
      '# Gamma',
      '',
      'we always close the segment the same way every episode.',
    ].join('\n');
    const document = compileFixtureScript(source);
    const index = new DocumentIndex(document, {
      rareWeight: DEFAULT_TRACKING_PROFILE.rareWeight,
    });
    const key = 'always close segment';
    expect(index.phraseOccurrences(key)).toBe(2);
    expect(index.phraseOccurrencesInSection(key, 0)).toBe(1);
  });

  it('token distinctiveness is continuous, not a rare/not-rare bucket (§14.3)', () => {
    const { index } = refrainDocument();
    const once = index.tokenDistinctiveness('crimson');
    const often = index.tokenDistinctiveness('market');
    expect(once).toBeGreaterThan(often);
    expect(often).toBeGreaterThan(0);
    // §14.3 "combine it with a language stopword weight": the stopword bucket
    // multiplies the inverse frequency rather than replacing it, so a rare
    // function word is still demoted below what its frequency alone would say.
    const theFrequency = index.tokenFrequency.get('the') ?? 0;
    expect(theFrequency).toBeGreaterThan(0);
    expect(index.tokenDistinctiveness('the')).toBeLessThan(
      DocumentIndex.distinctivenessOf(theFrequency),
    );
  });
});

/* ---------------------------------------------------------------------------
 * `anchorOccurrences` — the same measure, asked of an alignment's own evidence.
 *
 * The retrieval gate above asks "may this anchor nominate a span over there?".
 * The commit gate asks the mirror question: "the aligner matched *these script
 * tokens* — how many other places in the script would have matched as well?".
 * They must answer with the same currency, because they enforce the same
 * sentence of §23.2 at the two ends of one decision.
 *
 * `UNIQUE_RUN` is the whole reason the phrase arm exists. Every one of its
 * words is common — none of them is rare enough to be indexed as an anchor —
 * and it is still, as a sequence, the only one of its kind in the script. That
 * is the ordinary shape of a section opening the presenter genuinely skipped
 * ahead to: unremarkable words, its own phrasing. A gate that read
 * distinctiveness off the words would refuse to follow them.
 * ------------------------------------------------------------------------- */
describe('S1: the distinctiveness of an alignment’s own evidence (§23.1, §23.2)', () => {
  const span = (start: number, length: number): number[] =>
    Array.from({ length }, (_, i) => start + i);

  it('a matched refrain answers with the refrain’s own repeat count', () => {
    const { document, index } = refrainDocument();
    const [near] = occurrencesOf(document, REFRAIN.split(' '));
    expect(near).toBeDefined();
    if (near === undefined) return;
    expect(index.anchorOccurrences(span(near, REFRAIN.split(' ').length))).toBe(3);
  });

  it('a run of common words that occurs once answers 1', () => {
    const { document, index } = refrainDocument();
    const words = UNIQUE_RUN.split(' ');
    const [unique] = occurrencesOf(document, words);
    expect(unique).toBeDefined();
    if (unique === undefined) return;

    // The load-bearing precondition: not one word of it is distinctive on its
    // own, so only the phrase arm can reach the answer.
    for (const word of words) {
      expect(index.tokenFrequency.get(word) ?? 0, word).toBeGreaterThan(1);
    }
    expect(index.anchorOccurrences(span(unique, words.length))).toBe(1);
  });

  it('a gap in the matched tokens breaks the phrase rather than inventing one', () => {
    const { document, index } = refrainDocument();
    const words = UNIQUE_RUN.split(' ');
    const [unique] = occurrencesOf(document, words);
    if (unique === undefined) throw new Error('fixture changed');

    // "harbour _ candle": adjacent in the script but not both matched, so there
    // is no evidence for the phrase and none is credited. What is left is the
    // two words, each of them common.
    const answer = index.anchorOccurrences([unique, unique + 2]);
    expect(answer).toBeGreaterThan(1);
    expect(answer).toBe(
      Math.min(index.tokenFrequency.get('harbour') ?? 0, index.tokenFrequency.get('candle') ?? 0),
    );
  });

  it('an isolated unique word is still evidence', () => {
    const { document, index } = refrainDocument();
    const [crimson] = occurrencesOf(document, ['crimson']);
    if (crimson === undefined) throw new Error('fixture changed');
    // Deliberate: refusing to see a lone distinctive word is how a
    // distinctiveness rule becomes a freeze. `crimson` is in the refrain, so
    // this also shows the measure reporting a repeated word honestly.
    expect(index.anchorOccurrences([crimson])).toBe(3);

    const source = ['# Title', '', 'the market letter mentions phosphorescence today.'].join('\n');
    const short = compileFixtureScript(source);
    const shortIndex = new DocumentIndex(short, {
      rareWeight: DEFAULT_TRACKING_PROFILE.rareWeight,
    });
    const [rare] = occurrencesOf(short, ['phosphorescence']);
    if (rare === undefined) throw new Error('fixture changed');
    expect(shortIndex.anchorOccurrences([rare])).toBe(1);
  });

  it('a span with no content at all reports no distinctiveness', () => {
    const { index } = refrainDocument();
    expect(index.anchorOccurrences([])).toBe(Number.POSITIVE_INFINITY);
    // Out-of-range positions are dropped rather than clamped onto real tokens.
    expect(index.anchorOccurrences([-4, index.tokenCount + 10])).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('S1: the repeat allowance scales with the script (§23.2)', () => {
  it('a short clip demands a unique phrase; a long keynote may allow more', () => {
    const profile = DEFAULT_TRACKING_PROFILE;
    // A 40-word social clip and a 400-word explainer: twice is a refrain.
    expect(globalAnchorRepeatAllowance(40, profile)).toBe(1);
    expect(globalAnchorRepeatAllowance(400, profile)).toBe(1);
    // A 6000-token keynote: a three-word phrase appearing three times there is
    // not what §23.2 means by "common".
    expect(globalAnchorRepeatAllowance(6000, profile)).toBe(3);
    // The floor holds even for a degenerate script.
    expect(globalAnchorRepeatAllowance(0, profile)).toBe(1);
  });
});

describe('S1: a repeated phrase cannot nominate a distant span (§23.2)', () => {
  it('the distant copies of a refrain open no window; the nearby one still does', () => {
    const { document, index } = refrainDocument();
    const positions = occurrencesOf(document, REFRAIN.split(' '));
    const [near, far, furthest] = positions as [number, number, number];
    const windows = windowsFor(index, REFRAIN);
    const context =
      `refrain at ${positions.join(',')} of ${index.tokenCount}; windows ` +
      windows.map((w) => `${w.scope}[${w.startTokenIndex}..${w.endTokenIndex}]`).join(' ');

    // Precondition: the fixture really does put two copies out of reach.
    expect(near).toBeLessThan(DEFAULT_TRACKING_PROFILE.continuityForwardTokens);
    expect(far).toBeGreaterThan(DEFAULT_TRACKING_PROFILE.continuityForwardTokens + 100);
    expect(globalAnchorRepeatAllowance(index.tokenCount, DEFAULT_TRACKING_PROFILE)).toBe(1);

    // SAFETY: three occurrences is a refrain, so it may not propose a jump.
    expect(covers(windows, far), context).toBe(false);
    expect(covers(windows, furthest), context).toBe(false);

    // LIVENESS: it may still confirm where the presenter already is — the
    // anchor is not simply deleted, it is bounded to the continuity band.
    expect(covers(windows, near, 'ngram'), context).toBe(true);
  });

  it('a sequence that is unique still nominates at the same distance', () => {
    // The other direction, in the same fixture and the same run: a gate that
    // refused every distant anchor would pass the test above and fail here.
    const { document, index } = refrainDocument();
    const [unique] = occurrencesOf(document, UNIQUE_RUN.split(' '));
    expect(unique).toBeDefined();
    if (unique === undefined) return;

    // Every word of it is common, so only the n-gram index can reach it, and
    // the sequence occurs exactly once.
    expect(index.phraseOccurrences('harbour ribbon candle')).toBe(1);
    for (const word of UNIQUE_RUN.split(' ')) {
      expect(index.rareTokenPositions.has(word), word).toBe(false);
    }
    expect(unique).toBeGreaterThan(DEFAULT_TRACKING_PROFILE.continuityForwardTokens + 100);

    const windows = windowsFor(index, UNIQUE_RUN);
    const context = windows
      .map((w) => `${w.scope}[${w.startTokenIndex}..${w.endTokenIndex}]`)
      .join(' ');
    expect(covers(windows, unique, 'ngram'), `unique at ${unique}; ${context}`).toBe(true);
  });
});
