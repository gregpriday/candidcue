/**
 * §22.2 / §19.4 — text that follows an HTML comment on the same line.
 *
 * `- <!-- note --> and then the line` is a single CommonMark *HTML block*: the
 * comment does not end at `-->`, it ends at the end of the line, so the
 * presenter's words live inside the comment node's raw value. The compiler
 * discarded that node whole, which is right for the comment and catastrophic
 * for the words: a line of the script vanished between the editor and the
 * glass, with no diagnostic to look at. A compile error would have been kinder.
 *
 * The tests below hold three things at once, because the fix is only correct if
 * all three survive:
 *
 *  1. the words after the comment are spoken;
 *  2. a `cc:` directive in front of them is still silent, and still applies;
 *  3. the spoken token stream is byte- and index-identical to the same script
 *     written without the comment — the property every downstream alignment
 *     anchor rests on.
 */
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/shared/markdown/compile';
import type { CompiledScript } from '../../../src/shared/contracts';

function compileSource(source: string): CompiledScript {
  return compile(source, { scriptId: 'html-comment' });
}

function surfaces(result: CompiledScript): string[] {
  return result.spokenTokens.map((token) => token.surface);
}

function spanTexts(result: CompiledScript, predicate: (spanId: string) => boolean): string[] {
  const byId = new Map(result.sentences.map((s) => [s.id, s.normalizedText]));
  return (result.coaching?.spans ?? [])
    .filter((span) => predicate(span.spanId))
    .map((span) => byId.get(span.spanId) ?? `<unknown ${span.spanId}>`);
}

/* ------------------------------------------------------------------ */
/* 1. The words survive                                                */
/* ------------------------------------------------------------------ */

describe('a comment never eats the rest of the line', () => {
  it('speaks the text after a comment in a list item', () => {
    const result = compileSource(
      ['- First item is coached.', '- <!-- an aside --> Second item.', ''].join('\n'),
    );
    expect(surfaces(result)).toEqual(['First', 'item', 'is', 'coached', 'Second', 'item']);
    expect(result.sentences.map((s) => s.normalizedText)).toEqual([
      'first item is coached',
      'second item',
    ]);
    // The comment itself is gone: no diagnostic, no rendered text, no token.
    expect(result.diagnostics).toEqual([]);
  });

  it('speaks the text after a comment at the top level', () => {
    const result = compileSource(['<!-- an aside --> The opening line.', '', 'And more.', ''].join('\n'));
    expect(surfaces(result)).toEqual(['The', 'opening', 'line', 'And', 'more']);
    expect(result.diagnostics).toEqual([]);
  });

  it('speaks the text after a comment inside a blockquote', () => {
    const result = compileSource(['> <!-- an aside --> Quoted line.', ''].join('\n'));
    expect(surfaces(result)).toEqual(['Quoted', 'line']);
    expect(result.diagnostics).toEqual([]);
  });

  it('handles a run of comments before the text', () => {
    const result = compileSource(['- <!-- one --><!-- two --> Third item.', ''].join('\n'));
    expect(surfaces(result)).toEqual(['Third', 'item']);
  });

  it('still discards a comment with nothing after it', () => {
    const result = compileSource(['- <!-- an aside -->', '- Second item.', ''].join('\n'));
    expect(surfaces(result)).toEqual(['Second', 'item']);
    expect(result.diagnostics).toEqual([]);
  });

  /**
   * An unterminated `<!--` is not a comment we can split, and guessing where
   * the author meant it to end is worse than leaving it exactly as it was.
   */
  it('leaves an unterminated comment alone', () => {
    const result = compileSource(['- <!-- never closed', '', 'Later words.', ''].join('\n'));
    expect(surfaces(result)).toContain('Later');
  });
});

/* ------------------------------------------------------------------ */
/* 2. The directive still works, and is still silent                   */
/* ------------------------------------------------------------------ */

describe('§19.4 a directive in a list item is silent and still applies', () => {
  const source = ['- First item is coached.', '- <!-- cc:coach off --> Second item.', ''].join('\n');

  it('applies the directive to the item it is written in', () => {
    const result = compileSource(source);
    expect(spanTexts(result, () => true)).toEqual(['second item']);
    expect(result.coaching?.spans[0]?.coachingOff).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it('leaks no directive keyword into the spoken stream', () => {
    const spoken = ` ${compileSource(source)
      .spokenTokens.map((t) => t.normalized)
      .join(' ')} `;
    for (const leaked of ['cc', 'coach', 'off']) {
      expect(spoken.includes(` ${leaked} `), `"${leaked}" leaked`).toBe(false);
    }
  });

  it('applies a pace directive written inline in a list item', () => {
    const result = compileSource(
      ['- <!-- cc:pace 150-190 --> Rattle through this bit.', '- But not this bit.', ''].join('\n'),
    );
    expect(spanTexts(result, () => true)).toEqual(['rattle through this bit']);
    expect(result.coaching?.spans[0]?.paceLowWpm).toBe(150);
    expect(result.coaching?.spans[0]?.paceHighWpm).toBe(190);
  });
});

/* ------------------------------------------------------------------ */
/* 3. The identity property                                            */
/* ------------------------------------------------------------------ */

describe('the spoken stream is identical with and without the comment', () => {
  const bare = ['- First item is coached.', '- Second item.', '', 'A closing paragraph.', ''].join(
    '\n',
  );
  const marked = [
    '- First item is coached.',
    '- <!-- cc:coach off --> Second item.',
    '',
    '<!-- cc:pace 150-190 --> A closing paragraph.',
    '',
  ].join('\n');

  it('produces the same surfaces, the same indexes and the same sentences', () => {
    const plain = compileSource(bare);
    const annotated = compileSource(marked);

    expect(surfaces(annotated)).toEqual(surfaces(plain));
    // The assertion that protects alignment: same words is not enough, the
    // indexes must line up too.
    expect(annotated.spokenTokens.map((t) => t.index)).toEqual(
      plain.spokenTokens.map((t) => t.index),
    );
    expect(annotated.sentences.map((s) => s.normalizedText)).toEqual(
      plain.sentences.map((s) => s.normalizedText),
    );
    // Sentence ids are content hashes, so equal ids prove the *scope* a
    // directive names is the same span the bare script produces.
    expect(annotated.sentences.map((s) => s.id)).toEqual(plain.sentences.map((s) => s.id));
    expect(annotated.statistics.spokenWordCount).toBe(plain.statistics.spokenWordCount);
  });

  it('keeps every token offset pointing at the real document', () => {
    const annotated = compileSource(marked);
    for (const token of annotated.spokenTokens) {
      expect(marked.slice(token.source.utf16Start, token.source.utf16End)).toBe(token.surface);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 4. Raw markup after a comment is still not script                   */
/* ------------------------------------------------------------------ */

describe('§22.2 raw HTML after a comment is visible and silent', () => {
  it('reports it rather than speaking it', () => {
    const result = compileSource(['<!-- an aside --> <span>markup</span>', '', 'Words.', ''].join('\n'));
    expect(result.diagnostics.map((d) => d.code)).toEqual(['raw_html_blocked']);
    expect(surfaces(result)).toEqual(['Words']);
  });
});
