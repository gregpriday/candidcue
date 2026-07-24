/**
 * B7 — the alias inverted index (§14.2, §14.4).
 *
 * `matchTokens` has always consulted `SpokenToken.aliases`, but only *inside* a
 * window some other index had already opened. Nothing was keyed on the alias
 * form, so a presenter who said "zintara" where the script writes "Zyntara" —
 * the exact case §14.2 exists for ("aliases observed during microphone test",
 * "known pronunciation dictionary results") — nominated no span at all, and the
 * alias score had nothing to raise.
 *
 * ## Where the gap actually bites
 *
 * Not everywhere, and the fixtures here are built to sit precisely on it. The
 * n-gram index keys on *content* tokens with stopwords removed, so a fluent
 * read of an ordinary sentence usually nominates itself through its neighbours
 * even when one term is mangled. What it cannot do is nominate a span whose
 * content words are all *separated by* aliased terms — an alias-heavy passage,
 * which is the case the finding names. Every tail bigram there straddles a term
 * the transcriber rendered differently, so every one of them misses.
 *
 * The isolation is asserted, not assumed: each test states both that an alias
 * window opens and that no other index opened one. Delete the alias lookups in
 * `generateCandidates` and the first half fails; weaken the fixture and the
 * second half fails.
 */
import { describe, expect, it } from 'vitest';
import { generateCandidates } from '../../../src/shared/tracking/candidates';
import { DocumentIndex } from '../../../src/shared/tracking/document-index';
import { AlignmentEngine } from '../../../src/shared/tracking/engine';
import { DEFAULT_TRACKING_PROFILE } from '../../../src/shared/tracking/profile';
import { compileFixtureScript } from '../../fixtures/alignment/fixture-script';
import { TranscriptScripter } from '../../fixtures/transcript-events/builder';
import type { LedgerToken, TrackingDocument } from '../../../src/shared/tracking/types';
import { STOPWORDS } from '../../../src/shared/tracking/normalize';

/* ---------------------------------------------------------------------------
 * Fixture: one long chapter of ordinary prose with one alias-heavy sentence
 * buried far past every local window.
 * ------------------------------------------------------------------------- */

/** As authored. Every content word is separated from the next by a rare term. */
const TARGET_SENTENCE = 'Zyntara is the Kestrix of the Vantiq we have been building.';

/** As the transcriber renders it — three product names in alias form. */
const TARGET_AS_SPOKEN = 'zintara is the kestriks of the vantik we have been building';

/**
 * Pronunciation aliases (§14.2 source list). None of these strings appears
 * anywhere in the script, so nothing but the alias index can key on them.
 */
const PRONUNCIATION_ALIASES = {
  zyntara: ['zintara'],
  kestrix: ['kestriks'],
  vantiq: ['vantik'],
} as const;

/**
 * Filler vocabulary. Every word recurs many times, so none of it is a rare
 * token; `building` is included deliberately, because it is the one content
 * word of the target sentence that the transcriber gets right and it must not
 * be able to nominate the target on its own.
 */
const FILLER_POOL = [
  'market', 'garden', 'letter', 'number', 'picture', 'window', 'paper', 'corner',
  'bridge', 'summer', 'winter', 'morning', 'evening', 'forest', 'river', 'ladder',
  'basket', 'kitchen', 'meadow', 'harbour', 'signal', 'ribbon', 'candle', 'pocket',
  'building', 'building', 'building',
];

/** Deterministic filler prose, so the fixture is stable across runs. */
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

interface AliasFixture {
  document: TrackingDocument;
  index: DocumentIndex;
  /** Spoken-token index of the first aliased term in the target sentence. */
  targetTokenIndex: number;
}

/**
 * A single section on purpose: the destination has to be *reachable*, so what
 * the test measures stays "which index nominated it" rather than "did the
 * section gate allow it".
 */
function aliasFixture(leadingSentences = 60, trailingSentences = 20): AliasFixture {
  const source = [
    '# The Long Chapter',
    '',
    ...paragraphs(fillerSentences(leadingSentences, 20260724)),
    TARGET_SENTENCE,
    '',
    ...paragraphs(fillerSentences(trailingSentences, 99887766)),
  ].join('\n');

  const document = compileFixtureScript(source, {
    rareWords: ['zyntara', 'kestrix', 'vantiq'],
    aliases: PRONUNCIATION_ALIASES,
  });
  const index = new DocumentIndex(document, { rareWeight: DEFAULT_TRACKING_PROFILE.rareWeight });
  const target = document.spokenTokens.find((token) => token.normalized === 'zyntara');
  if (target === undefined) throw new Error('fixture lost its aliased term');
  return { document, index, targetTokenIndex: target.index };
}

function paragraphs(sentences: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < sentences.length; i += 4) {
    out.push(sentences.slice(i, i + 4).join(' '), '');
  }
  return out;
}

/** The transcript tail the aligner would hold after the target was spoken. */
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

function windowsFor(index: DocumentIndex, spoken: string) {
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

/* ------------------------------------------------------------------------- */

describe('B7: an alias can open a candidate window (§14.2, §14.4)', () => {
  it('the alias index carries the spoken form; no other index does', () => {
    const { index, targetTokenIndex } = aliasFixture();
    expect(index.rareTokenPositions.has('zyntara')).toBe(true);
    for (const spoken of ['zintara', 'kestriks', 'vantik']) {
      expect(index.rareTokenPositions.has(spoken), spoken).toBe(false);
      expect(index.ngramPositions.has(spoken), spoken).toBe(false);
    }
    expect(index.aliasTokenPositions.get('zintara')).toEqual([targetTokenIndex]);
  });

  it('a window opens around terms the presenter only ever said in alias form', () => {
    const { index, targetTokenIndex } = aliasFixture();
    const windows = windowsFor(index, TARGET_AS_SPOKEN);
    const covering = windows.filter(
      (w) => w.startTokenIndex <= targetTokenIndex && targetTokenIndex <= w.endTokenIndex,
    );
    const context =
      `target ${targetTokenIndex} of ${index.tokenCount}; windows ` +
      windows.map((w) => `${w.scope}[${w.startTokenIndex}..${w.endTokenIndex}]`).join(' ');

    // The finding: without the alias index nothing nominates this span at all.
    expect(covering.map((w) => w.scope), context).toContain('alias_anchor');
    // And the fixture is still isolating in the way that matters: nothing that
    // keys on the script's own spelling (rare tokens, n-grams) or on proximity
    // to the cursor reached this span.
    //
    // What has joined since is the §14.4 phonetic-key index, which admits these
    // same three terms because a *pronunciation* alias is usually also a
    // phonetic neighbour — "zintara" for "Zyntara" hashes to the same key. That
    // is two weak signals agreeing, which is what §14.4 asks candidate
    // retrieval to do, so it is named here rather than excluded. The alias
    // index still carries spoken forms phonetics cannot reach: acronym
    // expansions and number words, covered by the multi-word case below.
    expect(new Set(covering.map((w) => w.scope)), context).toEqual(
      new Set(['alias_anchor', 'phonetic_anchor']),
    );
  });

  it('an alias that is an ordinary frequent word of the script is not an anchor', () => {
    // §23.2: a common repeated word must never be able to nominate spans all
    // over the document. `no` -> "number" is exactly that shape in a script
    // that says "number" constantly.
    const source = [
      '# Counting',
      '',
      'The number of items is the number we counted before the number changed again.',
      '',
      'Every number tells a story and the number keeps rising through the number series.',
    ].join('\n');
    const document = compileFixtureScript(source, { aliases: { counted: ['number'] } });
    const index = new DocumentIndex(document, { rareWeight: DEFAULT_TRACKING_PROFILE.rareWeight });
    expect(index.tokenFrequency.get('number')).toBeGreaterThan(2);
    expect(index.aliasTokenPositions.has('number')).toBe(false);
  });

  it('multi-word aliases are probed with transcript n-grams, not just single words', () => {
    // "47" read aloud is two transcript tokens, so the alias key is two words
    // and a unigram probe would never find it.
    const source = [
      '# Release Notes',
      '',
      'The team shipped 47 corrections before the window closed for the quarter.',
    ].join('\n');
    const document = compileFixtureScript(source, {
      rareWords: ['47'],
      aliases: { '47': ['forty seven'] },
    });
    const index = new DocumentIndex(document, { rareWeight: DEFAULT_TRACKING_PROFILE.rareWeight });
    const target = document.spokenTokens.find((t) => t.normalized === '47');
    expect(index.aliasTokenPositions.get('forty seven')).toEqual([target?.index]);

    const windows = windowsFor(index, 'shipped forty seven corrections');
    expect(windows.map((w) => w.scope)).toContain('alias_anchor');
  });
});

describe('B7: acquisition succeeds on terms only ever heard in alias form', () => {
  /**
   * The functional consequence of the finding. A fresh engine may lock
   * anywhere (§13, `unacquired`), so the section gate is not what is being
   * measured — candidate *retrieval* is. The presenter starts mid-chapter,
   * hundreds of tokens past every local window, and the only distinctive
   * things they say are product names in their spoken form.
   */
  it('the cursor lands on the sentence the presenter actually read', () => {
    const { document, targetTokenIndex } = aliasFixture();
    const engine = new AlignmentEngine(document, {
      sessionId: 'alias-acquisition',
      sessionGeneration: 1,
      stageGeneration: 1,
    });
    const scripter = new TranscriptScripter(10_000, 1);

    let committed = 0;
    for (let turn = 0; turn < 3; turn++) {
      for (const event of scripter.speak({ text: TARGET_AS_SPOKEN })) {
        const output = engine.handleTranscriptEvent(event);
        if (output.snapshot) committed = output.snapshot.committedTokenIndex;
      }
    }

    // Well past the continuity and section windows, which is why nothing but
    // the alias index could have proposed it.
    expect(targetTokenIndex).toBeGreaterThan(300);
    expect(
      Math.abs(committed - targetTokenIndex),
      `committed ${committed}, target ${targetTokenIndex}`,
    ).toBeLessThanOrEqual(12);
  });
});
