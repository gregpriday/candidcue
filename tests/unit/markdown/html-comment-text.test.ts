/**
 * §22.2 — text that follows an HTML comment on the same line.
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
 *  2. a comment in the retired `cc:` coaching syntax is an ordinary comment —
 *     silent, and reported nowhere, since nothing it says has an effect;
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
/* 2. A retired directive is an ordinary comment                       */
/* ------------------------------------------------------------------ */

describe('a retired `cc:` directive is an ordinary comment', () => {
  // Every form the coaching rail understood, the three it only reported as
  // unsupported, and the malformed ones it used to warn about. Old scripts
  // carry all of them, and a warning on each would be noise about a feature
  // that no longer exists.
  const retired = [
    'cc:style calm',
    'cc:pace 150-190',
    'cc:coach off',
    'cc:coach on',
    'cc:filler intentional',
    'cc:end',
    'cc:pause 3s',
    'cc:emphasis high',
    'cc:duration 2:00',
    'cc:',
    'cc:wobble',
    'cc:pace fast',
  ];

  it.each(retired)('keeps <!-- %s --> in a list item silent and unreported', (directive) => {
    const bare = compileSource(['- First item.', '- Second item.', ''].join('\n'));
    const result = compileSource(
      ['- First item.', `- <!-- ${directive} --> Second item.`, ''].join('\n'),
    );
    expect(surfaces(result)).toEqual(['First', 'item', 'Second', 'item']);
    expect(result.spokenTokens.map((t) => t.index)).toEqual(bare.spokenTokens.map((t) => t.index));
    expect(result.diagnostics).toEqual([]);
  });

  it.each(retired)('reports nothing for <!-- %s --> on a line of its own', (directive) => {
    // Once before the paragraph and once after it, where the old resolver
    // complained that a directive covered no spoken text.
    const comment = `<!-- ${directive} -->`;
    const result = compileSource([comment, '', 'A paragraph.', '', comment, ''].join('\n'));
    expect(surfaces(result)).toEqual(['A', 'paragraph']);
    expect(result.diagnostics).toEqual([]);
  });

  it('leaks no directive keyword into the spoken stream', () => {
    const source = ['- First item.', '- <!-- cc:coach off --> Second item.', ''].join('\n');
    const spoken = ` ${compileSource(source)
      .spokenTokens.map((t) => t.normalized)
      .join(' ')} `;
    for (const leaked of ['cc', 'coach', 'off']) {
      expect(spoken.includes(` ${leaked} `), `"${leaked}" leaked`).toBe(false);
    }
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
    // Sentence ids are content hashes, so equal ids prove the comment left
    // every span exactly as the bare script produces it.
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
