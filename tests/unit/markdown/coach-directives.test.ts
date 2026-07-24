/**
 * §19.4 script directives and §19.5 front matter, at the compiler.
 *
 * Three properties are load-bearing here and each is asserted directly rather
 * than inferred:
 *
 *  1. **Silence.** A directive may not contribute a spoken token and may not
 *     move a token index. The second half is the one that protects alignment:
 *     a directive that shifted indexes by one would leave every downstream
 *     anchor pointing at the wrong word, which is far worse than the coaching
 *     feature simply being absent.
 *  2. **Scope.** A directive whose reach is ambiguous is worse than no
 *     directive. Every scoping rule is pinned by a test that names the spans it
 *     expects and, just as importantly, the spans it expects to be untouched.
 *  3. **Inertness on malformed input.** A user's script must always open. Bad
 *     input produces a diagnostic and otherwise changes nothing.
 */
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/shared/markdown/compile';
import type { CompiledScript } from '../../../src/shared/contracts';

function compileSource(source: string): CompiledScript {
  return compile(source, { scriptId: 'directives' });
}

/** The spans a directive landed on, by their authored text — ids are hashes. */
function spanTexts(result: CompiledScript, predicate: (span: NonNullable<CompiledScript['coaching']>['spans'][number]) => boolean): string[] {
  const byId = new Map(result.sentences.map((s) => [s.id, s.normalizedText]));
  return (result.coaching?.spans ?? [])
    .filter(predicate)
    .map((span) => byId.get(span.spanId) ?? `<unknown ${span.spanId}>`);
}

function codes(result: CompiledScript): string[] {
  return result.diagnostics.map((d) => d.code);
}

/* ------------------------------------------------------------------ */
/* 1. Silence                                                          */
/* ------------------------------------------------------------------ */

describe('§19.4 directives are silent', () => {
  const prose = [
    '# Opening',
    '',
    'The first paragraph is delivered normally.',
    '',
    'The disclaimer paragraph is read verbatim.',
    '',
    'And then we are back to normal delivery.',
    '',
  ];

  const plain = prose.join('\n');
  const annotated = [
    '---',
    'coach:',
    '  mode: coach',
    '  style: calm',
    '  target_wpm: [130, 165]',
    '  target_duration: "08:30"',
    '---',
    '',
    '# Opening',
    '',
    'The first paragraph is delivered normally.',
    '',
    '<!-- cc:coach off -->',
    '<!-- cc:style calm -->',
    '',
    'The disclaimer paragraph is read verbatim.',
    '',
    '<!-- cc:end -->',
    '',
    '<!-- cc:pace 150-190 -->',
    '',
    'And then we are back to normal delivery.',
    '',
  ].join('\n');

  it('produces a byte-identical spoken stream with and without directives', () => {
    const bare = compileSource(plain);
    const marked = compileSource(annotated);

    expect(marked.spokenTokens.map((t) => t.surface)).toEqual(
      bare.spokenTokens.map((t) => t.surface),
    );
    // The assertion that actually protects alignment: same words is not enough,
    // the *indexes* must match too.
    expect(marked.spokenTokens.map((t) => t.index)).toEqual(
      bare.spokenTokens.map((t) => t.index),
    );
    expect(marked.sentences.map((s) => s.normalizedText)).toEqual(
      bare.sentences.map((s) => s.normalizedText),
    );
    expect(marked.statistics.spokenWordCount).toBe(bare.statistics.spokenWordCount);
  });

  it('leaks no directive keyword into the spoken stream', () => {
    const spoken = ` ${compileSource(annotated).spokenTokens.map((t) => t.normalized).join(' ')} `;
    for (const leaked of [
      'cc',
      'coach',
      'pace',
      'style',
      'calm',
      'filler',
      'intentional',
      'end',
      'off',
      'mode',
      'target',
      'wpm',
      'duration',
    ]) {
      expect(spoken.includes(` ${leaked} `), `"${leaked}" leaked into the spoken stream`).toBe(
        false,
      );
    }
  });

  it('renders no directive text and no front matter as visible content', () => {
    const rendered = JSON.stringify(compileSource(annotated).blocks);
    expect(rendered).not.toContain('cc:');
    expect(rendered).not.toContain('target_wpm');
    expect(rendered).not.toContain('coach:');
  });

  it('still records the directives it swallowed', () => {
    const marked = compileSource(annotated);
    expect(marked.coaching?.frontMatter?.mode).toBe('coach');
    expect(marked.coaching?.spans.length).toBeGreaterThan(0);
    expect(marked.diagnostics).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 2. Front matter vs. a leading `---`                                 */
/* ------------------------------------------------------------------ */

describe('§19.5 front matter does not eat ordinary Markdown', () => {
  it('leaves a leading horizontal rule alone', () => {
    const result = compileSource('---\n\n# Heading\n\nSome spoken words here.\n');
    expect(result.coaching?.frontMatter).toBeNull();
    expect(result.blocks[0]?.kind).toBe('divider');
    expect(result.blocks[1]?.kind).toBe('heading');
    expect(result.spokenTokens.length).toBeGreaterThan(0);
  });

  it('leaves a rule / text / rule sandwich alone even when it looks like YAML', () => {
    // `Note: something` is a valid YAML key line. Without the `coach:` guard
    // this whole block would vanish from the script. CommonMark reads it as a
    // rule, a setext heading and a paragraph, and it still does.
    const result = compileSource('---\nNote: read this part slowly.\n---\n\nThen carry on.\n');
    expect(result.coaching?.frontMatter).toBeNull();
    expect(result.blocks.map((b) => b.kind)).toEqual(['divider', 'heading', 'paragraph']);
    expect(result.outline[0]?.title).toBe('Note: read this part slowly.');
    expect(result.spokenTokens.map((t) => t.normalized).join(' ')).toBe('then carry on');
  });

  it('leaves a setext heading alone', () => {
    const result = compileSource('The Big Idea\n---\n\nAnd the words that follow.\n');
    expect(result.coaching?.frontMatter).toBeNull();
    expect(result.blocks[0]?.kind).toBe('heading');
    expect(result.outline[0]?.title).toBe('The Big Idea');
  });

  it('leaves an unterminated leading rule alone', () => {
    const result = compileSource('---\ncoach:\n  mode: coach\n\nNo closing marker anywhere.\n');
    expect(result.coaching?.frontMatter).toBeNull();
    const spoken = result.spokenTokens.map((t) => t.normalized).join(' ');
    expect(spoken).toContain('no closing marker anywhere');
  });

  it('parses the §19.5 example, preserving unknown fields and rejecting bad values', () => {
    const result = compileSource(
      [
        '---',
        'coach:',
        '  mode: coach',
        '  style: conversational',
        '  target_wpm: [130, 165]',
        '  target_variety: [45, 75]',
        '  target_duration: "08:30"',
        '  filler_detection: precision',
        '  live_tips: normal',
        '  positive_feedback: false',
        '  some_future_key: keep me',
        '---',
        '',
        'Read this out loud.',
        '',
      ].join('\n'),
    );
    const front = result.coaching?.frontMatter;
    expect(front?.mode).toBe('coach');
    expect(front?.style).toBe('conversational');
    expect(front?.targetWpm).toEqual([130, 165]);
    expect(front?.targetVariety).toEqual([45, 75]);
    expect(front?.targetDurationSeconds).toBe(8 * 60 + 30);
    expect(front?.liveTips).toBe('normal');
    expect(front?.positiveFeedback).toBe(false);
    // §19.5: unknown fields are preserved but ignored.
    expect(front?.unknownFields['some_future_key']).toBe('keep me');
    // The spec's own example value for `filler_detection` names a transcription
    // cost mode, which a script may not set; it is reported, not obeyed.
    expect(front?.fillerDetection).toBeUndefined();
    expect(codes(result)).toEqual(['coach_front_matter_bad_value']);
    expect(result.diagnostics.every((d) => !d.blocking)).toBe(true);
    // The document still compiles and still has its words.
    expect(result.spokenTokens.map((t) => t.normalized).join(' ')).toBe('read this out loud');
  });

  it('does not shift a single source offset', () => {
    const body = '# Title\n\nExactly these words are spoken.\n';
    const withFront = `---\ncoach:\n  mode: coach\n---\n${body}`;
    const bare = compileSource(body);
    const framed = compileSource(withFront);
    const offset = withFront.length - body.length;
    expect(framed.spokenTokens.map((t) => t.source.utf16Start)).toEqual(
      bare.spokenTokens.map((t) => t.source.utf16Start + offset),
    );
    // Every recorded offset still indexes the real document.
    for (const token of framed.spokenTokens) {
      expect(withFront.slice(token.source.utf16Start, token.source.utf16End)).toBe(token.surface);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 3. Scope                                                            */
/* ------------------------------------------------------------------ */

describe('§19.4 directive scope', () => {
  it('scopes a standalone directive to the next spoken block only', () => {
    const result = compileSource(
      [
        'Paragraph one is coached.',
        '',
        '<!-- cc:coach off -->',
        '',
        'Paragraph two is not. Neither is this sentence.',
        '',
        'Paragraph three is coached again.',
        '',
      ].join('\n'),
    );
    expect(spanTexts(result, (s) => s.coachingOff === true)).toEqual([
      'paragraph two is not',
      'neither is this sentence',
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it('skips past a heading to the next block that actually has words', () => {
    const result = compileSource(
      ['<!-- cc:coach off -->', '', '## A heading nobody reads aloud', '', 'But this is spoken.', ''].join(
        '\n',
      ),
    );
    expect(spanTexts(result, (s) => s.coachingOff === true)).toEqual(['but this is spoken']);
  });

  it('scopes an inline directive to the rest of its own block', () => {
    const result = compileSource(
      [
        'First sentence is coached. <!-- cc:coach off --> Second sentence is not. Third is not either.',
        '',
        'A later paragraph is coached again.',
        '',
      ].join('\n'),
    );
    expect(spanTexts(result, (s) => s.coachingOff === true)).toEqual([
      'second sentence is not',
      'third is not either',
    ]);
  });

  it('honours an explicitly bounded range', () => {
    const result = compileSource(
      [
        '<!-- cc:coach off -->',
        '',
        'Block one is inside the range.',
        '',
        'Block two is also inside the range.',
        '',
        '<!-- cc:end -->',
        '',
        'Block three is outside it.',
        '',
      ].join('\n'),
    );
    expect(spanTexts(result, (s) => s.coachingOff === true)).toEqual([
      'block one is inside the range',
      'block two is also inside the range',
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it('accepts cc:coach on as the closer for cc:coach off', () => {
    const result = compileSource(
      [
        '<!-- cc:coach off -->',
        '',
        'Silent for coaching purposes.',
        '',
        'Still silent for coaching purposes.',
        '',
        '<!-- cc:coach on -->',
        '',
        'Coached once more.',
        '',
      ].join('\n'),
    );
    expect(spanTexts(result, (s) => s.coachingOff === true)).toEqual([
      'silent for coaching purposes',
      'still silent for coaching purposes',
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  /**
   * The regression this rule exists for: a `cc:end` written for one passage
   * must not reach backwards and swallow an unrelated directive that opened
   * three paragraphs earlier.
   */
  it('gives a cc:end to the group written immediately above it, not to everything open', () => {
    const result = compileSource(
      [
        '<!-- cc:coach off -->',
        '',
        'Only this block is uncoached.',
        '',
        'This block is coached.',
        '',
        '<!-- cc:style calm -->',
        '<!-- cc:filler intentional -->',
        '',
        'A calm block. Another calm sentence.',
        '',
        '<!-- cc:end -->',
        '',
        'Ordinary delivery resumes.',
        '',
      ].join('\n'),
    );
    expect(spanTexts(result, (s) => s.coachingOff === true)).toEqual([
      'only this block is uncoached',
    ]);
    expect(spanTexts(result, (s) => s.style === 'calm')).toEqual([
      'a calm block',
      'another calm sentence',
    ]);
    expect(spanTexts(result, (s) => s.fillerIntentional === true)).toEqual([
      'a calm block',
      'another calm sentence',
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it('records a pace range on the block it precedes', () => {
    const result = compileSource(
      ['<!-- cc:pace 150-190 -->', '', 'Rattle through this bit.', '', 'But not this bit.', ''].join(
        '\n',
      ),
    );
    const spans = result.coaching?.spans ?? [];
    expect(spans).toHaveLength(1);
    expect(spans[0]?.paceLowWpm).toBe(150);
    expect(spans[0]?.paceHighWpm).toBe(190);
    expect(spanTexts(result, () => true)).toEqual(['rattle through this bit']);
  });

  it('reads a directive nested inside a blockquote', () => {
    const result = compileSource(
      ['> Quoted line one.', '>', '> <!-- cc:coach off -->', '>', '> Quoted line two.', ''].join(
        '\n',
      ),
    );
    expect(spanTexts(result, (s) => s.coachingOff === true)).toEqual(['quoted line two']);
    expect(result.diagnostics).toEqual([]);
  });

  /**
   * `- <!-- cc:x --> text` is an HTML *block* in CommonMark: the trailing text
   * is part of the comment's raw value, not a separate comment. The compiler
   * used to discard the node whole, which read the directive as nothing at all
   * *and* silently deleted the presenter's line. Both halves are now split
   * apart — the directive scopes from the end of the comment, the words are
   * spoken. See `html-comment-text.test.ts` for the full property set.
   */
  it('reads a comment that runs into other text without eating the text', () => {
    const result = compileSource(
      ['- First item is coached.', '- <!-- cc:coach off --> Second item.', ''].join('\n'),
    );
    expect(spanTexts(result, (s) => s.coachingOff === true)).toEqual(['second item']);
    expect(result.spokenTokens.map((t) => t.surface)).toEqual([
      'First',
      'item',
      'is',
      'coached',
      'Second',
      'item',
    ]);
    expect(result.diagnostics).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 4. Malformed input is inert                                         */
/* ------------------------------------------------------------------ */

describe('§19.4 malformed directives never break a compile', () => {
  const stillWorks = (result: CompiledScript) => {
    expect(result.diagnostics.every((d) => !d.blocking)).toBe(true);
    expect(result.spokenTokens.length).toBeGreaterThan(0);
    // Tokens still index the real document, so tracking still works.
    expect(result.spokenTokens.map((t) => t.index)).toEqual(
      result.spokenTokens.map((_, i) => i),
    );
  };

  it('reports an unknown directive and changes nothing', () => {
    const result = compileSource('<!-- cc:wibble sideways -->\n\nWords that must survive.\n');
    expect(codes(result)).toEqual(['coach_directive_unknown']);
    expect(result.coaching?.spans).toEqual([]);
    stillWorks(result);
  });

  it('reports a bad value and changes nothing', () => {
    const result = compileSource('<!-- cc:pace quickly -->\n\nWords that must survive.\n');
    expect(codes(result)).toEqual(['coach_directive_bad_value']);
    expect(result.coaching?.spans).toEqual([]);
    stillWorks(result);
  });

  it('reports a backwards pace range and changes nothing', () => {
    const result = compileSource('<!-- cc:pace 190-150 -->\n\nWords that must survive.\n');
    expect(codes(result)).toEqual(['coach_directive_bad_value']);
    expect(result.coaching?.spans).toEqual([]);
    stillWorks(result);
  });

  it('reports a stray closer', () => {
    const result = compileSource('Words that must survive.\n\n<!-- cc:end -->\n');
    expect(codes(result)).toEqual(['coach_directive_stray_end']);
    expect(result.coaching?.spans).toEqual([]);
    stillWorks(result);
  });

  it('reports a directive that governs nothing', () => {
    const result = compileSource('Words that must survive.\n\n<!-- cc:coach off -->\n');
    expect(codes(result)).toEqual(['coach_directive_no_scope']);
    expect(result.coaching?.spans).toEqual([]);
    stillWorks(result);
  });

  /**
   * §19.4 names `cc:pause`, `cc:emphasis` and `cc:duration`. None of them has a
   * consumer in this build, so each is reported rather than accepted. A
   * directive that parses and silently does nothing is the worst outcome
   * available: the author believes it worked.
   */
  it('reports the §19.4 directives that have no consumer instead of accepting them', () => {
    for (const directive of ['cc:pause short', 'cc:emphasis', 'cc:duration 00:45']) {
      const result = compileSource(`<!-- ${directive} -->\n\nWords that must survive.\n`);
      expect(codes(result), directive).toEqual(['coach_directive_unsupported']);
      expect(result.coaching?.spans, directive).toEqual([]);
      stillWorks(result);
    }
  });

  it('ignores a cc: comment inside fenced code', () => {
    const result = compileSource(
      ['Here is the syntax:', '', '```markdown', '<!-- cc:coach off -->', '```', '', 'Carry on.', ''].join(
        '\n',
      ),
    );
    expect(result.coaching?.spans).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it('ignores a cc: comment inside an inline code span', () => {
    const result = compileSource('Write `<!-- cc:coach off -->` to disable coaching.\n');
    expect(result.coaching?.spans).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it('leaves an ordinary HTML comment untouched', () => {
    const result = compileSource('<!-- just a note to myself -->\n\nWords that must survive.\n');
    expect(result.diagnostics).toEqual([]);
    expect(result.coaching?.spans).toEqual([]);
    stillWorks(result);
  });
});
