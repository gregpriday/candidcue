/**
 * What the stage is allowed to claim about a single word.
 *
 * The answer is: nothing. Alignment produces a position on a continuous axis,
 * not a word, and a mark on one token turns every ordinary sub-word wobble
 * into a twitch under the reader's eye — asserting a precision the engine
 * does not have. A boundary degrades gracefully where a pointer does not: an
 * estimate a token or two off shades one extra word slightly grey instead of
 * pointing confidently at the wrong one.
 *
 * So the cursor may only divide spoken from unspoken. These tests exist
 * because the underline was added once already, for a reason that sounded
 * good ("proof the take is alive"), and felt awful in use.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { render } from 'svelte/server';
import InlineNodes from '../../../src/stage/renderer/InlineNodes.svelte';
import type { SafeRenderNode } from '../../../src/shared/contracts';

const source = readFileSync(
  fileURLToPath(new URL('../../../src/stage/renderer/InlineNodes.svelte', import.meta.url)),
  'utf8',
);

/** Five words, tokens 0-4, so the cursor has words on both sides of it. */
const nodes: SafeRenderNode[] = [
  { type: 'text', text: 'alpha beta gamma delta epsilon', tokenIndexes: [0, 1, 2, 3, 4] },
];

/** Every anchored span, as the pairs `[token, word]` it claims. */
function anchored(html: string): [number, string][] {
  const out: [number, string][] = [];
  for (const match of html.matchAll(/data-t="(\d+)"[^>]*>([^<]*)</g)) {
    out.push([Number(match[1]), match[2]!]);
  }
  return out;
}

/** The class attribute of the span anchored at `token`. */
function classesAt(html: string, token: number): string[] {
  const match = new RegExp(`<span class="([^"]*)"[^>]*data-t="${token}"`).exec(html);
  if (!match) throw new Error(`no rendered span for token ${token}`);
  return match[1]!.split(/\s+/).filter(Boolean).sort();
}

describe('per-word marking on the stage', () => {
  const html = render(InlineNodes, { props: { nodes, cursor: 2 } }).body;

  it('dims the words already spoken', () => {
    expect(classesAt(html, 0)).toContain('past');
    expect(classesAt(html, 1)).toContain('past');
  });

  it('leaves the word at the cursor styled exactly like the ones after it', () => {
    /*
     * The load-bearing assertion. The cursor is our best guess, and a guess
     * that renders differently from its neighbours is a claim; identical
     * markup is the only way to be sure no styling can distinguish it.
     */
    expect(classesAt(html, 2)).toEqual(classesAt(html, 3));
    expect(classesAt(html, 2)).toEqual(classesAt(html, 4));
    expect(classesAt(html, 2)).not.toContain('past');
  });

  it('has no styling hook for a single token anywhere in the component', () => {
    // A class the markup no longer emits is how this would creep back: the CSS
    // returns first, then something starts setting it.
    expect(source).not.toContain('class:current');
    expect(source).not.toMatch(/\.w\.current\b/);
  });

  /*
   * A paragraph with an em dash in it used to render with NO per-word marking
   * at all: the compiler's `tokenIndexes` counts tokens and the renderer splits
   * words, the dash is a word and not a token, and the length check that
   * reconciled the two then failed for the whole node. Every span lost its
   * `data-t`, so the block dimmed as one flat shade however far into it the
   * reader was — which is what a presenter reported seeing, on the one
   * paragraph of the sample script that contains a dash.
   */
  it('marks the words around a written-but-unspoken word', () => {
    const dashed: SafeRenderNode[] = [
      {
        type: 'text',
        text: 'alpha beta — gamma delta',
        tokenIndexes: [0, 1, 2, 3],
        wordTokens: [0, 1, null, 2, 3],
      },
    ];
    const marked = render(InlineNodes, { props: { nodes: dashed, cursor: 2 } }).body;
    /*
     * The words each anchor is ON, not just how many there are. A mapping that
     * shifted by one across the dash would leave every assertion about classes
     * true and still point each anchor at its neighbour — and an anchor on the
     * wrong word is what moves the presenter's position.
     */
    expect(anchored(marked)).toEqual([
      [0, 'alpha'],
      [1, 'beta'],
      [2, 'gamma'],
      [3, 'delta'],
    ]);
    expect(classesAt(marked, 0)).toContain('past');
    expect(classesAt(marked, 1)).toContain('past');
    expect(classesAt(marked, 2)).not.toContain('past');
    // The dash is drawn, and anchored to nothing.
    expect(marked).toContain('—');
    expect(marked).not.toMatch(/data-t="[^"]*"[^>]*>—/);
  });

  it('never underlines a word, whatever the cursor is', () => {
    // Word spans carry `.w`; the only underlines in this component belong to
    // `link` and the `strike` mark, neither of which tracks the reader.
    const styles = source.slice(source.indexOf('<style>'));
    const wordRules = styles
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('}')
      .filter((rule) => /(^|\s|,)\.w[\s.{]/.test(rule));
    expect(wordRules.length).toBeGreaterThan(0);
    for (const rule of wordRules) {
      expect(rule, `word rule decorates text: ${rule.trim()}`).not.toContain('text-decoration');
    }
  });
});
