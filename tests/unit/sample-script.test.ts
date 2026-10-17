/**
 * The sample script a first-run user opens.
 *
 * This is the only script most people will read aloud before deciding whether
 * the app works, so it has to compile cleanly and exercise the structures that
 * following actually depends on. It is also the shape that has broken before:
 * a `#` part whose first child is a `##` scene is exactly the nesting that
 * once wedged the section-eligibility gate, because a presenter reading
 * straight through never says the parent heading out loud.
 *
 * The other creation path has no body to compile — a new script starts empty,
 * and `compile('')` is covered directly in `src/shared/markdown/compile.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { compile } from '../../src/shared/markdown/compile';
import { SAMPLE_SCRIPT_SOURCE, SAMPLE_SCRIPT_TITLE } from '../../src/control/lib/sample-script';

function compileSource(source: string) {
  return compile(source, { scriptId: 'sample' });
}

describe('sample script', () => {
  it('compiles the sample without diagnostics', () => {
    const result = compileSource(SAMPLE_SCRIPT_SOURCE);
    expect(result.diagnostics ?? []).toEqual([]);
    expect(result.spokenTokens.length).toBeGreaterThan(0);
  });

  it('is long enough to be worth reading aloud', () => {
    const result = compileSource(SAMPLE_SCRIPT_SOURCE);
    // Roughly a minute of speech at a natural pace. A stub tells a first-run
    // user nothing about whether the text keeps their place, which is the one
    // question the sample exists to answer.
    expect(result.spokenTokens.length).toBeGreaterThan(180);
  });

  it('nests scenes under parts, the shape that once wedged the section gate', () => {
    const result = compileSource(SAMPLE_SCRIPT_SOURCE);
    const levels = new Set<number>();
    const walk = (nodes: readonly { level: number; children?: readonly unknown[] }[]): void => {
      for (const node of nodes) {
        levels.add(node.level);
        if (node.children) walk(node.children as never);
      }
    };
    walk(result.outline as never);
    expect(levels.has(1), 'sample must contain top-level parts').toBe(true);
    expect(levels.has(2), 'sample must nest scenes under a part').toBe(true);
  });

  it('exercises the directive syntax a presenter will meet first', () => {
    // Cue, Beat and Take each take a different path through the compiler, and
    // all three are silent — none may contribute spoken tokens.
    expect(SAMPLE_SCRIPT_SOURCE).toMatch(/\[Cue:/);
    expect(SAMPLE_SCRIPT_SOURCE).toMatch(/\[Beat\]/);
    expect(SAMPLE_SCRIPT_SOURCE).toMatch(/\[Take:/);

    const result = compileSource(SAMPLE_SCRIPT_SOURCE);
    const spoken = result.spokenTokens.map((token) => token.normalized).join(' ');
    for (const leaked of ['cue', 'beat', 'take']) {
      expect(
        spoken.includes(` ${leaked} `),
        `directive keyword "${leaked}" leaked into the spoken stream`,
      ).toBe(false);
    }
  });

  it('demonstrates a §19.4 coaching directive on the line that needs one', () => {
    // The "slow right down" paragraph carries the sample's one directive, and
    // the compiler resolves it to the spans it covers.
    expect(SAMPLE_SCRIPT_SOURCE).toMatch(/<!-- cc:style calm -->/);

    const result = compileSource(SAMPLE_SCRIPT_SOURCE);
    expect(result.coaching?.spans.length).toBeGreaterThan(0);
    expect(result.coaching?.spans.every((span) => span.style === 'calm')).toBe(true);

    const slowSentence = result.sentences.find((sentence) =>
      sentence.normalizedText.startsWith('now try slowing right down'),
    );
    expect(slowSentence).toBeDefined();
    expect(result.coaching?.spans.map((span) => span.spanId)).toContain(slowSentence?.id);

    // Silent, like every other directive in this file.
    const spoken = ` ${result.spokenTokens.map((token) => token.normalized).join(' ')} `;
    for (const leaked of ['cc', 'style', 'calm']) {
      expect(
        spoken.includes(` ${leaked} `),
        `directive keyword "${leaked}" leaked into the spoken stream`,
      ).toBe(false);
    }
  });

  it('has a title that says what to do with it', () => {
    expect(SAMPLE_SCRIPT_TITLE.length).toBeGreaterThan(0);
    expect(SAMPLE_SCRIPT_TITLE).not.toMatch(/untitled/i);
  });
});
