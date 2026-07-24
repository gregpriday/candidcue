/**
 * The last two §14.4 candidate-opening indexes.
 *
 * `DocumentIndex` built rare-token, n-gram, alias and frequency tables. The two
 * §14.4 requires and nobody had built were the phonetic-key index and the
 * section-local number/date/currency/negation/proper-noun index — and both are
 * the same shape of bug the alias index was (commit `3b2b0dd`): the *scoring*
 * side already knew how to use the signal, and the *retrieval* side could not
 * nominate on it, so it could only ever confirm a window some other index had
 * already opened.
 *
 *   - `phoneticKey` ran pairwise inside `matchTokens`. A name the transcriber
 *     spelled by sound — the single most common thing an ASR does to an
 *     unusual term — therefore raised nothing.
 *   - `TOKEN_FLAGS.NUMBER` and `PROPER_NOUN` existed and nothing indexed over
 *     them, and negation was invisible twice over: it is a stopword on both
 *     sides, so it is filtered out of the content stream the n-gram index keys
 *     on *and* out of the transcript words candidate generation probes with.
 *
 * Every "this index opens a window" test here states both halves: that the new
 * scope covers the target, and that *no other scope does*. The second half is
 * what makes the first mean something — an assertion that a window opened is
 * worthless if the continuity band was covering the span all along.
 *
 * The admission gates get the same treatment in the other direction. A
 * phonetic key is a lossy hash and a section-local negation is a common word;
 * without a gate either one nominates spans across the whole document, which is
 * §23.2's "never use one common repeated phrase as a large-jump trigger" — so
 * each gate has a test that it refuses.
 */
import { describe, expect, it } from 'vitest';
import { generateCandidates } from '../../../src/shared/tracking/candidates';
import { DocumentIndex } from '../../../src/shared/tracking/document-index';
import { phoneticKey, STOPWORDS } from '../../../src/shared/tracking/normalize';
import { DEFAULT_TRACKING_PROFILE } from '../../../src/shared/tracking/profile';
import { compileFixtureScript } from '../../fixtures/alignment/fixture-script';
import type { CandidateWindow, LedgerToken } from '../../../src/shared/tracking/types';

/* ---------------------------------------------------------------------------
 * Shared scaffolding
 * ------------------------------------------------------------------------- */

/** Filler vocabulary that recurs constantly, so none of it is a rare token. */
const FILLER_POOL = [
  'market', 'garden', 'letter', 'number', 'picture', 'window', 'paper', 'corner',
  'bridge', 'summer', 'winter', 'morning', 'evening', 'forest', 'river', 'ladder',
  'basket', 'kitchen', 'meadow', 'harbour', 'signal', 'ribbon', 'candle', 'pocket',
  'building', 'building', 'building',
];

function fillerSentences(count: number, seed: number): string[] {
  let state = seed >>> 0;
  const random = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const out: string[] = [];
  while (out.length < count) {
    const words: string[] = [];
    while (words.length < 9) {
      const word = FILLER_POOL[Math.floor(random() * FILLER_POOL.length)] ?? 'market';
      if (words[words.length - 1] === word) continue;
      words.push(word);
    }
    out.push(`${words.join(' ')}.`);
  }
  return out;
}

function paragraphs(sentences: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < sentences.length; i += 4) {
    out.push(sentences.slice(i, i + 4).join(' '), '');
  }
  return out;
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

function windowsFor(
  index: DocumentIndex,
  spoken: string,
  committedTokenIndex = 0,
): CandidateWindow[] {
  return generateCandidates(
    index,
    {
      committedTokenIndex,
      transcriptTail: tailFor(spoken),
      checkpoints: [],
      globalSearch: false,
    },
    DEFAULT_TRACKING_PROFILE,
  );
}

function coveringScopes(windows: readonly CandidateWindow[], target: number): Set<string> {
  return new Set(
    windows
      .filter((w) => w.startTokenIndex <= target && target <= w.endTokenIndex)
      .map((w) => w.scope),
  );
}

function describeWindows(windows: readonly CandidateWindow[], target: number): string {
  return (
    `target ${target}; windows ` +
    windows.map((w) => `${w.scope}[${w.startTokenIndex}..${w.endTokenIndex}]`).join(' ')
  );
}

function indexFor(source: string, rareWords?: readonly string[]): DocumentIndex {
  const document = compileFixtureScript(source, rareWords ? { rareWords } : undefined);
  return new DocumentIndex(document, { rareWeight: DEFAULT_TRACKING_PROFILE.rareWeight });
}

/* ---------------------------------------------------------------------------
 * Phonetic-key index
 * ------------------------------------------------------------------------- */

/**
 * Every content word of the target sentence is a coined term the transcriber
 * gets wrong, and each is separated from the next by stopwords — so every
 * bigram the tail could form straddles a mangled word and misses. `building`
 * is the one content word rendered correctly, and it is deliberately common in
 * the filler so it cannot nominate the target on its own.
 */
const TARGET_SENTENCE = 'Zyntara is the Kestrix of the Vantiq we have been building.';
/** As the transcriber renders it: same sounds, different spellings. */
const TARGET_AS_HEARD = 'zintara is the kestriks of the vantik we have been building';

function phoneticFixture(): { index: DocumentIndex; target: number } {
  const source = [
    '# The Long Chapter',
    '',
    ...paragraphs(fillerSentences(60, 20260724)),
    TARGET_SENTENCE,
    '',
    ...paragraphs(fillerSentences(20, 99887766)),
  ].join('\n');
  // No aliases at all: the alias index cannot be what nominates this.
  const document = compileFixtureScript(source, { rareWords: ['zyntara', 'kestrix', 'vantiq'] });
  const index = new DocumentIndex(document, { rareWeight: DEFAULT_TRACKING_PROFILE.rareWeight });
  const target = document.spokenTokens.find((t) => t.normalized === 'zyntara');
  if (target === undefined) throw new Error('fixture lost its coined term');
  return { index, target: target.index };
}

describe('§14.4 phonetic-key index', () => {
  it('keys the script term on its sound; no other index carries the heard form', () => {
    const { index, target } = phoneticFixture();
    expect(index.phoneticKeyPositions.get(phoneticKey('zyntara'))).toEqual([target]);
    expect(phoneticKey('zintara')).toBe(phoneticKey('zyntara'));
    for (const heard of ['zintara', 'kestriks']) {
      expect(index.rareTokenPositions.has(heard), heard).toBe(false);
      expect(index.ngramPositions.has(heard), heard).toBe(false);
      expect(index.aliasTokenPositions.has(heard), heard).toBe(false);
    }
    expect(index.aliasTokenPositions.size).toBe(0);
  });

  it('opens a window around a term the transcriber only ever spelled by sound', () => {
    const { index, target } = phoneticFixture();
    const windows = windowsFor(index, TARGET_AS_HEARD);
    const scopes = coveringScopes(windows, target);
    const context = describeWindows(windows, target);

    // The finding: without this index nothing nominates the span at all.
    expect([...scopes], context).toContain('phonetic_anchor');
    // And the fixture isolates, so the assertion above cannot be satisfied by
    // some other index having opened the same span.
    expect(scopes, context).toEqual(new Set(['phonetic_anchor']));
  });

  it('refuses a key an ordinary word of the script also produces', () => {
    // §23.2. "abbot" and "about" hash to the same key, and "about" is a
    // stopword said constantly — an ungated phonetic index would let every
    // "about" in the transcript nominate every "abbot" in the script.
    const index = indexFor(
      [
        '# Chapter',
        '',
        'The abbot walked out about the garden and thought about the letters.',
        '',
        'We talked about the market and about the paper about the corner.',
      ].join('\n'),
    );
    expect(phoneticKey('abbot')).toBe(phoneticKey('about'));
    expect(index.phoneticKeyPositions.has(phoneticKey('abbot'))).toBe(false);
    expect(windowsFor(index, 'the abbot is').map((w) => w.scope)).not.toContain(
      'phonetic_anchor',
    );
  });

  it('refuses a key the script itself repeats', () => {
    // A word said six times is this script's ordinary vocabulary whatever it
    // sounds like, so it must not be able to propose six distant spans.
    const repeated = Array.from({ length: 6 }, () => 'The harbour signal was clear.').join(' ');
    const index = indexFor(['# Chapter', '', repeated].join('\n'));
    expect(index.phoneticKeyPositions.has(phoneticKey('harbour'))).toBe(false);
  });

  it('refuses a key too short to be an identity', () => {
    // "kl" is Kaggle, cagle, coil and equal. Three symbols is the floor.
    const index = indexFor(['# Chapter', '', 'The Kaggle report landed.'].join('\n'));
    expect(phoneticKey('kaggle').length).toBeLessThan(3);
    expect(index.phoneticKeyPositions.has(phoneticKey('kaggle'))).toBe(false);
  });
});

/* ---------------------------------------------------------------------------
 * Section-local number / date / currency / negation / proper-noun index
 * ------------------------------------------------------------------------- */

/**
 * A single chapter long enough that neither the continuity band nor the
 * `section` window (capped at `maxCandidateWindowTokens`, centred on the
 * cursor) reaches the target. The target sentence contains exactly one token
 * that is not a stopword — a two-digit number, which is too short and too
 * lightly weighted to be a rare anchor.
 */
const FIDELITY_SENTENCE = 'And it was just as we had 47 of these.';
const FIDELITY_AS_HEARD = 'and it was just as we had 47 of these';

function fidelityFixture(): { index: DocumentIndex; target: number } {
  const source = [
    '# One Long Chapter',
    '',
    ...paragraphs(fillerSentences(90, 13572468)),
    FIDELITY_SENTENCE,
    '',
    ...paragraphs(fillerSentences(20, 24681357)),
  ].join('\n');
  const document = compileFixtureScript(source);
  const index = new DocumentIndex(document, { rareWeight: DEFAULT_TRACKING_PROFILE.rareWeight });
  const target = document.spokenTokens.find((t) => t.normalized === '47');
  if (target === undefined) throw new Error('fixture lost its number');
  return { index, target: target.index };
}

describe('§14.4 section-local high-fidelity index', () => {
  it('indexes a number no other table will take', () => {
    const { index, target } = fidelityFixture();
    // §14.3 calls a number high-fidelity; every existing table disagrees.
    expect(index.rareTokenPositions.has('47')).toBe(false);
    expect(index.aliasTokenPositions.has('47')).toBe(false);
    expect(index.phoneticKeyPositions.has(phoneticKey('47'))).toBe(false);
    expect(index.sectionFidelityPositionsNear(0, '47')).toEqual([target]);
  });

  it('opens a window around a span whose only distinctive token is that number', () => {
    const { index, target } = fidelityFixture();
    const windows = windowsFor(index, FIDELITY_AS_HEARD);
    const scopes = coveringScopes(windows, target);
    const context = describeWindows(windows, target);

    expect([...scopes], context).toContain('fidelity_anchor');
    expect(scopes, context).toEqual(new Set(['fidelity_anchor']));
  });

  it('reaches a negation, which every content-word path filters out', () => {
    // §14.3: "preserve function words that change meaning, especially
    // negation". `not` is a stopword on both sides, so it is absent from the
    // content stream the n-gram index keys on *and* from the content words
    // candidate generation probes with. Every token of this sentence is a
    // stopword, so the tail yields no content word at all — nothing but the
    // fidelity index has anything to look up.
    const source = [
      '# One Long Chapter',
      '',
      ...paragraphs(fillerSentences(90, 55443322)),
      'And so it was that we did not.',
      '',
      ...paragraphs(fillerSentences(20, 22334455)),
    ].join('\n');
    const document = compileFixtureScript(source);
    const index = new DocumentIndex(document, { rareWeight: DEFAULT_TRACKING_PROFILE.rareWeight });
    const target = document.spokenTokens.find((t) => t.normalized === 'not');
    expect(target).toBeDefined();
    const heard = 'and so it was that we did not';
    expect(tailFor(heard).some((t) => t.content)).toBe(false);

    const windows = windowsFor(index, heard);
    const scopes = coveringScopes(windows, target!.index);
    expect(scopes, describeWindows(windows, target!.index)).toEqual(new Set(['fidelity_anchor']));
  });

  it('never nominates outside the section it was keyed in', () => {
    const source = [
      '# Chapter One',
      '',
      ...paragraphs(fillerSentences(20, 191919)),
      '',
      '# Chapter Two',
      '',
      ...paragraphs(fillerSentences(8, 282828)),
      FIDELITY_SENTENCE,
    ].join('\n');
    const document = compileFixtureScript(source);
    const index = new DocumentIndex(document, { rareWeight: DEFAULT_TRACKING_PROFILE.rareWeight });
    const target = document.spokenTokens.find((t) => t.normalized === '47');
    expect(target).toBeDefined();
    // Visible from inside chapter two, invisible from inside chapter one.
    expect(index.sectionFidelityPositionsNear(target!.index, '47')).toEqual([target!.index]);
    expect(index.sectionFidelityPositionsNear(0, '47')).toEqual([]);
    expect(windowsFor(index, FIDELITY_AS_HEARD, 0).map((w) => w.scope)).not.toContain(
      'fidelity_anchor',
    );
  });

  it('refuses a fidelity token its own section repeats', () => {
    // A section that says "not" constantly must not nominate every one of them
    // when the presenter says it once (§23.2).
    const index = indexFor(
      [
        '# Chapter',
        '',
        'It is not the market and not the garden and not the letter.',
        '',
        'That is not the paper and not the window and not the corner.',
      ].join('\n'),
    );
    expect(index.sectionFidelityPositionsNear(0, 'not')).toEqual([]);
    expect(windowsFor(index, 'it is not the market').map((w) => w.scope)).not.toContain(
      'fidelity_anchor',
    );
  });
});
