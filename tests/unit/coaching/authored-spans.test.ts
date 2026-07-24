/**
 * §20.4/§22 — the authored text the Luna Coach Observer is actually shown.
 *
 * `LunaCoachRequest.authoredSpans` had no producer at all: `initialHostState`
 * set it to `[]`, nothing ever wrote it, and the orchestrator copied that empty
 * array into every request. `punctuationClass` is a *required* field of each
 * entry, so it had no source either — a declared field with no producer, which
 * meant the request either omitted the authored text entirely or would have
 * carried a fabricated class if anything had ever filled the array.
 *
 * The tests below run against the real compiler, because the recovery path —
 * render-node text plus `tokenIndexes` — is the thing under test. The
 * tokenizer emits no punctuation token, so a class derived from the token
 * stream could only ever be a guess.
 */
import { describe, expect, it } from 'vitest';

import { compile } from '../../../src/shared/markdown/compile';
import {
  MAX_AUTHORED_SPAN_SENTENCES,
  authoredSpanWindow,
  buildAuthoredSpans,
} from '../../../src/shared/coaching/integration/authored-spans';
import type { CompiledScript } from '../../../src/shared/contracts';

const NONE: ReadonlySet<string> = new Set<string>();

function spansFor(source: string): ReturnType<typeof buildAuthoredSpans> {
  return buildAuthoredSpans(compile(source, { scriptId: 'authored-spans' }), NONE);
}

/* ------------------------------------------------------------------ */
/* punctuationClass is read off the authored characters                */
/* ------------------------------------------------------------------ */

describe('§22 punctuationClass comes from the authored text, not a guess', () => {
  it('distinguishes a sentence that closes from one that closes the paragraph', () => {
    const spans = spansFor(
      'We shipped the release today. The numbers came in ahead of forecast.\n',
    );
    expect(spans).toHaveLength(2);
    // A full stop inside the paragraph: the sentence closes, the passage does
    // not. The presenter lands and carries on.
    expect(spans[0]?.punctuationClass).toBe('strong');
    // The last sentence of a block: the strongest close there is.
    expect(spans[1]?.punctuationClass).toBe('paragraph');
  });

  it('is not a constant — two paragraphs give four different-ending spans', () => {
    const spans = spansFor(
      'Alpha beta gamma. Delta epsilon zeta.\n\nEta theta iota. Kappa lambda mu.\n',
    );
    expect(spans.map((span) => span.punctuationClass)).toEqual([
      'strong',
      'paragraph',
      'strong',
      'paragraph',
    ]);
  });

  it('reads a question and an exclamation as firm closes too', () => {
    const spans = spansFor('Did the numbers land? They absolutely did! And here is why.\n');
    expect(spans[0]?.punctuationClass).toBe('strong');
    expect(spans[1]?.punctuationClass).toBe('strong');
    expect(spans[2]?.punctuationClass).toBe('paragraph');
  });

  /**
   * The compiler's sentence splitter breaks on terminal stops, so `medium` and
   * `weak` are not reachable from ordinary prose. They are reachable — and
   * meaningful — for a span that ends on a clause break or on nothing at all,
   * which is what a hand-declared span or a future finer-grained splitter
   * produces. Asserted against a hand-built document rather than left untested,
   * because a class that is never checked is a class that can quietly become
   * whatever the last edit made it.
   */
  it('classes a clause break as medium and an unpunctuated end as weak', () => {
    const surfaces = ['alpha', 'beta', 'gamma', 'delta'];
    const compiled = {
      scriptId: 'hand-built',
      spokenTokens: surfaces.map((surface, index) => ({
        index,
        blockId: 'b-1',
        sentenceId: index < 2 ? 's-1' : 's-2',
        surface,
        normalized: surface,
        aliases: [],
        weight: 1,
        source: { utf16Start: 0, utf16End: 0 },
        flags: 0,
      })),
      sentences: [
        { id: 's-1', blockId: 'b-1', startTokenIndex: 0, endTokenIndex: 1 },
        { id: 's-2', blockId: 'b-1', startTokenIndex: 2, endTokenIndex: 3 },
      ],
      blocks: [
        {
          id: 'b-1',
          kind: 'paragraph',
          // `beta,` closes a clause; `delta` closes nothing, and the block
          // carries no `endTokenIndex`, so it is not a paragraph end either.
          renderNodes: [
            { type: 'text', text: 'alpha beta, gamma delta', tokenIndexes: [0, 1, 2, 3] },
          ],
          source: { utf16Start: 0, utf16End: 0 },
          spoken: true,
        },
      ],
    } as unknown as CompiledScript;

    const spans = buildAuthoredSpans(compiled, NONE);
    expect(spans[0]?.punctuationClass).toBe('medium');
    expect(spans[1]?.punctuationClass).toBe('weak');
  });

  it('does not read a later full stop back onto a token it could not place', () => {
    // The walk hits a token whose surface is not in the visual text and stops.
    // Everything after that point — including the paragraph's full stop — is
    // then sitting in the pending tail. Attributing it to the last token we
    // *did* place would report a firm close for a sentence that ends on a
    // space, which is the one direction this class must never fail in.
    const compiled = {
      scriptId: 'hand-built',
      spokenTokens: [
        { index: 0, surface: 'alpha' },
        { index: 1, surface: 'beta' },
        // A `{say="…"}` form that is not in the visual text at all.
        { index: 2, surface: 'qqqq' },
        { index: 3, surface: 'gamma' },
      ].map((token) => ({
        ...token,
        blockId: 'b-1',
        sentenceId: token.index < 2 ? 's-1' : 's-2',
        normalized: token.surface,
        aliases: [],
        weight: 1,
        source: { utf16Start: 0, utf16End: 0 },
        flags: 0,
      })),
      sentences: [
        { id: 's-1', blockId: 'b-1', startTokenIndex: 0, endTokenIndex: 1 },
        { id: 's-2', blockId: 'b-1', startTokenIndex: 2, endTokenIndex: 3 },
      ],
      blocks: [
        {
          id: 'b-1',
          kind: 'paragraph',
          renderNodes: [
            { type: 'text', text: 'alpha beta Zed gamma.', tokenIndexes: [0, 1, 2, 3] },
          ],
          source: { utf16Start: 0, utf16End: 0 },
          spoken: true,
        },
      ],
    } as unknown as CompiledScript;

    expect(buildAuthoredSpans(compiled, NONE)[0]?.punctuationClass).toBe('weak');
  });

  it('does not claim a firm close it could not observe', () => {
    // `{say="…"}` writes a spoken form that is not in the visual text, so the
    // forward walk cannot place the token. The block's own `endTokenIndex`
    // still says this sentence ends the paragraph — structure survives — but
    // nothing is invented from the characters.
    const spans = spansFor('Our customers adopted the API{say="A P I"} quickly.\n');
    expect(spans).toHaveLength(1);
    expect(spans[0]?.punctuationClass).toBe('paragraph');
    expect(spans[0]?.text).toContain('A P I');
  });
});

/* ------------------------------------------------------------------ */
/* …and the rest of the span is real too                               */
/* ------------------------------------------------------------------ */

describe('§22 the rest of an authored span', () => {
  it('carries the authored emphasis the writer marked', () => {
    const spans = spansFor('The migration finished **early** and nobody *expected* that.\n');
    expect(spans[0]?.emphasisTokens).toEqual(['early', 'expected']);
  });

  it('marks no emphasis where the author marked none', () => {
    const spans = spansFor('The migration finished early and nobody expected that.\n');
    expect(spans[0]?.emphasisTokens).toEqual([]);
  });

  it('carries the critical terms the local comparator acts on', () => {
    const spans = spansFor('Revenue grew forty two percent under Sarah last quarter.\n');
    const critical = spans[0]?.criticalTokens ?? [];
    expect(critical.join(' ')).toContain('forty two');
    expect(critical.join(' ')).toContain('Sarah');
  });

  it('reports the §19.4 coaching-disabled spans as disabled', () => {
    const compiled = compile('Alpha beta gamma. Delta epsilon zeta.\n', { scriptId: 's' });
    const disabled = new Set([compiled.sentences[1]!.id]);
    const spans = buildAuthoredSpans(compiled, disabled);
    expect(spans[0]?.coachingDisabled).toBe(false);
    expect(spans[1]?.coachingDisabled).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* §20.4 the window                                                    */
/* ------------------------------------------------------------------ */

describe('§20.4 the 1–3 sentences around the cursor', () => {
  const SOURCE = ['One two three.', 'Four five six.', 'Seven eight nine.', 'Ten eleven twelve.'].join(
    ' ',
  );

  it('sends the sentence before, the sentence on, and the sentence after', () => {
    const spans = spansFor(`${SOURCE}\n`);
    const window = authoredSpanWindow(spans, spans[2]!.spanId);
    expect(window.map((span) => span.spanId)).toEqual([
      spans[1]!.spanId,
      spans[2]!.spanId,
      spans[3]!.spanId,
    ]);
    expect(window.length).toBeLessThanOrEqual(MAX_AUTHORED_SPAN_SENTENCES);
  });

  it('does not run off the front of the script', () => {
    const spans = spansFor(`${SOURCE}\n`);
    const window = authoredSpanWindow(spans, spans[0]!.spanId);
    expect(window.map((span) => span.spanId)).toEqual([
      spans[0]!.spanId,
      spans[1]!.spanId,
      spans[2]!.spanId,
    ]);
  });

  it('sends nothing rather than the wrong three sentences', () => {
    const spans = spansFor(`${SOURCE}\n`);
    // A request showing the model three sentences the presenter is not on
    // invites a confident wrong answer; none is the honest input.
    expect(authoredSpanWindow(spans, null)).toEqual([]);
    expect(authoredSpanWindow(spans, 'not-a-span')).toEqual([]);
  });
});
