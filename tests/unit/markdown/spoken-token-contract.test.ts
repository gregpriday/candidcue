/**
 * The app half of the canonicalization contract.
 *
 * Two languages share one job here and the split is deliberate: the Markdown
 * compiler decides WHAT is a spoken token, and `cc-align` decides what a token
 * SOUNDS like. Nothing enforces the seam between them at build time, which is
 * exactly how `&` fell down it — the compiler emitted it as a token, the
 * engine's normalizer dropped it, and the app rendered a word that no
 * transcript could ever match.
 *
 * So the contract is asserted from both ends against the same surfaces:
 *
 *   - here, that the compiler really does produce them;
 *   - in `src-tauri/src/align/mod.rs::canonicalization_contract_tests`, that
 *     every one of them yields at least one atom.
 *
 * If either side changes its mind about a surface, one of the two fails.
 */
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/shared/markdown';
import { alignTokensFor } from '../../../src/control/services/alignment';

/**
 * Mirrors `APP_TOKEN_SURFACES` in `src-tauri/src/align/mod.rs`. Keep the two
 * lists identical — they are one fixture expressed twice because the seam they
 * describe is.
 */
const SURFACES = [
  'Hello',
  'world',
  'R',
  '&',
  'D',
  'AT&T',
  '$12',
  '50%',
  'well-known',
  "don't",
  'e.g',
  'U.S.A',
  '3.14',
  '42',
  'CandidCue',
  'twenty-first',
  '£20',
  '€5',
  'co-founder',
  'API',
];

describe('the spoken-token contract with the alignment engine', () => {
  it('the compiler emits exactly the surfaces the Rust fixture expects', () => {
    // `e.g` and `U.S.A` are written with their trailing dot in prose; the
    // tokenizer documents that it never keeps a trailing dot, which is why the
    // fixture spells them without one.
    const source =
      "Hello world R & D AT&T $12 50% well-known don't e.g. U.S.A. 3.14 42 " +
      'CandidCue twenty-first £20 €5 co-founder API';
    const compiled = compile(source, { scriptId: 'contract' });
    expect(compiled.spokenTokens.map((t) => t.surface)).toEqual(SURFACES);
  });

  it('hands every one of them to the engine, in order and unsplit', () => {
    const source =
      "Hello world R & D AT&T $12 50% well-known don't e.g. U.S.A. 3.14 42 " +
      'CandidCue twenty-first £20 €5 co-founder API';
    const compiled = compile(source, { scriptId: 'contract' });
    const tokens = alignTokensFor(compiled);

    /*
     * The ORDER and the COUNT are the contract: every snapshot position is a
     * fractional index into this array. A token filtered, merged or split here
     * shifts every position after it, and nothing downstream could detect it.
     */
    expect(tokens.map((t) => t.surface)).toEqual(SURFACES);
    expect(tokens).toHaveLength(compiled.spokenTokens.length);
  });

  /*
   * The engine brakes forward prediction at a sentence end, and it can only do
   * that if it is told where one is. `tokenize.ts` guarantees a surface never
   * ends in a dot, so this flag is the ONLY route the boundary has to the
   * engine — if it stops being sent, prediction silently reverts to running to
   * the end of the paragraph and nothing else fails.
   */
  it('marks the last token of every sentence, and only that one', () => {
    const compiled = compile('Alpha bravo charlie. Delta echo.\n\nFoxtrot golf.', {
      scriptId: 'sentences',
    });
    const tokens = alignTokensFor(compiled);

    const flagged = tokens.filter((t) => t.sentenceEnd).map((t) => t.surface);
    expect(flagged).toEqual(['charlie', 'echo', 'golf']);
    expect(tokens.filter((t) => t.sentenceEnd)).toHaveLength(compiled.sentences.length);
  });

  /*
   * The abbreviations are the reason this is segmented in TypeScript and not
   * re-derived in Rust: `segment.ts` keeps a list of non-terminal ones, and the
   * engine's own crude fallback would call `Dr.` a sentence end.
   */
  it('does not call an honorific or a decimal a sentence end', () => {
    const compiled = compile('Dr. Smith raised 3.14 million. Then he left.', {
      scriptId: 'abbreviations',
    });
    const tokens = alignTokensFor(compiled);

    expect(tokens.filter((t) => t.sentenceEnd).map((t) => t.surface)).toEqual([
      'million',
      'left',
    ]);
  });

  /*
   * A line that simply runs out is still somewhere the reader stops. The engine
   * forces a paragraph's last atom to end a sentence regardless, but the
   * compiler should be saying so too rather than relying on that backstop.
   */
  it('ends a sentence on an unpunctuated final token', () => {
    const compiled = compile('Alpha bravo\n\nCharlie delta', { scriptId: 'unpunctuated' });
    const tokens = alignTokensFor(compiled);

    expect(tokens.filter((t) => t.sentenceEnd).map((t) => t.surface)).toEqual([
      'bravo',
      'delta',
    ]);
  });

  /*
   * This is the expectation the old version of this test said should change.
   *
   * It used to read "reports a multi-sentence list item as a single unit, for
   * now", pinning a known gap: `SentenceUnit` is a NAVIGATION unit, a list
   * item is deliberately one of them however many sentences it holds (§25.5),
   * and alignment reused those units as sentence ends. So a bullet with two
   * sentences reported ONE boundary and the display could be carried straight
   * over the full stop inside it. Prose got the braking that keeps a
   * prediction from running past a pause; a bulleted script did not.
   *
   * The compiler publishes `grammaticalSentenceEnd` separately now, from the
   * real segmentation rather than the collapsed one.
   */
  it('brakes at a sentence end INSIDE a list item', () => {
    const compiled = compile('- Alpha bravo. Charlie delta.', { scriptId: 'bullets' });
    const tokens = alignTokensFor(compiled);

    expect(tokens.map((t) => t.surface)).toEqual(['Alpha', 'bravo', 'Charlie', 'delta']);
    expect(tokens.filter((t) => t.sentenceEnd).map((t) => t.surface)).toEqual([
      'bravo',
      'delta',
    ]);
  });

  it('still treats the whole list item as ONE navigation unit', () => {
    /*
     * The other half, and the reason grammatical ends could not simply replace
     * navigation units. Jumping by sentence should move by BULLET — a
     * "next sentence" that lands mid-bullet is not what anyone means by it.
     *
     * Both facts are now true at once, which is the point of publishing them
     * separately.
     */
    const compiled = compile('- Alpha bravo. Charlie delta.', { scriptId: 'bullets' });
    expect(compiled.sentences).toHaveLength(1);
    expect(compiled.sentences[0]).toMatchObject({ startTokenIndex: 0, endTokenIndex: 3 });
  });

  it('changes nothing for ordinary prose', () => {
    /*
     * Anti-regression. For a paragraph the collapsed and real segmentations are
     * identical, so the grammatical ends must land exactly where the navigation
     * ends always did — otherwise this "fix" quietly re-times every prose take
     * in the corpus.
     */
    const compiled = compile('Alpha bravo. Charlie delta.', { scriptId: 'prose' });
    const tokens = alignTokensFor(compiled);
    expect(tokens.filter((t) => t.sentenceEnd).map((t) => t.surface)).toEqual([
      'bravo',
      'delta',
    ]);
    expect(compiled.sentences).toHaveLength(2);
  });

  /*
   * `&` is the one that broke. The compiler has always emitted it as its own
   * token — the pattern in `tokenize.ts` names it explicitly — so an engine
   * that drops it renders a word with nothing behind it.
   */
  it('emits a standalone ampersand as a spoken token', () => {
    const compiled = compile('Research & Development', { scriptId: 'contract' });
    expect(compiled.spokenTokens.map((t) => t.surface)).toEqual([
      'Research',
      '&',
      'Development',
    ]);
  });
});
