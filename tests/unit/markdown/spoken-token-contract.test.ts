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
   * Pins the known gap rather than leaving it to be discovered on a stage.
   * A list item is ONE navigation unit by design (§25.5), so a bullet holding
   * two sentences reports one boundary and the display can still be carried
   * over the full stop inside it. Not a regression — that is what every
   * paragraph did before — but not the protection prose gets either. If
   * grammatical sentence ends are ever published separately from navigation
   * units, this expectation is the one that should change.
   */
  it('reports a multi-sentence list item as a single unit, for now', () => {
    const compiled = compile('- Alpha bravo. Charlie delta.', { scriptId: 'bullets' });
    const tokens = alignTokensFor(compiled);

    expect(tokens.map((t) => t.surface)).toEqual(['Alpha', 'bravo', 'Charlie', 'delta']);
    expect(tokens.filter((t) => t.sentenceEnd).map((t) => t.surface)).toEqual(['delta']);
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
