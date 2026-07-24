/**
 * B7 — the compile-time half of the alias inverted index (§14.4).
 *
 * §14.4 requires a "normalized token **and alias** inverted index" among the
 * indexes built once per compiled script revision. `buildSearchIndexes` built
 * every other one on that list and not this one, so the serialized artifact
 * could not express the retrieval path at all. These tests run the real
 * compiler, because the aliases under test are produced by
 * `aliasesForToken` — a fixture that hand-writes them would prove nothing
 * about what a real script yields.
 */
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/shared/markdown/compile';
import { DocumentIndex } from '../../../src/shared/tracking/document-index';
import { buildTrackingDocument } from '../../../src/shared/tracking/types';
import { DEFAULT_TRACKING_PROFILE } from '../../../src/shared/tracking/profile';

function indexesFor(source: string) {
  return compile(source, { scriptId: 'alias-index-test' }).indexes;
}

describe('buildSearchIndexes: alias inverted index (§14.4)', () => {
  it('an indexed alias points back at the token that owns it', () => {
    const indexes = indexesFor('We measured 47 separate regressions this quarter.\n');
    const [position] = indexes.aliasToken['forty seven'] ?? [];
    expect(position).toBeDefined();
    expect(indexes.exactToken['47']).toContain(position);
    // The spoken form is not a word of this script, which is exactly why the
    // exact-token index could never have retrieved it.
    expect(indexes.exactToken['forty']).toBeUndefined();
  });

  it('indexes the apostrophe-less form of a contraction but not its stopword split', () => {
    const indexes = indexesFor("We wouldn't rehearse the opening twice.\n");
    expect(indexes.aliasToken['wouldnt']).toBeDefined();
    // "would not" carries no distinctive word, so it is not an anchor.
    expect(indexes.aliasToken['would not']).toBeUndefined();
  });

  it('indexes multi-word number aliases under their spoken form', () => {
    const indexes = indexesFor('We shipped 47 corrections this quarter.\n');
    expect(indexes.aliasToken['forty seven']).toBeDefined();
  });

  it('indexes the split form of a hyphenated compound', () => {
    const indexes = indexesFor('The pipeline is fully real-time and deterministic.\n');
    expect(indexes.aliasToken['real time']).toBeDefined();
    expect(indexes.aliasToken['realtime']).toBeDefined();
  });

  it('refuses aliases that are ordinary frequent words of the script (§23.2)', () => {
    // "and" is a stopword and the script says it constantly, so `&` -> "and"
    // must not become a retrieval anchor pointing at every ampersand.
    const indexes = indexesFor(
      'Research & development and design and delivery and support and operations.\n',
    );
    expect(indexes.aliasToken['and']).toBeUndefined();
  });

  it('refuses single short alias fragments with no distinctive word', () => {
    const indexes = indexesFor('Meet at no. 5 on the corner.\n');
    // "number" is distinctive enough here (the script never says it), but the
    // gate is the rule under test: every indexed key carries a >= 3 character
    // non-stopword word.
    for (const key of Object.keys(indexes.aliasToken)) {
      expect(
        key.split(' ').some((word) => word.length >= 3),
        key,
      ).toBe(true);
    }
  });
});

/* ---------------------------------------------------------------------------
 * The two search indexes (§25.6 vs §31.3)
 *
 * `buildSearchIndexes` ships `CompiledScript.indexes` on every compile, and
 * `DocumentIndex` rebuilds an overlapping set from `TrackingDocument` when a
 * session starts. Two builders, one apparent purpose — which is how a subtle
 * alignment bug gets introduced by someone improving the copy that is not in
 * use. So the facts, asserted rather than asserted-about:
 *
 *   1. Nothing in `src/` outside the compiler reads `.indexes`. The engine's
 *      retrieval path goes exclusively through `DocumentIndex`.
 *   2. They are **not interchangeable**, and could not be swapped for each
 *      other by anyone who wanted to. The two tests below pin why: the rare
 *      rules select different tokens *in both directions*, and the n-gram key
 *      spaces do not overlap by construction, because one runs over every
 *      token and the other over content tokens only.
 *   3. They cannot be made to agree by sharing code either, because they sit
 *      on different stopword vocabularies on purpose —
 *      `markdown/stopwords.ts` is the compile-side list (130 entries, tuned
 *      for token weighting) and `tracking/normalize.ts` is the transcript-side
 *      one (~70). Reconciling them means choosing one for both, which is a
 *      larger question than either index.
 *
 * Which leaves deletion of the unused half as the only reconciliation actually
 * available. Measured, so the decision is not a matter of taste: on a
 * 6400-token script `indexes` is 875 KB of the 2.4 MB compiled payload — 35% —
 * built inside the compile Worker and structured-cloned to the main thread on
 * every compile, for no consumer. Its rare-token index on that script contains
 * *zero* entries, while the engine's contains many.
 *
 * Until that deletion lands (it needs the one call site in `compile.ts`), this
 * block is what stops the two drifting further in silence.
 * ------------------------------------------------------------------------- */
describe('the compile-time and runtime search indexes are not one index (§25.6, §31.3)', () => {
  /**
   * Long enough for the weight pass's 50-token floor, and built to contain one
   * token of each disagreeing kind: `oak` is a three-letter content word said
   * once, `Halvorsen` a proper noun said five times.
   */
  const SOURCE = [
    '# Field notes',
    '',
    'Halvorsen walked the ridge before the light came up over the water.',
    'The oak stood alone where the fence had been.',
    'Halvorsen counted the posts and wrote the number in the margin.',
    'Every morning the same walk and the same margin and the same number.',
    'Halvorsen said the fence would outlast the argument about the fence.',
    'The surveyor disagreed and Halvorsen wrote that in the margin too.',
    'By the end of the season Halvorsen had filled the notebook.',
  ].join('\n');

  const both = () => {
    const script = compile(SOURCE, { scriptId: 'divergence' });
    return {
      compiled: script.indexes,
      runtime: new DocumentIndex(buildTrackingDocument(script), {
        rareWeight: DEFAULT_TRACKING_PROFILE.rareWeight,
      }),
    };
  };

  it('selects different tokens as rare, in both directions', () => {
    const { compiled, runtime } = both();

    // Compile-side rule: `occurrences <= 2 && !stopword && length >= 3`.
    // Runtime rule: `weight >= rareWeight || (frequency <= 2 && length >= 4)`.
    // `oak` is three letters and said once: rare to the compiler, ordinary to
    // the engine, because three letters earns no inverse-frequency bump.
    expect(compiled.rareToken['oak'], 'oak').toBeDefined();
    expect(runtime.rareTokenPositions.has('oak'), 'oak').toBe(false);

    // And the other way: a proper noun carries `WEIGHT_PROPER_NOUN` however
    // often it is said, so the engine anchors on it and the compiler — which
    // never looks at weight — throws it away for being frequent.
    expect(runtime.tokenFrequency.get('halvorsen')).toBeGreaterThan(2);
    expect(runtime.rareTokenPositions.has('halvorsen'), 'halvorsen').toBe(true);
    expect(compiled.rareToken['halvorsen'], 'halvorsen').toBeUndefined();
  });

  it('does not share an n-gram key space at all', () => {
    const { compiled, runtime } = both();

    // The compile-side n-grams run over every token, so most of their keys are
    // mostly stopwords. The runtime's run over content tokens only, so no key
    // it holds can contain one — a lookup from one index into the other misses
    // on essentially everything.
    const withStopword = Object.keys(compiled.ngram2).filter((key) =>
      key.split(' ').includes('the'),
    );
    expect(withStopword.length).toBeGreaterThan(5);
    for (const key of withStopword) {
      expect(runtime.ngramPositions.has(key), key).toBe(false);
    }
    for (const key of runtime.ngramPositions.keys()) {
      expect(key.split(' ').includes('the'), key).toBe(false);
    }
  });
});
