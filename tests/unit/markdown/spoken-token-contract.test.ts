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
