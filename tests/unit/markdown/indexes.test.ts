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
